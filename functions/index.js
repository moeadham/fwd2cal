/* eslint-disable new-cap */
/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
/* eslint-disable require-jsdoc */
/* eslint-disable max-len */

const fs = require("fs");
const path = require("path");
const CREDENTIALS_PATH = path.join(
    "auth",
    "v2-google-auth-credentials.json",
);
const CREDENTIALS = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, {encoding: "utf-8"}),
);
const {getAuth} = require("firebase-admin/auth");
const {google} = require("googleapis");
const {logger} = require("firebase-functions/v2");
const {onTaskDispatched} = require("firebase-functions/v2/tasks");
const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {getFirestore} = require("firebase-admin/firestore");
const admin = require("firebase-admin");
const prompts = require("./util/prompts");
const {handleEmail} = require("./util/emailHandler");
const {inviteAdditionalAttendees} = require("./util/calendarHelper");
const {ENVIRONMENT_NAME, RESEND_API_KEY, RESEND_SIGNING_SECRET} = require("./util/config");
const {Resend} = require("resend");
const {getMockResendClient, setMockData, getLastSentEmail} = require("./util/resendMock");
const {addContactToResend} = require("./util/resend");
const {processAttachments} = require("./util/attachmentHandler");
const {getFunctions} = require("firebase-admin/functions");

admin.initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});

const {oauthCronJob,
  signupCallbackHandler,
  verifyAdditionalEmail} = require("./util/authHandler");

// Global configuration for onRequest functions
const onRequestConfig = {cors: true, memory: "512MiB", timeoutSeconds: 540};
const dispatchConfig = {
  retryConfig: {
    maxAttempts: 1,
    minBackoffSeconds: 1,
  },
  memory: "512MiB",
  timeoutSeconds: 3600,
};

// For debugging before we start inviting others to our events.
const ONLY_INVITE_HOST = true;
const DEFAULT_EVENT_LENGTH = 30;
// WARNING: Make sure you set a hard to guess endpoint in production.
// Sendgrid has no real authentication on the callback.
// Maximum is 62 characters
// Note: Firebase Functions v2 requires static function names, so dynamic
// endpoint names are no longer supported. Use URL rewriting in firebase.json
// or a proxy to achieve endpoint obfuscation if needed.

exports.v2signup = onRequest(onRequestConfig, async (req, res) => {
  const redirectUriIndex = ENVIRONMENT_NAME.value() === "production" ? 2 : 1;
  const signupUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${CREDENTIALS.web.client_id}&redirect_uri=${CREDENTIALS.web.redirect_uris[redirectUriIndex]}&scope=https://www.googleapis.com/auth/calendar+https://www.googleapis.com/auth/userinfo.email+https://www.googleapis.com/auth/userinfo.profile+openid&access_type=offline&prompt=consent`;
  res.redirect(302, signupUrl);
});

exports.v2oauthCallback = onRequest(onRequestConfig, async (req, res) => {
  try {
    await signupCallbackHandler(req.query);
  } catch (err) {
    logger.warn("Error in oauthCallback", err);
    res.status(err.code || 500).send(err.message);
    return;
  }
  res.redirect(302, "https://www.fwd2cal.com/thanks");
});

exports.v2resendInboundCallback = onRequest(onRequestConfig, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  try {
    // Use mock client in test mode, real client in production
    const isTestMode = ENVIRONMENT_NAME.value() === "local" || ENVIRONMENT_NAME.value() === "test";
    const resend = isTestMode ? getMockResendClient() : new Resend(RESEND_API_KEY.value());

    // In test mode, set up mock data from the request
    if (isTestMode && req.body.mockData) {
      const emailId = req.body.data.email_id;
      setMockData(
          emailId,
          req.body.mockData.emailContent,
          req.body.mockData.attachmentsList || [],
      );
    }

    // Verify webhook signature
    const signature = req.headers["svix-signature"];
    const svixId = req.headers["svix-id"];
    const svixTimestamp = req.headers["svix-timestamp"];

    if (!signature || !svixId || !svixTimestamp) {
      logger.error("Missing Resend webhook headers");
      res.status(401).json({error: "Unauthorized"});
      return;
    }

    // Verify the webhook signature
    const isValid = await resend.webhooks.verify({
      payload: JSON.stringify(req.body),
      headers: {
        id: svixId,
        timestamp: svixTimestamp,
        signature: signature,
      },
      webhookSecret: RESEND_SIGNING_SECRET.value(),
    });

    if (!isValid) {
      logger.error("Invalid Resend webhook signature");
      res.status(401).json({error: "Invalid signature"});
      return;
    }

    // Extract email data from webhook
    const webhookData = req.body;

    // Only process email.received events
    if (webhookData.type !== "email.received") {
      logger.info("Ignoring non-email.received event", {type: webhookData.type});
      res.status(200).json({message: "ok"});
      return;
    }
    // Dispatch the task with data.
    await dispatchTask({functionName: "v2resendInboundDispatch", data: webhookData});
    res.status(200).json({
      message: "thanks",
      webhookData,
    });
  } catch (error) {
    logger.error("Error processing Resend webhook", {error: error.message});
    res.status(200).json({message: "Something went wrong, but we're not going to tell you what."});
  }
});

async function dispatchTask({functionName, data, deadline=60 * 5, scheduleDelaySeconds=0, location="us-central1"}) {
  try {
    if (ENVIRONMENT_NAME.value() === "local") {
      logger.debug(`Not dispatching task ${functionName} in dev.`);
      return;
    } else {
      const queue = getFunctions().taskQueue(`locations/${location}/functions/${functionName}`);
      await queue.enqueue(data, {
        scheduleDelaySeconds: scheduleDelaySeconds,
        dispatchDeadlineSeconds: deadline,
        // uri: targetUri, // TaskOptionsExperimental.uri - Turns out this is useless and super slow.
      });
      logger.debug(`Dispatched task ${functionName}`);
      return;
    }
  } catch (error) {
    if (ENVIRONMENT_NAME.value() === "local") {
      logger.debug(`Error dispatching task ${functionName}: ${error}`);
    } else {
      logger.error(`Error dispatching task ${functionName}: ${error}`);
    }
    return;
  }
}

exports.v2resendInboundDispatch = onTaskDispatched(dispatchConfig, async (req) => {
  return await handleResdendInboundDispatch(req);
});

exports.v2testResendInboundDispatch = onRequest(onRequestConfig, async (req, res) => {
  try {
    res.status(200).json(await handleResdendInboundDispatch(req.body));
  } catch (err) {
    logger.error("Error in testResendInboundDispatch", err);
    res.status(500).json({error: err.message});
  }
});

async function handleResdendInboundDispatch(req) {
  const webhookData = req.data;

  const {email_id, from, to, subject, attachments} = webhookData.data;
  // Use mock client in test mode, real client in production
  const isTestMode = ENVIRONMENT_NAME.value() === "local" || ENVIRONMENT_NAME.value() === "test";
  const resend = isTestMode ? getMockResendClient() : new Resend(RESEND_API_KEY.value());
  // In test mode, set up mock data from the request
  if (isTestMode && webhookData.mockData) {
    const emailId = webhookData.data.email_id;
    setMockData(
        emailId,
        webhookData.mockData.emailContent,
        webhookData.mockData.attachmentsList || [],
    );
  }

  logger.info("Processing Resend email", {
    email_id,
    from,
    to,
    subject,
    attachmentCount: attachments ? attachments.length : 0,
  });

  // Add sender to Resend contacts (fire-and-forget)
  addContactToResend(from);

  // Fetch full email content from Resend API (receiving endpoint)
  let emailData;
  try {
    const {data, error} = await resend.emails.receiving.get(email_id);
    emailData = data;
    if (error) {
      logger.error("Failed to fetch email content from Resend", {
        error: error.message,
        email_id,
      });
      return {error: "Failed to fetch email content"};
    }
  } catch (emailError) {
    logger.error("Failed to fetch email content from Resend", {
      error: emailError.message,
      email_id,
    });
    return {error: "Failed to fetch email content"};
  }

  // Log FULL emailData as JSON for debugging
  logger.info("Full emailData JSON response", emailData);

  // Extract SPF and DKIM results from authentication-results header
  const authResults = emailData.headers?.["authentication-results"] || "";
  const spfResult = authResults.includes("spf=pass") ? "pass" : "fail";
  const dkimResult = authResults.includes("dkim=pass") ?
        (authResults.match(/dkim=pass header\.i=(@[^\s;]+)/) || [null, "@unknown"])[1] + " : pass" :
        "fail";

  // Log SPF/DKIM extraction results
  logger.info("SPF/DKIM extraction results", {
    authResultsRaw: authResults || "EMPTY",
    spfResult,
    dkimResultRaw: dkimResult,
    dkimFinal: `{${dkimResult}}`,
  });

  // Transform Resend format to internal format expected by handleEmail
  const transformedEmail = {
    subject: emailData.subject,
    text: emailData.text || "",
    html: emailData.html || "",
    from: emailData.from,
    to: Array.isArray(emailData.to) ? emailData.to : [emailData.to],
    headers: emailData.headers || {},
    SPF: spfResult,
    dkim: `{${dkimResult}}`,
  };

  // Log transformed email object for debugging
  logger.info("Transformed email object", {
    from: transformedEmail.from,
    to: transformedEmail.to,
    subject: transformedEmail.subject,
    SPF: transformedEmail.SPF,
    dkim: transformedEmail.dkim,
    textLength: transformedEmail.text?.length || 0,
    htmlLength: transformedEmail.html?.length || 0,
    headerCount: Object.keys(transformedEmail.headers).length,
  });

  // Handle attachments (ICS files and images)
  const {icsFiles, imageUrls} = await processAttachments(resend, email_id);

  if (ENVIRONMENT_NAME.value() !== "production") {
    logger.log("RESEND WEBHOOK DATA", webhookData);
    logger.log("FETCHED EMAIL DATA", emailData);
    logger.log("TRANSFORMED EMAIL", transformedEmail);
    logger.log("ICS FILES", icsFiles);
    logger.log("IMAGE URLS", imageUrls);
  }

  // Process the email
  const outcome = await handleEmail(transformedEmail, icsFiles, imageUrls);

  // Get the sent email data from mock for testing (non-production only)
  let sentEmail = null;
  if (ENVIRONMENT_NAME.value() !== "production") {
    sentEmail = getLastSentEmail(transformedEmail.from);
  }

  return {
    message: "thanks",
    data: outcome,
    sentEmail: sentEmail,
  };
}

exports.v2verifyAdditionalEmail = onRequest(onRequestConfig, async (req, res) => {
  try {
    await verifyAdditionalEmail(req, res);
  } catch (err) {
    logger.warn("Error in addUserRecord", err);
    return res.redirect(302, "https://www.fwd2cal.com/404");
  }
});

exports.v2inviteAdditionalAttendees = onRequest(onRequestConfig, async (req, res) => {
  try {
    await inviteAdditionalAttendees(req, res);
  } catch (err) {
    logger.warn("Error in inviteAdditionalAttendees", err);
    return res.redirect(302, "https://www.fwd2cal.com/404");
  }
});

exports.v2refreshTokensScheduled = onSchedule({
  schedule: "0 * * * *",
  timeZone: "America/New_York", // Users can choose timezone - default is America/Los_Angeles
  memory: "512MiB",
}, async (context) => {
  await oauthCronJob();
});
