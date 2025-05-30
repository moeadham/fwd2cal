/* eslint-disable max-len */
const prompts = {
  getEventData: `
Task: Review the following email thread and return a event_json with the following fields:
{
summary: the title of the event
location: a location of the event if one has been given
description: a description of the event if one has been given
conference_call: true or false, if the event is a conference call or virtual
date: DD MMMM YYYY - the date of the event
start_time: HH:mm - the start time of the event in 24 hour format
end_time: HH:mm - the end time of the event in 24 hour format
attendees: a list of attendees
}

The text will start with a Date. That is the date the email was sent.
The next line is a subject, that is the subject of the email thread.
Attendees should be selected based on the contents of the text. Generally everyone in the thread should be invited, but consider the contents of the email and the subject.
If the email is transactional, such as a receipt or automatically generated, than the only attendee is the sender.
If the email is a thread,  the most recent email is most relevant, but keep other details from the thread in context.
Relative dates are fine - like "next tuesday". Determine the date of the event based off of the relative difference from the date of the email.
Set the "summary" and "description" to "Event" if there are not enough details in the text to complete either of these fields.

To create an event, at minimum, you need to determine a date. If you can't determine a date, respond with an error that no date has been provided:
{
error: "No date provided"
description: "A short outline of what was specifically missing from the email"
}

Here are a few examples:
---EXAMPLE 1 START---
email_text: 
Date: Tue, 26 Mar 2024 12:38:21 +0000
Subject: Fwd: Get ready for the Genius Bar
From: Timmy Jimmy <timmy@gmail.com>
---------- Forwarded message ---------
From: Finess Clinic <noreply@email.apple.com>
Date: Tue, Mar 26, 2024 at 11:04 AM
Subject: Get ready for the Genius Bar
To: <timmy@gmail.com>


Your upcoming Genius Bar appointment.

Review steps below and check in with a Specialist when you arrive.


For convenience and a quicker check-in, add your appointment to Apple Wallet in your iOS device. Or show this code to a Specialist.



Wednesday, April 3, 2024
10:20

Add to Calendar
Apple Covent Garden

No. 1-7 The Piazza
London

Get directions, view store details, and read store-specific health and safety information
iPhone

Case ID: 102258148113

Manage my reservations

event_json:
{
summary: "Genius Bar",
location: "Apple Covent Garden",
description: "Case ID: 102258148113",
conference_call: false,
date: "3 April 2024",
start_time: "10:20",
end_time: undefined
attendees: ["timmy@gmail.com"]
}


--- EXAMPLE 1 END ---

---EXAMPLE 2 START---
email_text: 
Date: Thu, 21 Mar 2024 11:38:21 +0000
Subject: Fwd: Investing Holdings Strategic Initiative
From: jeff harry <jeff@investing.com>
---------- Forwarded message ---------
From: Richard Soom <rsoom@toom.com>
Sent: Thursday, March 21, 2024 11:19 AM
To: jeff harry <jeff@investing.com>
Cc: Joe Doe <Joe@investing.com>
Subject: RE: Investing Holdings Strategic Initiative


Thanks jeff, and hello Joe.



May I suggest 3/26 at 3:00 pm ET?


Richard

From: jeff harry <jeff@investing.com>
Sent: Thursday, March 21, 2024 11:18 AM
To: Richard Soom <rsoom@toom.com>
Cc: Joe Doe <Joe@investing.com>
Subject: Investing Holdings Strategic Initiative



Hi Richard,



Updating our previous correspondence, Joe Doe, Investings CIO (cc'd) and I would like a call with at your earliest convenience to discuss:



Introduction to Soom Toom
Investing's progress on sourcing deals to date
potential opportunities to work together
M&A mandate
Fairness opinion
merging with company where Soom Toom is the advisor to the go forward operating company


You had proposed March 28th at 9:30, 10:30 or 11am, do you have any availability prior to that time?



Best regards  


event_json:
{
summary: "Investing Holdings Strategic Initiative",
location: undefined,
description: "Introduction to Soom Toom
Investing's progress on sourcing deals to date
potential opportunities to work together",
conference_call: true,
date: "26 March 2024",
start_time: "15:00",
end_time: undefined,
attendees: ["rsoom@toom.com", "jeff@investing.com", "Joe@investing.com"]
}

--- EXAMPLE 2 END ---

---EXAMPLE 3 START---
email_text: 
Date: Fri, 5 Apr 2024 01:08:21 +0000
Subject: find a new suit
From: jeff john <jeff@john.com>
go to h&m next saturday at 2pm

event_json:
{
summary: "Find new suit",
location: "H&M",
description: "find new suit from H&M",
conference_call: false,
date: "13 April 2024",
start_time: "14:00",
end_time: undefined,
attendees: ["jeff@john.com"]
}

--- EXAMPLE 3 END ---

Respond only with JSON.
`,

  getEventTimezone:
`Task: Review the following email thread and return a timezone_json with the  IANA Time Zone of the event.
{
  reason: Brief reasoning of why the timezone was chosen
  timezone:  IANA Time Zone Database formatted string
}

If a timezone is not explicitly given, you can determine it based on the location (if a location is available). 
Do your best to infer a timezone from the details in the email.
If no location or timezone is available, you can leave it undefined.

Here are a few examples:
---EXAMPLE 1 START---
email_text: 
Date: Tue, 26 Mar 2024 12:38:21 +0000
Subject: Fwd: Get ready for the Genius Bar
From: Timmy Jimmy <timmy@gmail.com>
---------- Forwarded message ---------
From: Apple Support <noreply@email.apple.com>
Date: Tue, Mar 26, 2024 at 11:04 AM
Subject: Get ready for the Genius Bar
To: <timmy@gmail.com>


Your upcoming Genius Bar appointment.

Review steps below and check in with a Specialist when you arrive.


For convenience and a quicker check-in, add your appointment to Apple Wallet in your iOS device. Or show this code to a Specialist.



Wednesday, April 3, 2024
10:20

Add to Calendar
Apple Covent Garden

No. 1-7 The Piazza
London

Get directions, view store details, and read store-specific health and safety information
iPhone

Case ID: 102258148113

timezone_json:
{
  reason: "The timezone was not explicitly given, but it can be inferred from the location: London",
  timezone: "Europe/London"
}
--- EXAMPLE 1 END ---

---EXAMPLE 2 START---
email_text: 
Date: Thu, 21 Mar 2024 11:38:21 +0000
Subject: Fwd: Investing Holdings Strategic Initiative
From: jeff harry <jeff@investing.com>
---------- Forwarded message ---------
From: Richard Soom <rsoom@toom.com>
Sent: Thursday, March 21, 2024 11:19 AM
To: jeff harry <jeff@investing.com>
Cc: Joe Doe <Joe@investing.com>
Subject: RE: Investing Holdings Strategic Initiative


Thanks jeff, and hello Joe.



May I suggest 3/26 at 3:00 pm ET?


Richard

From: jeff harry <jeff@investing.com>
Sent: Thursday, March 21, 2024 11:18 AM
To: Richard Soom <rsoom@toom.com>
Cc: Joe Doe <Joe@investing.com>
Subject: Investing Holdings Strategic Initiative



Hi Richard,



Updating our previous correspondence, Joe Doe, Investings CIO (cc'd) and I would like a call with at your earliest convenience to discuss:



Introduction to Soom Toom
Investing's progress on sourcing deals to date
potential opportunities to work together
M&A mandate
Fairness opinion
merging with company where Soom Toom is the advisor to the go forward operating company


You had proposed March 28th at 9:30, 10:30 or 11am, do you have any availability prior to that time?



Best regards  

timezone_json:
{
  reason: "The timezone ET is referenced, which is eastern time in America",
  timezone: "America/New_York",
}

---EXAMPLE 2 END---

---EXAMPLE 3 START---
email_text: 
Date: Fri, 5 Apr 2024 01:08:21 +0000
Subject: find a new suit
From: jeff john <jeff@john.com>
go to h&m next saturday at 2pm

timezone_json:
{
  reason: "No timezone or location is given, it is not possible to determine a timezone",
  timezone: undefined,
}

--- EXAMPLE 3 END ---

Respond only with JSON.

`,

  parseICS: `
Task: Review the following ICS file and return a JSON in the google calendar format.

If a field is optional, and not present in the ICS file, you can leave it out of the JSON.

Google Calendar JSON format:
{
  "kind": "calendar#event", // Type of the resource ("calendar#event").
  "created": "datetime", // Creation time of the event (as a RFC3339 timestamp). Read-only.
  "updated": "datetime", // Last modification time of the event (as a RFC3339 timestamp). Read-only.
  "summary": "string", // Title of the event.
  "description": "string", // Description of the event. Can contain HTML. Optional.
  "location": "string", // Geographic location of the event as free-form text. Optional.
  "creator": {
    "id": "string", // The creator's Profile ID, if available.
    "email": "string", // The creator's email address, if available.
    "displayName": "string" // The creator's name, if available.
  },
  "organizer": {
    "id": "string", // The organizer's Profile ID, if available.
    "email": "string", // The organizer's email address, if available. It must be a valid email address as per RFC5322.
    "displayName": "string" // The organizer's name, if available.
  },
  "start": {
    "date": "date", // The date, in the format "yyyy-mm-dd", if this is an all-day event.
    "dateTime": "datetime", // The time, as a combined date-time value (formatted according to RFC3339). A time zone offset is required unless a time zone is explicitly specified in timeZone.
    "timeZone": "string" // IANA Time Zone Database formatted string. Example: "Europe/London" - MANDATORY
  },
  "end": {
    "date": "date", // The date, in the format "yyyy-mm-dd", if this is an all-day event.
    "dateTime": "datetime", // The time, as a combined date-time value (formatted according to RFC3339). A time zone offset is required unless a time zone is explicitly specified in timeZone.
    "timeZone": "string" // IANA Time Zone Database formatted string. Example: "Europe/London" - MANDATORY
  },
  "endTimeUnspecified": "boolean", // Whether the end time is actually unspecified. An end time is still provided for compatibility reasons, even if this attribute is set to True. The default is False.
  "recurrence": [
    "string" // List of RRULE, EXRULE, RDATE and EXDATE lines for a recurring event, as specified in RFC5545. Note that DTSTART and DTEND lines are not allowed in this field; event start and end times are specified in the start and end fields. This field is omitted for single events or instances of recurring events.
  ],
  "recurringEventId": "string", // For an instance of a recurring event, this is the id of the recurring event to which this instance belongs. Immutable.
  "originalStartTime": {
    "date": "date", // The date, in the format "yyyy-mm-dd", if this is an all-day event.
    "dateTime": "datetime", // The time, as a combined date-time value (formatted according to RFC3339). A time zone offset is required unless a time zone is explicitly specified in timeZone.
    "timeZone": "string" // // IANA Time Zone Database formatted string. Example: "Europe/London"
  },
  "attendees": [
    {
      "id": "string", // The attendee's Profile ID, if available.
      "email": "string", // The attendee's email address, if available. This field must be present when adding an attendee. It must be a valid email address as per RFC5322. Required when adding an attendee.
      "displayName": "string", // The attendee's name, if available. Optional.
      "organizer": "boolean", // Whether the attendee is the organizer of the event. Read-only. The default is False.
      "resource": "boolean", // Whether the attendee is a resource. Can only be set when the attendee is added to the event for the first time. Subsequent modifications are ignored. Optional. The default is False.
      "optional": "boolean", // Whether this is an optional attendee. Optional. The default is False.
      "responseStatus": "string", // The attendee's response status. Possible values are: "needsAction" - The attendee has not responded to the invitation (recommended for new events). "declined" - The attendee has declined the invitation. "tentative" - The attendee has tentatively accepted the invitation. "accepted" - The attendee has accepted the invitation.
      "comment": "string", // The attendee's response comment. Optional.
      "additionalGuests": "integer" // Number of additional guests. Optional. The default is 0.
    }
  ],
  "attendeesOmitted": "boolean", // Whether attendees may have been omitted from the event's representation. When retrieving an event, this may be due to a restriction specified by the maxAttendee query parameter. When updating an event, this can be used to only update the participant's response. Optional. The default is False.
  "hangoutLink": "string", // An absolute link to the Google Hangout associated with this event. Read-only.
  "conferenceData": {
    "createRequest": {
      "requestId": "string", // The client-generated unique ID for this request. Clients should regenerate this ID for every new request. If an ID provided is the same as for the previous request, the request is ignored.
      "conferenceSolutionKey": {
        "type": "string" // The conference solution type. Possible values are: "eventHangout" for Hangouts for consumers (deprecated; existing events may show this conference solution type but new conferences cannot be created) "eventNamedHangout" for classic Hangouts for Google Workspace users (deprecated; existing events may show this conference solution type but new conferences cannot be created) "hangoutsMeet" for Google Meet (http://meet.google.com) "addOn" for 3P conference providers
      },
      "status": {
        "statusCode": "string" // The current status of the conference create request. Read-only. Possible values are: "pending": the conference create request is still being processed. "success": the conference create request succeeded, the entry points are populated. "failure": the conference create request failed, there are no entry points.
      }
    },
    "entryPoints": [
      {
        "entryPointType": "string", // The type of the conference entry point. Possible values are: "video" - joining a conference over HTTP. A conference can have zero or one video entry point. "phone" - joining a conference by dialing a phone number. A conference can have zero or more phone entry points. "sip" - joining a conference over SIP. A conference can have zero or one sip entry point. "more" - further conference joining instructions, for example additional phone numbers. A conference can have zero or one more entry point. A conference with only a more entry point is not a valid conference.
        "uri": "string", // The URI of the entry point. The maximum length is 1300 characters. Format: for video, http: or https: schema is required. for phone, tel: schema is required. The URI should include the entire dial sequence (e.g., tel:+12345678900,,,123456789;1234). for sip, sip: schema is required, e.g., sip:12345678@myprovider.com. for more, http: or https: schema is required.
        "label": "string", // The label for the URI. Visible to end users. Not localized. The maximum length is 512 characters. Examples: for video: meet.google.com/aaa-bbbb-ccc for phone: +1 123 268 2601 for sip: 12345678@altostrat.com for more: should not be filled Optional.
        "pin": "string", // The PIN to access the conference. The maximum length is 128 characters. When creating new conference data, populate only the subset of {meetingCode, accessCode, passcode, password, pin} fields that match the terminology that the conference provider uses. Only the populated fields should be displayed. Optional.
        "accessCode": "string", // The access code to access the conference. The maximum length is 128 characters. When creating new conference data, populate only the subset of {meetingCode, accessCode, passcode, password, pin} fields that match the terminology that the conference provider uses. Only the populated fields should be displayed. Optional.
        "meetingCode": "string", // The meeting code to access the conference. The maximum length is 128 characters. When creating new conference data, populate only the subset of {meetingCode, accessCode, passcode, password, pin} fields that match the terminology that the conference provider uses. Only the populated fields should be displayed. Optional.
        "passcode": "string", // The passcode to access the conference. The maximum length is 128 characters. When creating new conference data, populate only the subset of {meetingCode, accessCode, passcode, password, pin} fields that match the terminology that the conference provider uses. Only the populated fields should be displayed. Optional.
        "password": "string" // The password to access the conference. The maximum length is 128 characters. When creating new conference data, populate only the subset of {meetingCode, accessCode, passcode, password, pin} fields that match the terminology that the conference provider uses. Only the populated fields should be displayed. Optional.
      }
    ],
    "conferenceSolution": {
      "key": {
        "type": "string" // The conference solution type. If a client encounters an unfamiliar or empty type, it should still be able to display the entry points. However, it should disallow modifications. The possible values are: "eventHangout" for Hangouts for consumers (deprecated; existing events may show this conference solution type but new conferences cannot be created) "eventNamedHangout" for classic Hangouts for Google Workspace users (deprecated; existing events may show this conference solution type but new conferences cannot be created) "hangoutsMeet" for Google Meet (http://meet.google.com) "addOn" for 3P conference providers
      },
      "name": "string", // The user-visible name of this solution. Not localized.
      "iconUri": "string" // The user-visible icon for this solution.
    },
    "conferenceId": "string", // The ID of the conference. Can be used by developers to keep track of conferences, should not be displayed to users. The ID value is formed differently for each conference solution type: eventHangout: ID is not set. (This conference type is deprecated.) eventNamedHangout: ID is the name of the Hangout. (This conference type is deprecated.) hangoutsMeet: ID is the 10-letter meeting code, for example aaa-bbbb-ccc. addOn: ID is defined by the third-party provider. Optional.
    "signature": "string", // The signature of the conference data. Generated on server side. Unset for a conference with a failed create request. Optional for a conference with a pending create request.
    "notes": "string" // Additional notes (such as instructions from the domain administrator, legal notices) to display to the user. Can contain HTML. The maximum length is 2048 characters. Optional.
  },
  "reminders": {
    "useDefault": "boolean", // Whether the default reminders of the calendar apply to the event.
    "overrides": [
      {
        "method": "string", // The method used by this reminder. Possible values are: "email" - Reminders are sent via email. "popup" - Reminders are sent via a UI popup. Required when adding a reminder.
        "minutes": "integer" // Number of minutes before the start of the event when the reminder should trigger. Valid values are between 0 and 40320 (4 weeks in minutes). Required when adding a reminder.
      }
    ]
  },
  "source": {
    "url": "string", // URL of the source pointing to a resource. The URL scheme must be HTTP or HTTPS.
    "title": "string" // Title of the source; for example a title of a web page or an email subject.
  },
  "workingLocationProperties": {
    "type": "string", // Type of the working location. Possible values are: "homeOffice" - The user is working at home. "officeLocation" - The user is working from an office. "customLocation" - The user is working from a custom location. Any details are specified in a sub-field of the specified name, but this field may be missing if empty. Any other fields are ignored. Required when adding working location properties.
    "homeOffice": "value", // If present, specifies that the user is working at home.
    "customLocation": {
      "label": "string" // An optional extra label for additional information.
    },
    "officeLocation": {
      "buildingId": "string", // An optional building identifier. This should reference a building ID in the organization's Resources database.
      "floorId": "string", // An optional floor identifier.
      "floorSectionId": "string", // An optional floor section identifier.
      "deskId": "string", // An optional desk identifier.
      "label": "string" // The office name that's displayed in Calendar Web and Mobile clients. We recommend you reference a building name in the organization's Resources database.
    }
  },
  "outOfOfficeProperties": {
    "autoDeclineMode": "string", // Whether to decline meeting invitations which overlap Out of office events. Valid values are declineNone, meaning that no meeting invitations are declined; declineAllConflictingInvitations, meaning that all conflicting meeting invitations that conflict with the event are declined; and declineOnlyNewConflictingInvitations, meaning that only new conflicting meeting invitations which arrive while the Out of office event is present are to be declined.
    "declineMessage": "string" // Response message to set if an existing event or new invitation is automatically declined by Calendar.
  },
  "focusTimeProperties": {
    "autoDeclineMode": "string", // Whether to decline meeting invitations which overlap Focus Time events. Valid values are declineNone, meaning that no meeting invitations are declined; declineAllConflictingInvitations, meaning that all conflicting meeting invitations that conflict with the event are declined; and declineOnlyNewConflictingInvitations, meaning that only new conflicting meeting invitations which arrive while the Focus Time event is present are to be declined.
    "declineMessage": "string", // Response message to set if an existing event or new invitation is automatically declined by Calendar.
    "chatStatus": "string" // The status to mark the user in Chat and related products. This can be available or doNotDisturb.
  },
}


ICS File:
`,
};

const schemas = {
  eventData: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "The title of the event",
      },
      location: {
        type: ["string", "null"],
        description: "A location of the event if one has been given",
      },
      description: {
        type: ["string", "null"],
        description: "A description of the event if one has been given",
      },
      conference_call: {
        type: "boolean",
        description: "True or false, if the event is a conference call or virtual",
      },
      date: {
        type: "string",
        description: "DD MMMM YYYY - the date of the event",
      },
      start_time: {
        type: "string",
        description: "HH:mm - the start time of the event in 24 hour format",
      },
      end_time: {
        type: ["string", "null"],
        description: "HH:mm - the end time of the event in 24 hour format",
      },
      attendees: {
        type: "array",
        items: {
          type: "string",
        },
        description: "A list of attendees",
      },
      error: {
        type: "string",
        description: "Error message if no date provided",
      },
    },
    additionalProperties: false,
  },

  timezone: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Brief reasoning of why the timezone was chosen",
      },
      timezone: {
        type: ["string", "null"],
        description: "IANA Time Zone Database formatted string",
      },
    },
    required: ["reason", "timezone"],
    additionalProperties: false,
  },

  icsParser: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description: "Type of the resource (calendar#event)",
      },
      created: {
        type: "string",
        description: "Creation time of the event (as a RFC3339 timestamp)",
      },
      updated: {
        type: "string",
        description: "Last modification time of the event (as a RFC3339 timestamp)",
      },
      summary: {
        type: "string",
        description: "Title of the event",
      },
      description: {
        type: "string",
        description: "Description of the event. Can contain HTML",
      },
      location: {
        type: "string",
        description: "Geographic location of the event as free-form text",
      },
      creator: {
        type: "object",
        properties: {
          id: {type: "string", description: "The creator's Profile ID"},
          email: {type: "string", description: "The creator's email address"},
          displayName: {type: "string", description: "The creator's name"},
        },
        additionalProperties: false,
      },
      organizer: {
        type: "object",
        properties: {
          id: {type: "string", description: "The organizer's Profile ID"},
          email: {type: "string", description: "The organizer's email address"},
          displayName: {type: "string", description: "The organizer's name"},
        },
        additionalProperties: false,
      },
      start: {
        type: "object",
        properties: {
          date: {type: "string", description: "The date, in the format yyyy-mm-dd, if this is an all-day event"},
          dateTime: {type: "string", description: "The time, as a combined date-time value (formatted according to RFC3339)"},
          timeZone: {type: "string", description: "IANA Time Zone Database formatted string. Example: Europe/London"},
        },
        required: ["timeZone"],
        additionalProperties: false,
      },
      end: {
        type: "object",
        properties: {
          date: {type: "string", description: "The date, in the format yyyy-mm-dd, if this is an all-day event"},
          dateTime: {type: "string", description: "The time, as a combined date-time value (formatted according to RFC3339)"},
          timeZone: {type: "string", description: "IANA Time Zone Database formatted string. Example: Europe/London"},
        },
        required: ["timeZone"],
        additionalProperties: false,
      },
      endTimeUnspecified: {
        type: "boolean",
        description: "Whether the end time is actually unspecified",
      },
      recurrence: {
        type: "array",
        items: {type: "string"},
        description: "List of RRULE, EXRULE, RDATE and EXDATE lines for a recurring event",
      },
      recurringEventId: {
        type: "string",
        description: "For an instance of a recurring event, this is the id of the recurring event",
      },
      originalStartTime: {
        type: "object",
        properties: {
          date: {type: "string", description: "The date, in the format yyyy-mm-dd, if this is an all-day event"},
          dateTime: {type: "string", description: "The time, as a combined date-time value (formatted according to RFC3339)"},
          timeZone: {type: "string", description: "IANA Time Zone Database formatted string"},
        },
        additionalProperties: false,
      },
      attendees: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {type: "string", description: "The attendee's Profile ID"},
            email: {type: "string", description: "The attendee's email address"},
            displayName: {type: "string", description: "The attendee's name"},
            organizer: {type: "boolean", description: "Whether the attendee is the organizer of the event"},
            resource: {type: "boolean", description: "Whether the attendee is a resource"},
            optional: {type: "boolean", description: "Whether this is an optional attendee"},
            responseStatus: {
              type: "string",
              enum: ["needsAction", "declined", "tentative", "accepted"],
              description: "The attendee's response status",
            },
            comment: {type: "string", description: "The attendee's response comment"},
            additionalGuests: {type: "integer", description: "Number of additional guests"},
          },
          additionalProperties: false,
        },
      },
      attendeesOmitted: {
        type: "boolean",
        description: "Whether attendees may have been omitted from the event's representation",
      },
      hangoutLink: {
        type: "string",
        description: "An absolute link to the Google Hangout associated with this event",
      },
      conferenceData: {
        type: "object",
        properties: {
          createRequest: {
            type: "object",
            properties: {
              requestId: {type: "string", description: "The client-generated unique ID for this request"},
              conferenceSolutionKey: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["eventHangout", "eventNamedHangout", "hangoutsMeet", "addOn"],
                    description: "The conference solution type",
                  },
                },
                additionalProperties: false,
              },
              status: {
                type: "object",
                properties: {
                  statusCode: {
                    type: "string",
                    enum: ["pending", "success", "failure"],
                    description: "The current status of the conference create request",
                  },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          entryPoints: {
            type: "array",
            items: {
              type: "object",
              properties: {
                entryPointType: {
                  type: "string",
                  enum: ["video", "phone", "sip", "more"],
                  description: "The type of the conference entry point",
                },
                uri: {type: "string", description: "The URI of the entry point"},
                label: {type: "string", description: "The label for the URI"},
                pin: {type: "string", description: "The PIN to access the conference"},
                accessCode: {type: "string", description: "The access code to access the conference"},
                meetingCode: {type: "string", description: "The meeting code to access the conference"},
                passcode: {type: "string", description: "The passcode to access the conference"},
                password: {type: "string", description: "The password to access the conference"},
              },
              additionalProperties: false,
            },
          },
          conferenceSolution: {
            type: "object",
            properties: {
              key: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["eventHangout", "eventNamedHangout", "hangoutsMeet", "addOn"],
                  },
                },
                additionalProperties: false,
              },
              name: {type: "string", description: "The user-visible name of this solution"},
              iconUri: {type: "string", description: "The user-visible icon for this solution"},
            },
            additionalProperties: false,
          },
          conferenceId: {type: "string", description: "The ID of the conference"},
          signature: {type: "string", description: "The signature of the conference data"},
          notes: {type: "string", description: "Additional notes to display to the user"},
        },
        additionalProperties: false,
      },
      reminders: {
        type: "object",
        properties: {
          useDefault: {type: "boolean", description: "Whether the default reminders of the calendar apply to the event"},
          overrides: {
            type: "array",
            items: {
              type: "object",
              properties: {
                method: {
                  type: "string",
                  enum: ["email", "popup"],
                  description: "The method used by this reminder",
                },
                minutes: {type: "integer", description: "Number of minutes before the start of the event when the reminder should trigger"},
              },
              required: ["method", "minutes"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      source: {
        type: "object",
        properties: {
          url: {type: "string", description: "URL of the source pointing to a resource"},
          title: {type: "string", description: "Title of the source"},
        },
        additionalProperties: false,
      },
      workingLocationProperties: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["homeOffice", "officeLocation", "customLocation"],
            description: "Type of the working location",
          },
          homeOffice: {description: "Specifies that the user is working at home"},
          customLocation: {
            type: "object",
            properties: {
              label: {type: "string", description: "An optional extra label for additional information"},
            },
            additionalProperties: false,
          },
          officeLocation: {
            type: "object",
            properties: {
              buildingId: {type: "string", description: "An optional building identifier"},
              floorId: {type: "string", description: "An optional floor identifier"},
              floorSectionId: {type: "string", description: "An optional floor section identifier"},
              deskId: {type: "string", description: "An optional desk identifier"},
              label: {type: "string", description: "The office name that's displayed in Calendar clients"},
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      outOfOfficeProperties: {
        type: "object",
        properties: {
          autoDeclineMode: {
            type: "string",
            enum: ["declineNone", "declineAllConflictingInvitations", "declineOnlyNewConflictingInvitations"],
            description: "Whether to decline meeting invitations which overlap Out of office events",
          },
          declineMessage: {type: "string", description: "Response message to set if an event is automatically declined"},
        },
        additionalProperties: false,
      },
      focusTimeProperties: {
        type: "object",
        properties: {
          autoDeclineMode: {
            type: "string",
            enum: ["declineNone", "declineAllConflictingInvitations", "declineOnlyNewConflictingInvitations"],
            description: "Whether to decline meeting invitations which overlap Focus Time events",
          },
          declineMessage: {type: "string", description: "Response message to set if an event is automatically declined"},
          chatStatus: {
            type: "string",
            enum: ["available", "doNotDisturb"],
            description: "The status to mark the user in Chat and related products",
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

module.exports = {prompts, schemas};

