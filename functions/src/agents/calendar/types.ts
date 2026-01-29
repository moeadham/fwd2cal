import {z} from "zod";

// ============================================================================
// ZOD SCHEMAS
// ============================================================================

// Event schema - individual event within the events array
export const EventSchema = z.object({
  summary: z.string().describe("The title of the event"),
  location: z.string().nullable().describe("A location of the event if one has been given"),
  description: z.string().nullable().describe("A description of the event if one has been given"),
  conference_call: z.boolean().describe("True or false, if the event is a conference call or virtual"),
  date: z.string().describe("DD MMMM YYYY - the date of the event"),
  start_time: z.string().describe("HH:mm - the start time of the event in 24 hour format"),
  end_time: z.string().nullable().describe("HH:mm - the end time of the event in 24 hour format"),
  attendees: z.array(z.string())
    .describe("A list of attendees email addresses. ONLY INCLUDE VALID EMAIL ADDRESSES, NOT NAMES."),
  selected_calendar_id: z.string().nullable().optional().describe("The calendar_id where this event should be added."),
  timeZone: z.string().nullable().optional().describe("IANA timezone string"),
});

// Event data schema - main response for email processing
export const EventDataSchema = z.object({
  events: z.array(EventSchema).nullable().optional().describe("Array of events extracted from the email"),
  error: z.string().nullable().optional().describe("Error message if no date provided"),
  description: z.string().nullable().optional().describe("Error description if no date provided"),
  reason: z.string().nullable().optional().describe("Reason for your choices. This is for debugging purposes only."),
});

// Timezone schema
export const TimezoneSchema = z.object({
  reason: z.string().describe("Brief reasoning of why the timezone was chosen"),
  timezone: z.string().nullable().describe("IANA Time Zone Database formatted string"),
});

// ICS Parser schema - complex Google Calendar event format
export const ICSParserSchema = z.object({
  kind: z.string().nullable().optional().describe("Type of the resource (calendar#event)"),
  created: z.string().nullable().optional().describe("Creation time of the event (as a RFC3339 timestamp)"),
  updated: z.string().nullable().optional().describe("Last modification time of the event (as a RFC3339 timestamp)"),
  summary: z.string().nullable().optional().describe("Title of the event"),
  description: z.string().nullable().optional().describe("Description of the event. Can contain HTML"),
  location: z.string().nullable().optional().describe("Geographic location of the event as free-form text"),
  creator: z.object({
    id: z.string().nullable().optional().describe("The creator's Profile ID"),
    email: z.string().nullable().optional().describe("The creator's email address"),
    displayName: z.string().nullable().optional().describe("The creator's name"),
  }).nullable().optional(),
  organizer: z.object({
    id: z.string().nullable().optional().describe("The organizer's Profile ID"),
    email: z.string().nullable().optional().describe("The organizer's email address"),
    displayName: z.string().nullable().optional().describe("The organizer's name"),
  }).nullable().optional(),
  start: z.object({
    date: z.string().nullable().optional()
      .describe("The date, in the format yyyy-mm-dd, if this is an all-day event"),
    dateTime: z.string().nullable().optional()
      .describe("The time, as a combined date-time value (formatted according to RFC3339)"),
    timeZone: z.string().describe("IANA Time Zone Database formatted string. Example: Europe/London"),
  }).nullable().optional(),
  end: z.object({
    date: z.string().nullable().optional()
      .describe("The date, in the format yyyy-mm-dd, if this is an all-day event"),
    dateTime: z.string().nullable().optional()
      .describe("The time, as a combined date-time value (formatted according to RFC3339)"),
    timeZone: z.string().describe("IANA Time Zone Database formatted string. Example: Europe/London"),
  }).nullable().optional(),
  endTimeUnspecified: z.boolean().nullable().optional()
    .describe("Whether the end time is actually unspecified"),
  recurrence: z.array(z.string()).nullable().optional()
    .describe("List of RRULE, EXRULE, RDATE and EXDATE lines for a recurring event"),
  recurringEventId: z.string().nullable().optional()
    .describe("For an instance of a recurring event, this is the id of the recurring event"),
  originalStartTime: z.object({
    date: z.string().nullable().optional()
      .describe("The date, in the format yyyy-mm-dd, if this is an all-day event"),
    dateTime: z.string().nullable().optional()
      .describe("The time, as a combined date-time value (formatted according to RFC3339)"),
    timeZone: z.string().nullable().optional().describe("IANA Time Zone Database formatted string"),
  }).nullable().optional(),
  attendees: z.array(z.object({
    id: z.string().nullable().optional().describe("The attendee's Profile ID"),
    email: z.string().nullable().optional().describe("The attendee's email address"),
    displayName: z.string().nullable().optional().describe("The attendee's name"),
    organizer: z.boolean().nullable().optional().describe("Whether the attendee is the organizer of the event"),
    resource: z.boolean().nullable().optional().describe("Whether the attendee is a resource"),
    optional: z.boolean().nullable().optional().describe("Whether this is an optional attendee"),
    responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"])
      .nullable().optional().describe("The attendee's response status"),
    comment: z.string().nullable().optional().describe("The attendee's response comment"),
    additionalGuests: z.number().int().nullable().optional().describe("Number of additional guests"),
  })).nullable().optional(),
  attendeesOmitted: z.boolean().nullable().optional()
    .describe("Whether attendees may have been omitted from the event's representation"),
  hangoutLink: z.string().nullable().optional()
    .describe("An absolute link to the Google Hangout associated with this event"),
  conferenceData: z.object({
    createRequest: z.object({
      requestId: z.string().nullable().optional().describe("The client-generated unique ID for this request"),
      conferenceSolutionKey: z.object({
        type: z.enum(["eventHangout", "eventNamedHangout", "hangoutsMeet", "addOn"])
          .nullable().optional().describe("The conference solution type"),
      }).nullable().optional(),
      status: z.object({
        statusCode: z.enum(["pending", "success", "failure"]).nullable().optional()
          .describe("The current status of the conference create request"),
      }).nullable().optional(),
    }).nullable().optional(),
    entryPoints: z.array(z.object({
      entryPointType: z.enum(["video", "phone", "sip", "more"]).nullable().optional()
        .describe("The type of the conference entry point"),
      uri: z.string().nullable().optional().describe("The URI of the entry point"),
      label: z.string().nullable().optional().describe("The label for the URI"),
      pin: z.string().nullable().optional().describe("The PIN to access the conference"),
      accessCode: z.string().nullable().optional().describe("The access code to access the conference"),
      meetingCode: z.string().nullable().optional().describe("The meeting code to access the conference"),
      passcode: z.string().nullable().optional().describe("The passcode to access the conference"),
      password: z.string().nullable().optional().describe("The password to access the conference"),
    })).nullable().optional(),
    conferenceSolution: z.object({
      key: z.object({
        type: z.enum(["eventHangout", "eventNamedHangout", "hangoutsMeet", "addOn"]).nullable().optional(),
      }).nullable().optional(),
      name: z.string().nullable().optional().describe("The user-visible name of this solution"),
      iconUri: z.string().nullable().optional().describe("The user-visible icon for this solution"),
    }).nullable().optional(),
    conferenceId: z.string().nullable().optional().describe("The ID of the conference"),
    signature: z.string().nullable().optional().describe("The signature of the conference data"),
    notes: z.string().nullable().optional().describe("Additional notes to display to the user"),
  }).nullable().optional(),
  reminders: z.object({
    useDefault: z.boolean().nullable().optional()
      .describe("Whether the default reminders of the calendar apply to the event"),
    overrides: z.array(z.object({
      method: z.enum(["email", "popup"]).describe("The method used by this reminder"),
      minutes: z.number().int()
        .describe("Number of minutes before the start of the event when the reminder should trigger"),
    })).nullable().optional(),
  }).nullable().optional(),
  source: z.object({
    url: z.string().nullable().optional().describe("URL of the source pointing to a resource"),
    title: z.string().nullable().optional().describe("Title of the source"),
  }).nullable().optional(),
  workingLocationProperties: z.object({
    type: z.enum(["homeOffice", "officeLocation", "customLocation"]).nullable().optional()
      .describe("Type of the working location"),
    homeOffice: z.unknown().nullable().optional().describe("Specifies that the user is working at home"),
    customLocation: z.object({
      label: z.string().nullable().optional().describe("An optional extra label for additional information"),
    }).nullable().optional(),
    officeLocation: z.object({
      buildingId: z.string().nullable().optional().describe("An optional building identifier"),
      floorId: z.string().nullable().optional().describe("An optional floor identifier"),
      floorSectionId: z.string().nullable().optional().describe("An optional floor section identifier"),
      deskId: z.string().nullable().optional().describe("An optional desk identifier"),
      label: z.string().nullable().optional().describe("The office name that's displayed in Calendar clients"),
    }).nullable().optional(),
  }).nullable().optional(),
  outOfOfficeProperties: z.object({
    autoDeclineMode: z.enum([
      "declineNone",
      "declineAllConflictingInvitations",
      "declineOnlyNewConflictingInvitations",
    ]).nullable().optional()
      .describe("Whether to decline meeting invitations which overlap Out of office events"),
    declineMessage: z.string().nullable().optional()
      .describe("Response message to set if an event is automatically declined"),
  }).nullable().optional(),
  focusTimeProperties: z.object({
    autoDeclineMode: z.enum([
      "declineNone",
      "declineAllConflictingInvitations",
      "declineOnlyNewConflictingInvitations",
    ]).nullable().optional()
      .describe("Whether to decline meeting invitations which overlap Focus Time events"),
    declineMessage: z.string().nullable().optional()
      .describe("Response message to set if an event is automatically declined"),
    chatStatus: z.enum(["available", "doNotDisturb"]).nullable().optional()
      .describe("The status to mark the user in Chat and related products"),
  }).nullable().optional(),
});

// Inferred Types from Zod Schemas
export type Event = z.infer<typeof EventSchema>;
export type EventData = z.infer<typeof EventDataSchema>;
export type Timezone = z.infer<typeof TimezoneSchema>;
export type ICSParsedEvent = z.infer<typeof ICSParserSchema>;

// ============================================================================
// CALENDAR TYPES
// ============================================================================

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

// ICS calendar event from node-ical library
export interface ICalEvent {
  type: string;
  start: Date;
  end: Date;
  summary?: string | { val: string };
  description?: string | { val: string };
  location?: string | { val: string };
  organizer?: { val: string };
  attendee?: Array<{ val: string }>;
  timezone?: string;
}

// ICS timezone from node-ical library
export interface ICalTimezone {
  type: string;
  tzid: string;
}

// ============================================================================
// EMAIL TYPES
// ============================================================================

// Transformed email from Resend webhook
export interface TransformedEmail {
  subject: string;
  text: string;
  html: string;
  from: string;
  to: string[];
  headers: Record<string, string>;
  SPF: "pass" | "fail";
  dkim: string;
}

// Email headers
export interface EmailHeaders {
  date?: string;
  subject?: string;
  from?: string;
  "Message-ID"?: string;
  References?: string;
  [key: string]: string | undefined;
}

// ICS file attachment
export interface ICSFile {
  fieldname: string;
  file: Buffer;
  filename: { filename: string };
  encoding: string;
  mimetype: string;
}

// Attachment info from Resend
export interface AttachmentInfo {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  download_url: string;
}

// Processed attachments result
export interface ProcessedAttachments {
  icsFiles: ICSFile[];
  imageUrls: string[];
}

// Email response template
export interface EmailResponseTemplate {
  templateName: string;
  replace: Record<string, string>;
  subject?: boolean;
}

// Mail template
export interface MailTemplate {
  html: string;
  subject?: string;
}

// Mail templates collection
export interface MailTemplates {
  noUserFound: MailTemplate;
  unverifiedEmail: MailTemplate;
  oauthFailed: MailTemplate;
  unableToParse: MailTemplate;
  aiParseError: MailTemplate;
  eventAddedICS: MailTemplate;
  icsError: MailTemplate;
  eventAdded: MailTemplate;
  eventAddedAttendees: MailTemplate;
  addAdditionalEmailAddress: MailTemplate;
  additionalEmailInUse: MailTemplate;
  removalEmailInUse: MailTemplate;
  emailAddressRemoved: MailTemplate;
  userDeleted: MailTemplate;
}

// Handle email result
export interface HandleEmailResult {
  error?: string;
  result?: string;
  verificationCode?: string;
}

// Email thread headers for reply
export interface EmailThreadHeaders {
  "In-Reply-To"?: string;
  References?: string;
  [key: string]: string | undefined;
}

// Maps email response types to templates
export interface EmailResponses {
  [key: string]: EmailResponseTemplate;
}

// Minimal email interface for LLM processing
export interface EmailForProcessing {
  text: string;
}

// Email headers for LLM processing
export interface HeadersForProcessing {
  date?: string;
  subject?: string;
  from?: string;
}

// ============================================================================
// OPENAI/LLM TYPES
// ============================================================================

// OpenAI message content types
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageURLContent {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export type MessageContent = string | Array<TextContent | ImageURLContent>;

// OpenAI chat message
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: MessageContent;
}

// Prompt configuration
export interface PromptConfig {
  model: string;
  prompt: string;
}

// Prompts object
export interface Prompts {
  getEventData: PromptConfig;
  getEventTimezone: PromptConfig;
  parseICS: PromptConfig;
}

// OpenAI completion response
export interface CompletionChoice {
  message: {
    content: string;
    parsed?: Record<string, unknown>;
  };
  finish_reason: string;
}

export interface CompletionResponse {
  choices: CompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
