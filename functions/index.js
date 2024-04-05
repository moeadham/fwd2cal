/* eslint-disable new-cap */
/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
/* eslint-disable require-jsdoc */
/* eslint-disable max-len */

const fs = require("fs");
const path = require("path");
const CREDENTIALS_PATH = path.join(
    "auth",
    "google-auth-credentials.json",
);
const handleAsync = require("./util/handleAsync");
const CREDENTIALS = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, {encoding: "utf-8"}),
);
const {getAuth} = require("firebase-admin/auth");

const {google} = require("googleapis");
const {logger} = require("firebase-functions");
const functions = require("firebase-functions");
const {getFirestore} = require("firebase-admin/firestore");
const admin = require("firebase-admin");
const busboy = require("busboy");
const prompts = require("./util/prompts");
const {handleEmail} = require("./util/emailHandler");
const {time} = require("console");
admin.initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});
const ENVIRONMENT = functions.config().environment.name;

const {oauthCronJob,
  signupCallbackHandler,
  verifyAdditionalEmail} = require("./util/authHandler");

// For debugging before we start inviting others to our events.
const ONLY_INVITE_HOST = true;
const DEFAULT_EVENT_LENGTH = 30;
// WARNING: Make sure you set a hard to guess endpoint in production.
// Sendgrid has no real authentication on the callback.
// Maximum is 62 characters
const SENDGRID_ENDPOINT = functions.config().environment.sendgrid_endpoint || "sendgridCallback";
const redirectUriIndex = functions.config() && functions.config().environment && functions.config().environment.name === "production" ? 2 : 1;

const URL = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${CREDENTIALS.web.client_id}&redirect_uri=${CREDENTIALS.web.redirect_uris[redirectUriIndex]}&scope=https://www.googleapis.com/auth/calendar+https://www.googleapis.com/auth/userinfo.email+https://www.googleapis.com/auth/userinfo.profile+openid&access_type=offline&prompt=consent`;
logger.log(URL);

exports.oauthCallback = functions.https.onRequest(async (req, res) => {
  // logger.log("oauthCallback", req.query);
  const [err, userRecord] = await handleAsync(() => signupCallbackHandler(req.query));
  if (err) {
    logger.error("Error in oauthCallback", err);
    res.status(err.code).send(err.message);
    return;
  }
  res.json({message: "Authentication successful", uid: userRecord.uid});
});

const sendgridCallback = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }
  const bb = busboy({headers: req.headers});
  const result = {};

  bb.on("field", (fieldname, val) => {
    result[fieldname] = val;
  });

  bb.on("finish", async () => {
    // logger.log("FULL EMAIL BELOW");
    // logger.log(result); // To capture emails for test bindings.
    const outcome = await handleEmail(result);
    res.json({message: "thanks", data: outcome});
  });

  bb.end(req.rawBody);
});

exports[SENDGRID_ENDPOINT] = sendgridCallback;

exports.verifyAdditionalEmail = functions.https.onRequest(async (req, res) => {
  const [err, addUserRecord] = await handleAsync(() => verifyAdditionalEmail(req, res));
});

// Refresh Expiring oAuth tokens.

exports.refreshTokensScheduled = functions.pubsub.schedule("0 * * * *")
    .timeZone("America/New_York") // Users can choose timezone - default is America/Los_Angeles
    .onRun(async (context) => {
      await oauthCronJob();
    });
