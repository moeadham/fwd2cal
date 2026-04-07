/* eslint-disable max-len */
import {PromptConfig} from "../../types";

const prompt: PromptConfig = {
  model: "openai/gpt-4.1-mini",
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

If the email specifies a date but no specific time, set start_time to null and end_time to null. Do NOT guess a time like "00:00". A null start_time means an all-day event will be created.

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

---EXAMPLE 6 START---
available_calendars:
[
  {
    "calendar_id": "jezos@gmail.com",
    "summary": "jezos@gmail.com",
    "description": "",
    "is_default": true,
    "timeZone": "America/Chicago"
  }
]

email_text:
Date: Fri, 6 Mar 2026 10:00:00 +0000
Subject: Fwd: Appointment Reminder
From: jezos@gmail.com
---------- Forwarded message ---------
From: Smile Dental <noreply@smiledental.com>
Date: Mon, Mar 3, 2025 at 9:00 AM
Subject: Appointment Reminder
To: <jezos@gmail.com>

This is a reminder that you have a dental appointment on March 15, 2025.

Please arrive 10 minutes early.

Smile Dental
123 Main St, Chicago, IL 60601

events_json:
{
  events: [
    {
      summary: "Dentist Appointment",
      location: "Smile Dental, 123 Main St, Chicago, IL 60601",
      description: "Arrive 10 minutes early",
      conference_call: false,
      date: "15 March 2025",
      start_time: null,
      end_time: null,
      attendees: ["jezos@gmail.com"],
      selected_calendar_id: null
    }
  ]
}

--- EXAMPLE 6 END ---

Respond only with JSON.
`,
};

export {prompt};
