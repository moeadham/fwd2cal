/* eslint-disable require-jsdoc */

const {Resend} = require("resend");
const {logger} = require("firebase-functions");
const {RESEND_API_KEY, ENVIRONMENT_NAME} = require("./config");
const {getMockResendClient} = require("./resendMock");
const {sendEvent} = require("./analytics");

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

    // Log client type for debugging
    const isTestMode = ENVIRONMENT_NAME.value() === "local" ||
        ENVIRONMENT_NAME.value() === "test";
    logger.info("Resend client info", {
      clientType: isTestMode ? "MOCK" : "REAL",
      environment: ENVIRONMENT_NAME.value(),
      hasApiKey: !!RESEND_API_KEY.value(),
    });

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
      sendEvent("email_service", "emailSendFailed",
          {reason: "resend_api_error"});
      /* eslint-disable-next-line max-len */
      throw new Error(`Resend API error: ${response.error.message || JSON.stringify(response.error)}`);
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
    logger.error("Failed to send email via Resend", {
      error: error.message,
      errorStack: error.stack,
      to,
      from,
      subject,
    });
    sendEvent("email_service", "emailSendFailed", {reason: "exception"});
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Add contact to Resend contacts list
 * Fails silently - no error throwing
 * @param {string} email - Email address to add
 */
function addContactToResend(email) {
  const client = getResendClient();
  if (!client) return;

  client.contacts.create({
    email: email,
    unsubscribed: false,
  }).catch((error) => {
    logger.warn("Failed to add contact to Resend",
        {email, error: error.message});
  });
}

/**
 * Add contact to a Resend segment
 * Fails silently - no error throwing
 * @param {string} email - Email address to add
 * @param {string} segmentId - Resend segment ID
 */
function addContactToSegment(email, segmentId) {
  const client = getResendClient();
  if (!client) return;

  client.contacts.segments.add({
    email: email,
    segmentId: segmentId,
  }).catch((error) => {
    logger.warn("Failed to add contact to segment",
        {email, segmentId, error: error.message});
  });
}

/**
 * Remove contact from a Resend segment
 * Fails silently - no error throwing
 * @param {string} email - Email address to remove
 * @param {string} segmentId - Resend segment ID
 */
function removeContactFromSegment(email, segmentId) {
  const client = getResendClient();
  if (!client) return;

  client.contacts.segments.remove({
    email: email,
    segmentId: segmentId,
  }).catch((error) => {
    logger.warn("Failed to remove contact from segment",
        {email, segmentId, error: error.message});
  });
}

module.exports = {
  sendEmailResend,
  addContactToResend,
  addContactToSegment,
  removeContactFromSegment,
};
