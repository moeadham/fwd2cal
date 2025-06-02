const {logger} = require("firebase-functions");
const functions = require("firebase-functions");
const mailgun = require("./mailgun");
const sendgrid = require("./sendgrid");

/**
 * Test email endpoint that sends emails via SendGrid or Mailgun
 * Requires admin_api_key for authentication
 */
async function testEmailHandler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  // Verify admin API key
  const adminApiKey = functions.config().environment.admin_api_key;
  const providedKey = req.headers.authorization || req.body.admin_api_key;
  
  if (!adminApiKey || providedKey !== adminApiKey) {
    res.status(401).json({error: "Unauthorized"});
    return;
  }

  const {service} = req.body;
  
  if (!service || (service !== "sendgrid" && service !== "mailgun")) {
    res.status(400).json({error: "service must be 'sendgrid' or 'mailgun'"});
    return;
  }

  const emailData = {
    to: "test-0gillx3jc@srv1.mail-tester.com",
    from: "calendar@fwd2cal.com",
    subject: `Test Email via ${service}`,
    text: `This is a test email sent via ${service} at ${new Date().toISOString()}`,
    html: `
      <html>
        <body>
          <h1>Test Email</h1>
          <p>This is a test email sent via <strong>${service}</strong></p>
          <p>Timestamp: ${new Date().toISOString()}</p>
          <p>This email is being sent to test email deliverability.</p>
        </body>
      </html>
    `
  };

  try {
    if (service === "sendgrid") {
      await sendgrid.sendEmail(emailData);
      logger.log("Test email sent successfully via SendGrid");
      res.json({success: true, service: "sendgrid", message: "Email sent successfully"});
    } else if (service === "mailgun") {
      await mailgun.sendEmail(emailData);
      logger.log("Test email sent successfully via Mailgun");
      res.json({success: true, service: "mailgun", message: "Email sent successfully"});
    }
  } catch (error) {
    logger.error(`Error sending test email via ${service}:`, error);
    res.status(500).json({error: `Failed to send email via ${service}`, details: error.message});
  }
}

module.exports = {testEmailHandler};