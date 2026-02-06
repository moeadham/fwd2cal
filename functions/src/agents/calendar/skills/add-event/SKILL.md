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
1. Authenticate with user's Google Calendar (OAuth)
2. Fetch user's available calendars
3. Check for ICS attachments - if found, parse event from ICS
4. If no ICS, extract event details using LLM (retry with document attachments if needed)
5. Validate event times
6. Add event(s) to Google Calendar
7. Send confirmation email
