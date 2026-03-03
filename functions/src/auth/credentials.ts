import fs from "fs";
import path from "path";
import {GoogleOAuthCredentials, AgentName} from "./types";
import {AGENT_NAME} from "../util/config";

const isDevProject = process.env.GCLOUD_PROJECT === "fwd2cal-dev-2578e";

const credentialsFileNames: Record<AgentName, string> = {
  calendar: isDevProject ?
    "v2-google-auth-credentials-fwd2cal-dev.json" :
    "v2-google-auth-credentials-fwd2cal.json",
  drive: isDevProject ?
    "v2-google-auth-credentials-drive2cal-dev.json" :
    "v2-google-auth-credentials-drive2cal.json",
};

const credentialsCache = new Map<AgentName, GoogleOAuthCredentials>();

function getAgentCredentials(): GoogleOAuthCredentials {
  const agentName = AGENT_NAME.value() as AgentName;
  const cached = credentialsCache.get(agentName);
  if (cached) return cached;

  const agentPath = path.join(
      __dirname, "..", "agents", agentName, "auth",
      credentialsFileNames[agentName],
  );

  if (!fs.existsSync(agentPath)) {
    throw new Error(
        `Missing OAuth credentials for agent "${agentName}" at ${agentPath}`,
    );
  }

  const credentials: GoogleOAuthCredentials = JSON.parse(
      fs.readFileSync(agentPath, {encoding: "utf-8"}),
  );
  credentialsCache.set(agentName, credentials);
  return credentials;
}

// Helper functions that take environment param value
const getRedirectUriIndex = (environment: string): number => {
  return environment === "production" ? 2 : 1;
};

const getApiUrl = (environment: string): string => {
  return environment === "production" ?
    "https://app.fwd2cal.com/v2/" :
    "http://127.0.0.1:5002/v2/";
};

export {getAgentCredentials, getRedirectUriIndex, getApiUrl};
