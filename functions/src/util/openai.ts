import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { logger } from "firebase-functions/v2";
import tokenHelper from "./tokenHelper";
import { prompts } from "./prompts";
import {
  EventDataSchema,
  TimezoneSchema,
  ICSParserSchema,
  EventData,
  Timezone,
  ICSParsedEvent,
  ChatMessage,
  CalendarForLLM,
  TextContent,
  ImageURLContent,
} from "../types";
import { OPENROUTER_API_KEY } from "./config";
import { sendEvent } from "./analytics";
import { z } from "zod";

const DEFAULT_TEMP = 0.1;
const DEFAULT_MAX_TOKENS = 16384;

// Lazy initialization of OpenAI client configured for OpenRouter
let openai: OpenAI | null = null;

const getOpenAIClient = (): OpenAI => {
  if (!openai) {
    const apiKey = OPENROUTER_API_KEY.value();
    if (!apiKey) {
      throw new Error("OpenRouter API key not configured");
    }
    openai = new OpenAI({
      apiKey: apiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return openai;
};

async function defaultCompletion<T>(
  messages: ChatMessage[],
  model: string,
  temperature: number = DEFAULT_TEMP,
  zodSchema: z.ZodType<T> | null = null,
  uid: string | null = null
): Promise<T | string> {
  logger.debug(
    `OpenAI request with ${tokenHelper.countTokens(JSON.stringify(messages))} prompt tokens`
  );

  const requestOptions: OpenAI.ChatCompletionCreateParams = {
    messages: messages as OpenAI.ChatCompletionMessageParam[],
    model: model,
    temperature: temperature,
    max_tokens: DEFAULT_MAX_TOKENS,
  };

  if (zodSchema) {
    // Use structured output with Zod schema
    (requestOptions as OpenAI.ChatCompletionCreateParams).response_format =
      zodResponseFormat(zodSchema, "response") as OpenAI.ResponseFormatJSONSchema;
    const completion = await (
      getOpenAIClient().chat.completions as OpenAI.Chat.Completions & {
        parse: (params: OpenAI.ChatCompletionCreateParams) => Promise<{
          choices: Array<{
            message: { parsed: T };
            finish_reason: string;
          }>;
          usage: { total_tokens: number };
        }>;
      }
    ).parse(requestOptions);

    if (!completion) {
      logger.error("Completion is null");
      if (uid)
        sendEvent(uid, "aiError", {
          reason: "invalid_response",
        });
      throw new Error("Completion is null");
    }
    if (!completion.choices || !completion.choices[0]) {
      logger.error("No choices in completion");
      logger.error(JSON.stringify(completion, null, 2));
      if (uid)
        sendEvent(uid, "aiError", {
          reason: "invalid_response",
        });
      throw new Error("No choices in completion");
    }
    if (completion.choices[0].finish_reason !== "stop") {
      logger.error(
        `Unexpected finish reason: ${completion.choices[0].finish_reason}`
      );
      logger.error(JSON.stringify(completion, null, 2));
      if (uid)
        sendEvent(uid, "aiError", {
          reason: "invalid_response",
        });
      throw new Error(
        `Unexpected finish reason: ${completion.choices[0].finish_reason}`
      );
    }

    logger.debug(`OpenAI tokens used: ${completion.usage.total_tokens}`);
    return completion.choices[0].message.parsed;
  } else {
    // Regular text completion without structured output
    const completion = await getOpenAIClient().chat.completions.create(
      requestOptions
    );
    return completion.choices[0].message.content || "";
  }
}

interface EmailForProcessing {
  text: string;
}

interface HeadersForProcessing {
  date?: string;
  subject?: string;
  from?: string;
}

async function processEmail(
  email: EmailForProcessing,
  headers: HeadersForProcessing,
  uid: string | null = null,
  imageUrls: string[] = [],
  calendars: CalendarForLLM[] = []
): Promise<EventData> {
  // Prepend calendar list if provided
  let calendarText = "";
  if (calendars && calendars.length > 0) {
    calendarText = `available_calendars:\n${JSON.stringify(calendars, null, 2)}\n\nemail_text:\n`;
  }

  const text = `${calendarText}Date: ${headers.date}
  Subject: ${headers.subject}
  From: ${headers.from}
  ${email.text}`;

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
    { role: "user", content: userContent },
  ];
  const timezoneMessages: ChatMessage[] = [
    {
      role: "system",
      content: prompts.getEventTimezone.prompt,
    },
    { role: "user", content: userContent },
  ];

  const [eventResponse, timezoneResponse] = await Promise.all([
    defaultCompletion<EventData>(
      eventMessages,
      prompts.getEventData.model,
      DEFAULT_TEMP,
      EventDataSchema,
      uid
    ),
    defaultCompletion<Timezone>(
      timezoneMessages,
      prompts.getEventTimezone.model,
      DEFAULT_TEMP,
      TimezoneSchema,
      uid
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
    `Timezone selection: ${timezoneResult.timezone}, ${timezoneResult.reason}`
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
    return { events: [singleEvent] };
  }

  return eventResult;
}

async function parseICS(ics: string): Promise<ICSParsedEvent> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: prompts.parseICS.prompt,
    },
    { role: "user", content: ics },
  ];
  return (await defaultCompletion<ICSParsedEvent>(
    messages,
    prompts.parseICS.model,
    DEFAULT_TEMP,
    ICSParserSchema
  )) as ICSParsedEvent;
}

export { defaultCompletion, processEmail, parseICS };
