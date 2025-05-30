/* eslint-disable require-jsdoc */
/* eslint-disable max-len */
const OpenAI = require("openai");
const {logger} = require("firebase-functions");
const tokenHelper = require("./tokenHelper");
const {prompts, schemas} = require("./prompts");
const {OPENAI_API_KEY} = require("./credentials");
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const DEFAULT_TEMP = 0.1;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL = "gpt-4.1-mini-2025-04-14";// "gpt-4o-mini-2024-07-18";

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

async function defaultCompletion(messages, temperature = DEFAULT_TEMP, schema = null) {
  logger.debug(`OpenAI request with ${tokenHelper.countTokens(JSON.stringify(messages))} prompt tokens`);

  const requestOptions = {
    messages: messages,
    model: DEFAULT_MODEL,
    temperature: temperature,
    max_tokens: DEFAULT_MAX_TOKENS,
  };

  if (schema) {
    requestOptions.response_format = {
      type: "json_schema",
      json_schema: {
        name: "response",
        schema: schema,
      },
    };
  }

  const completion = await openai.chat.completions.create(requestOptions);

  if (schema) {
    return parseJsonFromOpenAIResponse(completion);
  } else {
    return completion.choices[0].message.content;
  }
}

function parseJsonFromOpenAIResponse(completion) {
  let response;
  if (!completion) {
    logger.warn(`Completion is null`);
    logger.warn(JSON.stringify(completion, null, 2));
    throw new Error("Completion is null");
  }
  if (!completion.choices || !completion.choices[0]) {
    logger.error(`No choices in completion`);
    logger.error(JSON.stringify(completion, null, 2));
    throw new Error("No choices in completion");
  }
  if (completion.choices[0].finish_reason !== "stop") {
    logger.error(`Unexpected finish reason: ${completion.choices[0].finish_reason}`);
    logger.error(JSON.stringify(completion, null, 2));
    throw new Error(`Unexpected finish reason: ${completion.choices[0].finish_reason}`);
  }
  if (!completion.choices[0].message || !completion.choices[0].message.content) {
    logger.error(`No content in completion message`);
    logger.error(JSON.stringify(completion, null, 2));
    throw new Error("No content in completion message");
  }
  try {
    response = JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    throw new Error("Non JSON response received. Try again.");
  }
  logger.debug(`OpenAI tokens used: ${completion.usage.total_tokens}`);
  return response;
}

async function processEmail(email, headers) {
  const text = `
  Date: ${headers.Date}
  Subject: ${headers.Subject}
  From: ${headers.From}
  ${email.text}`;

  // logger.log(text);
  const eventMessages = [
    {
      role: "system",
      content: prompts.getEventData,
    },
    {role: "user", content: text},
  ];
  const timezoneMessages = [
    {
      role: "system",
      content: prompts.getEventTimezone,
    },
    {role: "user", content: text},
  ];

  const [eventResponse, timezoneResponse] = await Promise.all([
    defaultCompletion(eventMessages, DEFAULT_TEMP, schemas.eventData),
    defaultCompletion(timezoneMessages, DEFAULT_TEMP, schemas.timezone),
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
  return await defaultCompletion(messages, DEFAULT_TEMP, schemas.icsParser);
}

module.exports = {
  defaultCompletion,
  processEmail,
  parseICS,
};

