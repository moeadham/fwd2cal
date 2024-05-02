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

If the email is a thread,  the most recent email is most relevant, but keep other details from the thread in context.
Relative dates are fine - like "next tuesday". Determine the date of the event based off of the relative difference from the date of the email.
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
};

module.exports = prompts;

