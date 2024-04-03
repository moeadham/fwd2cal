/* eslint-disable require-jsdoc */
const {logger} = require("firebase-functions");
const {getUser} = require("./firestoreHandler");
const {getOauthClient} = require("./oauthHandler");
const {processEmail} = require("./openai");
const {addEvent} = require("./calendarHelper");
const {sendEmail} = require("./sendgrid");
const {MAIN_EMAIL_ADDRESS} = require("./credentials");

const ERROR_TYPES = {
  unverifiedEmail: "unverifiedEmail",
  noUserFound: "noUserFound",
  oauthFailed: "oauthFailed",
  unableToParse: "unableToParse",
};

// Error handling wrapper
async function handleAsync(fn) {
  try {
    return [null, await fn()];
  } catch (err) {
    return [err, null];
  }
}


async function handleEmail(email) {
  // Is the email sender verified?
  if (!verifyEmail(email)) {
    logger.error("Unverified Email");
    sendEmailResponse(email, ERROR_TYPES.unverifiedEmail);
    return;
  }

  // Do we know this user?
  const uid = await getUser(email);
  if (!uid) {
    logger.error("No User found.");
    sendEmailResponse(email, ERROR_TYPES.noUserFound);
    return;
  }
  logger.log("User ID: ", uid);

  // Can we authenticate with their calendar?
  const [oauthErr, oauth2Client] = await handleAsync(() => getOauthClient(uid));
  if (oauthErr) {
    logger.error("Error getting OAuth client: ", oauthErr);
    sendEmailResponse(email, ERROR_TYPES.oauthFailed);
    return;
  }

  // Can we get event details from the thread?
  const [processEmailErr, event] = await handleAsync(() => processEmail(email));
  if (processEmailErr) {
    logger.error("Error processing email: ", processEmailErr);
    sendEmailResponse(email, ERROR_TYPES.unableToParse);
    return;
  }

  // Can we add the event to their calendar?
  const [addEventErr, eventObject] =
    await handleAsync(() => addEvent(oauth2Client, event));
  if (addEventErr) {
    logger.error("Error adding event to calendar: ", addEventErr);
    sendEmailResponse(email, ERROR_TYPES.unableToParse);
    return;
  }
  return eventObject;
}

async function sendEmailResponse(originalEmail, errorType, includeThread) {
  let sender;
  try {
    sender = JSON.parse(originalEmail.envelope).from.toLowerCase();
  } catch (error) {
    logger.error("Error parsing envelope", error);
    return null;
  }
  await sendEmail({
    to: sender,
    from: MAIN_EMAIL_ADDRESS,
    subject: originalEmail,
    text: "",
    html: "",
  });
}

function verifyEmail(email) {
  if (email.SPF !== "pass") {
    return false;
  }
  if (email.dkim.indexOf("pass") === -1 ) {
    return false;
  }
  // WARN: This IP might change, disable for now.
  //   if (email.sender_ip !== "209.85.216.44" && ENVIRONMENT==="production") {
  //     return false;
  //   }
  return true;
}


module.exports = {
  handleEmail,
};

