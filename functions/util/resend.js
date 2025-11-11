/* eslint-disable require-jsdoc */

const {Resend} = require("resend");
const {logger} = require("firebase-functions");
const {RESEND_API_KEY, ENVIRONMENT_NAME} = require("./config");
const {getMockResendClient} = require("./resendMock");

let resend = null;

/**
 * Initialize Resend client (lazy initialization)
 * @return {Resend} Resend client or mock
 */
function getResendClient() {
  // Use mock client in test/local mode (same as index.js)
  const isTestMode = ENVIRONMENT_NAME.value() === "local" ||
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
  return resend;
}

/**
 * Send email via Resend
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email address
 * @param {string} options.from - Sender email address
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Plain text content
 * @param {string} options.html - HTML content
 * @param {Object} options.headers - Optional headers for threading
 * @return {Promise<Object>} Response from Resend API
 */
async function sendEmailResend({to, from, subject, text, html, headers = {}}) {
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
