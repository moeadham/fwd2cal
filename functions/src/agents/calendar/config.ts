import {defineString} from "firebase-functions/params";
import {AgentName} from "../../auth/types";

export const AGENT_NAME: AgentName = "calendar";

export const RESEND_SIGNING_SECRET = defineString("RESEND_SIGNING_SECRET");
