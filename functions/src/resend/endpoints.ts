import {logger} from "firebase-functions/v2";
import {onRequest, HttpsOptions} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFunctions} from "firebase-admin/functions";
import {Resend} from "resend";

import {
  ENVIRONMENT_NAME,
  MAIN_EMAIL_ADDRESS,
  DRIVE_EMAIL_ADDRESS,
  RESEND_API_KEY,
  RESEND_SIGNING_SECRET,
} from "../util/config";
import {
  ResendWebhookData,
  TaskDispatchOptions,
  ResendClient,
} from "../util/types";
import {getMockResendClient, setMockData} from "../util/resendMock";
import {oauthCronJob} from "../auth/authHandler";

// Global configuration for onRequest functions
const onRequestConfig: HttpsOptions = {
  cors: true,
  memory: "512MiB",
  timeoutSeconds: 540,
};

// ============================================================================
// SHARED INBOUND WEBHOOK (routes to calendar or drive dispatch)
// ============================================================================

export const v2resendInboundCallback = onRequest(
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
        const resend: ResendClient = isTestMode ?
        getMockResendClient() :
        (new Resend(RESEND_API_KEY.value()) as unknown as ResendClient);

        // In test mode, set up mock data from the request
        if (isTestMode && req.body.mockData) {
          const emailId = req.body.data.email_id;
          setMockData(
              emailId,
              req.body.mockData.emailContent,
              req.body.mockData.attachmentsList || [],
          );
        }

        // Verify webhook signature
        const signature = req.headers["svix-signature"] as string;
        const svixId = req.headers["svix-id"] as string;
        const svixTimestamp = req.headers["svix-timestamp"] as string;

        if (!signature || !svixId || !svixTimestamp) {
          logger.error("Missing Resend webhook headers");
          res.status(401).json({error: "Unauthorized"});
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
          res.status(401).json({error: "Invalid signature"});
          return;
        }

        // Extract email data from webhook
        const webhookData: ResendWebhookData = req.body;

        // Only process email.received events
        if (webhookData.type !== "email.received") {
          logger.info("Ignoring non-email.received event", {
            type: webhookData.type,
          });
          res.status(200).json({message: "ok"});
          return;
        }

        // Route emails based on recipient address
        const recipients = webhookData.data.to || [];
        const mainEmail = MAIN_EMAIL_ADDRESS.value();
        const driveEmail = DRIVE_EMAIL_ADDRESS.value();

        const isCalendarEmail = recipients.some(
            (addr: string) => addr.toLowerCase() === mainEmail.toLowerCase(),
        );
        const isDriveEmail = recipients.some(
            (addr: string) => addr.toLowerCase() === driveEmail.toLowerCase(),
        );

        if (isCalendarEmail) {
          await dispatchTask({
            functionName: "v2resendInboundDispatch",
            data: webhookData,
          });
          res.status(200).json({message: "thanks", webhookData});
        } else if (isDriveEmail) {
          await dispatchTask({
            functionName: "v2driveInboundDispatch",
            data: webhookData,
          });
          res.status(200).json({message: "thanks", webhookData});
        } else {
          logger.log(
              "Email not for this environment." +
              ` Recipients: ${recipients.join(", ")},` +
              ` Expected: ${mainEmail} or ${driveEmail}`,
          );
          res.status(200).json({
            message: "Email not for this environment, skipping",
          });
        }
      } catch (error) {
        const err = error as Error;
        logger.error("Error processing Resend webhook", {error: err.message});
        res.status(200).json({
          message: "Something went wrong, but we're not going to tell you what.",
        });
      }
    },
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
          `locations/${location}/functions/${functionName}`,
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

// ============================================================================
// SHARED SCHEDULED TASKS
// ============================================================================

export const v2refreshTokensScheduled = onSchedule(
    {
      schedule: "0 * * * *",
      timeZone: "America/New_York",
      memory: "512MiB",
    },
    async (_context) => {
      await oauthCronJob();
    },
);
