import {defineString, defineInt} from "firebase-functions/params";
import {AgentName} from "../../auth/types";

export const AGENT_NAME: AgentName = "drive";

export const AGENT_HOSTING_URL = defineString("DRIVE_AGENT_HOSTING_URL", {
  default: "https://app.fwd2drive.com",
});

export const DRIVE_RESEND_SIGNING_SECRET = defineString("DRIVE_RESEND_SIGNING_SECRET");

export const AGENT_EMAIL_ADDRESS = defineString("DRIVE_EMAIL_ADDRESS", {
  default: "drive@fwd2drive.com",
});

export const DRIVE_USER_EMAIL = defineString("DRIVE_USER_EMAIL", {
  default: "drive@fwd2drive.com",
});

export const MAX_DRIVE_UPLOAD_BYTES = defineInt("MAX_DRIVE_UPLOAD_BYTES", {
  default: 26214400, // 25MB
});

export const DRIVE_ACTION_SIGNING_KEY = defineString("DRIVE_ACTION_SIGNING_KEY");

export const DRIVE_ADMIN_API_KEY = defineString("DRIVE_ADMIN_API_KEY");

export const DRIVE_ADMIN_TEST_EMAIL = defineString("DRIVE_ADMIN_TEST_EMAIL", {
  default: "jjacarillo@gmail.com",
});

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

export const ORGANIZE_DRIVE_FULL_LISTING_THRESHOLD = defineInt(
    "ORGANIZE_DRIVE_FULL_LISTING_THRESHOLD", {
      default: 500,
    },
);


export const REFINE_ORGANIZATION_MODEL = defineString(
    "REFINE_ORGANIZATION_MODEL", {
      default: "openai/gpt-4.1",
    },
);

export const ORGANIZE_DRIVE_REFINE_TREE_PER_CHUNK = defineString(
    "ORGANIZE_DRIVE_REFINE_TREE_PER_CHUNK", {
      default: "false",
    },
);

export const REFINE_TREE_PER_CHUNK_MODEL = defineString(
    "REFINE_TREE_PER_CHUNK_MODEL", {
      default: "openai/o4-mini",
    },
);

export const ORGANIZE_DRIVE_CHUNK_SIZE = defineInt(
    "ORGANIZE_DRIVE_CHUNK_SIZE", {
      default: 30,
    },
);

export const ORGANIZE_DRIVE_MAX_FILE_ACTIONS = defineInt(
    "ORGANIZE_DRIVE_MAX_FILE_ACTIONS", {
      default: 200,
    },
);

export const ORGANIZE_DRIVE_PLAN_CONCURRENCY = defineInt(
    "ORGANIZE_DRIVE_PLAN_CONCURRENCY", {
      default: 8,
    },
);

/* eslint-disable max-len */
export const ORGANIZE_PROMO_HTML = "<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href=\"mailto:drive@fwd2drive.com\">drive@fwd2drive.com</a>.";
