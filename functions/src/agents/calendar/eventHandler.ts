import {logger} from "firebase-functions/v2";
import {getOauthClient} from "../../auth/authHandler";
import {processEmail} from "./llm";
import {
  addEvent,
  eventFromICS,
  getUserCalendars,
  formatCalendarForLLM,
} from "./calendarHelper";
import {sendEmailResend} from "../../util/resend";
import {getApiUrl} from "../../auth/credentials";
import {
  ENVIRONMENT_NAME,
  MAIN_EMAIL_ADDRESS,
  getSupportEmail,
} from "../../util/config";
import handleAsync from "../../util/handleAsync";
import {
  isValidEmail,
  getEmailHeaders,
  getEmailThreadHeaders,
  threadEmailHtml,
} from "../../util/emailUtils";
import moment from "moment-timezone";
import qs from "qs";
import {sendEvent} from "../../util/analytics";
import {sendEmailResponse, EMAIL_RESPONSES} from "./emailResponseUtils";
import {
  TransformedEmail,
  ICSFile,
  EmailResponseTemplate,
  Event,
  EventValidationResult,
  GoogleCalendarEvent,
  CalendarForLLM,
  FailedEvent,
  ParsedDocument,
} from "./types";
import {Auth} from "googleapis";

export async function eventHandler(
    email: TransformedEmail,
    sender: string,
    uid: string,
    files: ICSFile[] = [],
    imageUrls: string[] = [],
    documents: ParsedDocument[] = [],
): Promise<GoogleCalendarEvent | GoogleCalendarEvent[] | undefined> {
  // Can we authenticate with their calendar?
  const [oauthErr, oauth2Client] = await handleAsync(() => getOauthClient(uid, "calendar"));
  if (oauthErr || !oauth2Client) {
    logger.warn("Error getting OAuth client: ", oauthErr);
    await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed, true);
    sendEvent(uid, "calendarError", {reason: "oauth_failed"});
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
    const errMsg = calendarErr instanceof Error ? calendarErr.message : String(calendarErr);
    const isAuthError =
      errMsg.includes("invalid_grant") ||
      errMsg.includes("Token has been expired") ||
      errMsg.includes("No refresh token") ||
      errMsg.includes("Insufficient Permission") ||
      errMsg.includes("unauthorized_client");
    if (isAuthError) {
      logger.warn("OAuth error fetching calendars: ", calendarErr);
      await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed, true);
      sendEvent(uid, "calendarError", {reason: "oauth_failed"});
      return;
    }
    logger.warn(
        "Error fetching calendars, continuing without calendar list: ",
        calendarErr,
    );
    // Continue without calendar list - will default to primary calendar
  }

  // Is there an ICS attachment to the email?
  let event: Event | undefined;
  if (files && files.length > 0) {
    logger.debug("Checking attachments for an ICS file");
    const icsFile = files.find((file) =>
      file.filename.filename.endsWith(".ics"),
    );
    if (icsFile) {
      logger.debug("ICS file found");
      const [icsErr, icsEvent] = await handleAsync(() => eventFromICS(icsFile));
      if (icsErr) {
        logger.warn("ICS error: ", icsErr);
        sendEvent(uid, "icsProcessingFailed", {reason: "parse_failed"});
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

    // First try without documents
    let [processEmailErr, aiEvent] = await handleAsync(() =>
      processEmail(email, headers, uid, imageUrls, calendarsForLLM),
    );

    // If no events found and we have documents, retry with documents
    const noEventsFound = !processEmailErr && aiEvent &&
      (aiEvent.error || !aiEvent.events || aiEvent.events.length === 0);
    if (noEventsFound && documents.length > 0) {
      logger.info("No events found in email text, retrying with document attachments", {
        documentCount: documents.length,
      });
      [processEmailErr, aiEvent] = await handleAsync(() =>
        processEmail(email, headers, uid, imageUrls, calendarsForLLM, documents),
      );
    }

    if (processEmailErr) {
      logger.warn("OpenAI error: ", processEmailErr);
      await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
      sendEvent(uid, "dataQualityIssue", {reason: "ai_api_error"});
      return;
    }

    if (!aiEvent) {
      logger.warn("No event data returned from AI");
      await sendEmailResponse(sender, email, EMAIL_RESPONSES.unableToParse, true);
      sendEvent(uid, "dataQualityIssue", {reason: "no_ai_response"});
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
      sendEvent(uid, "dataQualityIssue", {reason: "ai_returned_error"});
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
              true,
          );
          sendEvent(uid, "dataQualityIssue", {reason: "no_events_found"});
          return;
        }

        // Validate all events
        const invalidEvents: number[] = [];
        for (let i = 0; i < aiEvent.events.length; i++) {
          const ev = aiEvent.events[i];
          const timeValidation = validateEventTimes(ev);
          if (!timeValidation.isValid) {
            logger.warn(
                `Invalid event times from AI for event ${i + 1}: ${timeValidation.error}`,
            );
            invalidEvents.push(i);
          }
        }

        // Remove invalid events
        if (invalidEvents.length > 0) {
          aiEvent.events = aiEvent.events.filter(
              (_, index) => !invalidEvents.includes(index),
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
              true,
          );
          return;
        }

        // Process multiple events
        return addEventsAndSendResponse(
            oauth2Client,
            aiEvent.events,
            uid,
            sender,
            email,
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
              true,
          );
          return;
        }

        // Convert to array format
        return addEventsAndSendResponse(
            oauth2Client,
            [singleEvent],
            uid,
            sender,
            email,
        );
      }
    }
  }

  // Handle ICS event (convert to array format)
  return addEventsAndSendResponse(oauth2Client, [event], uid, sender, email);
}

function validateEventTimes(event: Event): EventValidationResult {
  if (!event.date || !event.start_time) {
    return {isValid: false, error: "Missing required date or start_time"};
  }

  // Try to parse the start time
  const startTime = `${event.date} ${event.start_time}`;
  const startDate = moment.tz(
      startTime,
      "DD MMMM YYYY HH:mm",
      event.timeZone || "UTC",
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
        event.timeZone || "UTC",
    );

    if (!endDate.isValid()) {
      logger.warn(
          `Invalid end time, will use default duration: ${event.end_time}`,
      );
      event.end_time = null; // Remove invalid end time
    } else if (endDate.isSameOrBefore(startDate)) {
      logger.warn(
          `End time is not after start time, will use default duration: ${event.end_time}`,
      );
      event.end_time = null; // Remove invalid end time
    }
  }

  return {isValid: true};
}

async function addEventsAndSendResponse(
    oauth2Client: Auth.OAuth2Client,
    events: Event[],
    uid: string,
    sender: string,
    email: TransformedEmail,
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
            `Dropping invalid email address from attendees: ${attendee}`,
        );
      }
      return isValid;
    });

    // Update event with filtered attendees
    event.attendees = validAttendees;

    // Try to add the event to their calendar
    const [addEventErr, eventObject] = await handleAsync(() =>
      addEvent(oauth2Client, event, uid),
    );

    if (addEventErr || !eventObject) {
      logger.warn(
          `Error adding event "${event.summary}" to calendar: `,
          addEventErr,
      );
      failedEvents.push({
        event: {summary: event.summary, attendees: event.attendees},
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

  // If all events failed, send appropriate error response
  if (successfulEvents.length === 0) {
    const isAuthError = failedEvents.some(
        (f) => f.error.includes("invalid_grant") ||
          f.error.includes("Token has been expired") ||
          f.error.includes("No refresh token") ||
          f.error.includes("Insufficient Permission") ||
          f.error.includes("unauthorized_client"),
    );
    if (isAuthError) {
      sendEvent(uid, "calendarError", {reason: "oauth_failed"});
      await sendEmailResponse(sender, email, EMAIL_RESPONSES.oauthFailed, true);
    } else {
      sendEvent(uid, "calendarError", {reason: "event_creation_failed"});
      const errorDetails = failedEvents
          .map((f) => `${f.event.summary}: ${f.error}`).join("; ");
      const response: EmailResponseTemplate = {
        ...EMAIL_RESPONSES.aiParseError,
        replace: {
          PARSE_ERROR_DESCRIPTION:
            `Failed to create event(s): ${errorDetails}`,
        },
      };
      await sendEmailResponse(sender, email, response, true);
    }
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

    const viewBtnStyle = "display:inline-block; padding:10px 20px; margin:5px 0; " +
      "background-color:#3498db; color:white; text-align:center; text-decoration:none; " +
      "font-weight:bold; border-radius:5px; border:none; cursor:pointer;";
    responseHtml += `<a href="${eventObject.htmlLink}" style="${viewBtnStyle}">View Event</a>`;

    // Add invite button if there are multiple attendees and an invite link
    if (eventObject.inviteOthersLink) {
      const inviteesWithoutHost = eventObject.attendees?.filter(
          (attendee) => attendee.email !== eventObject.organizer?.email,
      );
      if (inviteesWithoutHost && inviteesWithoutHost.length > 0) {
        const inviteeEmails = inviteesWithoutHost.map((a) => a.email).join(", ");
        responseHtml += `<br>You may want to invite: ${inviteeEmails}<br>`;
        const inviteBtnStyle = "display:inline-block; padding:10px 20px; margin:5px 0; " +
          "background-color:#3498db; color:white; text-align:center; text-decoration:none; " +
          "font-weight:bold; border-radius:5px; border:none; cursor:pointer;";
        responseHtml += `<a href="${eventObject.inviteOthersLink}" style="${inviteBtnStyle}">` +
          `Invite Guests</a>`;
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
    const calendarNameText = eventObject.isPrimaryCalendar ?
      "" :
      `<br>Calendar: ${eventObject.calendarName}`;

    let response: EmailResponseTemplate;
    if (eventObject.inviteOthersLink) {
      const inviteesWithoutHost =
        eventObject.inviteOthersAttendees?.filter(
            (emailAddr) => emailAddr !== eventObject.organizer?.email,
        ) || [];

      response = {
        ...EMAIL_RESPONSES.eventAddedAttendees,
        replace: {
          EVENT_LINK: eventObject.htmlLink,
          EVENT_DATE: moment(eventObject.start.dateTime)
              .tz(eventObject.start.timeZone)
              .format("dddd, MMMM Do, YYYY [at] h:mm A z"),
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
              .format("dddd, MMMM Do, YYYY [at] h:mm A z"),
          EVENT_ATTENDEES: eventObject.attendees ?
            eventObject.attendees.map((attendee) => attendee.email).join(", ") :
            "",
          CALENDAR_NAME: calendarNameText,
        },
      };
    }

    await sendEmailResponse(sender, email, response, true);
  } else {
    // Multiple events - send custom HTML email
    const supportEmail = getSupportEmail();
    const customHtml = `
${successfulEvents.length} events added to your calendar.
${responseHtml}
<br><br>You can always ask for help: <a href="mailto:${supportEmail}">${supportEmail}</a><br>
    `;

    await sendEmailResend({
      to: sender,
      from: MAIN_EMAIL_ADDRESS.value(),
      subject: `Re: ${email.subject}`,
      html: threadEmailHtml(email, customHtml),
      headers: getEmailThreadHeaders(email.headers),
    });
  }

  // Return single event for backward compatibility, array for multiple
  return successfulEvents.length === 1 ? successfulEvents[0] : successfulEvents;
}
