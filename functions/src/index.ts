import fs from "fs";
import path from "path";
import { logger } from "firebase-functions/v2";
import { onTaskDispatched, TaskQueueOptions } from "firebase-functions/v2/tasks";
import { onRequest, HttpsOptions } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";
import admin from "firebase-admin";
import { Resend } from "resend";
import { getFunctions } from "firebase-admin/functions";

import { handleEmail } from "./agents/calendar/emailHandler";
import { inviteAdditionalAttendees } from "./agents/calendar/calendarHelper";
import {
  ENVIRONMENT_NAME,
  RESEND_API_KEY,
  RESEND_SIGNING_SECRET,
} from "./util/config";
import {
  getMockResendClient,
  setMockData,
  getLastSentEmail,
} from "./util/resendMock";
import { addContactToResend } from "./util/resend";
import { processAttachments } from "./agents/calendar/attachmentHandler";
import {
  oauthCronJob,
  signupCallbackHandler,
  verifyAdditionalEmail,
} from "./util/authHandler";
import {
  GoogleOAuthCredentials,
  TransformedEmail,
  ResendWebhookData,
  TaskDispatchOptions,
  ResendClient,
} from "./types";

const CREDENTIALS_PATH = path.join("auth", "v2-google-auth-credentials.json");
const CREDENTIALS: GoogleOAuthCredentials = JSON.parse(
  fs.readFileSync(CREDENTIALS_PATH, { encoding: "utf-8" })
);

admin.initializeApp();
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

// Global configuration for onRequest functions
const onRequestConfig: HttpsOptions = {
  cors: true,
  memory: "512MiB",
  timeoutSeconds: 540,
};

const dispatchConfig: TaskQueueOptions = {
  retryConfig: {
    maxAttempts: 1,
    minBackoffSeconds: 1,
  },
  memory: "512MiB",
  timeoutSeconds: 3600,
};

exports.v2signup = onRequest(
  onRequestConfig,
  async (_req, res) => {
    const redirectUriIndex =
      ENVIRONMENT_NAME.value() === "production" ? 2 : 1;
    const signupUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${CREDENTIALS.web.client_id}&redirect_uri=${CREDENTIALS.web.redirect_uris[redirectUriIndex]}&scope=https://www.googleapis.com/auth/calendar+https://www.googleapis.com/auth/userinfo.email+https://www.googleapis.com/auth/userinfo.profile+openid&access_type=offline&prompt=consent`;
    res.redirect(302, signupUrl);
  }
);

exports.v2oauthCallback = onRequest(
  onRequestConfig,
  async (req, res) => {
    try {
      await signupCallbackHandler(req.query as Record<string, string>);
    } catch (err) {
      const error = err as { code?: number; message: string };
      logger.warn("Error in oauthCallback", err);
      res.status(error.code || 500).send(error.message);
      return;
    }
    res.redirect(302, "https://www.fwd2cal.com/thanks");
  }
);

exports.v2resendInboundCallback = onRequest(
  onRequestConfig,
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).end();
      return;
    }

    try {
      // Use mock client in test mode, real client in production
      const isTestMode =
        ENVIRONMENT_NAME.value() === "local" ||
        ENVIRONMENT_NAME.value() === "test";
      const resend: ResendClient = isTestMode
        ? getMockResendClient()
        : (new Resend(RESEND_API_KEY.value()) as unknown as ResendClient);

      // In test mode, set up mock data from the request
      if (isTestMode && req.body.mockData) {
        const emailId = req.body.data.email_id;
        setMockData(
          emailId,
          req.body.mockData.emailContent,
          req.body.mockData.attachmentsList || []
        );
      }

      // Verify webhook signature
      const signature = req.headers["svix-signature"] as string;
      const svixId = req.headers["svix-id"] as string;
      const svixTimestamp = req.headers["svix-timestamp"] as string;

      if (!signature || !svixId || !svixTimestamp) {
        logger.error("Missing Resend webhook headers");
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      // Verify the webhook signature
      const isValid = await resend.webhooks.verify({
        payload: JSON.stringify(req.body),
        headers: {
          id: svixId,
          timestamp: svixTimestamp,
          signature: signature,
        },
        webhookSecret: RESEND_SIGNING_SECRET.value(),
      });

      if (!isValid) {
        logger.error("Invalid Resend webhook signature");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      // Extract email data from webhook
      const webhookData: ResendWebhookData = req.body;

      // Only process email.received events
      if (webhookData.type !== "email.received") {
        logger.info("Ignoring non-email.received event", {
          type: webhookData.type,
        });
        res.status(200).json({ message: "ok" });
        return;
      }
      // Dispatch the task with data.
      await dispatchTask({
        functionName: "v2resendInboundDispatch",
        data: webhookData,
      });
      res.status(200).json({
        message: "thanks",
        webhookData,
      });
    } catch (error) {
      const err = error as Error;
      logger.error("Error processing Resend webhook", { error: err.message });
      res.status(200).json({
        message: "Something went wrong, but we're not going to tell you what.",
      });
    }
  }
);

async function dispatchTask({
  functionName,
  data,
  deadline = 60 * 5,
  scheduleDelaySeconds = 0,
  location = "us-central1",
}: TaskDispatchOptions): Promise<void> {
  try {
    if (ENVIRONMENT_NAME.value() === "local") {
      logger.debug(`Not dispatching task ${functionName} in dev.`);
      return;
    } else {
      const queue = getFunctions().taskQueue(
        `locations/${location}/functions/${functionName}`
      );
      await queue.enqueue(data, {
        scheduleDelaySeconds: scheduleDelaySeconds,
        dispatchDeadlineSeconds: deadline,
      });
      logger.debug(`Dispatched task ${functionName}`);
      return;
    }
  } catch (error) {
    if (ENVIRONMENT_NAME.value() === "local") {
      logger.debug(`Error dispatching task ${functionName}: ${error}`);
    } else {
      logger.error(`Error dispatching task ${functionName}: ${error}`);
    }
    return;
  }
}

interface TaskRequest {
  data: ResendWebhookData;
}

interface DispatchResult {
  message: string;
  data?: unknown;
  sentEmail?: unknown;
  error?: string;
}

exports.v2resendInboundDispatch = onTaskDispatched(
  dispatchConfig,
  async (req: TaskRequest): Promise<void> => {
    await handleResendInboundDispatch(req);
  }
);

exports.v2testResendInboundDispatch = onRequest(
  onRequestConfig,
  async (req, res) => {
    try {
      res.status(200).json(await handleResendInboundDispatch(req.body));
    } catch (err) {
      const error = err as Error;
      logger.error("Error in testResendInboundDispatch", err);
      res.status(500).json({ error: error.message });
    }
  }
);

async function handleResendInboundDispatch(
  req: TaskRequest
): Promise<DispatchResult> {
  const webhookData = req.data;

  const { email_id, from, to, subject, attachments } = webhookData.data;
  // Use mock client in test mode, real client in production
  const isTestMode =
    ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
  const resend: ResendClient = isTestMode
    ? getMockResendClient()
    : (new Resend(RESEND_API_KEY.value()) as unknown as ResendClient);

  // In test mode, set up mock data from the request
  if (isTestMode && webhookData.mockData) {
    const emailId = webhookData.data.email_id;
    setMockData(
      emailId,
      webhookData.mockData.emailContent,
      webhookData.mockData.attachmentsList || []
    );
  }

  logger.info("Processing Resend email", {
    email_id,
    from,
    to,
    subject,
    attachmentCount: attachments ? attachments.length : 0,
  });

  // Add sender to Resend contacts (fire-and-forget)
  addContactToResend(from);

  // Fetch full email content from Resend API (receiving endpoint)
  let emailData;
  try {
    const { data, error } = await resend.emails.receiving.get(email_id);
    emailData = data;
    if (error) {
      logger.error("Failed to fetch email content from Resend", {
        error: error.message,
        email_id,
      });
      return { message: "error", error: "Failed to fetch email content" };
    }
  } catch (emailError) {
    const err = emailError as Error;
    logger.error("Failed to fetch email content from Resend", {
      error: err.message,
      email_id,
    });
    return { message: "error", error: "Failed to fetch email content" };
  }

  // Log FULL emailData as JSON for debugging
  logger.info("Full emailData JSON response", emailData);

  // Extract SPF and DKIM results from authentication-results header
  const authResults = emailData.headers?.["authentication-results"] || "";
  const spfResult = authResults.includes("spf=pass") ? "pass" : "fail";
  const dkimResult = authResults.includes("dkim=pass")
    ? (authResults.match(/dkim=pass header\.i=(@[^\s;]+)/) || [
        null,
        "@unknown",
      ])[1] + " : pass"
    : "fail";

  // Log SPF/DKIM extraction results
  logger.info("SPF/DKIM extraction results", {
    authResultsRaw: authResults || "EMPTY",
    spfResult,
    dkimResultRaw: dkimResult,
    dkimFinal: `{${dkimResult}}`,
  });

  // Transform Resend format to internal format expected by handleEmail
  const transformedEmail: TransformedEmail = {
    subject: emailData.subject,
    text: emailData.text || "",
    html: emailData.html || "",
    from: emailData.from,
    to: Array.isArray(emailData.to) ? emailData.to : [emailData.to],
    headers: emailData.headers || {},
    SPF: spfResult as "pass" | "fail",
    dkim: `{${dkimResult}}`,
  };

  // Log transformed email object for debugging
  logger.info("Transformed email object", {
    from: transformedEmail.from,
    to: transformedEmail.to,
    subject: transformedEmail.subject,
    SPF: transformedEmail.SPF,
    dkim: transformedEmail.dkim,
    textLength: transformedEmail.text?.length || 0,
    htmlLength: transformedEmail.html?.length || 0,
    headerCount: Object.keys(transformedEmail.headers).length,
  });

  // Handle attachments (ICS files and images)
  const { icsFiles, imageUrls } = await processAttachments(resend, email_id);

  if (ENVIRONMENT_NAME.value() !== "production") {
    logger.log("RESEND WEBHOOK DATA", webhookData);
    logger.log("FETCHED EMAIL DATA", emailData);
    logger.log("TRANSFORMED EMAIL", transformedEmail);
    logger.log("ICS FILES", icsFiles);
    logger.log("IMAGE URLS", imageUrls);
  }

  // Process the email
  const outcome = await handleEmail(transformedEmail, icsFiles, imageUrls);

  // Get the sent email data from mock for testing (non-production only)
  let sentEmail = null;
  if (ENVIRONMENT_NAME.value() !== "production") {
    sentEmail = getLastSentEmail(transformedEmail.from);
  }

  return {
    message: "thanks",
    data: outcome,
    sentEmail: sentEmail,
  };
}

exports.v2verifyAdditionalEmail = onRequest(
  onRequestConfig,
  async (req, res) => {
    try {
      await verifyAdditionalEmail(req as Parameters<typeof verifyAdditionalEmail>[0], res);
    } catch (err) {
      logger.warn("Error in addUserRecord", err);
      return res.redirect(302, "https://www.fwd2cal.com/404");
    }
  }
);

exports.v2inviteAdditionalAttendees = onRequest(
  onRequestConfig,
  async (req, res) => {
    try {
      await inviteAdditionalAttendees(req as Parameters<typeof inviteAdditionalAttendees>[0], res);
    } catch (err) {
      logger.warn("Error in inviteAdditionalAttendees", err);
      return res.redirect(302, "https://www.fwd2cal.com/404");
    }
  }
);

exports.v2refreshTokensScheduled = onSchedule(
  {
    schedule: "0 * * * *",
    timeZone: "America/New_York",
    memory: "512MiB",
  },
  async (_context) => {
    await oauthCronJob();
  }
);
