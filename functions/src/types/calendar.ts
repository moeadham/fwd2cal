// Google Calendar from API
export interface GoogleCalendar {
  kind: string;
  etag: string;
  id: string;
  summary: string;
  summaryOverride?: string;
  description?: string;
  location?: string;
  timeZone: string;
  colorId?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  hidden?: boolean;
  selected?: boolean;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
  defaultReminders?: Array<{ method: string; minutes: number }>;
  notificationSettings?: { notifications: Array<{ type: string; method: string }> };
  primary?: boolean;
  deleted?: boolean;
  conferenceProperties?: { allowedConferenceSolutionTypes: string[] };
}

// Mapped calendar for internal use
export interface MappedCalendar {
  kind: string;
  etag: string;
  selected: boolean | undefined;
  accessRole: string;
  conferenceProperties: { allowedConferenceSolutionTypes: string[] } | undefined;
  calendar_id: string;
  summary: string;
  summaryOverride: string | undefined;
  description: string | undefined;
  primary: boolean | undefined;
  timeZone: string;
  location: string | undefined;
  hidden: boolean | undefined;
  deleted: boolean | undefined;
  uid: string;
}

// Calendar for LLM context
export interface CalendarForLLM {
  calendar_id: string;
  summary: string;
  description: string;
  is_default: boolean;
  timeZone: string;
}

// Google Calendar event (returned from API)
export interface GoogleCalendarEvent {
  kind: string;
  id: string;
  htmlLink: string;
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: Array<{ email: string; responseStatus?: string }>;
  organizer?: { email: string; displayName?: string };
  location?: string;
  calendarId?: string;
  calendarName?: string;
  isPrimaryCalendar?: boolean;
  uid?: string;
  inviteOthersLink?: string;
  inviteOthersAttendees?: string[];
}

// Time object for calendar events
export interface TimeObject {
  start: {
    dateTime: string;
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
}

// Event validation result
export interface EventValidationResult {
  isValid: boolean;
  error?: string;
}

// Parsed ICS event result (simplified)
export interface ParsedICSEvent {
  summary: string;
  location: string | undefined;
  description: string | undefined;
  conference_call: string;
  date: string;
  start_time: string;
  end_time: string;
  attendees: string[];
  timezone?: string;
}

// Calendar event request body for Google API
export interface CalendarEventRequestBody {
  summary: string;
  status: string;
  description: string;
  attendees: Array<{ email: string; responseStatus?: string }>;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  guestsCanInviteOthers: boolean;
  guestsCanModify: boolean;
  guestsCanSeeOtherGuests: boolean;
  location?: string;
}

// Failed event info
export interface FailedEvent {
  event: { summary: string; attendees: string[] };
  error: string;
}
