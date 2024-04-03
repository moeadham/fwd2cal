const sgMail = require("@sendgrid/mail");
const {logger} = require("firebase-functions");
const {SENDGRID_API_KEY} = require("./credentials");

// Setting SendGrid API Key
sgMail.setApiKey(SENDGRID_API_KEY);

/**
 * Sends an email using SendGrid.
 * @param {string} to The recipient's email address.
 * @param {string} from The sender's email address.
 * @param {string} subject The subject of the email.
 * @param {string} text The plain text content of the email.
 * @param {string} html The HTML content of the email (optional).
 * @return {Promise<void>} A promise that resolves when the email is sent.
 */
async function sendEmail({to, from, subject, text, html = ""}) {
  const msg = {
    to,
    from,
    subject,
    text,
    html,
  };

  try {
    await sgMail.send(msg);
    logger.log("Email sent successfully");
  } catch (error) {
    logger.error("Error sending email:", error);
    if (error.response) {
      logger.error(error.response.body);
    }
    throw error; // Rethrow after logging
  }
}

module.exports = {sendEmail};
