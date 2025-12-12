import { Resend } from "resend";
import { logger } from "firebase-functions/v2";
import { RESEND_API_KEY, ENVIRONMENT_NAME } from "./config";
import { getMockResendClient } from "./resendMock";
import { sendEvent } from "./analytics";
import { ResendEmailOptions, ResendAPIResponse, ResendClient } from "../types";

let resend: Resend | null = null;

/**
 * Initialize Resend client (lazy initialization)
 */
function getResendClient(): ResendClient | null {
  // Use mock client in test/local mode (same as index.js)
  const isTestMode =
    ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
  if (isTestMode) {
    return getMockResendClient(); // Returns singleton mock instance
  }

  // Production mode - use real Resend client
  if (!resend) {
    const apiKey = RESEND_API_KEY.value();
    if (!apiKey) {
      logger.warn("Resend API key not configured");
      return null;
    }
    resend = new Resend(apiKey);
  }
  return resend as unknown as ResendClient;
}

/**
 * Send email via Resend
 */
async function sendEmailResend({
  to,
  from,
  subject,
  text,
  html,
  headers = {},
}: ResendEmailOptions): Promise<ResendAPIResponse> {
  try {
    const client = getResendClient();
    if (!client) {
      throw new Error("Resend client not initialized");
    }

    // Log client type for debugging
    const isTestMode =
      ENVIRONMENT_NAME.value() === "local" ||
      ENVIRONMENT_NAME.value() === "test";
    logger.info("Resend client info", {
      clientType: isTestMode ? "MOCK" : "REAL",
      environment: ENVIRONMENT_NAME.value(),
      hasApiKey: !!RESEND_API_KEY.value(),
    });

    const message: {
      from: string;
      to: string;
      subject: string;
      text?: string;
      html: string;
      headers?: Record<string, string>;
    } = {
      from: from,
      to: to,
      subject: subject,
      text: text,
      html: html,
    };

    // Add threading headers if provided
    if (headers && Object.keys(headers).length > 0) {
      message.headers = headers;
    }

    logger.info("Sending email via Resend", {
      to,
      from,
      subject,
      hasHeaders: !!message.headers,
      textLength: text?.length || 0,
      htmlLength: html?.length || 0,
      messageKeys: Object.keys(message),
    });

    const response = await client.emails.send(message);

    // Log full response details
    logger.info("Raw Resend API response", {
      responseKeys: Object.keys(response || {}),
      responseId: response?.id || "MISSING",
      responseData: response?.data || "MISSING",
      fullResponse: JSON.stringify(response),
    });

    // Check if Resend returned an error
    // (they don't throw, they return {data, error})
    if (response.error) {
      logger.error("Resend API returned error", {
        error: response.error,
        to,
        from,
        subject,
      });
      sendEvent("email_service", "emailSendFailed", {
        reason: "resend_api_error",
      });
      throw new Error(
        `Resend API error: ${response.error.message || JSON.stringify(response.error)}`
      );
    }

    logger.info("Email sent successfully via Resend", {
      id: response.id || response.data?.id,
      to,
      from,
      subject,
      hasId: !!(response.id || response.data?.id),
    });

    return response;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error("Failed to send email via Resend", {
      error: errorMessage,
      errorStack: errorStack,
      to,
      from,
      subject,
    });
    sendEvent("email_service", "emailSendFailed", { reason: "exception" });
    throw new Error(`Failed to send email: ${errorMessage}`);
  }
}

/**
 * Add contact to Resend contacts list
 * Fails silently - no error throwing
 */
function addContactToResend(email: string): void {
  const client = getResendClient();
  if (!client) return;

  client.contacts
    .create({
      email: email,
      unsubscribed: false,
    })
    .catch((error: Error) => {
      logger.warn("Failed to add contact to Resend", {
        email,
        error: error.message,
      });
    });
}

/**
 * Add contact to a Resend segment
 * Fails silently - no error throwing
 */
function addContactToSegment(email: string, segmentId: string): void {
  const client = getResendClient();
  if (!client) return;

  client.contacts.segments
    .add({
      email: email,
      segmentId: segmentId,
    })
    .catch((error: Error) => {
      logger.warn("Failed to add contact to segment", {
        email,
        segmentId,
        error: error.message,
      });
    });
}

/**
 * Remove contact from a Resend segment
 * Fails silently - no error throwing
 */
function removeContactFromSegment(email: string, segmentId: string): void {
  const client = getResendClient();
  if (!client) return;

  client.contacts.segments
    .remove({
      email: email,
      segmentId: segmentId,
    })
    .catch((error: Error) => {
      logger.warn("Failed to remove contact from segment", {
        email,
        segmentId,
        error: error.message,
      });
    });
}

export {
  sendEmailResend,
  addContactToResend,
  addContactToSegment,
  removeContactFromSegment,
  getResendClient,
};
