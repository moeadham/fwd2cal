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
  handleOrganizeChunkTask,
  handleRetryOrganizeProposal,
  dispatchPostAuthTask,
} from "./dispatchHandler";
import {signupCallbackHandler, hasRequiredScopes, oauthCronJob} from "../../auth/authHandler";
import {processInboundWebhook} from "../../resend/webhookUtils";
import {getAgentCredentials, getRedirectUriIndex} from "../../auth/credentials";
import {ENVIRONMENT_NAME} from "../../util/config";
import {
  AGENT_NAME,
  AGENT_HOSTING_URL,
  AGENT_EMAIL_ADDRESS,
  DRIVE_ADMIN_API_KEY,
  DRIVE_RESEND_SIGNING_SECRET,
} from "./config";
import {TaskRequest, TransformedEmail} from "../../util/types";
import {
  cleanupExpiredDriveFileData,
  DRIVE_USERS_COLLECTION,
  getUserFromEmail,
  getUserFromUID,
} from "../../util/firestoreHandler";
import {withErrorTracking} from "../../util/analytics";
import {
  cleanupStuckOrganizeProposals,
  findGeneratingProposal,
  hasFullDriveScope,
  scanAndPropose,
} from "./organizeHandler";

import {
  PostAuthTaskData,
  OrganizeActionTaskData,
  OrganizeChunkTaskData,
} from "./types";

// Global configuration for onRequest functions
const onRequestConfig: HttpsOptions = {
  cors: true,
  memory: "512MiB",
  timeoutSeconds: 540,
};

const driveDispatchConfig: TaskQueueOptions = {
  retryConfig: {
    maxAttempts: 3,
    minBackoffSeconds: 30,
    maxBackoffSeconds: 120,
  },
  memory: "2GiB",
  timeoutSeconds: 1800,
};

// ============================================================================
// DRIVE AGENT ROUTES
// ============================================================================

export const v2driveSignup = onRequest(
    onRequestConfig,
    async (req, res) => {
      const credentials = getAgentCredentials(AGENT_NAME);
      const redirectUriIndex = getRedirectUriIndex(ENVIRONMENT_NAME.value());
      const scopes = [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "openid",
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
      const credentials = getAgentCredentials(AGENT_NAME);
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
      let grantedScope: string;
      try {
        const result = await signupCallbackHandler(
            req.query as Record<string, string>,
            AGENT_NAME,
        );
        uid = result.user.uid;
        grantedScope = result.grantedScope;
      } catch (err) {
        const error = err as { code?: number; message: string };
        logger.warn("Error in driveOauthCallback", err);
        res.status(error.code || 500).send(error.message);
        return;
      }

      // Parse state once for both scope determination and post-auth dispatch
      const state = req.query.state as string | undefined;
      let parsedState: ReturnType<typeof parseOAuthState> | null = null;
      if (state) {
        try {
          parsedState = parseOAuthState(state);
        } catch {
          // Invalid state, fall through to standard scope check
        }
      }

      const requiredScopes = parsedState?.organize ?
        ["https://www.googleapis.com/auth/drive"] :
        [
          "https://www.googleapis.com/auth/drive.file",
        ];

      if (!hasRequiredScopes(grantedScope, requiredScopes)) {
        logger.warn("Drive signup: insufficient scopes", {
          uid, grantedScope, requiredScopes,
        });
        res.redirect(302, `${AGENT_HOSTING_URL.value()}/insufficient-permissions`);
        return;
      }

      if (parsedState) {
        try {
          const {emailId, proposal, organize} = parsedState;
          await dispatchPostAuthTask({emailId, uid, organize, proposal});
        } catch (err) {
          logger.error("Drive: Failed to process after OAuth", {
            state,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      res.redirect(302, "https://www.fwd2drive.com/thanks");
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
    withErrorTracking("drive", async (req: TaskRequest): Promise<void> => {
      await handleDriveInboundDispatch(req);
    }),
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
    withErrorTracking("drive", async (req): Promise<void> => {
      await handlePostAuthTask(req.data as PostAuthTaskData);
    }),
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

export const v2driveRetryOrganizeProposal = onRequest(
    onRequestConfig,
    async (req, res) => {
      await handleRetryOrganizeProposal(req, res);
    },
);

export const v2driveAdminOrganize = onRequest(
    onRequestConfig,
    async (req, res) => {
      if (req.method === "GET") {
        const adminFormHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin: Trigger Drive Organization</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f9fafb;
      --surface: #ffffff;
      --text: #111827;
      --text-muted: #6b7280;
      --border: #e5e7eb;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --radius: 8px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111827;
        --surface: #1f2937;
        --text: #f9fafb;
        --text-muted: #9ca3af;
        --border: #374151;
        --primary: #3b82f6;
        --primary-hover: #60a5fa;
      }
    }
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      background-color: var(--bg);
      color: var(--text);
      max-width: 600px; 
      margin: 60px auto; 
      padding: 0 20px; 
      line-height: 1.5;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 32px;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    }
    h1 { margin-top: 0; font-size: 1.5rem; font-weight: 600; }
    p.desc { color: var(--text-muted); margin-bottom: 24px; font-size: 0.95rem; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 6px; font-weight: 500; font-size: 0.9rem; }
    input { 
      width: 100%; 
      padding: 10px 12px; 
      border: 1px solid var(--border);
      background-color: var(--surface);
      color: var(--text);
      border-radius: 6px;
      box-sizing: border-box; 
      font-family: inherit;
      font-size: 0.95rem;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }
    @media (prefers-color-scheme: dark) {
      input:focus { box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2); }
    }
    button { 
      width: 100%;
      padding: 12px; 
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer; 
      transition: background-color 0.2s;
    }
    button:hover:not(:disabled) { background: var(--primary-hover); }
    button:disabled { opacity: 0.7; cursor: not-allowed; }
    h2 { font-size: 1.1rem; margin-top: 32px; margin-bottom: 12px; font-weight: 600; }
    pre { 
      background: #1f2937; 
      color: #e5e7eb;
      padding: 16px; 
      border-radius: var(--radius);
      overflow-x: auto; 
      min-height: 50px; 
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.85rem;
      line-height: 1.4;
    }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Trigger Drive Organization</h1>
    <p class="desc">Manually trigger the organization process for a given user.</p>
    <form id="adminForm">
      <div class="form-group">
        <label for="apiKey">API Key</label>
        <input type="password" id="apiKey" required>
      </div>
      <div class="form-group">
        <label for="userEmailOrUid">User Email or UID</label>
        <input type="text" id="userEmailOrUid" placeholder="e.g. user@example.com" required>
      </div>
      <button type="submit" id="submitBtn">Run Organization</button>
    </form>
    
    <div id="responseContainer" class="hidden">
      <h2>Response</h2>
      <pre id="responseArea"></pre>
    </div>
  </div>

  <script>
    document.getElementById('adminForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const apiKey = document.getElementById('apiKey').value;
      const emailOrUid = document.getElementById('userEmailOrUid').value.trim();
      const submitBtn = document.getElementById('submitBtn');
      const responseContainer = document.getElementById('responseContainer');
      const responseArea = document.getElementById('responseArea');
      
      submitBtn.disabled = true;
      submitBtn.textContent = 'Processing...';
      responseContainer.classList.remove('hidden');
      responseArea.textContent = 'Loading...';
      
      const payload = emailOrUid.includes('@') ? { email: emailOrUid } : { uid: emailOrUid };
      
      try {
        const res = await fetch('', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': apiKey
          },
          body: JSON.stringify(payload)
        });
        
        let data;
        try {
          data = await res.json();
        } catch (err) {
          data = await res.text();
        }
        
        responseArea.textContent = JSON.stringify(data, null, 2);
        if (!res.ok) {
          responseArea.textContent += '\\n\\nStatus: ' + res.status;
        }
      } catch (err) {
        responseArea.textContent = 'Error: ' + err.message;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Run Organization';
      }
    });
  </script>
</body>
</html>`;
        res.set("Content-Type", "text/html");
        res.status(200).send(adminFormHtml);
        return;
      }

      if (req.method !== "POST") {
        res.set("Allow", "GET, POST");
        res.status(405).json({error: "Method not allowed"});
        return;
      }

      const adminKey = req.get("x-admin-key");
      if (!adminKey || adminKey !== DRIVE_ADMIN_API_KEY.value()) {
        res.status(401).json({error: "Unauthorized"});
        return;
      }

      const body = req.body as {email?: string; uid?: string} | undefined;
      const requestedEmail = body?.email?.trim();
      let uid = body?.uid?.trim();

      if (!requestedEmail && !uid) {
        res.status(400).json({error: "Either email or uid is required"});
        return;
      }

      if (requestedEmail && !uid) {
        uid = await getUserFromEmail(requestedEmail) ?? undefined;
        if (!uid) {
          res.status(404).json({error: "User not found"});
          return;
        }
      }

      let userData;
      try {
        userData = await getUserFromUID(uid!, DRIVE_USERS_COLLECTION);
      } catch (_error) {
        res.status(404).json({error: "User not found"});
        return;
      }

      if (!userData.access_token || !hasFullDriveScope(userData.token_scope)) {
        res.status(403).json({error: "User does not have full drive scope"});
        return;
      }

      const emailId = `admin-organize-${Date.now()}`;
      const generatingProposal = await findGeneratingProposal(uid!, emailId);
      if (generatingProposal) {
        res.status(409).json({error: "Proposal already generating"});
        return;
      }

      const syntheticEmail: TransformedEmail = {
        subject: "Admin: Organize Drive",
        text: "",
        html: "",
        from: userData.email,
        to: [AGENT_EMAIL_ADDRESS.value()],
        headers: {},
        SPF: "pass",
        dkim: "pass",
      };

      const result = await scanAndPropose(
          syntheticEmail,
          userData.email,
          emailId,
          uid!,
      );
      res.status(200).json(result);
    },
);

export const v2driveOrganizeActionTask = onTaskDispatched(
    driveDispatchConfig,
    withErrorTracking("drive", async (req): Promise<void> => {
      await handleOrganizeActionTask(req.data as OrganizeActionTaskData);
    }),
);

export const v2driveOrganizeChunkTask = onTaskDispatched(
    driveDispatchConfig,
    withErrorTracking("drive", async (req): Promise<void> => {
      await handleOrganizeChunkTask(req.data as OrganizeChunkTaskData);
    }),
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

export const v2cleanupStuckOrganizeProposals = onSchedule(
    {
      schedule: "every 15 minutes",
      timeZone: "UTC",
      memory: "512MiB",
    },
    async () => {
      const result = await cleanupStuckOrganizeProposals();
      logger.info("Drive organize cleanup complete", result);
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
          AGENT_EMAIL_ADDRESS.value(), DRIVE_RESEND_SIGNING_SECRET.value(),
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
      await oauthCronJob(AGENT_NAME);
    },
);
