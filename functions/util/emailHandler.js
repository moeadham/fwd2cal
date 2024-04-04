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
const moment = require("moment-timezone");
const { event } = require("firebase-functions/v1/analytics");


const EMAIL_RESPONSES = {
  unverifiedEmail: {
    templateName: "unverifiedEmail",
    replace: {
      FROM_EMAIL: "",
    },
  },
  noUserFound: {
    templateName: "noUserFound",
    replace: {
      FROM_EMAIL: "",
    },
  },
  oauthFailed: {
    templateName: "oauthFailed",
    replace: {},
  },
  unableToParse: {
    templateName: "unableToParse",
    replace: {},
  },
  eventAdded: {
    templateName: "eventAdded",
    replace: {
      EVENT_LINK: "",
      EVENT_DATE: "",
      EVENT_ATTENDEES: "",
    },
  },
};

async function handleEmail(email) {
  // Do we know this user?
  const sender = getSenderFromRawEmail(email);
  // Is the email sender verified?
  if (!verifyEmail(email)) {
    logger.error("Unverified Email");
    const response = {
      ...EMAIL_RESPONSES.unverifiedEmail,
      replace: {
        FROM_EMAIL: sender,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    return;
  }


  const uid = await getUserFromEmail(sender);
  if (!uid) {
    logger.error("No User found");
    const response = {
      ...EMAIL_RESPONSES.noUserFound,
      replace: {
        FROM_EMAIL: sender,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    return;
  }
  const subjectAction = understandSubject(email.subject);
  switch (subjectAction) {
    case "addUser":
      // Code to handle addUser action
      return await addEmailAddressToUser(email, sender, uid);
    case "addEvent":
      // Code to handle addEvent action
      return await eventHandler(email, sender, uid);
    default:
      return await eventHandler(email, sender, uid);
  }
}

function understandSubject(subject) {
  subject = subject.toLowerCase();
  if (subject.startsWith("add")) {
    return "addUser";
  } else if (subject.startsWith("fwd")) {
    return "addEvent";
  } else {
    return "addEvent";
  }
}

async function addEmailAddressToUser(email, sender, uid) {
  const subject = email.subject;
  const emailRegex = /^add\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})$/;
  const match = subject.match(emailRegex);
  if (!match) {
    logger.error("Email format incorrect in subject");
    const response = {
      ...EMAIL_RESPONSES.unverifiedEmail,
      replace: {
        FROM_EMAIL: sender,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    return;
  }
  const emailAddressToAdd = match[1];
  // Continue with adding email address logic...
}

async function eventHandler(email, sender, uid) {
  logger.log("User ID: ", uid);

  // Can we authenticate with their calendar?
  const [oauthErr, oauth2Client] = await handleAsync(() => getOauthClient(uid));
  if (oauthErr) {
    logger.error("Error getting OAuth client: ", oauthErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed, true);
    return;
  }

  // Can we get event details from the thread?
  const [processEmailErr, event] = await handleAsync(() => processEmail(email));
  if (processEmailErr) {
    logger.error("Error processing email: ", processEmailErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
    return;
  }

  // Can we add the event to their calendar?
  const [addEventErr, eventObject] =
    await handleAsync(() => addEvent(oauth2Client, event));
  if (addEventErr) {
    logger.error("Error adding event to calendar: ", addEventErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
    return;
  }
  const response = {
    ...EMAIL_RESPONSES.eventAdded,
    replace: {
      EVENT_LINK: eventObject.htmlLink,
      EVENT_DATE: moment(eventObject.start.dateTime)
          .tz(eventObject.start.timeZone)
          .format("dddd, MMMM Do [at] h:mm A"),
      EVENT_ATTENDEES:
          eventObject.attendees.map((attendee) => attendee.email).join(", "),
    },
  };
  await sendEmailResponse(sender, email, response, true);
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

// eslint-disable-next-line no-unused-vars
function getDateFromHeader(header) {
  let date;
  try {
    const datePattern = /Date: (.*)/g;
    const matches = datePattern.exec(header);
    if (matches && matches[1]) {
      // Thu, 28 Mar 2024 10:38:21 +0000
      date = moment(matches[1].trim(), "ddd, DD MMM YYYY HH:mm:ss ZZ").toDate();
    }
  } catch (error) {
    logger.error("Error extracting date with moment from header", error);
  }
  return date;
}

function getEmailThreadHeaders(header) {
  const headers = {};
  try {
    const inreplyPattern = /In-Reply-To: (.*)/g;
    let matches = inreplyPattern.exec(header);
    if (matches && matches[1]) {
      // Thu, 28 Mar 2024 10:38:21 +0000
      headers["In-Reply-To"] = matches[1].trim();
    }
    const referncesPattern = /References: (.*)/g;
    matches = referncesPattern.exec(header);
    if (matches && matches[1]) {
      // Thu, 28 Mar 2024 10:38:21 +0000
      headers["References"] = matches[1].trim();
    }
  } catch (error) {
    logger.error("Error extracting date with moment from header", error);
  }
  return headers;
}

function threadEmailHtml(original, html) {
  // const date = getDateFromHeader(original.header);
  // const formattedDate = moment(date).format("MMM DD, YYYY");
  // const formattedTime = moment(date).format("h:mm A");
  // const senderFull = original.from;
  // const threadLine =
  //   `On Tue, ${formattedDate} at ${formattedTime} ${senderFull} wrote:`;
  // return `${html}
  // <div class="gmail_quote">
  // <div dir="ltr" class="gmail_attr">
  // ${threadLine}
  // ${original.html}
  // </div>
  // </div>`;
  return `${html}${original.html}`;
}

function getHtml(messageType) {
  let html = mailTemplates[messageType.templateName].html;
  Object.keys(messageType.replace).forEach((key) => {
    html = html.replace(new RegExp(`%${key}%`, "g"), messageType.replace[key]);
  });
  return html;
}

async function sendEmailResponse(sender,
    originalEmail,
    messageType,
    includeThread) {
  let html = getHtml(messageType);
  if (includeThread) {
    html = threadEmailHtml(originalEmail, html);
  }
  await sendEmail({
    to: sender,
    from: MAIN_EMAIL_ADDRESS,
    subject: originalEmail.subject,
    html: html,
    headers: getEmailThreadHeaders(originalEmail.headers),
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

