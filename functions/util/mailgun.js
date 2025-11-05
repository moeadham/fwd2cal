const Mailgun = require("mailgun.js");
const FormData = require("form-data");
const {logger} = require("firebase-functions");
const {MAILGUN_API_KEY, ENVIRONMENT_NAME} = require("./config");

// Lazy initialization of Mailgun client
let mg = null;
const getMailgunClient = () => {
  if (!mg) {
    const mailgun = new Mailgun(FormData);
    const apiKey = MAILGUN_API_KEY.value();
    if (!apiKey) {
      logger.warn("Mailgun API key not configured");
      return null;
    }
    mg = mailgun.client({username: "api", key: apiKey});
  }
  return mg;
};

/**
 * Sends an email using Mailgun.
 * @param {string} to The recipient's email address.
 * @param {string} from The sender's email address.
 * @param {string} subject The subject of the email.
 * @param {string} text The plain text content of the email.
 * @param {string} html The HTML content of the email (optional).
 * @param {Object} headers Additional headers (optional).
 * @return {Promise<void>} A promise that resolves when the email is sent.
 */
async function sendEmail({to, from, subject, text, html = "", headers = {}}) {
  if (!subject) {
    subject = "fwd2cal";
  }

  const msg = {
    to,
    from,
    subject,
    text: html || text,
    html,
  };

  // Add custom headers if provided
  if (headers.References) {
    msg["h:References"] = headers.References;
  }

  try {
    if (ENVIRONMENT_NAME.value() === "production") {
      const mgClient = getMailgunClient();
      if (!mgClient) {
        logger.warn("Mailgun client not initialized - API key missing");
        return;
      }
      // Extract domain from sender email for Mailgun domain
      const domain = from.split("@")[1] || "fwd2cal.com";
      logger.log(`Attempting to send via Mailgun using domain: ${domain}`);
      logger.log(`Message to: ${to}, from: ${from}, subject: ${subject}`);
      await mgClient.messages.create(domain, msg);
      logger.log("Email sent successfully via Mailgun");
    } else {
      logger.log("Email not sent. ENVIRONMENT is not production.");
    }
  } catch (error) {
    logger.warn("Error sending email via Mailgun:", error);
    if (error.response) {
      logger.warn(error.response.body);
    }
  }
}

module.exports = {sendEmail};
