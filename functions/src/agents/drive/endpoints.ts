import {logger} from "firebase-functions/v2";
import {onTaskDispatched, TaskQueueOptions} from "firebase-functions/v2/tasks";
import {onRequest, HttpsOptions} from "firebase-functions/v2/https";
import {getFunctions} from "firebase-admin/functions";
import {Resend} from "resend";

import {handleDriveEmail, processUpload} from "./driveHandler";
import {handleOrganizeDrive} from "./organizeHandler";
import {driveSignupUrl} from "./mailTemplates";
import {signupCallbackHandler} from "../../auth/authHandler";
import {getAgentCredentials, getRedirectUriIndex} from "../../auth/credentials";
import {ENVIRONMENT_NAME, RESEND_API_KEY} from "../../util/config";
import {
  TaskRequest,
  DispatchResult,
  TransformedEmail,
  ResendClient,
} from "../../util/types";
import {getLastSentEmail, getMockResendClient, setMockData} from "../../util/resendMock";
import {setDriveEnabled, getUserFromEmail, getUserFromUID} from "../../util/firestoreHandler";
import {sendEvent} from "../../util/analytics";
import {
  fetchAndTransformEmail,
  EmailFetchError,
} from "../../resend/emailFetcher";
import {FileProposal} from "./types";

/**
 * Parse the OAuth state parameter (base64url-encoded JSON with emailId + proposal).
 */
function parseOAuthState(
    state: string,
): {emailId: string; proposal?: FileProposal; organize?: boolean} {
  const json = Buffer.from(state, "base64url").toString();
  const parsed = JSON.parse(json);
  return {emailId: parsed.emailId, proposal: parsed.proposal, organize: parsed.organize};
}

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
    async (req, res) => {
      const credentials = getAgentCredentials("drive");
      const redirectUriIndex = getRedirectUriIndex(ENVIRONMENT_NAME.value());
      const scopes = [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "openid",
        "https://www.googleapis.com/auth/drive.metadata",
        "https://www.googleapis.com/auth/drive.file",
      ].join("+");
      // Pass state (resendEmailId) through OAuth so callback can trigger upload
      const state = req.query.state as string | undefined;
      let signupUrl = "https://accounts.google.com/o/oauth2/v2/auth" +
        `?response_type=code` +
        `&client_id=${credentials.web.client_id}` +
        `&redirect_uri=${credentials.web.redirect_uris[redirectUriIndex]}` +
        `&scope=${scopes}` +
        `&access_type=offline` +
        `&prompt=consent`;
      if (state) {
        signupUrl += `&state=${encodeURIComponent(state)}`;
      }
      res.redirect(302, signupUrl);
    },
);

export const v2driveFullScopeSignup = onRequest(
    onRequestConfig,
    async (req, res) => {
      const credentials = getAgentCredentials("drive");
      const redirectUriIndex = getRedirectUriIndex(ENVIRONMENT_NAME.value());
      const scopes = [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "openid",
        "https://www.googleapis.com/auth/drive",
      ].join("+");
      const state = req.query.state as string | undefined;
      let signupUrl = "https://accounts.google.com/o/oauth2/v2/auth" +
        `?response_type=code` +
        `&client_id=${credentials.web.client_id}` +
        `&redirect_uri=${credentials.web.redirect_uris[redirectUriIndex]}` +
        `&scope=${scopes}` +
        `&access_type=offline` +
        `&prompt=consent`;
      if (state) {
        signupUrl += `&state=${encodeURIComponent(state)}`;
      }
      res.redirect(302, signupUrl);
    },
);

export const v2driveOauthCallback = onRequest(
    onRequestConfig,
    async (req, res) => {
      let uid: string;
      try {
        const userRecord = await signupCallbackHandler(
            req.query as Record<string, string>,
            "drive",
        );
        uid = userRecord.uid;
        await setDriveEnabled(uid, true);
        sendEvent(uid, "drive_sign_up");
      } catch (err) {
        const error = err as { code?: number; message: string };
        logger.warn("Error in driveOauthCallback", err);
        res.status(error.code || 500).send(error.message);
        return;
      }

      // If state contains a resendEmailId (+ optional proposal), process the pending upload
      const state = req.query.state as string | undefined;
      if (state) {
        try {
          const {emailId, proposal, organize} = parseOAuthState(state);
          // Dispatch as background task to avoid blocking the browser redirect
          await dispatchPostAuthTask({emailId, uid, organize, proposal});
        } catch (err) {
          logger.error("Drive: Failed to process after OAuth", {
            state,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      res.redirect(302, "https://www.fwd2cal.com/drive-thanks");
    },
);

// ============================================================================
// CONFIRM ENDPOINT — triggers upload for returning users or redirects to OAuth
// ============================================================================

/**
 * Fetch an email by ID from Resend and transform it.
 * Used by confirm endpoint and OAuth callback to re-fetch the original email.
 */
async function fetchEmailById(
    emailId: string,
): Promise<{resend: ResendClient; transformedEmail: TransformedEmail}> {
  const isTestMode =
    ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
  const resend: ResendClient = isTestMode ?
    getMockResendClient() :
    (new Resend(RESEND_API_KEY.value()) as unknown as ResendClient);

  const {data, error} = await resend.emails.receiving.get(emailId);
  if (error) {
    throw new Error(`Failed to fetch email: ${error.message}`);
  }

  const authResults = data.headers?.["authentication-results"] || "";
  const spfResult = authResults.includes("spf=pass") ? "pass" : "fail";
  const dkimResult = authResults.includes("dkim=pass") ?
    (authResults.match(/dkim=pass header\.i=(@[^\s;]+)/) || [
      null,
      "@unknown",
    ])[1] + " : pass" :
    "fail";

  const transformedEmail: TransformedEmail = {
    subject: data.subject,
    text: data.text || "",
    html: data.html || "",
    from: data.from,
    to: Array.isArray(data.to) ? data.to : [data.to],
    headers: data.headers || {},
    SPF: spfResult as "pass" | "fail",
    dkim: `{${dkimResult}}`,
  };

  return {resend, transformedEmail};
}

export const v2driveConfirm = onRequest(
    onRequestConfig,
    async (req, res) => {
      const emailId = req.query.emailId as string;
      if (!emailId) {
        res.status(400).send("Missing emailId");
        return;
      }

      // Fetch the original email to identify the sender
      let resend: ResendClient;
      let transformedEmail: TransformedEmail;
      try {
        const result = await fetchEmailById(emailId);
        resend = result.resend;
        transformedEmail = result.transformedEmail;
      } catch (err) {
        logger.error("Drive: Failed to fetch email for confirm", {
          emailId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).send("Failed to fetch email");
        return;
      }

      const sender = transformedEmail.from?.toLowerCase();
      if (!sender) {
        res.status(400).send("Could not determine sender");
        return;
      }

      // Check if user has OAuth already
      const uid = await getUserFromEmail(sender);
      if (uid) {
        try {
          const userData = await getUserFromUID(uid);
          if (userData.driveEnabled && userData.access_token) {
            // User has OAuth — process upload directly
            await processUpload(emailId, uid, resend, transformedEmail);
            res.redirect(302, "https://www.fwd2cal.com/drive-upload-success");
            return;
          }
        } catch (err) {
          logger.warn("Drive: Error checking user for confirm", {
            uid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // No OAuth — redirect to signup with emailId as state
      const encodedState = Buffer.from(JSON.stringify({emailId})).toString("base64url");
      res.redirect(302, `${driveSignupUrl}?state=${encodeURIComponent(encodedState)}`);
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

export const v2driveProcessAfterAuth = onTaskDispatched(
    driveDispatchConfig,
    async (req): Promise<void> => {
      const {emailId, uid, organize, proposal} =
        req.data as PostAuthTaskData;
      if (organize) {
        logger.info("Drive post-auth: Starting organize", {emailId});
        const {transformedEmail} = await fetchEmailById(emailId);
        await handleOrganizeDrive(transformedEmail, emailId);
      } else {
        logger.info("Drive post-auth: Starting upload", {emailId, uid});
        const {resend, transformedEmail} = await fetchEmailById(emailId);
        await processUpload(emailId, uid, resend, transformedEmail, proposal);
      }
    },
);

export const v2testDriveProcessUpload = onRequest(
    onRequestConfig,
    async (req, res) => {
      try {
        const {emailId, mockData} = req.body;
        if (!emailId) {
          res.status(400).json({error: "Missing emailId"});
          return;
        }

        // Set up mock data if provided (test mode)
        if (mockData && ENVIRONMENT_NAME.value() !== "production") {
          setMockData(emailId, mockData.emailContent, mockData.attachmentsList || []);
        }

        const {resend, transformedEmail} = await fetchEmailById(emailId);
        const sender = transformedEmail.from?.toLowerCase();
        if (!sender) {
          res.status(400).json({error: "Could not determine sender"});
          return;
        }

        const uid = await getUserFromEmail(sender);
        if (!uid) {
          res.status(400).json({error: "User not found"});
          return;
        }

        const result = await processUpload(emailId, uid, resend, transformedEmail);

        let sentEmail = null;
        if (ENVIRONMENT_NAME.value() !== "production") {
          sentEmail = getLastSentEmail(sender);
        }

        res.status(200).json({message: "thanks", data: result, sentEmail});
      } catch (err) {
        const error = err as Error;
        logger.error("Error in testDriveProcessUpload", err);
        res.status(500).json({error: error.message});
      }
    },
);

interface PostAuthTaskData {
  emailId: string;
  uid: string;
  organize?: boolean;
  proposal?: FileProposal;
}

async function dispatchPostAuthTask(data: PostAuthTaskData): Promise<void> {
  const isLocal = ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
  if (isLocal) {
    // In local/test mode, run synchronously (task queues not available)
    if (data.organize) {
      const {transformedEmail} = await fetchEmailById(data.emailId);
      await handleOrganizeDrive(transformedEmail, data.emailId);
    } else {
      const {resend, transformedEmail} = await fetchEmailById(data.emailId);
      await processUpload(
          data.emailId, data.uid, resend, transformedEmail, data.proposal,
      );
    }
    return;
  }
  const queue = getFunctions().taskQueue(
      "locations/us-central1/functions/v2driveProcessAfterAuth",
  );
  await queue.enqueue(data, {
    dispatchDeadlineSeconds: 60 * 30,
  });
  logger.info("Drive: Dispatched post-auth task", {
    emailId: data.emailId, organize: !!data.organize,
  });
}

async function handleDriveInboundDispatch(
    req: TaskRequest,
): Promise<DispatchResult> {
  const webhookData = req.data;

  let transformedEmail;
  let resend;
  try {
    const result = await fetchAndTransformEmail(webhookData);
    transformedEmail = result.transformedEmail;
    resend = result.resend;
  } catch (error) {
    if (error instanceof EmailFetchError) {
      return {message: "error", error: error.message};
    }
    throw error;
  }

  if (ENVIRONMENT_NAME.value() !== "production") {
    logger.log("DRIVE WEBHOOK DATA", webhookData);
    logger.log("DRIVE TRANSFORMED EMAIL", transformedEmail);
  }

  // Process with the drive handler
  // eslint-disable-next-line camelcase
  const {email_id} = webhookData.data;
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
