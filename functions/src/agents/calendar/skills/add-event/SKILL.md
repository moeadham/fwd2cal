---
name: add-event
description: Extract calendar events from forwarded emails and add them to the user's Google Calendar. Use this for meeting invites, appointment confirmations, event notifications, or any email containing date/time information.
triggers:
  - fwd:
  - fw:
  - forwarded
  - meeting
  - appointment
  - calendar
subjectOnly: true
---

# Add Calendar Event

## When to use
- Email contains event details (date, time, location)
- Forwarded meeting invitations
- Appointment confirmations
- Any email the user wants added to their calendar

## Execution
This is the default skill. Process the email through the event extraction pipeline.
