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

const ENVIRONMENT = functions.config().environment.name;
const REDIRECT_URI_INDEX = ENVIRONMENT === "production" ? 2 : 1;
const MAIN_EMAIL_ADDRESS = "calendar@fwd2cal.com";

const OPENAI_API_KEY = functions.config().environment.openai_api_key;
const SENDGRID_API_KEY = functions.config().environment.sendgrid_api_key;

const API_URL = ENVIRONMENT === "production" ? "https://app.fwd2cal.com/" : "http://127.0.0.1:5001/fwd2cal/us-central1/";


module.exports = {
  CREDENTIALS,
  MAIN_EMAIL_ADDRESS,
  REDIRECT_URI_INDEX,
  OPENAI_API_KEY,
  SENDGRID_API_KEY,
  ENVIRONMENT,
  API_URL,
};

