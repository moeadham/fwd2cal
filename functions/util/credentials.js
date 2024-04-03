const fs = require("fs");
const path = require("path");
const functions = require("firebase-functions");
const CREDENTIALS_PATH = path.join(
    "auth",
    "google-auth-credentials.json",
);

const CREDENTIALS = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, {encoding: "utf-8"}),
);

const REDIRECT_URI_INDEX = functions.config() &&
    functions.config().environment &&
    functions.config().environment.name === "production" ? 2 : 1;
conse MAIN_EMAIL_ADDRESS = "calendar@fwd2cal.com"

module.exports = {
  CREDENTIALS,
  MAIN_EMAIL_ADDRESS,
  REDIRECT_URI_INDEX,
};

