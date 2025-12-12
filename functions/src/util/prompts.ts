import { Prompts } from "../types";

// Model configuration
const DEFAULT_REASONING_MODEL = "openai/gpt-4.1-mini";
const DEFAULT_FAST_MODEL = "openai/gpt-4.1-mini";

const prompts: Prompts = {
  getEventData: {
    model: DEFAULT_REASONING_MODEL,
    prompt: `
Task: Review the following email thread and extract ALL events mentioned. Return an events_json with the following structure:
{
  events: [
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
  ]
}

IMPORTANT: Extract ALL distinct events mentioned in the email. Each event with a different date, time, or purpose should be a separate entry in the events array.

The text will start with a Date. That is the date the email was sent.
The next line is a subject, that is the subject of the email thread.
Attendees should be selected based on the contents of the text. Generally everyone in the thread should be invited, but consider the contents of the email and the subject.
If the email is transactional, such as a receipt or automatically generated, than the only attendee is the sender.
If the email is a thread,  the most recent email is most relevant, but keep other details from the thread in context.
Relative dates are fine - like "next tuesday". Determine the date of the event based off of the relative difference from the date of the email.
Set the "summary" and "description" to "Event" if there are not enough details in the text to complete either of these fields.

To create an event, at minimum, you need to determine a date. If you can't determine a date for any event, respond with an error:
{
error: "No date provided"
description: "A short outline of what was specifically missing from the email"
}

Here are a few examples:
---EXAMPLE 1 START---
available_calendars:
[
  {
    "calendar_id": "timmy@gmail.com",
    "summary": "timmy@gmail.com",
    "description": "",
    "is_default": true,
    "timeZone": "Europe/London"
  },
  {
    "calendar_id": "timmy@acme.com",
    "summary": "timmy@acme.com",
    "description": "",
    "is_default": false,
    "timeZone": "America/New_York"
  }
]

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

events_json:
{
  events: [
    {
      summary: "Genius Bar",
      location: "Apple Covent Garden",
      description: "Case ID: 102258148113",
      conference_call: false,
      date: "3 April 2024",
      start_time: "10:20",
      end_time: undefined,
      attendees: ["timmy@gmail.com"],
      selected_calendar_id: null
    }
  ]
}


--- EXAMPLE 1 END ---

---EXAMPLE 2 START---
available_calendars:
[
  {
    "calendar_id": "jeff@gmail.com",
    "summary": "jeff@gmail.com",
    "description": "",
    "is_default": true,
    "timeZone": "America/New_York"
  },
  {
    "calendar_id": "jeff@investing.com",
    "summary": "jeff@investing.com",
    "description": "",
    "is_default": false,
    "timeZone": "America/New_York"
  }
]

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


events_json:
{
  events: [
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
      attendees: ["rsoom@toom.com", "jeff@investing.com", "Joe@investing.com"],
      selected_calendar_id: "jeff@investing.com"
    }
  ]
}

--- EXAMPLE 2 END ---

---EXAMPLE 3 START---
available_calendars:
[
  {
    "calendar_id": "jeff@john.com",
    "summary": "jeff@john.com",
    "description": "",
    "is_default": true,
    "timeZone": "America/Los_Angeles"
  },
  {
    "calendar_id": "jeff.john@oakwood.edu",
    "summary": "School Calendar",
    "description": "Oakwood School Events",
    "is_default": false,
    "timeZone": "America/Los_Angeles"
  }
]

email_text:
Date: Fri, 5 Apr 2024 01:08:21 +0000
Subject: find a new suit
From: jeff john <jeff@john.com>
go to h&m next saturday at 2pm

events_json:
{
  events: [
    {
      summary: "Find new suit",
      location: "H&M",
      description: "find new suit from H&M",
      conference_call: false,
      date: "13 April 2024",
      start_time: "14:00",
      end_time: undefined,
      attendees: ["jeff@john.com"],
      selected_calendar_id: null
    }
  ]
}

--- EXAMPLE 3 END ---

---EXAMPLE 4 START---
available_calendars:
[
  {
    "calendar_id": "alex@gmail.com",
    "summary": "alex@gmail.com",
    "description": "",
    "is_default": true,
    "timeZone": "America/New_York"
  },
  {
    "calendar_id": "alex@techco.com",
    "summary": "alex@techco.com",
    "description": "",
    "is_default": false,
    "timeZone": "America/New_York"
  }
]

email_text:
Date: Wed, 15 Apr 2025 16:30:00 +0000
Subject: Fwd: Conference Schedule - Tech Summit 2025
From: alex@techco.com
---------- Forwarded message ---------
From: Tech Summit <noreply@techsummit.com>
Date: Wed, Apr 15, 2025 at 4:30 PM
Subject: Conference Schedule - Tech Summit 2025
To: <alex@techco.com>

Dear Attendee,

Your personalized schedule for Tech Summit 2025:

Day 1 (May 5th):
- Keynote: Future of AI at 9:00 AM - 10:30 AM in Main Auditorium
- Workshop: Machine Learning Basics from 2:00 PM to 5:00 PM in Room 201

Day 2 (May 6th):
- Panel Discussion: Ethics in Tech at 11:00 AM (1 hour) in Conference Hall B
- Networking Lunch at 12:30 PM in the Atrium

Looking forward to seeing you there!

Tech Summit Team

events_json:
{
  events: [
    {
      summary: "Keynote: Future of AI",
      location: "Main Auditorium",
      description: "Tech Summit 2025 - Keynote: Future of AI",
      conference_call: false,
      date: "5 May 2025",
      start_time: "09:00",
      end_time: "10:30",
      attendees: ["alex@techco.com"],
      selected_calendar_id: "alex@techco.com"
    },
    {
      summary: "Workshop: Machine Learning Basics",
      location: "Room 201",
      description: "Tech Summit 2025 - Workshop: Machine Learning Basics",
      conference_call: false,
      date: "5 May 2025",
      start_time: "14:00",
      end_time: "17:00",
      attendees: ["alex@techco.com"],
      selected_calendar_id: "alex@techco.com"
    },
    {
      summary: "Panel Discussion: Ethics in Tech",
      location: "Conference Hall B",
      description: "Tech Summit 2025 - Panel Discussion: Ethics in Tech",
      conference_call: false,
      date: "6 May 2025",
      start_time: "11:00",
      end_time: "12:00",
      attendees: ["alex@techco.com"],
      selected_calendar_id: "alex@techco.com"
    },
    {
      summary: "Networking Lunch",
      location: "Atrium",
      description: "Tech Summit 2025 - Networking Lunch",
      conference_call: false,
      date: "6 May 2025",
      start_time: "12:30",
      end_time: undefined,
      attendees: ["alex@techco.com"],
      selected_calendar_id: "alex@techco.com"
    }
  ]
}

--- EXAMPLE 4 END ---

---EXAMPLE 5 START---
available_calendars:
[
  {
    "calendar_id": "sarah@gmail.com",
    "summary": "sarah@gmail.com",
    "description": "",
    "is_default": true,
    "timeZone": "America/Los_Angeles"
  },
  {
    "calendar_id": "sarah@designco.com",
    "summary": "sarah@designco.com",
    "description": "",
    "is_default": false,
    "timeZone": "America/Los_Angeles"
  }
]

email_text:
Date: Mon, 10 Jun 2024 09:15:00 +0000
Subject: Fwd: Design Review Meeting
From: sarah@gmail.com
---------- Forwarded message ---------
From: Mike Johnson <mike@designco.com>
Date: Mon, Jun 10, 2024 at 9:00 AM
Subject: Design Review Meeting
To: Sarah Williams <sarah@designco.com>
Cc: Design Team <team@designco.com>

Hi Sarah,

Let's schedule our quarterly design review meeting for this Thursday, June 13th at 2:00 PM.

We'll review:
- Q2 design deliverables
- Client feedback
- Q3 roadmap planning

Looking forward to it!

Mike

events_json:
{
  events: [
    {
      summary: "Design Review Meeting",
      location: undefined,
      description: "Q2 design deliverables review, client feedback, Q3 roadmap planning",
      conference_call: true,
      date: "13 June 2024",
      start_time: "14:00",
      end_time: undefined,
      attendees: ["mike@designco.com", "sarah@designco.com", "team@designco.com"],
      selected_calendar_id: "sarah@designco.com"
    }
  ]
}

--- EXAMPLE 5 END ---

Respond only with JSON.
`,
  },

  getEventTimezone: {
    model: DEFAULT_FAST_MODEL,
    prompt: `Task: Review the following email thread and return a timezone_json with the  IANA Time Zone of the event.
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
  },

  parseICS: {
    model: DEFAULT_REASONING_MODEL,
    prompt: `Task: Review the following ICS file and return a JSON in the google calendar format.

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
  },
};

export { prompts };
