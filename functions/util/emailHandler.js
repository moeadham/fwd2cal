/* eslint-disable require-jsdoc */
const {logger} = require("firebase-functions");
const {getUserFromEmail} = require("./firestoreHandler");
const {getOauthClient} = require("./oauthHandler");
const {processEmail} = require("./openai");
const {addEvent} = require("./calendarHelper");
const {sendEmail} = require("./sendgrid");
const {MAIN_EMAIL_ADDRESS} = require("./credentials");
const handleAsync = require("./handleAsync");
const {mailTemplates} = require("./mailTemplates");


const EMAIL_RESPONSES = {
  unverifiedEmail: "unverifiedEmail",
  noUserFound: "noUserFound",
  oauthFailed: "oauthFailed",
  unableToParse: "unableToParse",
  eventAdded: "eventAdded",
};

async function handleEmail(email) {
  // Is the email sender verified?
  if (!verifyEmail(email)) {
    logger.error("Unverified Email");
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.unverifiedEmail);
    return;
  }

  // Do we know this user?
  const sender = getSenderFromRawEmail(email);
  const uid = await getUserFromEmail(sender);
  if (!uid) {
    logger.error("No User found");
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.noUserFound);
    return;
  }
  logger.log("User ID: ", uid);

  // Can we authenticate with their calendar?
  const [oauthErr, oauth2Client] = await handleAsync(() => getOauthClient(uid));
  if (oauthErr) {
    logger.error("Error getting OAuth client: ", oauthErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed);
    return;
  }

  // Can we get event details from the thread?
  const [processEmailErr, event] = await handleAsync(() => processEmail(email));
  if (processEmailErr) {
    logger.error("Error processing email: ", processEmailErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse);
    return;
  }

  // Can we add the event to their calendar?
  const [addEventErr, eventObject] =
    await handleAsync(() => addEvent(oauth2Client, event));
  if (addEventErr) {
    logger.error("Error adding event to calendar: ", addEventErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse);
    return;
  }
  await sendEmailResponse(sender, email, EMAIL_RESPONSES.eventAdded);
  return eventObject;
}

function getSenderFromRawEmail(email) {
  let sender;
  try {
    sender = JSON.parse(email.envelope).from.toLowerCase();
  } catch (error) {
    logger.error("Error parsing envelope", error);
  }
  return sender;
}

async function sendEmailResponse(sender,
    originalEmail,
    errorType,
    includeThread) {
  let text = mailTemplates[errorType].text;
  text = text.replace(/%FROM_EMAIL%/g, sender);
  await sendEmail({
    to: sender,
    from: MAIN_EMAIL_ADDRESS,
    subject: EMAIL_RESPONSES[errorType],
    text: text,
    // html: "",
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

