import {logger} from "firebase-functions/v2";
import {onTaskDispatched, TaskQueueOptions} from "firebase-functions/v2/tasks";
import {onRequest, HttpsOptions} from "firebase-functions/v2/https";
import {Resend} from "resend";

import {handleDriveEmail} from "./driveHandler";
import {signupCallbackHandler} from "../../auth/authHandler";
import {getAgentCredentials, getRedirectUriIndex} from "../../auth/credentials";
import {
  ENVIRONMENT_NAME,
  RESEND_API_KEY,
} from "../../util/config";
import {
  TransformedEmail,
  ResendClient,
  TaskRequest,
  DispatchResult,
} from "../../util/types";
import {
  getMockResendClient,
  setMockData,
  getLastSentEmail,
} from "../../util/resendMock";
import {addContactToResend} from "../../util/resend";
import {setDriveEnabled} from "../../util/firestoreHandler";
import {sendEvent} from "../../util/analytics";

// Global configuration for onRequest functions
const onRequestConfig: HttpsOptions = {
  cors: true,
  memory: "512MiB",
  timeoutSeconds: 540,
};

const driveDispatchConfig: TaskQueueOptions = {
  retryConfig: {
    maxAttempts: 1,
    minBackoffSeconds: 1,
  },
  memory: "1GiB",
  timeoutSeconds: 1800,
};

// ============================================================================
// DRIVE AGENT ENDPOINTS
// ============================================================================

export const v2driveSignup = onRequest(
    onRequestConfig,
    async (_req, res) => {
      const credentials = getAgentCredentials("drive");
      const redirectUriIndex = getRedirectUriIndex(ENVIRONMENT_NAME.value());
      const scopes = [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "openid",
        "https://www.googleapis.com/auth/drive.metadata",
        "https://www.googleapis.com/auth/drive.file",
      ].join("+");
      const signupUrl = "https://accounts.google.com/o/oauth2/v2/auth" +
        `?response_type=code` +
        `&client_id=${credentials.web.client_id}` +
        `&redirect_uri=${credentials.web.redirect_uris[redirectUriIndex]}` +
        `&scope=${scopes}` +
        `&access_type=offline` +
        `&prompt=consent`;
      res.redirect(302, signupUrl);
    },
);

export const v2driveOauthCallback = onRequest(
    onRequestConfig,
    async (req, res) => {
      try {
        const userRecord = await signupCallbackHandler(
            req.query as Record<string, string>,
            "drive",
        );
        await setDriveEnabled(userRecord.uid, true);
        sendEvent(userRecord.uid, "drive_sign_up");
      } catch (err) {
        const error = err as { code?: number; message: string };
        logger.warn("Error in driveOauthCallback", err);
        res.status(error.code || 500).send(error.message);
        return;
      }
      res.redirect(302, "https://www.fwd2cal.com/drive-thanks");
    },
);

// ============================================================================
// DRIVE DISPATCH + TEST
// ============================================================================

export const v2driveInboundDispatch = onTaskDispatched(
    driveDispatchConfig,
    async (req: TaskRequest): Promise<void> => {
      await handleDriveInboundDispatch(req);
    },
);

export const v2testDriveInboundDispatch = onRequest(
    onRequestConfig,
    async (req, res) => {
      try {
        res.status(200).json(await handleDriveInboundDispatch(req.body));
      } catch (err) {
        const error = err as Error;
        logger.error("Error in testDriveInboundDispatch", err);
        res.status(500).json({error: error.message});
      }
    },
);

async function handleDriveInboundDispatch(
    req: TaskRequest,
): Promise<DispatchResult> {
  const webhookData = req.data;

  // eslint-disable-next-line camelcase
  const {email_id, from, to, subject, attachments} = webhookData.data;
  const isTestMode =
    ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
  const resend: ResendClient = isTestMode ?
    getMockResendClient() :
    (new Resend(RESEND_API_KEY.value()) as unknown as ResendClient);

  if (isTestMode && webhookData.mockData) {
    const emailId = webhookData.data.email_id;
    setMockData(
        emailId,
        webhookData.mockData.emailContent,
        webhookData.mockData.attachmentsList || [],
    );
  }

  logger.info("Processing Drive email", {
    email_id, // eslint-disable-line camelcase
    from,
    to,
    subject,
    attachmentCount: attachments ? attachments.length : 0,
  });

  addContactToResend(from);

  // Fetch full email content from Resend API
  let emailData;
  try {
    const {data, error} = await resend.emails.receiving.get(email_id);
    emailData = data;
    if (error) {
      logger.error("Drive: Failed to fetch email content", {
        error: error.message,
        email_id, // eslint-disable-line camelcase
      });
      return {message: "error", error: "Failed to fetch email content"};
    }
  } catch (emailError) {
    const err = emailError as Error;
    logger.error("Drive: Failed to fetch email content", {
      error: err.message,
      email_id, // eslint-disable-line camelcase
    });
    return {message: "error", error: "Failed to fetch email content"};
  }

  // Extract SPF and DKIM results
  const authResults = emailData.headers?.["authentication-results"] || "";
  const spfResult = authResults.includes("spf=pass") ? "pass" : "fail";
  const dkimResult = authResults.includes("dkim=pass") ?
    (authResults.match(/dkim=pass header\.i=(@[^\s;]+)/) || [
      null,
      "@unknown",
    ])[1] + " : pass" :
    "fail";

  // Transform to internal email format
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

  if (ENVIRONMENT_NAME.value() !== "production") {
    logger.log("DRIVE WEBHOOK DATA", webhookData);
    logger.log("DRIVE TRANSFORMED EMAIL", transformedEmail);
  }

  // Process with the drive handler
  const outcome = await handleDriveEmail(transformedEmail, resend, email_id);

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
