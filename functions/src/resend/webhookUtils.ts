import {logger} from "firebase-functions/v2";
import {getFunctions} from "firebase-admin/functions";
import {Resend} from "resend";
import {Request, Response} from "express";

import {
  ENVIRONMENT_NAME,
  RESEND_API_KEY,
} from "../util/config";
import {
  ResendWebhookData,
  TaskDispatchOptions,
  ResendClient,
} from "../util/types";
import {getMockResendClient, setMockData} from "../util/resendMock";

const BLOCKED_SENDER_PREFIXES = ["noreply@", "no-reply@", "mailer-daemon@", "info@"];
const BLOCKED_SENDERS = new Set([
  "calendar-notification@google.com",
  "calendar-noreply@google.com",
]);
const BLOCKED_SUBJECT_PATTERNS = [
  /^out of office/i,
  /^automatic reply/i,
  /^auto[- ]?reply/i,
  /^away from (the )?office/i,
  /\bauto[- ]?response\b/i,
  /^undeliverable:/i,
  /^mail delivery failed/i,
  /^delivery status notification/i,
  /^returned mail/i,
];

function isAutomatedSender(from: string): boolean {
  const sender = from.toLowerCase();
  if (BLOCKED_SENDERS.has(sender)) return true;
  return BLOCKED_SENDER_PREFIXES.some((prefix) => sender.startsWith(prefix));
}

function isAutomatedSubject(subject: string): boolean {
  return BLOCKED_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject));
}

/**
 * Shared helper: verifies a Resend inbound webhook request (signature, event
 * type) and dispatches validated email.received events to the given Cloud Task.
 */
export async function processInboundWebhook(
    req: Request,
    res: Response,
    dispatchFunctionName: string,
    expectedRecipient: string,
    signingSecret: string,
): Promise<void> {
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
      webhookSecret: signingSecret,
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

    // Verify the email is addressed to the expected recipient
    const recipients = webhookData.data.to || [];
    const isForUs = recipients.some(
        (addr) => addr.toLowerCase() === expectedRecipient.toLowerCase(),
    );
    if (!isForUs) {
      logger.log(
          "Email not for this environment." +
          ` Recipients: ${recipients.join(", ")},` +
          ` Expected: ${expectedRecipient}`,
      );
      res.status(200).json({
        message: "Email not for this environment, skipping",
      });
      return;
    }

    const sender = webhookData.data.from;
    if (isAutomatedSender(sender)) {
      logger.log(`Ignoring automated sender: ${sender}`);
      res.status(200).json({
        message: "Automated sender, skipping",
      });
      return;
    }

    const subject = webhookData.data.subject || "";
    if (isAutomatedSubject(subject)) {
      logger.log(`Ignoring automated subject: ${subject}`);
      res.status(200).json({
        message: "Automated reply, skipping",
      });
      return;
    }

    await dispatchTask({
      functionName: dispatchFunctionName,
      data: webhookData,
    });
    res.status(200).json({message: "thanks", webhookData});
  } catch (error) {
    const err = error as Error;
    logger.error("Error processing Resend webhook", {error: err.message});
    res.status(200).json({
      message: "Something went wrong, but we're not going to tell you what.",
    });
  }
}

export async function dispatchTask({
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
