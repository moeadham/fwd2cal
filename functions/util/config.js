/**
 * Firebase Functions v2 Configuration
 *
 * Export params directly - call .value() only inside function handlers
 */

const {defineString} = require("firebase-functions/params");

const ENVIRONMENT_NAME = defineString("ENVIRONMENT_NAME", {
  default: "production",
});

const OPENAI_API_KEY = defineString("OPENAI_API_KEY");
const MAILGUN_API_KEY = defineString("MAILGUN_API_KEY");
const SENDGRID_API_KEY = defineString("SENDGRID_API_KEY");
const SENTRY_DSN = defineString("SENTRY_DSN");
const GA_MEASUREMENT = defineString("GA_MEASUREMENT");
const GA_SECRET = defineString("GA_SECRET");

// Additional constants that don't change
const MAIN_EMAIL_ADDRESS = "calendar@fwd2cal.com";

module.exports = {
  ENVIRONMENT_NAME,
  OPENAI_API_KEY,
  MAILGUN_API_KEY,
  SENDGRID_API_KEY,
  SENTRY_DSN,
  GA_MEASUREMENT,
  GA_SECRET,
  MAIN_EMAIL_ADDRESS,
};
