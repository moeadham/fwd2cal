/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
const {logger} = require("firebase-functions");
const {getUserFromEmail,
  addPendingEmailAddress,
  removeEmailAddress,
  deleteUser} = require("./firestoreHandler");
const {getOauthClient,
  deleteAccount} = require("./authHandler");
const {processEmail} = require("./openai");
const {addEvent, eventFromICS} = require("./calendarHelper");
const {sendEmail} = require("./sendgrid");
const {MAIN_EMAIL_ADDRESS,
  API_URL} = require("./credentials");
const handleAsync = require("./handleAsync");
const {mailTemplates} = require("./mailTemplates");
const moment = require("moment-timezone");
const qs = require("qs");
// const {event} = require("firebase-functions/v1/analytics");


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
  aiParseError: {
    templateName: "aiParseError",
    replace: {
      PARSE_ERROR_DESCRIPTION: "",
    },
  },
  eventAdded: {
    templateName: "eventAdded",
    replace: {
      EVENT_LINK: "",
      EVENT_DATE: "",
      EVENT_ATTENDEES: "",
    },
  },
  eventAddedAttendees: {
    templateName: "eventAddedAttendees",
    replace: {
      EVENT_LINK: "",
      EVENT_DATE: "",
      INVITE_LINK: "",
      EVENT_ATTENDEES: "",
    },
  },
  addAdditionalEmailAddress: {
    templateName: "addAdditionalEmailAddress",
    replace: {
      VERIFICATION_CODE: "",
      ORIGINATOR_EMAIL: "",
    },
    subject: true,
  },
  additionalEmailInUse: {
    templateName: "additionalEmailInUse",
    replace: {
      EMAIL_TO_ADD: "",
    },
  },
  removalEmailInUse: {
    templateName: "removalEmailInUse",
    replace: {
      EMAIL_TO_REMOVE: "",
    },
  },
  emailAddressRemoved: {
    templateName: "emailAddressRemoved",
    replace: {
      EMAIL_TO_REMOVE: "",
    },
  },
  userDeleted: {
    templateName: "userDeleted",
    replace: {},
  },
};

async function handleEmail(email, files) {
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
    return {error: "Unverified email address"};
  }
  // Is this a support email?
  const to = getRecipientsFromRawEmail(email);
  if (to.includes("support@fwd2cal.com") ||
      to.includes("admin@fwd2cal.com") ||
      email.subject.toLowerCase().startsWith("verify your email address")) { // To handle google account creation.
    return await sendToSupport(sender, email);
  }

  const uid = await getUserFromEmail(sender);
  if (!uid) {
    logger.error(`No User found with ${sender}`);
    const response = {
      ...EMAIL_RESPONSES.noUserFound,
      replace: {
        FROM_EMAIL: sender,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    return {result: `${sender} has been invited to signup`};
  }
  const subjectAction = understandSubject(email.subject);
  logger.log(`Request from ${sender} to ${subjectAction}`);
  switch (subjectAction) {
    case "addUser":
      return await addEmailAddressToUser(email, sender, uid);
    case "removeEmail":
      return await removeEmailAddressFromUser(email, sender, uid);
    case "deleteAccount":
      return await deleteUserAccount(email, sender, uid);
    case "addEvent":
      return await eventHandler(email, sender, uid, files);
    default:
      return await eventHandler(email, sender, uid, files);
  }
}

async function sendToSupport(sender, email) {
  logger.log(`Support email received from ${sender}`);
  logger.log(email.subject);
  logger.log(email.text);
  const content = `From: ${sender} <br><br> Subject: ${email.subject} <br><br> ${email.html}`;
  await sendEmail({
    to: "fwd2cal@googlegroups.com",
    from: MAIN_EMAIL_ADDRESS,
    subject: email.subject,
    html: content,
  });
  return {result: `email forwarded to support group.`};
}

function understandSubject(subject) {
  subject = subject.toLowerCase();
  if (subject.startsWith("add")) {
    return "addUser";
  } else if (subject.startsWith("remove")) {
    return "removeEmail";
  } else if (subject.startsWith("delete account")) {
    return "deleteAccount";
  } else if (subject.startsWith("fwd")) {
    return "addEvent";
  } else {
    return "addEvent";
  }
}

async function deleteUserAccount(email, sender, uid) {
  await deleteUser(uid);
  await deleteAccount(uid);
  const response = {
    ...EMAIL_RESPONSES.userDeleted,
    replace: {},
  };
  await sendEmailResponse(sender, email, response, true);
  return `${uid} account deleted.`;
}


async function removeEmailAddressFromUser(email, sender, uid) {
  // TODO: Make sure sender is the main account? Let's see if this goes wrong.
  const subject = email.subject;
  const emailRegex = /^remove\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})$/;
  const match = subject.match(emailRegex);
  if (!match) {
    logger.log(`Email that starts with 'remove' but doesn't 
      have a valid email address after it.`);
    return await eventHandler(email, sender, uid);
  }
  const emailAddressToRemove = match[1];
  // Check if the email address is already added.
  // If not, add it to the pending email address list.
  const existingUid = await getUserFromEmail(emailAddressToRemove);
  if (existingUid !== uid) {
    logger.error(`${uid} attempted to remove 
      ${emailAddressToRemove}, but registered to ${existingUid}`);
    const response = {
      ...EMAIL_RESPONSES.removalEmailInUse,
      replace: {
        EMAIL_TO_REMOVE: emailAddressToRemove,
      },
    };
    logger.log(`Sending email additionalEmailInUse to ${sender}`);
    return await sendEmailResponse(sender, email, response, true);
  } else {
    await removeEmailAddress(emailAddressToRemove);
    logger.log(`${uid} to removed
      ${emailAddressToRemove}, uid ${existingUid}`);
    const response = {
      ...EMAIL_RESPONSES.emailAddressRemoved,
      replace: {
        EMAIL_TO_REMOVE: emailAddressToRemove,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    return `${emailAddressToRemove} removed.`;
  }
}

async function addEmailAddressToUser(email, sender, uid) {
  // TODO: Make sure sender is the main account? Let's see if this goes wrong.
  const subject = email.subject;
  const emailRegex = /^add\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})$/;
  const match = subject.match(emailRegex);
  if (!match) {
    logger.log(`Email that starts with 'add' but doesn't 
      have a valid email address after it.`);
    return await eventHandler(email, sender, uid);
  }
  const emailAddressToAdd = match[1];
  // Check if the email address is already added.
  // If not, add it to the pending email address list.
  const existingUid = await getUserFromEmail(emailAddressToAdd);
  if (existingUid) {
    logger.error(`${uid} attempted to add 
      ${emailAddressToAdd}, but already registered to ${existingUid}`);
    const response = {
      ...EMAIL_RESPONSES.additionalEmailInUse,
      replace: {
        EMAIL_TO_ADD: emailAddressToAdd,
      },
    };
    logger.log(`Sending email additionalEmailInUse to ${sender}`);
    return await sendEmailResponse(sender, email, response, true);
  }
  const verificationCode = await addPendingEmailAddress(uid, emailAddressToAdd);
  // Send email to the user with the verification code.
  const response = {
    ...EMAIL_RESPONSES.addAdditionalEmailAddress,
    replace: {
      VERIFICATION_CODE: verificationCode,
      ORIGINATOR_EMAIL: sender,
    },
  };
  logger.log(
      // eslint-disable-next-line max-len
      `Sending email addAdditionalEmailAddress ${emailAddressToAdd} to pending list for ${uid}`);
  await sendEmailResponse(emailAddressToAdd, email, response, false);
  return {verificationCode};
}

async function eventHandler(email, sender, uid, files) {
  // logger.log("User ID: ", uid);

  // Can we authenticate with their calendar?
  const [oauthErr, oauth2Client] = await handleAsync(() => getOauthClient(uid));
  if (oauthErr) {
    logger.error("Error getting OAuth client: ", oauthErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed, true);
    return;
  }

  // Is there an ICS attachment to the email?
  let event;
  if (files && files.length > 0) {
    logger.debug("Checking attachments for an ICS file");
    console.log(files);
    const icsFile = files.find((file) => file.filename.filename.endsWith(".ics"));
    if (icsFile) {
      logger.debug("ICS file found");
      const [icsErr, icsEvent] = await handleAsync(() => eventFromICS(icsFile));
      if (icsErr) {
        logger.error("ICS error: ", icsErr);
      } else {
        event = icsEvent;
      }
    } else {
      logger.debug("No ICS file found, using regular AI.");
    }
  }

  if (!event) {
    // Can we get event details from the thread with AI?
    const headers = getEmailHeaders(email.headers, ["Date", "Subject", "From"]);
    const [processEmailErr, aiEvent] = await handleAsync(() => processEmail(email, headers));
    if (processEmailErr) {
      logger.error("OpenAI error: ", processEmailErr);
      await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
      return;
    }
    if (aiEvent.error) {
      const response = {
        ...EMAIL_RESPONSES.aiParseError,
        replace: {
          PARSE_ERROR_DESCRIPTION: event.description,
        },
      };
      logger.error("Error in email contents: ", event);
      await sendEmailResponse(sender, email, response, true);
      return aiEvent;
    } else {
      event = aiEvent;
    }
  }
  return addEventAndSendResponse(oauth2Client, event, uid, sender, email);
}

async function addEventAndSendResponse(oauth2Client, event, uid, sender, email) {
  // Can we add the event to their calendar?
  const [addEventErr, eventObject] =
    await handleAsync(() => addEvent(oauth2Client, event, uid));
  if (addEventErr) {
    logger.error("Error adding event to calendar: ", addEventErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
    return;
  }
  let response;

  // Now we check if we need to add a button to the email
  // so additional attendees can be invited.
  if (event.attendees.length > 1) {
    logger.debug(`Multiple attendees - invite link to email.`);
    const params = {
      eventId: eventObject.id,
      calendarId: eventObject.calendarId,
      uid: uid,
      attendees: event.attendees,
    };
    const inviteLink = `${API_URL}inviteAdditionalAttendees?${qs.stringify(params)}`;
    eventObject.inviteOthersLink = inviteLink;
    const inviteesWithoutHost = event.attendees.filter((attendee) => attendee !== eventObject.organizer.email);
    response = {
      ...EMAIL_RESPONSES.eventAddedAttendees,
      replace: {
        EVENT_LINK: eventObject.htmlLink,
        EVENT_DATE: moment(eventObject.start.dateTime)
            .tz(eventObject.start.timeZone)
            .format("dddd, MMMM Do [at] h:mm A"),
        INVITE_LINK: inviteLink,
        EVENT_ATTENDEES: inviteesWithoutHost.join(", "),
      },
    };
  } else {
    logger.debug(`Only one attendee - not invitation link needed.`);
    response = {
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
  }
  await sendEmailResponse(sender, email, response, true);
  return eventObject;
}

function getSenderFromRawEmail(email) {
  let sender;
  try {
    const envelope = JSON.parse(email.envelope);
    sender = envelope.from.toLowerCase();
  } catch (error) {
    logger.error("Error parsing envelope", error);
  }
  return sender;
}

function getRecipientsFromRawEmail(email) {
  let to;
  try {
    const envelope = JSON.parse(email.envelope);
    to = envelope.to;
    to = to.map((email) => email.toLowerCase());
  } catch (error) {
    logger.error("Error parsing envelope", error);
  }
  return to;
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

function getEmailHeaders(header, items) {
  const headers = {};
  try {
    items.forEach((item) => {
      const pattern = new RegExp(`${item}: (.*)`, "g");
      const matches = pattern.exec(header);
      if (matches && matches[1]) {
        headers[item] = matches[1].trim();
      }
    });
  } catch (error) {
    logger.error("Error extracting headers", error);
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
  logger.log("messageType", messageType.templateName);
  let html = mailTemplates[messageType.templateName].html;
  Object.keys(messageType.replace).forEach((key) => {
    html = html.replace(new RegExp(`%${key}%`, "g"), messageType.replace[key]);
  });
  return html;
}

function getSubject(messageType) {
  let subject = mailTemplates[messageType.templateName].subject;
  Object.keys(messageType.replace).forEach((key) => {
    subject = subject.replace(new RegExp(`%${key}%`, "g"), messageType.replace[key]);
  });
  return subject;
}

async function sendEmailResponse(sender,
    originalEmail,
    messageType,
    includeThread) {
  let html = getHtml(messageType);
  let subject = originalEmail.subject;
  if (messageType.subject) {
    subject = getSubject(messageType);
  }
  if (includeThread) {
    html = threadEmailHtml(originalEmail, html);
  }
  await sendEmail({
    to: sender,
    from: MAIN_EMAIL_ADDRESS,
    subject: subject,
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

