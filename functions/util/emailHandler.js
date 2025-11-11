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
const sendEmailResend = require("./resend");
const {MAIN_EMAIL_ADDRESS, getApiUrl} = require("./credentials");
const {ENVIRONMENT_NAME} = require("./config");
const handleAsync = require("./handleAsync");
const {mailTemplates} = require("./mailTemplates");
const moment = require("moment-timezone");
const qs = require("qs");
const {sendEvent} = require("./analytics");


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
    logger.warn("Unverified Email");
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
    logger.warn(`No User found with ${sender}`);
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
  sendEvent(uid, subjectAction);
  switch (subjectAction) {
    case "addUser":
      return await addEmailAddressToUser(email, sender, uid, files);
    case "removeEmail":
      return await removeEmailAddressFromUser(email, sender, uid, files);
    case "deleteAccount":
      return await deleteUserAccount(email, sender, uid, files);
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
  await sendEmailResend({
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

async function deleteUserAccount(email, sender, uid, files = []) {
  await deleteUser(uid);
  await deleteAccount(uid);
  const response = {
    ...EMAIL_RESPONSES.userDeleted,
    replace: {},
  };
  await sendEmailResponse(sender, email, response, true);
  return `${uid} account deleted.`;
}


async function removeEmailAddressFromUser(email, sender, uid, files = []) {
  // TODO: Make sure sender is the main account? Let's see if this goes wrong.
  const subject = email.subject;
  const emailRegex = /^remove\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})$/;
  const match = subject.match(emailRegex);
  if (!match) {
    logger.log(`Email that starts with 'remove' but doesn't 
      have a valid email address after it.`);
    logger.log(`Subject: ${email.subject}`);
    return await eventHandler(email, sender, uid, files);
  }
  const emailAddressToRemove = match[1];
  // Check if the email address is already added.
  // If not, add it to the pending email address list.
  const existingUid = await getUserFromEmail(emailAddressToRemove);
  if (existingUid !== uid) {
    logger.warn(`${uid} attempted to remove 
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

async function addEmailAddressToUser(email, sender, uid, files = []) {
  // TODO: Make sure sender is the main account? Let's see if this goes wrong.
  const subject = email.subject;
  const emailRegex = /^add\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})$/;
  const match = subject.match(emailRegex);
  if (!match) {
    logger.log(`Email that starts with 'add' but doesn't 
      have a valid email address after it.`);
    return await eventHandler(email, sender, uid, files);
  }
  const emailAddressToAdd = match[1];
  // Check if the email address is already added.
  // If not, add it to the pending email address list.
  const existingUid = await getUserFromEmail(emailAddressToAdd);
  if (existingUid) {
    logger.warn(`${uid} attempted to add 
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

async function eventHandler(email, sender, uid, files = []) {
  // logger.log("User ID: ", uid);

  // Can we authenticate with their calendar?
  const [oauthErr, oauth2Client] = await handleAsync(() => getOauthClient(uid));
  if (oauthErr) {
    logger.warn("Error getting OAuth client: ", oauthErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed, true);
    sendEvent(uid, "addEvent", {result: "oauthFailed"});
    return;
  }

  // Is there an ICS attachment to the email?
  let event;
  if (files && files.length > 0) {
    logger.debug("Checking attachments for an ICS file");
    const icsFile = files.find((file) => file.filename.filename.endsWith(".ics"));
    if (icsFile) {
      logger.debug("ICS file found");
      const [icsErr, icsEvent] = await handleAsync(() => eventFromICS(icsFile));
      if (icsErr) {
        logger.warn("ICS error: ", icsErr);
      } else {
        event = icsEvent;
      }
    } else {
      logger.debug("No ICS file found, using regular AI.");
    }
  }

  if (!event) {
    // Can we get event details from the thread with AI?
    const headers = getEmailHeaders(email.headers, ["date", "subject", "from"]);
    const [processEmailErr, aiEvent] = await handleAsync(() => processEmail(email, headers));
    if (processEmailErr) {
      logger.warn("OpenAI error: ", processEmailErr);
      await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
      sendEvent(uid, "addEvent", {result: "aiUnableToParse"});
      return;
    }
    if (aiEvent.error) {
      const parseError = aiEvent.description || "";
      const response = {
        ...EMAIL_RESPONSES.aiParseError,
        replace: {
          PARSE_ERROR_DESCRIPTION: parseError,
        },
      };
      logger.warn("Error in email contents: ", aiEvent);
      await sendEmailResponse(sender, email, response, true);
      sendEvent(uid, "addEvent", {result: "aiUnableToParse"});
      return aiEvent;
    } else {
      // Handle new array format
      if (aiEvent.events && Array.isArray(aiEvent.events)) {
        if (aiEvent.events.length === 0) {
          logger.warn("No events found in email");
          await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
          sendEvent(uid, "addEvent", {result: "aiUnableToParse"});
          return;
        }

        // Validate all events
        const invalidEvents = [];
        for (let i = 0; i < aiEvent.events.length; i++) {
          const event = aiEvent.events[i];
          const timeValidation = validateEventTimes(event);
          if (!timeValidation.isValid) {
            logger.warn(`Invalid event times from AI for event ${i + 1}: ${timeValidation.error}`);
            invalidEvents.push(i);
          }
        }

        // Remove invalid events
        if (invalidEvents.length > 0) {
          aiEvent.events = aiEvent.events.filter((_, index) => !invalidEvents.includes(index));
        }

        if (aiEvent.events.length === 0) {
          logger.warn("All events had invalid times");
          await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
          sendEvent(uid, "addEvent", {result: "aiUnableToParse"});
          return;
        }

        // Process multiple events
        return addEventsAndSendResponse(oauth2Client, aiEvent.events, uid, sender, email);
      } else {
        // Old single event format (backward compatibility)
        event = aiEvent;

        // Validate event times before proceeding
        const timeValidation = validateEventTimes(event);
        if (!timeValidation.isValid) {
          logger.warn(`Invalid event times from AI: ${timeValidation.error}`);
          await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
          sendEvent(uid, "addEvent", {result: "aiUnableToParse"});
          return;
        }

        // Convert to array format
        return addEventsAndSendResponse(oauth2Client, [event], uid, sender, email);
      }
    }
  }

  // Handle ICS event (convert to array format)
  return addEventsAndSendResponse(oauth2Client, [event], uid, sender, email);
}

function validateEventTimes(event) {
  const moment = require("moment-timezone");

  if (!event.date || !event.start_time) {
    return {isValid: false, error: "Missing required date or start_time"};
  }

  // Try to parse the start time
  const startTime = `${event.date} ${event.start_time}`;
  const startDate = moment.tz(startTime, "DD MMMM YYYY HH:mm", event.timeZone || "UTC");

  if (!startDate.isValid()) {
    return {isValid: false, error: `Invalid start date/time: ${event.date} ${event.start_time}`};
  }

  // If end_time is provided, validate it too
  if (event.end_time) {
    const endTime = `${event.date} ${event.end_time}`;
    const endDate = moment.tz(endTime, "DD MMMM YYYY HH:mm", event.timeZone || "UTC");

    if (!endDate.isValid()) {
      logger.warn(`Invalid end time, will use default duration: ${event.end_time}`);
      event.end_time = undefined; // Remove invalid end time
    } else if (endDate.isSameOrBefore(startDate)) {
      logger.warn(`End time is not after start time, will use default duration: ${event.end_time}`);
      event.end_time = undefined; // Remove invalid end time
    }
  }

  return {isValid: true};
}

function isValidEmail(email) {
  // Email validation regex that supports + character and other common email patterns
  const emailRegex = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

async function addEventsAndSendResponse(oauth2Client, events, uid, sender, email) {
  const successfulEvents = [];
  const failedEvents = [];

  // Process each event
  for (const event of events) {
    // Filter out invalid email addresses from attendees
    const validAttendees = event.attendees.filter((attendee) => {
      const isValid = isValidEmail(attendee);
      if (!isValid) {
        logger.warn(`Dropping invalid email address from attendees: ${attendee}`);
      }
      return isValid;
    });

    // Update event with filtered attendees
    event.attendees = validAttendees;

    // Try to add the event to their calendar
    const [addEventErr, eventObject] =
      await handleAsync(() => addEvent(oauth2Client, event, uid));

    if (addEventErr) {
      logger.warn(`Error adding event "${event.summary}" to calendar: `, addEventErr);
      failedEvents.push({event, error: addEventErr.message});
    } else {
      // Add invite link if there are multiple attendees
      if (event.attendees && event.attendees.length > 1) {
        const params = {
          eventId: eventObject.id,
          calendarId: eventObject.calendarId,
          uid: uid,
          attendees: event.attendees,
        };
        const apiUrl = getApiUrl(ENVIRONMENT_NAME.value());
        eventObject.inviteOthersLink = `${apiUrl}inviteAdditionalAttendees?${qs.stringify(params)}`;
        eventObject.inviteOthersAttendees = event.attendees;
      }
      successfulEvents.push(eventObject);
    }
  }

  // If all events failed, send oauth failed response
  if (successfulEvents.length === 0) {
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed, true);
    return;
  }

  // Build response with all successful events
  let responseHtml = "";
  // let hasMultipleAttendees = false;

  for (const eventObject of successfulEvents) {
    const eventDate = moment(eventObject.start.dateTime)
        .tz(eventObject.start.timeZone)
        .format("dddd, MMMM Do [at] h:mm A z");

    responseHtml += `<p><strong>${eventObject.summary}</strong><br>`;
    responseHtml += `Date: ${eventDate}<br>`;
    if (eventObject.location) {
      responseHtml += `Location: ${eventObject.location}<br>`;
    }

    // Check if any event has multiple attendees
    if (eventObject.attendees && eventObject.attendees.length > 1) {
      const attendeeEmails = eventObject.attendees.map((a) => a.email).join(", ");
      responseHtml += `Attendees: ${attendeeEmails}<br>`;
    }

    responseHtml += `<a href="${eventObject.htmlLink}" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View Event</a>`;

    // Add invite button if there are multiple attendees and an invite link
    if (eventObject.inviteOthersLink) {
      const inviteesWithoutHost = eventObject.attendees.filter((attendee) => attendee.email !== eventObject.organizer.email);
      if (inviteesWithoutHost.length > 0) {
        responseHtml += `<br>You may want to invite: ${inviteesWithoutHost.map((a) => a.email).join(", ")}<br>`;
        responseHtml += `<a href="${eventObject.inviteOthersLink}" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Invite Guests</a>`;
      }
    }

    responseHtml += "</p><hr>";
  }

  // Add failed events info if any
  if (failedEvents.length > 0) {
    responseHtml += `<p><strong>Failed to add ${failedEvents.length} event(s):</strong><br>`;
    for (const failed of failedEvents) {
      responseHtml += `- ${failed.event.summary}: ${failed.error}<br>`;
    }
    responseHtml += "</p>";
  }

  // Use existing email response system with custom HTML
  if (successfulEvents.length === 1) {
    // Single event - use existing response format
    const eventObject = successfulEvents[0];
    let response;

    if (eventObject.inviteOthersLink) {
      const inviteesWithoutHost = eventObject.inviteOthersAttendees.filter((email) => email !== eventObject.organizer.email);

      response = {
        ...EMAIL_RESPONSES.eventAddedAttendees,
        replace: {
          EVENT_LINK: eventObject.htmlLink,
          EVENT_DATE: moment(eventObject.start.dateTime)
              .tz(eventObject.start.timeZone)
              .format("dddd, MMMM Do [at] h:mm A z"),
          INVITE_LINK: eventObject.inviteOthersLink,
          EVENT_ATTENDEES: inviteesWithoutHost.join(", "),
        },
      };
    } else {
      response = {
        ...EMAIL_RESPONSES.eventAdded,
        replace: {
          EVENT_LINK: eventObject.htmlLink,
          EVENT_DATE: moment(eventObject.start.dateTime)
              .tz(eventObject.start.timeZone)
              .format("dddd, MMMM Do [at] h:mm A z"),
          EVENT_ATTENDEES: eventObject.attendees ? eventObject.attendees.map((attendee) => attendee.email).join(", ") : "",
        },
      };
    }

    await sendEmailResponse(sender, email, response, true);
  } else {
    // Multiple events - send custom HTML email
    const customHtml = `
${successfulEvents.length} events added to your calendar.
${responseHtml}
<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>
    `;

    await sendEmailResend({
      to: sender,
      from: MAIN_EMAIL_ADDRESS,
      subject: `Re: ${email.subject}`,
      html: threadEmailHtml(email, customHtml),
      headers: getEmailThreadHeaders(email.headers),
    });
  }

  // Return single event for backward compatibility, array for multiple
  return successfulEvents.length === 1 ? successfulEvents[0] : successfulEvents;
}

function getSenderFromRawEmail(email) {
  return email.from ? email.from.toLowerCase() : undefined;
}

function getRecipientsFromRawEmail(email) {
  const to = email.to || [];
  return Array.isArray(to) ? to.map((email) => email.toLowerCase()) : [to.toLowerCase()];
}

function getEmailThreadHeaders(headers) {
  return getEmailHeaders(headers, ["In-Reply-To", "References"]);
}

function getEmailHeaders(headers, items) {
  const result = {};
  try {
    // Handle if headers is not an object
    if (!headers || typeof headers !== "object") {
      return result;
    }

    items.forEach((item) => {
      // Case-insensitive key lookup
      const key = Object.keys(headers).find((k) =>
        k.toLowerCase() === item.toLowerCase(),
      );
      if (key && headers[key]) {
        // Trim if it's a string, otherwise return as-is
        result[item] = typeof headers[key] === "string" ?
            headers[key].trim() : headers[key];
      }
    });
  } catch (error) {
    logger.warn("Error extracting headers", error);
  }
  return result;
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
  await sendEmailResend({
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

