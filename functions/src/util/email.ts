import {logger} from "firebase-functions/v2";
import {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_EMAIL_API_TOKEN,
  ENVIRONMENT_NAME,
  OUTBOUND_EMAIL_PROVIDER,
} from "./config";
import {sendEvent} from "./analytics";
import {recordMockSentEmail} from "./emailMock";
import {sendEmailResend} from "./resend";
import {
  CloudflareEmailResult,
  OutboundEmailAttachment,
  ResendAPIResponse,
  SendEmailOptions,
} from "./types";

const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
};

interface CloudflareApiError {
  code: number;
  message: string;
}

interface CloudflareApiResponse {
  success: boolean;
  errors?: CloudflareApiError[];
  messages?: CloudflareApiError[];
  result?: CloudflareEmailResult;
}

interface CloudflareAttachment {
  content: string;
  filename: string;
  type: string;
  disposition: "attachment";
}

class CloudflareEmailError extends Error {
  constructor(
      message: string,
      readonly status: number,
      readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CloudflareEmailError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTestMode(): boolean {
  return ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
}

function htmlToPlainText(html: string): string {
  return html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
}

function toCloudflareAttachment(
    attachment: OutboundEmailAttachment,
): CloudflareAttachment {
  return {
    content: Buffer.isBuffer(attachment.content) ?
      attachment.content.toString("base64") :
      attachment.content,
    filename: attachment.filename,
    type: attachment.content_type || "application/octet-stream",
    disposition: "attachment",
  };
}

function getApiErrorMessage(
    response: CloudflareApiResponse,
    status: number,
): string {
  const errors = response.errors || [];
  if (errors.length === 0) {
    return `Cloudflare Email API request failed with status ${status}`;
  }
  return errors.map((error) => `${error.code}: ${error.message}`).join(", ");
}

function validateDelivery(result: CloudflareEmailResult): void {
  const failed = [
    ...result.permanent_bounces,
    ...(result.suppressed_recipients || []),
  ];
  if (failed.length > 0) {
    throw new CloudflareEmailError(
        `Cloudflare rejected ${failed.length} recipient(s)`,
        200,
        false,
    );
  }
  if (result.delivered.length === 0 && result.queued.length === 0) {
    throw new CloudflareEmailError(
        "Cloudflare did not accept any recipients",
        200,
        false,
    );
  }
}

async function sendEmailCloudflare({
  to,
  from,
  subject,
  text,
  html,
  headers = {},
  attachments,
}: SendEmailOptions): Promise<CloudflareEmailResult> {
  const accountId = CLOUDFLARE_ACCOUNT_ID.value();
  const apiToken = CLOUDFLARE_EMAIL_API_TOKEN.value();
  if (!accountId || !apiToken) {
    throw new Error("Cloudflare Email API credentials are not configured");
  }

  const payload = {
    to,
    from,
    subject,
    text: text || htmlToPlainText(html),
    html,
    headers,
    attachments: attachments?.map(toCloudflareAttachment),
  };
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" +
    `${encodeURIComponent(accountId)}/email/sending/send`;

  logger.info("Sending email via Cloudflare Email Service", {
    from,
    subject,
    hasHeaders: Object.keys(headers).length > 0,
    hasAttachments: !!attachments?.length,
    textLength: payload.text.length,
    htmlLength: html.length,
  });

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.min(
          RETRY_CONFIG.initialDelayMs * Math.pow(2, attempt - 1),
          RETRY_CONFIG.maxDelayMs,
      );
      logger.info("Retrying Cloudflare Email API call", {
        attempt,
        delayMs,
        subject,
      });
      await sleep(delayMs);
    }

    try {
      const httpResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      const response = await httpResponse.json() as CloudflareApiResponse;

      if (!httpResponse.ok || !response.success || !response.result) {
        const retryable = httpResponse.status === 429 ||
          httpResponse.status >= 500;
        throw new CloudflareEmailError(
            getApiErrorMessage(response, httpResponse.status),
            httpResponse.status,
            retryable,
        );
      }

      validateDelivery(response.result);
      logger.info("Email accepted by Cloudflare Email Service", {
        attempt,
        messageId: response.result.message_id,
        deliveredCount: response.result.delivered.length,
        queuedCount: response.result.queued.length,
      });
      return response.result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = !(error instanceof CloudflareEmailError) ||
        error.retryable;
      const exhausted = attempt === RETRY_CONFIG.maxRetries;
      logger.warn("Cloudflare Email API call failed", {
        attempt,
        maxRetries: RETRY_CONFIG.maxRetries,
        retryable,
        error: lastError.message,
      });
      if (!retryable || exhausted) break;
    }
  }

  sendEvent("email_service", "emailSendFailed", "system", {
    reason: "cloudflare_api_error",
  });
  logger.error("Failed to send email via Cloudflare Email Service", {
    error: lastError?.message,
    from,
    subject,
  });
  throw new Error(`Failed to send email: ${lastError?.message || "Unknown error"}`);
}

async function sendEmail(
    options: SendEmailOptions,
): Promise<CloudflareEmailResult | ResendAPIResponse> {
  if (isTestMode()) {
    recordMockSentEmail({
      ...options,
      text: options.text || htmlToPlainText(options.html),
    });
    return {
      delivered: [options.to],
      queued: [],
      permanent_bounces: [],
      message_id: `mock-email-${Date.now()}`,
    };
  }

  const provider = OUTBOUND_EMAIL_PROVIDER.value().trim().toLowerCase();
  logger.info("Selected outbound email provider", {provider});
  if (provider === "cloudflare") return sendEmailCloudflare(options);
  if (provider === "resend") return sendEmailResend(options);
  throw new Error(`Unsupported outbound email provider: ${provider}`);
}

export {sendEmail, sendEmailCloudflare, htmlToPlainText};
