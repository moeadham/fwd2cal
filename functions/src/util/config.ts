/**
 * Firebase Functions v2 Configuration
 *
 * Export params directly - call .value() only inside function handlers
 */

import {defineString, defineInt} from "firebase-functions/params";

const ENVIRONMENT_NAME = defineString("ENVIRONMENT_NAME", {
  default: "production",
});

const OPENROUTER_API_KEY = defineString("OPENROUTER_API_KEY");
const POSTHOG_API_KEY = defineString("POSTHOG_API_KEY");
const RESEND_API_KEY = defineString("RESEND_API_KEY");
const RESEND_SIGNING_SECRET = defineString("RESEND_SIGNING_SECRET");
const RESEND_REGISTERED_USERS_SEGMENT_ID = defineString(
    "RESEND_REGISTERED_USERS_SEGMENT_ID",
);


const MAIN_EMAIL_ADDRESS = defineString("MAIN_EMAIL_ADDRESS", {
  default: "calendar@fwd2cal.com",
});

const SKILL_CONFIDENCE_THRESHOLD = defineString("SKILL_CONFIDENCE_THRESHOLD", {
  default: "0.3",
});

const SKILL_BODY_EXCERPT_LENGTH = defineString("SKILL_BODY_EXCERPT_LENGTH", {
  default: "500",
});

const DEFAULT_EVENT_LENGTH_MINUTES = defineString("DEFAULT_EVENT_LENGTH_MINUTES", {
  default: "30",
});

const MAX_CHARS_PER_DOCUMENT = defineString("MAX_CHARS_PER_DOCUMENT", {
  default: "3000",
});

const MAX_TOTAL_DOCUMENT_CHARS = defineString("MAX_TOTAL_DOCUMENT_CHARS", {
  default: "8000",
});

const MAX_CHARS_PER_SHEET = defineString("MAX_CHARS_PER_SHEET", {
  default: "1500",
});

const MAX_ATTACHMENT_BYTES = defineString("MAX_ATTACHMENT_BYTES", {
  default: "10485760", // 10MB
});

const MAX_TOTAL_DOCUMENT_BYTES = defineString("MAX_TOTAL_DOCUMENT_BYTES", {
  default: "52428800", // 50MB
});

const DRIVE_EMAIL_ADDRESS = defineString("DRIVE_EMAIL_ADDRESS", {
  default: "drive@fwd2cal.com",
});

const MAX_DRIVE_UPLOAD_BYTES = defineInt("MAX_DRIVE_UPLOAD_BYTES", {
  default: 26214400, // 25MB
});

/**
 * Extracts the domain from an email address.
 * @param email - The email address (e.g., "calendar@fwd2cal.com")
 * @returns The domain part (e.g., "fwd2cal.com")
 */
function getEmailDomain(email: string): string {
  return email.split("@")[1];
}

/**
 * Gets the support email address derived from MAIN_EMAIL_ADDRESS domain.
 * Must be called inside a function handler.
 */
function getSupportEmail(): string {
  return `support@${getEmailDomain(MAIN_EMAIL_ADDRESS.value())}`;
}

/**
 * Gets the admin email address derived from MAIN_EMAIL_ADDRESS domain.
 * Must be called inside a function handler.
 */
function getAdminEmail(): string {
  return `admin@${getEmailDomain(MAIN_EMAIL_ADDRESS.value())}`;
}

const ORGANIZE_DRIVE_COST_PER_FILE = defineString("ORGANIZE_DRIVE_COST_PER_FILE", {
  default: "0.05",
});

const ORGANIZE_DRIVE_MAX_FILES = defineInt("ORGANIZE_DRIVE_MAX_FILES", {
  default: 5000,
});

const ORGANIZE_DRIVE_FULL_LISTING_THRESHOLD = defineInt(
    "ORGANIZE_DRIVE_FULL_LISTING_THRESHOLD", {
      default: 500,
    },
);

const ORGANIZE_DRIVE_MAX_PREVIEW_ROWS = defineInt(
    "ORGANIZE_DRIVE_MAX_PREVIEW_ROWS", {
      default: 20,
    },
);

const ORGANIZE_DRIVE_CHUNK_SIZE = defineInt(
    "ORGANIZE_DRIVE_CHUNK_SIZE", {
      default: 100,
    },
);

export {
  ENVIRONMENT_NAME,
  OPENROUTER_API_KEY,
  POSTHOG_API_KEY,
  MAIN_EMAIL_ADDRESS,
  RESEND_API_KEY,
  RESEND_SIGNING_SECRET,
  RESEND_REGISTERED_USERS_SEGMENT_ID,
  SKILL_CONFIDENCE_THRESHOLD,
  SKILL_BODY_EXCERPT_LENGTH,
  DEFAULT_EVENT_LENGTH_MINUTES,
  MAX_CHARS_PER_DOCUMENT,
  MAX_TOTAL_DOCUMENT_CHARS,
  MAX_CHARS_PER_SHEET,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_DOCUMENT_BYTES,
  DRIVE_EMAIL_ADDRESS,
  MAX_DRIVE_UPLOAD_BYTES,
  ORGANIZE_DRIVE_COST_PER_FILE,
  ORGANIZE_DRIVE_MAX_FILES,
  ORGANIZE_DRIVE_FULL_LISTING_THRESHOLD,
  ORGANIZE_DRIVE_MAX_PREVIEW_ROWS,
  ORGANIZE_DRIVE_CHUNK_SIZE,
  getSupportEmail,
  getAdminEmail,
};
