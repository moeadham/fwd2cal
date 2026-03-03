/**
 * Firebase Functions v2 Configuration — Shared
 *
 * Agent-specific config lives in agents/<name>/config.ts
 * Export params directly - call .value() only inside function handlers
 */

import {defineString} from "firebase-functions/params";

const AGENT_NAME = defineString("AGENT_NAME", {
  default: "calendar",
});

const ENVIRONMENT_NAME = defineString("ENVIRONMENT_NAME", {
  default: "production",
});

const OPENROUTER_API_KEY = defineString("OPENROUTER_API_KEY");
const POSTHOG_API_KEY = defineString("POSTHOG_API_KEY");
const RESEND_API_KEY = defineString("RESEND_API_KEY");
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

/**
 * Returns the hosting base URL for the current environment.
 * Must be called inside a function handler.
 */
function getHostingBaseUrl(): string {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    return "http://localhost:5002";
  }
  if (process.env.GCLOUD_PROJECT === "fwd2cal-dev-2578e") {
    return "https://fwd2cal-dev-2578e.web.app";
  }
  return "https://app.fwd2cal.com";
}

export {
  AGENT_NAME,
  ENVIRONMENT_NAME,
  OPENROUTER_API_KEY,
  POSTHOG_API_KEY,
  MAIN_EMAIL_ADDRESS,
  RESEND_API_KEY,
  RESEND_REGISTERED_USERS_SEGMENT_ID,
  SKILL_CONFIDENCE_THRESHOLD,
  SKILL_BODY_EXCERPT_LENGTH,
  DEFAULT_EVENT_LENGTH_MINUTES,
  MAX_CHARS_PER_DOCUMENT,
  MAX_TOTAL_DOCUMENT_CHARS,
  MAX_CHARS_PER_SHEET,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_DOCUMENT_BYTES,
  getSupportEmail,
  getAdminEmail,
  getHostingBaseUrl,
};
