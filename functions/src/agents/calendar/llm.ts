import {logger} from "firebase-functions/v2";
import {defaultCompletion, DEFAULT_TEMP} from "../../util/openai";
import {prompts} from "./prompts";
import {
  EventDataSchema,
  TimezoneSchema,
  ICSParserSchema,
  SkillSelectionSchema,
  EventData,
  Timezone,
  ICSParsedEvent,
  SkillSelection,
  ChatMessage,
  CalendarForLLM,
  TextContent,
  ImageURLContent,
  EmailForProcessing,
  HeadersForProcessing,
  ParsedDocument,
} from "./types";

async function processEmail(
    email: EmailForProcessing,
    headers: HeadersForProcessing,
    uid: string | null = null,
    imageUrls: string[] = [],
    calendars: CalendarForLLM[] = [],
    documents: ParsedDocument[] = [],
): Promise<EventData> {
  // Prepend calendar list if provided
  let calendarText = "";
  if (calendars && calendars.length > 0) {
    calendarText = `available_calendars:\n${JSON.stringify(calendars, null, 2)}\n\nemail_text:\n`;
  }

  // Format document text if provided
  let documentText = "";
  if (documents && documents.length > 0) {
    documentText = "\n\n--- ATTACHED DOCUMENTS ---\n" +
      documents.map((doc) => `## ${doc.filename}\n${doc.content}`).join("\n\n");
    logger.info("Including document text in LLM request", {
      documentCount: documents.length,
      totalChars: documentText.length,
    });
  }

  const text = `${calendarText}Date: ${headers.date}
  Subject: ${headers.subject}
  From: ${headers.from}
  ${email.text}${documentText}`;

  // Build user message content - text + images
  let userContent: string | Array<TextContent | ImageURLContent>;
  if (imageUrls && imageUrls.length > 0) {
    // Multi-content format with text and images
    const contentArray: Array<TextContent | ImageURLContent> = [
      {
        type: "text",
        text: text,
      },
    ];
    // Add each image URL
    imageUrls.forEach((url) => {
      contentArray.push({
        type: "image_url",
        image_url: {
          url: url,
        },
      });
    });
    userContent = contentArray;
    logger.info("Including images in LLM request", {
      imageCount: imageUrls.length,
    });
  } else {
    // Text-only format (backward compatible)
    userContent = text;
  }

  const eventMessages: ChatMessage[] = [
    {
      role: "system",
      content: prompts.getEventData.prompt,
    },
    {role: "user", content: userContent},
  ];
  const timezoneMessages: ChatMessage[] = [
    {
      role: "system",
      content: prompts.getEventTimezone.prompt,
    },
    {role: "user", content: userContent},
  ];

  const [eventResponse, timezoneResponse] = await Promise.all([
    defaultCompletion<EventData>(
        eventMessages,
        prompts.getEventData.model,
        DEFAULT_TEMP,
        EventDataSchema,
        uid,
    ),
    defaultCompletion<Timezone>(
        timezoneMessages,
        prompts.getEventTimezone.model,
        DEFAULT_TEMP,
        TimezoneSchema,
        uid,
    ),
  ]);

  const eventResult = eventResponse as EventData;
  const timezoneResult = timezoneResponse as Timezone;

  // Clean up undefined values
  [eventResult, timezoneResult].forEach((res) => {
    Object.keys(res).forEach((key) => {
      const value = (res as Record<string, unknown>)[key];
      if (value === "undefined" || value === null) {
        (res as Record<string, unknown>)[key] = undefined;
      }
    });
  });

  logger.debug(
      `Timezone selection: ${timezoneResult.timezone}, ${timezoneResult.reason}`,
  );

  // Handle both old single event format and new array format
  if (eventResult.events && Array.isArray(eventResult.events)) {
    // New array format - add timezone to each event
    eventResult.events.forEach((event) => {
      event.timeZone = timezoneResult.timezone || undefined;
      // Clean up undefined values in each event
      Object.keys(event).forEach((key) => {
        const value = (event as Record<string, unknown>)[key];
        if (value === "undefined" || value === null) {
          (event as Record<string, unknown>)[key] = undefined;
        }
      });
    });
  } else if (!eventResult.error) {
    // Old single event format - convert to array format
    const singleEvent = {
      summary: (eventResult as unknown as Record<string, string>).summary || "Event",
      location: (eventResult as unknown as Record<string, string | null>).location,
      description: (eventResult as unknown as Record<string, string | null>).description,
      conference_call: (eventResult as unknown as Record<string, boolean>).conference_call || false,
      date: (eventResult as unknown as Record<string, string>).date || "",
      start_time: (eventResult as unknown as Record<string, string>).start_time || "",
      end_time: (eventResult as unknown as Record<string, string | null>).end_time,
      attendees: (eventResult as unknown as Record<string, string[]>).attendees || [],
      timeZone: timezoneResult.timezone || undefined,
    };
    return {events: [singleEvent]};
  }

  return eventResult;
}

async function parseICS(ics: string): Promise<ICSParsedEvent> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: prompts.parseICS.prompt,
    },
    {role: "user", content: ics},
  ];
  return (await defaultCompletion<ICSParsedEvent>(
      messages,
      prompts.parseICS.model,
      DEFAULT_TEMP,
      ICSParserSchema,
  )) as ICSParsedEvent;
}

async function selectSkill(
    subject: string,
    body: string,
    skillsContext: string,
    uid: string | null = null,
): Promise<SkillSelection> {
  // Replace placeholder in prompt with actual skills context
  const systemPrompt = prompts.selectSkill.prompt.replace(
      "{skills_context}",
      skillsContext,
  );

  const userContent = `Subject: ${subject}\n\nBody:\n${body}`;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt,
    },
    {role: "user", content: userContent},
  ];

  return (await defaultCompletion<SkillSelection>(
      messages,
      prompts.selectSkill.model,
      DEFAULT_TEMP,
      SkillSelectionSchema,
      uid,
  )) as SkillSelection;
}

export {processEmail, parseICS, selectSkill};
