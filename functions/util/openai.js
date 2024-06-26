/* eslint-disable require-jsdoc */
/* eslint-disable max-len */
const OpenAI = require("openai");
const {logger} = require("firebase-functions");
const tokenHelper = require("./tokenHelper");
const prompts = require("./prompts");
const {OPENAI_API_KEY} = require("./credentials");
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const DEFAULT_TEMP = 0.1;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL = "gpt-4-1106-preview";

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

async function defaultCompletion(messages, temperature = DEFAULT_TEMP, format = "json_object") {
  logger.debug(`OpenAI request with ${tokenHelper.countTokens(JSON.stringify(messages))} prompt tokens`);
  const {data: completion, response: raw} = await openai.chat.completions.create({
    messages: messages,
    model: DEFAULT_MODEL,
    response_format: {type: format},
    temperature: temperature,
    max_tokens: DEFAULT_MAX_TOKENS,
  }).withResponse();
  if (format === "json_object") {
    return parseJsonFromOpenAIResponse(completion, raw);
  } else {
    return completion.choices[0].message.content;
  }
}

function parseJsonFromOpenAIResponse(completion, raw) {
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
  logger.debug(`OpenAI tokens used: ${completion.usage.total_tokens} remaining tokens: ${raw.headers.get("x-ratelimit-remaining-tokens")}`);
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
    defaultCompletion(eventMessages),
    defaultCompletion(timezoneMessages),
  ]);

  [eventResponse, timezoneResponse].forEach((res) => {
    Object.keys(res).forEach((key) => {
      if (res[key] === "undefined") {
        res[key] = undefined;
      }
    });
  });
  logger.debug(`Timezone selection: ${timezoneResponse.timezone}, ${timezoneResponse.reason}`);

  eventResponse.timeZone = timezoneResponse.timezone;

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
  return await defaultCompletion(messages);
}

module.exports = {
  defaultCompletion,
  processEmail,
  parseICS,
};

