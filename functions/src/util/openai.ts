import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { logger } from "firebase-functions/v2";
import tokenHelper from "./tokenHelper";
import { ChatMessage } from "../types";
import { OPENROUTER_API_KEY } from "./config";
import { sendEvent } from "./analytics";
import { z } from "zod";

const DEFAULT_TEMP = 0.1;
const DEFAULT_MAX_TOKENS = 16384;

// Lazy initialization of OpenAI client configured for OpenRouter
let openai: OpenAI | null = null;

/**
 * Get or create the OpenAI client configured for OpenRouter
 */
function getOpenAIClient(): OpenAI {
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
}

/**
 * Generic completion function with support for structured output via Zod schemas
 */
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

export { getOpenAIClient, defaultCompletion, DEFAULT_TEMP, DEFAULT_MAX_TOKENS };
