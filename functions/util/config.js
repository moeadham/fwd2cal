/**
 * Firebase Functions v2 Configuration
 *
 * Export params directly - call .value() only inside function handlers
 */

const {defineString} = require("firebase-functions/params");

const ENVIRONMENT_NAME = defineString("ENVIRONMENT_NAME", {
  default: "production",
});

const OPENROUTER_API_KEY = defineString("OPENROUTER_API_KEY");
const POSTHOG_API_KEY = defineString("POSTHOG_API_KEY");
const RESEND_API_KEY = defineString("RESEND_API_KEY");
const RESEND_SIGNING_SECRET = defineString("RESEND_SIGNING_SECRET");
const RESEND_REGISTERED_USERS_SEGMENT_ID =
  defineString("RESEND_REGISTERED_USERS_SEGMENT_ID");

// Additional constants that don't change
const MAIN_EMAIL_ADDRESS = "calendar@fwd2cal.com";

module.exports = {
  ENVIRONMENT_NAME,
  OPENROUTER_API_KEY,
  POSTHOG_API_KEY,
  MAIN_EMAIL_ADDRESS,
  RESEND_API_KEY,
  RESEND_SIGNING_SECRET,
  RESEND_REGISTERED_USERS_SEGMENT_ID,
};
