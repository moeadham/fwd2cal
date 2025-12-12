import { logger } from "firebase-functions/v2";
import {
  getUserFromEmail,
  getUserFromUID,
  addPendingEmailAddress,
  removeEmailAddress,
  deleteUser,
} from "./firestoreHandler";
import { getOauthClient, deleteAccount } from "./authHandler";
import { processEmail } from "./openai";
import {
  addEvent,
  eventFromICS,
  getUserCalendars,
  formatCalendarForLLM,
} from "./calendarHelper";
import { sendEmailResend, removeContactFromSegment } from "./resend";
import { getApiUrl } from "./credentials";
import {
  ENVIRONMENT_NAME,
  MAIN_EMAIL_ADDRESS,
  RESEND_REGISTERED_USERS_SEGMENT_ID,
} from "./config";
import handleAsync from "./handleAsync";
import { mailTemplates } from "./mailTemplates";
import moment from "moment-timezone";
import qs from "qs";
import { sendEvent } from "./analytics";
import {
  TransformedEmail,
  ICSFile,
  EmailResponseTemplate,
  HandleEmailResult,
  Event,
  EventValidationResult,
  GoogleCalendarEvent,
  CalendarForLLM,
  FailedEvent,
  EmailThreadHeaders,
} from "../types";
import { Auth } from "googleapis";

interface EmailResponses {
  [key: string]: EmailResponseTemplate;
}

const EMAIL_RESPONSES: EmailResponses = {
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
      CALENDAR_NAME: "",
    },
  },
  eventAddedAttendees: {
    templateName: "eventAddedAttendees",
    replace: {
      EVENT_LINK: "",
      EVENT_DATE: "",
      INVITE_LINK: "",
      EVENT_ATTENDEES: "",
      CALENDAR_NAME: "",
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

async function handleEmail(
  email: TransformedEmail,
  files: ICSFile[],
  imageUrls: string[] = []
): Promise<HandleEmailResult | GoogleCalendarEvent | GoogleCalendarEvent[] | undefined> {
  // Do we know this user?
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    return { error: "No sender found" };
  }

  // Is the email sender verified?
  if (!verifyEmail(email)) {
    logger.warn("Unverified Email");
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.unverifiedEmail,
      replace: {
        FROM_EMAIL: sender,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    return { error: "Unverified email address" };
  }

  // Is this a support email?
  const to = getRecipientsFromRawEmail(email);
  if (
    to.includes("support@fwd2cal.com") ||
    to.includes("admin@fwd2cal.com") ||
    (email.subject &&
      email.subject.toLowerCase().startsWith("verify your email address"))
  ) {
    // To handle google account creation.
    return await sendToSupport(sender, email);
  }

  const uid = await getUserFromEmail(sender);
  if (!uid) {
    logger.warn(`No User found with ${sender}`);
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.noUserFound,
      replace: {
        FROM_EMAIL: sender,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    sendEvent(sender, "userInvited");
    return { result: `${sender} has been invited to signup` };
  }

  const subjectAction = understandSubject(email.subject);
  logger.log(`Request from ${sender} to ${subjectAction}`);
  // Track all received emails with the action type
  sendEvent(uid, "emailReceived", { action: subjectAction });

  switch (subjectAction) {
    case "addUser":
      return await addEmailAddressToUser(email, sender, uid, files);
    case "removeEmail":
      return await removeEmailAddressFromUser(email, sender, uid, files);
    case "deleteAccount":
      return await deleteUserAccount(email, sender, uid);
    case "addEvent":
      return await eventHandler(email, sender, uid, files, imageUrls);
    default:
      return await eventHandler(email, sender, uid, files, imageUrls);
  }
}

async function sendToSupport(
  sender: string,
  email: TransformedEmail
): Promise<HandleEmailResult> {
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
  return { result: `email forwarded to support group.` };
}

function understandSubject(subject: string): string {
  if (!subject) subject = "";
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

async function deleteUserAccount(
  email: TransformedEmail,
  sender: string,
  uid: string
): Promise<HandleEmailResult> {
  // Get primary email address before deleting user
  const user = await getUserFromUID(uid);
  const primaryEmail = user.email;

  await deleteUser(uid);
  await deleteAccount(uid);

  // Remove primary email from registered users segment (fire-and-forget)
  removeContactFromSegment(
    primaryEmail,
    RESEND_REGISTERED_USERS_SEGMENT_ID.value()
  );

  const response: EmailResponseTemplate = {
    ...EMAIL_RESPONSES.userDeleted,
    replace: {},
  };
  await sendEmailResponse(sender, email, response, true);
  sendEvent(uid, "deleteAccount");
  return { result: `${uid} account deleted.` };
}

async function removeEmailAddressFromUser(
  email: TransformedEmail,
  sender: string,
  uid: string,
  files: ICSFile[] = []
): Promise<HandleEmailResult | GoogleCalendarEvent | GoogleCalendarEvent[] | undefined> {
  const subject = email.subject;
  const emailRegex =
    /^remove\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})$/;
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
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.removalEmailInUse,
      replace: {
        EMAIL_TO_REMOVE: emailAddressToRemove,
      },
    };
    logger.log(`Sending email additionalEmailInUse to ${sender}`);
    sendEvent(uid, "removeEmailFailed", { reason: "not_owned" });
    await sendEmailResponse(sender, email, response, true);
    return;
  } else {
    await removeEmailAddress(emailAddressToRemove);
    logger.log(`${uid} to removed
      ${emailAddressToRemove}, uid ${existingUid}`);
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.emailAddressRemoved,
      replace: {
        EMAIL_TO_REMOVE: emailAddressToRemove,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    sendEvent(uid, "removeEmail");
    return { result: `${emailAddressToRemove} removed.` };
  }
}

async function addEmailAddressToUser(
  email: TransformedEmail,
  sender: string,
  uid: string,
  files: ICSFile[] = []
): Promise<HandleEmailResult | GoogleCalendarEvent | GoogleCalendarEvent[] | undefined> {
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
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.additionalEmailInUse,
      replace: {
        EMAIL_TO_ADD: emailAddressToAdd,
      },
    };
    logger.log(`Sending email additionalEmailInUse to ${sender}`);
    sendEvent(uid, "addUserFailed", { reason: "email_in_use" });
    await sendEmailResponse(sender, email, response, true);
    return;
  }
  const verificationCode = await addPendingEmailAddress(uid, emailAddressToAdd);
  // Send email to the user with the verification code.
  const response: EmailResponseTemplate = {
    ...EMAIL_RESPONSES.addAdditionalEmailAddress,
    replace: {
      VERIFICATION_CODE: verificationCode,
      ORIGINATOR_EMAIL: sender,
    },
  };
  logger.log(
    `Sending email addAdditionalEmailAddress ${emailAddressToAdd} to pending list for ${uid}`
  );
  await sendEmailResponse(emailAddressToAdd, email, response, false);
  sendEvent(uid, "addUserRequest");
  return { verificationCode };
}

async function eventHandler(
  email: TransformedEmail,
  sender: string,
  uid: string,
  files: ICSFile[] = [],
  imageUrls: string[] = []
): Promise<GoogleCalendarEvent | GoogleCalendarEvent[] | undefined> {
  // Can we authenticate with their calendar?
  const [oauthErr, oauth2Client] = await handleAsync(() => getOauthClient(uid));
  if (oauthErr || !oauth2Client) {
    logger.warn("Error getting OAuth client: ", oauthErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed, true);
    sendEvent(uid, "calendarError", { reason: "oauth_failed" });
    return;
  }

  // Fetch user's calendars for LLM context
  let calendarsForLLM: CalendarForLLM[] = [];
  try {
    const calendars = await getUserCalendars(oauth2Client, uid);
    calendarsForLLM = calendars.map(formatCalendarForLLM);
    logger.log(`Fetched ${calendarsForLLM.length} calendars for user ${uid}`);
    logger.log("Calendars for LLM:", JSON.stringify(calendarsForLLM, null, 2));
  } catch (calendarErr) {
    logger.warn(
      "Error fetching calendars, continuing without calendar list: ",
      calendarErr
    );
    // Continue without calendar list - will default to primary calendar
  }

  // Is there an ICS attachment to the email?
  let event: Event | undefined;
  if (files && files.length > 0) {
    logger.debug("Checking attachments for an ICS file");
    const icsFile = files.find((file) =>
      file.filename.filename.endsWith(".ics")
    );
    if (icsFile) {
      logger.debug("ICS file found");
      const [icsErr, icsEvent] = await handleAsync(() => eventFromICS(icsFile));
      if (icsErr) {
        logger.warn("ICS error: ", icsErr);
        sendEvent(uid, "icsProcessingFailed", { reason: "parse_failed" });
      } else if (icsEvent) {
        event = {
          summary: icsEvent.summary,
          location: icsEvent.location || null,
          description: icsEvent.description || null,
          conference_call: !!icsEvent.conference_call,
          date: icsEvent.date,
          start_time: icsEvent.start_time,
          end_time: icsEvent.end_time || null,
          attendees: icsEvent.attendees,
          timeZone: icsEvent.timezone,
        };
      }
    } else {
      logger.debug("No ICS file found, using regular AI.");
    }
  }

  if (!event) {
    // Can we get event details from the thread with AI?
    const headers = getEmailHeaders(email.headers, ["date", "subject", "from"]);
    const [processEmailErr, aiEvent] = await handleAsync(() =>
      processEmail(email, headers, uid, imageUrls, calendarsForLLM)
    );
    if (processEmailErr) {
      logger.warn("OpenAI error: ", processEmailErr);
      await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
      sendEvent(uid, "dataQualityIssue", { reason: "ai_api_error" });
      return;
    }

    if (!aiEvent) {
      logger.warn("No event data returned from AI");
      await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
      sendEvent(uid, "dataQualityIssue", { reason: "no_ai_response" });
      return;
    }

    if (aiEvent.error) {
      const parseError = aiEvent.description || "";
      const response: EmailResponseTemplate = {
        ...EMAIL_RESPONSES.aiParseError,
        replace: {
          PARSE_ERROR_DESCRIPTION: parseError,
        },
      };
      logger.warn("Error in email contents: ", aiEvent);
      await sendEmailResponse(sender, email, response, true);
      sendEvent(uid, "dataQualityIssue", { reason: "ai_returned_error" });
      return;
    } else {
      // Handle new array format
      if (aiEvent.events && Array.isArray(aiEvent.events)) {
        if (aiEvent.events.length === 0) {
          logger.warn("No events found in email");
          await sendEmailResponse(
            sender,
            email,
            EMAIL_RESPONSES.unableToParse,
            true
          );
          sendEvent(uid, "dataQualityIssue", { reason: "no_events_found" });
          return;
        }

        // Validate all events
        const invalidEvents: number[] = [];
        for (let i = 0; i < aiEvent.events.length; i++) {
          const ev = aiEvent.events[i];
          const timeValidation = validateEventTimes(ev);
          if (!timeValidation.isValid) {
            logger.warn(
              `Invalid event times from AI for event ${i + 1}: ${timeValidation.error}`
            );
            invalidEvents.push(i);
          }
        }

        // Remove invalid events
        if (invalidEvents.length > 0) {
          aiEvent.events = aiEvent.events.filter(
            (_, index) => !invalidEvents.includes(index)
          );
        }

        if (aiEvent.events.length === 0) {
          logger.warn("All events had invalid times");
          sendEvent(uid, "dataQualityIssue", {
            reason: "missing_required_fields",
          });
          await sendEmailResponse(
            sender,
            email,
            EMAIL_RESPONSES.unableToParse,
            true
          );
          return;
        }

        // Process multiple events
        return addEventsAndSendResponse(
          oauth2Client,
          aiEvent.events,
          uid,
          sender,
          email
        );
      } else {
        // Old single event format (backward compatibility)
        const singleEvent = aiEvent as unknown as Event;

        // Validate event times before proceeding
        const timeValidation = validateEventTimes(singleEvent);
        if (!timeValidation.isValid) {
          logger.warn(`Invalid event times from AI: ${timeValidation.error}`);
          sendEvent(uid, "dataQualityIssue", {
            reason: "missing_required_fields",
          });
          await sendEmailResponse(
            sender,
            email,
            EMAIL_RESPONSES.unableToParse,
            true
          );
          return;
        }

        // Convert to array format
        return addEventsAndSendResponse(
          oauth2Client,
          [singleEvent],
          uid,
          sender,
          email
        );
      }
    }
  }

  // Handle ICS event (convert to array format)
  return addEventsAndSendResponse(oauth2Client, [event], uid, sender, email);
}

function validateEventTimes(event: Event): EventValidationResult {
  if (!event.date || !event.start_time) {
    return { isValid: false, error: "Missing required date or start_time" };
  }

  // Try to parse the start time
  const startTime = `${event.date} ${event.start_time}`;
  const startDate = moment.tz(
    startTime,
    "DD MMMM YYYY HH:mm",
    event.timeZone || "UTC"
  );

  if (!startDate.isValid()) {
    return {
      isValid: false,
      error: `Invalid start date/time: ${event.date} ${event.start_time}`,
    };
  }

  // If end_time is provided, validate it too
  if (event.end_time) {
    const endTime = `${event.date} ${event.end_time}`;
    const endDate = moment.tz(
      endTime,
      "DD MMMM YYYY HH:mm",
      event.timeZone || "UTC"
    );

    if (!endDate.isValid()) {
      logger.warn(
        `Invalid end time, will use default duration: ${event.end_time}`
      );
      event.end_time = null; // Remove invalid end time
    } else if (endDate.isSameOrBefore(startDate)) {
      logger.warn(
        `End time is not after start time, will use default duration: ${event.end_time}`
      );
      event.end_time = null; // Remove invalid end time
    }
  }

  return { isValid: true };
}

function isValidEmail(email: string): boolean {
  // Email validation regex that supports + character and other common email patterns
  const emailRegex = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

async function addEventsAndSendResponse(
  oauth2Client: Auth.OAuth2Client,
  events: Event[],
  uid: string,
  sender: string,
  email: TransformedEmail
): Promise<GoogleCalendarEvent | GoogleCalendarEvent[] | undefined> {
  const successfulEvents: GoogleCalendarEvent[] = [];
  const failedEvents: FailedEvent[] = [];

  // Process each event
  for (const event of events) {
    // Filter out invalid email addresses from attendees
    const validAttendees = event.attendees.filter((attendee) => {
      const isValid = isValidEmail(attendee);
      if (!isValid) {
        logger.warn(
          `Dropping invalid email address from attendees: ${attendee}`
        );
      }
      return isValid;
    });

    // Update event with filtered attendees
    event.attendees = validAttendees;

    // Try to add the event to their calendar
    const [addEventErr, eventObject] = await handleAsync(() =>
      addEvent(oauth2Client, event, uid)
    );

    if (addEventErr || !eventObject) {
      logger.warn(
        `Error adding event "${event.summary}" to calendar: `,
        addEventErr
      );
      failedEvents.push({
        event: { summary: event.summary, attendees: event.attendees },
        error: addEventErr?.message || "Unknown error",
      });
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
    sendEvent(uid, "calendarError", { reason: "oauth_failed" });
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed, true);
    return;
  }

  // Build response with all successful events
  let responseHtml = "";

  for (const eventObject of successfulEvents) {
    const eventDate = moment(eventObject.start.dateTime)
      .tz(eventObject.start.timeZone)
      .format("dddd, MMMM Do [at] h:mm A z");

    responseHtml += `<p><strong>${eventObject.summary}</strong><br>`;
    responseHtml += `Date: ${eventDate}<br>`;
    if (eventObject.location) {
      responseHtml += `Location: ${eventObject.location}<br>`;
    }

    // Add calendar name if not primary
    if (!eventObject.isPrimaryCalendar && eventObject.calendarName) {
      responseHtml += `Calendar: ${eventObject.calendarName}<br>`;
    }

    // Check if any event has multiple attendees
    if (eventObject.attendees && eventObject.attendees.length > 1) {
      const attendeeEmails = eventObject.attendees
        .map((a) => a.email)
        .join(", ");
      responseHtml += `Attendees: ${attendeeEmails}<br>`;
    }

    responseHtml += `<a href="${eventObject.htmlLink}" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View Event</a>`;

    // Add invite button if there are multiple attendees and an invite link
    if (eventObject.inviteOthersLink) {
      const inviteesWithoutHost = eventObject.attendees?.filter(
        (attendee) => attendee.email !== eventObject.organizer?.email
      );
      if (inviteesWithoutHost && inviteesWithoutHost.length > 0) {
        responseHtml += `<br>You may want to invite: ${inviteesWithoutHost.map((a) => a.email).join(", ")}<br>`;
        responseHtml += `<a href="${eventObject.inviteOthersLink}" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Invite Guests</a>`;
      }
    }

    responseHtml += "</p><hr>";
  }

  // Add failed events info if any
  if (failedEvents.length > 0) {
    sendEvent(uid, "addEventPartialFailure");
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

    // Determine calendar name to display (only if not primary)
    const calendarNameText = eventObject.isPrimaryCalendar
      ? ""
      : `<br>Calendar: ${eventObject.calendarName}`;

    let response: EmailResponseTemplate;
    if (eventObject.inviteOthersLink) {
      const inviteesWithoutHost =
        eventObject.inviteOthersAttendees?.filter(
          (emailAddr) => emailAddr !== eventObject.organizer?.email
        ) || [];

      response = {
        ...EMAIL_RESPONSES.eventAddedAttendees,
        replace: {
          EVENT_LINK: eventObject.htmlLink,
          EVENT_DATE: moment(eventObject.start.dateTime)
            .tz(eventObject.start.timeZone)
            .format("dddd, MMMM Do [at] h:mm A z"),
          INVITE_LINK: eventObject.inviteOthersLink,
          EVENT_ATTENDEES: inviteesWithoutHost.join(", "),
          CALENDAR_NAME: calendarNameText,
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
          EVENT_ATTENDEES: eventObject.attendees
            ? eventObject.attendees.map((attendee) => attendee.email).join(", ")
            : "",
          CALENDAR_NAME: calendarNameText,
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

function getSenderFromRawEmail(email: TransformedEmail): string | undefined {
  return email.from ? email.from.toLowerCase() : undefined;
}

function getRecipientsFromRawEmail(email: TransformedEmail): string[] {
  const to = email.to || [];
  return to.map((emailAddr) => emailAddr.toLowerCase());
}

function getEmailThreadHeaders(
  headers: Record<string, string>
): EmailThreadHeaders {
  // Extract incoming Message-ID and existing References from the email
  const extracted = getEmailHeaders(headers, ["Message-ID", "References"]);

  const messageId = extracted["Message-ID"];
  const existingReferences = extracted["References"];

  const threadHeaders: EmailThreadHeaders = {};

  // Build proper threading headers for the reply
  if (messageId) {
    // Set In-Reply-To to the incoming message's ID
    threadHeaders["In-Reply-To"] = messageId;

    // Build References chain: existing references + incoming message ID
    if (existingReferences) {
      threadHeaders["References"] = `${existingReferences} ${messageId}`;
    } else {
      threadHeaders["References"] = messageId;
    }
  }

  return threadHeaders;
}

function getEmailHeaders(
  headers: Record<string, string>,
  items: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    // Handle if headers is not an object
    if (!headers || typeof headers !== "object") {
      return result;
    }

    items.forEach((item) => {
      // Case-insensitive key lookup
      const key = Object.keys(headers).find(
        (k) => k.toLowerCase() === item.toLowerCase()
      );
      if (key && headers[key]) {
        // Trim if it's a string, otherwise return as-is
        result[item] =
          typeof headers[key] === "string" ? headers[key].trim() : headers[key];
      }
    });
  } catch (error) {
    logger.warn("Error extracting headers", error);
  }
  return result;
}

/**
 * Strip base64-encoded images from HTML
 * Resend doesn't allow sending emails with inline base64 images
 */
function stripBase64Images(html: string): string {
  if (!html) return html;

  // Remove <img src="data:image/..."> tags
  // Match both single and double quotes, and handle potential whitespace
  return html.replace(
    /<img[^>]*\ssrc\s*=\s*["']data:image\/[^"']*["'][^>]*>/gi,
    "[Image removed]"
  );
}

function threadEmailHtml(original: TransformedEmail, html: string): string {
  if (!html) html = "";
  try {
    // Parse sender information from headers
    let senderDisplay = original.from;
    if (original.headers && original.headers.from) {
      // Remove outer quotes if present: "\"Name\" <email>" -> "Name" <email>
      const fromHeader = original.headers.from.replace(/^"(.*)"$/, "$1");
      // Extract name and email from format: "Name <email>" or just "email"
      const match = fromHeader.match(/^(.+?)\s*<(.+?)>$/);
      if (match) {
        senderDisplay = `${match[1].replace(/^"|"$/g, "")} <${match[2]}>`;
      } else {
        senderDisplay = fromHeader;
      }
    }

    // Parse date from headers
    let formattedDate = "";
    let formattedTime = "";
    if (original.headers && original.headers.date) {
      // Remove outer quotes if present: "\"2025-11-10T06:47:51.000Z\"" -> ISO date
      const dateString = original.headers.date.replace(/^"(.*)"$/, "$1");
      // Use moment's RFC2822 parsing with strict mode to avoid deprecation warnings
      const dateMoment = moment(dateString, moment.RFC_2822, true).isValid()
        ? moment(dateString, moment.RFC_2822, true)
        : moment(dateString); // Fallback for ISO dates
      if (dateMoment.isValid()) {
        formattedDate = dateMoment.utc().format("ddd, MMM D, YYYY");
        formattedTime = dateMoment.utc().format("h:mm A") + " UTC";
      }
    }

    // Strip base64 images from original HTML before including in response
    const cleanedHtml = stripBase64Images(original.html);

    // If we successfully parsed date and sender, create Gmail-style threading
    if (formattedDate && formattedTime) {
      const threadLine = `On ${formattedDate}, at ${formattedTime}, ${senderDisplay} wrote:`;
      return `${html}<br>
<div class="gmail_quote">
<div dir="ltr" class="gmail_attr">
${threadLine}<br>
</div>
<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left-width:1px;border-left-style:solid;padding-left:1ex;border-left-color:rgb(204,204,204)">
${cleanedHtml}
</blockquote>
</div>`;
    }
  } catch (error) {
    logger.warn("Error threading email HTML", error);
  }

  // Fallback to simple concatenation if anything fails
  // Make sure to strip base64 images here too
  return `${html}${stripBase64Images(original.html)}`;
}

function getHtml(messageType: EmailResponseTemplate): string {
  logger.log("messageType", messageType.templateName);
  const template =
    mailTemplates[messageType.templateName as keyof typeof mailTemplates];
  let html = template.html;
  Object.keys(messageType.replace).forEach((key) => {
    html = html.replace(new RegExp(`%${key}%`, "g"), messageType.replace[key]);
  });
  return html;
}

function getSubject(messageType: EmailResponseTemplate): string {
  const template =
    mailTemplates[messageType.templateName as keyof typeof mailTemplates];
  let subject = template.subject || "";
  Object.keys(messageType.replace).forEach((key) => {
    subject = subject.replace(
      new RegExp(`%${key}%`, "g"),
      messageType.replace[key]
    );
  });
  return subject;
}

async function sendEmailResponse(
  sender: string,
  originalEmail: TransformedEmail,
  messageType: EmailResponseTemplate,
  includeThread: boolean
): Promise<void> {
  let html = getHtml(messageType);
  let subject = originalEmail.subject || "Re: ";
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

function verifyEmail(email: TransformedEmail): boolean {
  // Log incoming email verification data
  logger.info("Email verification check", {
    from: email.from,
    SPF: email.SPF,
    dkim: email.dkim,
  });

  if (email.SPF !== "pass") {
    logger.warn("Email verification failed: SPF check failed", {
      from: email.from,
      SPF: email.SPF,
      expected: "pass",
    });
    sendEvent(email.from, "emailRejected", { reason: "spf_failed" });
    return false;
  }

  if (email.dkim.indexOf("pass") === -1) {
    logger.warn("Email verification failed: DKIM check failed", {
      from: email.from,
      dkim: email.dkim,
      containsPass: email.dkim.indexOf("pass") !== -1,
    });
    sendEvent(email.from, "emailRejected", { reason: "dkim_failed" });
    return false;
  }

  logger.info("Email verification passed", {
    from: email.from,
  });

  return true;
}

export { handleEmail };
