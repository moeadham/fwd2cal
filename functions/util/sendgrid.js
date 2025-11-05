const sgMail = require("@sendgrid/mail");
const {logger} = require("firebase-functions");
const {SENDGRID_API_KEY, ENVIRONMENT_NAME} = require("./config");

// Lazy initialization of SendGrid
let sgInitialized = false;
const initSendGrid = () => {
  if (!sgInitialized) {
    const apiKey = SENDGRID_API_KEY.value();
    if (apiKey) {
      sgMail.setApiKey(apiKey);
      sgInitialized = true;
    } else {
      logger.warn("SendGrid API key not configured");
    }
  }
};

/**
 * Sends an email using SendGrid.
 * @param {string} to The recipient's email address.
 * @param {string} from The sender's email address.
 * @param {string} subject The subject of the email.
 * @param {string} text The plain text content of the email.
 * @param {string} html The HTML content of the email (optional).
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
    text: html,
    html,
  };
  if (headers.References) {
    msg.headers = headers;
  }
  try {
    if (ENVIRONMENT_NAME.value() === "production") {
      initSendGrid(); // Initialize SendGrid if not already done
      if (sgInitialized) {
        await sgMail.send(msg);
        logger.log("Email sent successfully");
      }
    } else {
      logger.log("Email not sent. ENVIRONMENT is not production.");
    }
  } catch (error) {
    logger.warn("Error sending email:", error);
    if (error.response) {
      logger.warn(error.response.body);
    }
  }
}

module.exports = {sendEmail};
