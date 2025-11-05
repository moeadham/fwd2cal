const fs = require("fs");
const path = require("path");

const CREDENTIALS_PATH = path.join(
    "auth",
    "google-auth-credentials.json",
);

const CREDENTIALS = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, {encoding: "utf-8"}),
);

const MAIN_EMAIL_ADDRESS = "calendar@fwd2cal.com";

// Helper functions that take environment param value
const getRedirectUriIndex = (environment) => {
  return environment === "production" ? 2 : 1;
};

const getApiUrl = (environment) => {
  return environment === "production" ?
      "https://app.fwd2cal.com/auth/" :
      "http://127.0.0.1:5001/fwd2cal/us-central1/";
};

module.exports = {
  CREDENTIALS,
  MAIN_EMAIL_ADDRESS,
  getRedirectUriIndex,
  getApiUrl,
};
