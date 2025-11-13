const fs = require("fs");
const path = require("path");

const CREDENTIALS_PATH = path.join(
    "auth",
    "v2-google-auth-credentials.json",
);

const CREDENTIALS = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, {encoding: "utf-8"}),
);

// Helper functions that take environment param value
const getRedirectUriIndex = (environment) => {
  return environment === "production" ? 2 : 1;
};

const getApiUrl = (environment) => {
  return environment === "production" ?
      "https://app.fwd2cal.com/v2/" :
      "http://127.0.0.1:5002/v2/";
};

module.exports = {
  CREDENTIALS,
  getRedirectUriIndex,
  getApiUrl,
};
