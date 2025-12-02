/* eslint-disable require-jsdoc */
/* eslint-disable max-len */
const OpenAI = require("openai");
const {zodResponseFormat} = require("openai/helpers/zod");
const {logger} = require("firebase-functions");
const tokenHelper = require("./tokenHelper");
const {prompts} = require("./prompts");
const {getUserContext} = require("./firestoreHandler");
const {EventDataSchema, TimezoneSchema, ICSParserSchema} = require("./schemas.zod");
const {OPENROUTER_API_KEY} = require("./config");
const {sendEvent} = require("./analytics");

const DEFAULT_TEMP = 0.1;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL = "openai/gpt-4.1-mini";

// Lazy initialization of OpenAI client configured for OpenRouter
let openai = null;
const getOpenAIClient = () => {
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

async function defaultCompletion(messages, temperature = DEFAULT_TEMP, zodSchema = null, uid = null) {
  logger.debug(`OpenAI request with ${tokenHelper.countTokens(JSON.stringify(messages))} prompt tokens`);

  const requestOptions = {
    messages: messages,
    model: DEFAULT_MODEL,
    temperature: temperature,
    max_tokens: DEFAULT_MAX_TOKENS,
  };

  if (zodSchema) {
    // Use structured output with Zod schema
    requestOptions.response_format = zodResponseFormat(zodSchema, "response");
    const completion = await getOpenAIClient().chat.completions.parse(requestOptions);

    if (!completion) {
      logger.error("Completion is null");
      if (uid) sendEvent(uid, "aiError", {reason: "invalid_response", detail: "completion_null"});
      throw new Error("Completion is null");
    }
    if (!completion.choices || !completion.choices[0]) {
      logger.error("No choices in completion");
      logger.error(JSON.stringify(completion, null, 2));
      if (uid) sendEvent(uid, "aiError", {reason: "invalid_response", detail: "no_choices"});
      throw new Error("No choices in completion");
    }
    if (completion.choices[0].finish_reason !== "stop") {
      logger.error(`Unexpected finish reason: ${completion.choices[0].finish_reason}`);
      logger.error(JSON.stringify(completion, null, 2));
      if (uid) sendEvent(uid, "aiError", {reason: "invalid_response", detail: completion.choices[0].finish_reason});
      throw new Error(`Unexpected finish reason: ${completion.choices[0].finish_reason}`);
    }

    logger.debug(`OpenAI tokens used: ${completion.usage.total_tokens}`);
    return completion.choices[0].message.parsed;
  } else {
    // Regular text completion without structured output
    const completion = await getOpenAIClient().chat.completions.create(requestOptions);
    return completion.choices[0].message.content;
  }
}

async function processEmail(email, headers, uid = null) {
  const text = `
  Date: ${headers.date}
  Subject: ${headers.subject}
  From: ${headers.from}
  ${email.text}`;

  let userContextInstruction = "";
  if (uid) {
    try {
      const userContext = await getUserContext(uid);
      if (userContext && userContext.trim()) {
        userContextInstruction = `\n\nUser context (use this to decide which events are relevant and how to interpret the email):\n${userContext.trim()}`;
      }
    } catch (error) {
      logger.warn(`Unable to load user context for uid ${uid}:`, error);
    }
  }

  const eventMessages = [
    {
      role: "system",
      content: prompts.getEventData + userContextInstruction,
    },
    {role: "user", content: text},
  ];
  const timezoneMessages = [
    {
      role: "system",
      content: prompts.getEventTimezone + userContextInstruction,
    },
    {role: "user", content: text},
  ];

  const [eventResponse, timezoneResponse] = await Promise.all([
    defaultCompletion(eventMessages, DEFAULT_TEMP, EventDataSchema, uid),
    defaultCompletion(timezoneMessages, DEFAULT_TEMP, TimezoneSchema, uid),
  ]);

  // Clean up undefined values
  [eventResponse, timezoneResponse].forEach((res) => {
    Object.keys(res).forEach((key) => {
      if (res[key] === "undefined" || res[key] === null) {
        res[key] = undefined;
      }
    });
  });

  logger.debug(`Timezone selection: ${timezoneResponse.timezone}, ${timezoneResponse.reason}`);

  // Handle both old single event format and new array format
  if (eventResponse.events && Array.isArray(eventResponse.events)) {
    // New array format - add timezone to each event
    eventResponse.events.forEach((event) => {
      event.timeZone = timezoneResponse.timezone;
      // Clean up undefined values in each event
      Object.keys(event).forEach((key) => {
        if (event[key] === "undefined" || event[key] === null) {
          event[key] = undefined;
        }
      });
    });
  } else if (!eventResponse.error) {
    // Old single event format - convert to array format
    const singleEvent = {
      summary: eventResponse.summary,
      location: eventResponse.location,
      description: eventResponse.description,
      conference_call: eventResponse.conference_call,
      date: eventResponse.date,
      start_time: eventResponse.start_time,
      end_time: eventResponse.end_time,
      attendees: eventResponse.attendees,
      timeZone: timezoneResponse.timezone,
    };
    return {events: [singleEvent]};
  }

  return eventResponse;
}

async function parseICS(ics) {
  const messages = [
    {
      role: "system",
      content: prompts.parseICS,
    },
    {role: "user", content: ics},
  ];
  return await defaultCompletion(messages, DEFAULT_TEMP, ICSParserSchema);
}

module.exports = {
  defaultCompletion,
  processEmail,
  parseICS,
};

