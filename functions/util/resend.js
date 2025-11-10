const {Resend} = require("resend");
const {logger} = require("firebase-functions");
const {RESEND_API_KEY, ENVIRONMENT_NAME} = require("./config");

let resend = null;

/**
 * Initialize Resend client (lazy initialization)
 */
function getResendClient() {
  if (!resend) {
    const apiKey = RESEND_API_KEY.value();
    if (!apiKey) {
      logger.warn("Resend API key not configured");
      return null;
    }
    resend = new Resend(apiKey);
  }
  return resend;
}

/**
 * Send email via Resend
 * @param {string} to - Recipient email address
 * @param {string} from - Sender email address
 * @param {string} subject - Email subject
 * @param {string} text - Plain text content
 * @param {string} html - HTML content
 * @param {Object} headers - Optional headers for threading
 * @return {Promise<Object>} Response from Resend API
 */
async function sendEmailResend(to, from, subject, text, html, headers = {}) {
  // Skip sending in non-production environments
  if (ENVIRONMENT_NAME.value() !== "production") {
    logger.info("Skipping email send in non-production environment", {
      to,
      from,
      subject,
      environment: ENVIRONMENT_NAME.value(),
    });
    return {success: true, skipped: true};
  }

  try {
    const client = getResendClient();
    if (!client) {
      throw new Error("Resend client not initialized");
    }

    const message = {
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
    });

    const response = await client.emails.send(message);

    logger.info("Email sent successfully via Resend", {
      id: response.id,
      to,
      from,
      subject,
    });

    return response;
  } catch (error) {
    logger.error("Failed to send email via Resend", {
      error: error.message,
      to,
      from,
      subject,
    });
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

module.exports = sendEmailResend;