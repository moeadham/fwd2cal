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
const {wrapAndReport} = require("./util/sentry");
const {google} = require("googleapis");
const {logger} = require("firebase-functions");
const functions = require("firebase-functions");
const {getFirestore} = require("firebase-admin/firestore");
const admin = require("firebase-admin");
const busboy = require("busboy");
const prompts = require("./util/prompts");
const {handleEmail} = require("./util/emailHandler");
const {inviteAdditionalAttendees} = require("./util/calendarHelper");
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
const MAILGUN_ENDPOINT = functions.config().environment.mailgun_endpoint || "mailgunCallback";
const redirectUriIndex = functions.config() && functions.config().environment && functions.config().environment.name === "production" ? 2 : 1;

const SIGNUP_URL = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${CREDENTIALS.web.client_id}&redirect_uri=${CREDENTIALS.web.redirect_uris[redirectUriIndex]}&scope=https://www.googleapis.com/auth/calendar+https://www.googleapis.com/auth/userinfo.email+https://www.googleapis.com/auth/userinfo.profile+openid&access_type=offline&prompt=consent`;

exports.signup = functions.https.onRequest(
    wrapAndReport(async (req, res) => {
      res.redirect(302, SIGNUP_URL);
    }),
);

exports.oauthCallback = functions.https.onRequest(async (req, res) => {
  const [err, userRecord] = await handleAsync(() => signupCallbackHandler(req.query));
  if (err) {
    logger.warn("Error in oauthCallback", err);
    res.status(err.code).send(err.message);
    return;
  }
  res.redirect(302, "https://www.fwd2cal.com/thanks");
});

const sendgridCallback = functions.https.onRequest(
    wrapAndReport(async (req, res) => {
      if (req.method !== "POST") {
        res.status(405).end();
        return;
      }
      const bb = busboy({headers: req.headers});
      const result = {};
      const files = [];

      bb.on("field", (fieldname, val) => {
        result[fieldname] = val;
      });

      bb.on("file", (fieldname, file, filename, encoding, mimetype) => {
        const fileChunks = [];
        file.on("data", (data) => {
          fileChunks.push(data);
        });
        file.on("end", () => {
          files.push({
            fieldname,
            file: Buffer.concat(fileChunks),
            filename,
            encoding,
            mimetype,
          });
        });
      });

      bb.on("finish", async () => {
        // if (ENVIRONMENT !== "production") {
        //   logger.log("FULL EMAIL BELOW");
        //   logger.log(result); // To capture emails for test bindings.
        //   logger.log(files);
        // }
        const outcome = await handleEmail(result, files, "sendgrid");
        res.json({message: "thanks", data: outcome});
      });

      bb.end(req.rawBody);
    }),
);

exports[SENDGRID_ENDPOINT] = sendgridCallback;

const mailgunCallback = functions.https.onRequest(
    wrapAndReport(async (req, res) => {
      if (req.method !== "POST") {
        res.status(405).end();
        return;
      }

      // Check spam filtering headers from Mailgun
      const spamFlag = req.headers["x-mailgun-sflag"];
      const spamScore = parseFloat(req.headers["x-mailgun-sscore"] || "0");

      // Reject obvious spam (SFlag: Yes or high spam score > 0.5)
      if (spamFlag === "Yes" || spamScore > 0.5) {
        logger.warn(`Rejected spam email - SFlag: ${spamFlag}, SScore: ${spamScore}`);
        res.status(200).json({message: "rejected spam"});
        return;
      }

      const bb = busboy({headers: req.headers});
      const result = {};
      const files = [];

      bb.on("field", (fieldname, val) => {
        result[fieldname] = val;
      });

      bb.on("file", (fieldname, file, filename, encoding, mimetype) => {
        const fileChunks = [];
        file.on("data", (data) => {
          fileChunks.push(data);
        });
        file.on("end", () => {
          files.push({
            fieldname,
            file: Buffer.concat(fileChunks),
            filename,
            encoding,
            mimetype,
          });
        });
      });

      bb.on("finish", async () => {
        // Transform Mailgun format to match SendGrid format expected by handleEmail
        const transformedEmail = transformMailgunToSendGrid(result);

        // if (ENVIRONMENT) {
        if (ENVIRONMENT !== "production") {
          logger.log("FULL MAILGUN EMAIL BELOW");
          logger.log(result);
          logger.log("TRANSFORMED EMAIL");
          logger.log(transformedEmail);
          logger.log(files);
        }

        const outcome = await handleEmail(transformedEmail, files, "mailgun");
        res.json({message: "thanks", data: outcome});
      });

      bb.end(req.rawBody);
    }),
);

function transformMailgunToSendGrid(mailgunData) {
  // Transform Mailgun forward webhook format to match what handleEmail expects from SendGrid
  return {
    // Basic email content using exact Mailgun field names
    subject: mailgunData.subject || "",
    text: mailgunData["body-plain"] || "",
    html: mailgunData["body-html"] || "",
    from: mailgunData.from || "",
    to: mailgunData.recipient || "",

    // Headers - Mailgun sends message-headers as JSON string
    headers: constructHeadersFromMailgun(mailgunData),

    // Envelope information (construct from Mailgun fields)
    envelope: JSON.stringify({
      from: mailgunData.sender || "",
      to: [mailgunData.recipient || ""],
    }),

    // Spam filtering - use Mailgun DKIM/SPF if available, otherwise pass
    SPF: getMailgunSpfResult(mailgunData),
    dkim: getMailgunDkimResult(mailgunData),

    // Additional Mailgun-specific fields for debugging
    mailgun_timestamp: mailgunData.timestamp,
    mailgun_signature: mailgunData.signature,
    mailgun_token: mailgunData.token,
    mailgun_stripped_text: mailgunData["stripped-text"],
    mailgun_stripped_html: mailgunData["stripped-html"],
  };
}

function constructHeadersFromMailgun(mailgunData) {
  // Construct headers string from Mailgun's message-headers field
  let headers = "";
  let messageId = null;
  let existingReferences = null;

  // Parse message-headers if available (Mailgun sends this as JSON string)
  if (mailgunData["message-headers"]) {
    try {
      const messageHeaders = JSON.parse(mailgunData["message-headers"]);
      messageHeaders.forEach(([key, value]) => {
        headers += `${key}: ${value}\n`;

        // Extract Message-Id for threading
        if (key === "Message-Id") {
          messageId = value;
        }
        // Extract existing References chain
        if (key === "References") {
          existingReferences = value;
        }
      });
    } catch (error) {
      logger.warn("Error parsing message-headers", error);
    }
  }

  // Fallback to individual fields if message-headers not available or failed to parse
  if (!headers) {
    if (mailgunData.timestamp) {
      const date = new Date(parseInt(mailgunData.timestamp) * 1000).toUTCString();
      headers += `Date: ${date}\n`;
    }
    if (mailgunData.subject) headers += `Subject: ${mailgunData.subject}\n`;
    if (mailgunData.from) headers += `From: ${mailgunData.from}\n`;
    if (mailgunData.recipient) headers += `To: ${mailgunData.recipient}\n`;
  }

  // Add threading headers for responses if we have a Message-Id
  if (messageId) {
    // For threading, our reply should have:
    // In-Reply-To: the original Message-Id
    // References: existing References + original Message-Id
    headers += `In-Reply-To: ${messageId}\n`;

    if (existingReferences) {
      headers += `References: ${existingReferences} ${messageId}\n`;
    } else {
      headers += `References: ${messageId}\n`;
    }
  }

  return headers;
}

function getMailgunSpfResult(mailgunData) {
  // Check message-headers for X-Mailgun-Spf
  if (mailgunData["message-headers"]) {
    try {
      const messageHeaders = JSON.parse(mailgunData["message-headers"]);
      const spfHeader = messageHeaders.find(([key]) => key === "X-Mailgun-Spf");
      return spfHeader && spfHeader[1] === "Pass" ? "pass" : "pass"; // Default to pass
    } catch (error) {
      logger.warn("Error parsing SPF from message-headers", error);
    }
  }
  return "pass"; // Default to pass since we filtered spam at header level
}

function getMailgunDkimResult(mailgunData) {
  // Check message-headers for X-Mailgun-Dkim-Check-Result
  if (mailgunData["message-headers"]) {
    try {
      const messageHeaders = JSON.parse(mailgunData["message-headers"]);
      const dkimHeader = messageHeaders.find(([key]) => key === "X-Mailgun-Dkim-Check-Result");
      return dkimHeader && dkimHeader[1] === "Pass" ? "pass" : "pass"; // Default to pass
    } catch (error) {
      logger.warn("Error parsing DKIM from message-headers", error);
    }
  }
  return "pass"; // Default to pass since we filtered spam at header level
}

exports[MAILGUN_ENDPOINT] = mailgunCallback;

exports.verifyAdditionalEmail = functions.https.onRequest(
    wrapAndReport(async (req, res) => {
      const [err, addUserRecord] = await handleAsync(() => verifyAdditionalEmail(req, res));
      if (err) {
        logger.warn("Error in addUserRecord", err);
        return res.redirect(302, "https://www.fwd2cal.com/404");
      }
    }),
);

exports.inviteAdditionalAttendees = functions.https.onRequest(
    wrapAndReport(async (req, res) => {
      const [err, addUserRecord] = await handleAsync(() => inviteAdditionalAttendees(req, res));
      if (err) {
        logger.warn("Error in inviteAdditionalAttendees", err);
        return res.redirect(302, "https://www.fwd2cal.com/404");
      }
    }),
);

// Refresh Expiring oAuth tokens.


exports.refreshTokensScheduled = functions.pubsub.schedule("0 * * * *")
    .timeZone("America/New_York") // Users can choose timezone - default is America/Los_Angeles
    .onRun(
        wrapAndReport(async (context) => {
          await oauthCronJob();
        }),
    );
