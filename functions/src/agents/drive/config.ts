import {defineString, defineInt} from "firebase-functions/params";
import {AgentName} from "../../auth/types";

export const AGENT_NAME: AgentName = "drive";

export const DRIVE_RESEND_SIGNING_SECRET = defineString("DRIVE_RESEND_SIGNING_SECRET");

export const DRIVE_EMAIL_ADDRESS = defineString("DRIVE_EMAIL_ADDRESS", {
  default: "drive@fwd2drive.com",
});

export const MAX_DRIVE_UPLOAD_BYTES = defineInt("MAX_DRIVE_UPLOAD_BYTES", {
  default: 26214400, // 25MB
});

export const DRIVE_ACTION_SIGNING_KEY = defineString("DRIVE_ACTION_SIGNING_KEY");

export const ORGANIZE_DRIVE_TEXT_MAX_TOKENS = defineInt(
    "ORGANIZE_DRIVE_TEXT_MAX_TOKENS", {
      default: 1600, // max input tokens for a 2-page text document
    },
);

export const ORGANIZE_DRIVE_IMAGE_MAX_TOKENS = defineInt(
    "ORGANIZE_DRIVE_IMAGE_MAX_TOKENS", {
      default: 2805, // max input tokens for full-res image OCR (16 tiles × 170 + 85)
    },
);

export const ORGANIZE_DRIVE_COST_PER_M_INPUT_TOKENS = defineString(
    "ORGANIZE_DRIVE_COST_PER_M_INPUT_TOKENS", {
      default: "0.40", // gpt-4.1-mini input price per 1M tokens
    },
);

export const ORGANIZE_DRIVE_MAX_FILES = defineInt("ORGANIZE_DRIVE_MAX_FILES", {
  default: 5000,
});

export const ORGANIZE_DRIVE_FULL_LISTING_THRESHOLD = defineInt(
    "ORGANIZE_DRIVE_FULL_LISTING_THRESHOLD", {
      default: 500,
    },
);


export const ORGANIZE_DRIVE_CHUNK_SIZE = defineInt(
    "ORGANIZE_DRIVE_CHUNK_SIZE", {
      default: 100,
    },
);
