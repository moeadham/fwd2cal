import {logger} from "firebase-functions/v2";
import {onTaskDispatched, TaskQueueOptions} from "firebase-functions/v2/tasks";
import {onRequest, HttpsOptions} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";

import {handleResendInboundDispatch} from "./emailHandler";
import {inviteAdditionalAttendees} from "./calendarHelper";
import {
  signupCallbackHandler,
  hasRequiredScopes,
  verifyAdditionalEmail,
  oauthCronJob,
} from "../../auth/authHandler";
import {getAgentCredentials, getRedirectUriIndex} from "../../auth/credentials";
import {ENVIRONMENT_NAME} from "../../util/config";
import {AGENT_NAME, AGENT_HOSTING_URL, AGENT_EMAIL_ADDRESS, RESEND_SIGNING_SECRET} from "./config";
import {processInboundWebhook} from "../../resend/webhookUtils";
import {withErrorTracking} from "../../util/analytics";
import {TaskRequest} from "../../util/types";

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
// CALENDAR AGENT ROUTES
// ============================================================================

export const v2signup = onRequest(
    onRequestConfig,
    async (_req, res) => {
      const credentials = getAgentCredentials(AGENT_NAME);
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
      let grantedScope: string;
      try {
        const result = await signupCallbackHandler(
            req.query as Record<string, string>,
            AGENT_NAME,
        );
        grantedScope = result.grantedScope;
      } catch (err) {
        const error = err as { code?: number; message: string };
        logger.warn("Error in oauthCallback", err);
        res.status(error.code || 500).send(error.message);
        return;
      }

      if (!hasRequiredScopes(grantedScope, [
        "https://www.googleapis.com/auth/calendar",
      ])) {
        logger.warn("Calendar signup: insufficient scopes", {grantedScope});
        res.redirect(302, `${AGENT_HOSTING_URL.value()}/insufficient-permissions`);
        return;
      }

      res.redirect(302, "https://www.fwd2cal.com/thanks");
    },
);

export const v2testOauthCallback = onRequest(
    onRequestConfig,
    async (req, res) => {
      const grantedScope = req.body.scope || "";
      if (!hasRequiredScopes(grantedScope, [
        "https://www.googleapis.com/auth/calendar",
      ])) {
        res.redirect(302, `${AGENT_HOSTING_URL.value()}/insufficient-permissions`);
        return;
      }
      res.redirect(302, "https://www.fwd2cal.com/thanks");
    },
);

// ============================================================================
// CALENDAR DISPATCH
// ============================================================================

export const v2resendInboundDispatch = onTaskDispatched(
    dispatchConfig,
    withErrorTracking("calendar", async (req: TaskRequest): Promise<void> => {
      await handleResendInboundDispatch(req);
    }),
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

// ============================================================================
// ADDITIONAL CALENDAR ROUTES
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

// ============================================================================
// CALENDAR INBOUND WEBHOOK + SCHEDULED TOKEN REFRESH
// ============================================================================

export const v2resendInboundCallback = onRequest(
    onRequestConfig,
    async (req, res) => {
      await processInboundWebhook(
          req, res, "v2resendInboundDispatch",
          AGENT_EMAIL_ADDRESS.value(), RESEND_SIGNING_SECRET.value(),
      );
    },
);

export const v2refreshTokensScheduled = onSchedule(
    {
      schedule: "0 * * * *",
      timeZone: "America/New_York",
      memory: "512MiB",
    },
    async () => {
      await oauthCronJob(AGENT_NAME);
    },
);
