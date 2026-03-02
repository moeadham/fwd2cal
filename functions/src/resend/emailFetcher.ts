import {logger} from "firebase-functions/v2";
import {Resend} from "resend";

import {
  ENVIRONMENT_NAME,
  RESEND_API_KEY,
} from "../util/config";
import {
  TransformedEmail,
  ResendClient,
  ResendWebhookData,
  ResendEmailData,
} from "../util/types";
import {getMockResendClient, setMockData} from "../util/resendMock";
import {addContactToResend} from "../util/resend";

export class EmailFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailFetchError";
  }
}

export interface FetchedEmail {
  transformedEmail: TransformedEmail;
  emailData: ResendEmailData;
  resend: ResendClient;
}

/**
 * Initialize Resend client, set up mock data if in test mode,
 * fetch full email from Resend receiving API, extract SPF/DKIM,
 * and build a TransformedEmail.
 */
export async function fetchAndTransformEmail(
    webhookData: ResendWebhookData,
): Promise<FetchedEmail> {
  // eslint-disable-next-line camelcase
  const {email_id, from, to, subject, attachments} = webhookData.data;

  const isTestMode =
    ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
  const resend: ResendClient = isTestMode ?
    getMockResendClient() :
    (new Resend(RESEND_API_KEY.value()) as unknown as ResendClient);

  if (isTestMode && webhookData.mockData) {
    setMockData(
        email_id, // eslint-disable-line camelcase
        webhookData.mockData.emailContent,
        webhookData.mockData.attachmentsList || [],
    );
  }

  logger.info("Processing inbound email", {
    email_id, // eslint-disable-line camelcase
    from,
    to,
    subject,
    attachmentCount: attachments ? attachments.length : 0,
  });

  // Add sender to Resend contacts (fire-and-forget)
  addContactToResend(from);

  // Fetch full email content from Resend API
  let emailData;
  try {
    const {data, error} = await resend.emails.receiving.get(email_id);
    emailData = data;
    if (error) {
      logger.error("Failed to fetch email content from Resend", {
        error: error.message,
        email_id, // eslint-disable-line camelcase
      });
      throw new EmailFetchError("Failed to fetch email content");
    }
  } catch (emailError) {
    if (emailError instanceof EmailFetchError) throw emailError;
    const err = emailError as Error;
    logger.error("Failed to fetch email content from Resend", {
      error: err.message,
      email_id, // eslint-disable-line camelcase
    });
    throw new EmailFetchError("Failed to fetch email content");
  }

  // Extract SPF and DKIM results from authentication-results header
  const authResults = emailData.headers?.["authentication-results"] || "";
  const spfResult = authResults.includes("spf=pass") ? "pass" : "fail";
  const dkimResult = authResults.includes("dkim=pass") ?
    (authResults.match(/dkim=pass header\.i=(@[^\s;]+)/) || [
      null,
      "@unknown",
    ])[1] + " : pass" :
    "fail";

  // Transform Resend format to internal format
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

  return {transformedEmail, emailData, resend};
}
