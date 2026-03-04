import {defineString} from "firebase-functions/params";
import {AgentName} from "../../auth/types";

export const AGENT_NAME: AgentName = "calendar";

export const AGENT_HOSTING_URL = defineString("CALENDAR_AGENT_HOSTING_URL", {
  default: "https://app.fwd2cal.com",
});

export const AGENT_EMAIL_ADDRESS = defineString("CALENDAR_EMAIL_ADDRESS", {
  default: "calendar@fwd2cal.com",
});

export const RESEND_SIGNING_SECRET = defineString("RESEND_SIGNING_SECRET");
