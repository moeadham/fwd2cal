import {logger} from "firebase-functions/v2";
import {onTaskDispatched, TaskQueueOptions} from "firebase-functions/v2/tasks";
import {onRequest, HttpsOptions} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";

import {
  parseOAuthState,
  handleDriveInboundDispatch,
  handleDriveConfirm,
  handleOrganizeAction,
  handleTestProcessUpload,
  handlePostAuthTask,
  handleOrganizeActionTask,
  dispatchPostAuthTask,
} from "./dispatchHandler";
import {signupCallbackHandler, oauthCronJob} from "../../auth/authHandler";
import {processInboundWebhook} from "../../resend/webhookUtils";
import {getAgentCredentials, getRedirectUriIndex} from "../../auth/credentials";
import {ENVIRONMENT_NAME, DRIVE_EMAIL_ADDRESS, DRIVE_RESEND_SIGNING_SECRET} from "../../util/config";
import {TaskRequest} from "../../util/types";
import {cleanupExpiredDriveFileData} from "../../util/firestoreHandler";
import {sendEvent} from "../../util/analytics";
import {PostAuthTaskData, OrganizeActionTaskData} from "./types";

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
// DRIVE AGENT ROUTES
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
// CONFIRM — triggers upload for returning users or redirects to OAuth
// ============================================================================

export const v2driveConfirm = onRequest(
    onRequestConfig,
    async (req, res) => {
      await handleDriveConfirm(req, res);
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
      await handlePostAuthTask(req.data as PostAuthTaskData);
    },
);

export const v2testDriveProcessUpload = onRequest(
    onRequestConfig,
    async (req, res) => {
      await handleTestProcessUpload(req, res);
    },
);

// ============================================================================
// ORGANIZE ACTION (approve / undo via button click)
// ============================================================================

export const v2driveOrganizeAction = onRequest(
    onRequestConfig,
    async (req, res) => {
      await handleOrganizeAction(req, res);
    },
);

export const v2driveOrganizeActionTask = onTaskDispatched(
    driveDispatchConfig,
    async (req): Promise<void> => {
      await handleOrganizeActionTask(req.data as OrganizeActionTaskData);
    },
);

// ============================================================================
// SCHEDULED CLEANUP
// ============================================================================

export const v2cleanupDriveFileData = onSchedule(
    {
      schedule: "0 3 * * *",
      timeZone: "UTC",
      memory: "512MiB",
    },
    async () => {
      const deleted = await cleanupExpiredDriveFileData();
      logger.info("Drive: Cleanup complete", {deleted});
    },
);

// ============================================================================
// DRIVE INBOUND WEBHOOK + SCHEDULED TOKEN REFRESH
// ============================================================================

export const v2driveInboundCallback = onRequest(
    onRequestConfig,
    async (req, res) => {
      await processInboundWebhook(
          req, res, "v2driveInboundDispatch",
          DRIVE_EMAIL_ADDRESS.value(), DRIVE_RESEND_SIGNING_SECRET.value(),
      );
    },
);

export const v2driveRefreshTokensScheduled = onSchedule(
    {
      schedule: "0 * * * *",
      timeZone: "America/New_York",
      memory: "512MiB",
    },
    async () => {
      await oauthCronJob("drive");
    },
);
