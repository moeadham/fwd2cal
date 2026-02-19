import {logger} from "firebase-functions/v2";
import {onTaskDispatched, TaskQueueOptions} from "firebase-functions/v2/tasks";
import {onRequest, HttpsOptions} from "firebase-functions/v2/https";

import {handleEmail} from "./emailHandler";
import {inviteAdditionalAttendees} from "./calendarHelper";
import {processAttachments} from "./attachmentHandler";
import {
  signupCallbackHandler,
  verifyAdditionalEmail,
} from "../../auth/authHandler";
import {getAgentCredentials, getRedirectUriIndex} from "../../auth/credentials";
import {ENVIRONMENT_NAME} from "../../util/config";
import {
  TaskRequest,
  DispatchResult,
} from "../../util/types";
import {getLastSentEmail} from "../../util/resendMock";
import {
  fetchAndTransformEmail,
  EmailFetchError,
} from "../../resend/emailFetcher";

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
  timeoutSeconds: 1800,
};

// ============================================================================
// CALENDAR AGENT ENDPOINTS
// ============================================================================

export const v2signup = onRequest(
    onRequestConfig,
    async (_req, res) => {
      const credentials = getAgentCredentials("calendar");
      const redirectUriIndex = getRedirectUriIndex(ENVIRONMENT_NAME.value());
      const scopes = [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "openid",
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

export const v2oauthCallback = onRequest(
    onRequestConfig,
    async (req, res) => {
      try {
        await signupCallbackHandler(
            req.query as Record<string, string>,
            "calendar",
        );
      } catch (err) {
        const error = err as { code?: number; message: string };
        logger.warn("Error in oauthCallback", err);
        res.status(error.code || 500).send(error.message);
        return;
      }
      res.redirect(302, "https://www.fwd2cal.com/thanks");
    },
);

// ============================================================================
// CALENDAR DISPATCH + TEST
// ============================================================================

export const v2resendInboundDispatch = onTaskDispatched(
    dispatchConfig,
    async (req: TaskRequest): Promise<void> => {
      await handleResendInboundDispatch(req);
    },
);

export const v2testResendInboundDispatch = onRequest(
    onRequestConfig,
    async (req, res) => {
      try {
        res.status(200).json(await handleResendInboundDispatch(req.body));
      } catch (err) {
        const error = err as Error;
        logger.error("Error in testResendInboundDispatch", err);
        res.status(500).json({error: error.message});
      }
    },
);

async function handleResendInboundDispatch(
    req: TaskRequest,
): Promise<DispatchResult> {
  const webhookData = req.data;

  let transformedEmail;
  let emailData;
  let resend;
  try {
    const result = await fetchAndTransformEmail(webhookData);
    transformedEmail = result.transformedEmail;
    emailData = result.emailData;
    resend = result.resend;
  } catch (error) {
    if (error instanceof EmailFetchError) {
      return {message: "error", error: error.message};
    }
    throw error;
  }

  // Log FULL emailData as JSON for debugging
  logger.info("Full emailData JSON response", emailData);

  // Log SPF/DKIM extraction results
  logger.info("SPF/DKIM extraction results", {
    authResultsRaw: emailData.headers?.["authentication-results"] || "EMPTY",
    spfResult: transformedEmail.SPF,
    dkimResultRaw: transformedEmail.dkim,
  });

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

  // Handle attachments (ICS files, images, and documents)
  // eslint-disable-next-line camelcase
  const {email_id} = webhookData.data;
  const {icsFiles, imageUrls, documents} = await processAttachments(resend, email_id);

  if (ENVIRONMENT_NAME.value() !== "production") {
    logger.log("RESEND WEBHOOK DATA", webhookData);
    logger.log("FETCHED EMAIL DATA", emailData);
    logger.log("TRANSFORMED EMAIL", transformedEmail);
    logger.log("ICS FILES", icsFiles);
    logger.log("IMAGE URLS", imageUrls);
    logger.log("DOCUMENTS", documents.map((d) => d.filename));
  }

  // Process the email
  const outcome = await handleEmail(transformedEmail, icsFiles, imageUrls, documents);

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

// ============================================================================
// ADDITIONAL CALENDAR ENDPOINTS
// ============================================================================

export const v2verifyAdditionalEmail = onRequest(
    onRequestConfig,
    async (req, res) => {
      try {
        await verifyAdditionalEmail(req as Parameters<typeof verifyAdditionalEmail>[0], res);
      } catch (err) {
        logger.warn("Error in addUserRecord", err);
        return res.redirect(302, "https://www.fwd2cal.com/404");
      }
    },
);

export const v2inviteAdditionalAttendees = onRequest(
    onRequestConfig,
    async (req, res) => {
      try {
        await inviteAdditionalAttendees(req as Parameters<typeof inviteAdditionalAttendees>[0], res);
      } catch (err) {
        logger.warn("Error in inviteAdditionalAttendees", err);
        return res.redirect(302, "https://www.fwd2cal.com/404");
      }
    },
);
