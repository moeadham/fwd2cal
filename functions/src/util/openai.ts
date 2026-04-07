import OpenAI from "openai";
import {LengthFinishReasonError} from "openai/core/error";
import {zodResponseFormat} from "openai/helpers/zod";
import {logger} from "firebase-functions/v2";
import tokenHelper from "./tokenHelper";
import {ChatMessage} from "./types";
import {OPENROUTER_API_KEY} from "./config";
import {sendEvent} from "./analytics";
import {z} from "zod";

const DEFAULT_TEMP = 0.1;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_RETRY_DELAY_MS = 10000;

/**
 * Check if an error is a network-related error
 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as Error & { code?: string; type?: string };
  return (
    err.message?.includes("terminated") ||
    err.code === "UND_ERR_SOCKET" ||
    err.code === "ECONNRESET" ||
    err.code === "ETIMEDOUT" ||
    err.type === "system"
  );
}

/**
 * Check if an error is retryable (network, 429, 5xx, or transient 404)
 */
function isRetryableError(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  const err = error as Error & { status?: number };
  if (err.status === 404 || err.status === 429) return true;
  if (err.status && err.status >= 500 && err.status < 600) return true;
  return false;
}

/**
 * Check if an error is a parsing/syntax error that should retry immediately
 */
function isParsingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message?.includes("Cannot read properties of undefined") ||
    error.message?.includes("SyntaxError")
  );
}

/**
 * Delay helper for retry logic
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    uid: string | null = null,
    retry: boolean = true,
    maxTokens?: number,
): Promise<T | string> {
  logger.debug(
      `OpenAI request with ${tokenHelper.countTokens(JSON.stringify(messages))} prompt tokens`,
  );

  const requestOptions: OpenAI.ChatCompletionCreateParams = {
    messages: messages as OpenAI.ChatCompletionMessageParam[],
    model: model,
    temperature: temperature,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
  };

  try {
    if (zodSchema) {
      // Use structured output with Zod schema via raw create + manual parse
      (requestOptions as OpenAI.ChatCompletionCreateParams).response_format =
        zodResponseFormat(zodSchema, "response") as OpenAI.ResponseFormatJSONSchema;
      const completion = await getOpenAIClient().chat.completions.create(
          requestOptions,
      );

      if (!completion) {
        logger.error("Completion is null");
        if (uid) {
          sendEvent(uid, "aiError", "system", {
            reason: "invalid_response",
          });
        }
        throw new Error("Completion is null");
      }
      if (!completion.choices || !completion.choices[0]) {
        logger.error("No choices in completion");
        logger.error(JSON.stringify(completion, null, 2));
        if (uid) {
          sendEvent(uid, "aiError", "system", {
            reason: "invalid_response",
          });
        }
        throw new Error("No choices in completion");
      }

      const choice = completion.choices[0];
      const rawContent = choice.message?.content || "";

      if (choice.finish_reason === "length") {
        logger.error("Response truncated (finish_reason=length)", {
          model,
          contentLength: rawContent.length,
          contentPreview: rawContent.substring(0, 2000),
          usage: completion.usage,
        });
        if (uid) {
          sendEvent(uid, "aiError", "system", {
            reason: "length_limit",
          });
        }
        throw new LengthFinishReasonError();
      }

      if (choice.finish_reason !== "stop") {
        logger.error(
            `Unexpected finish reason: ${choice.finish_reason}`,
        );
        logger.error(JSON.stringify(completion, null, 2));
        if (uid) {
          sendEvent(uid, "aiError", "system", {
            reason: "invalid_response",
          });
        }
        throw new Error(
            `Unexpected finish reason: ${choice.finish_reason}`,
        );
      }

      // Parse the raw JSON content with the Zod schema
      const parsed = zodSchema.parse(JSON.parse(rawContent));
      logger.debug(`OpenAI tokens used: ${completion.usage?.total_tokens}`);
      return parsed;
    } else {
      // Regular text completion without structured output
      const completion = await getOpenAIClient().chat.completions.create(
          requestOptions,
      );
      return completion.choices[0].message.content || "";
    }
  } catch (error) {
    const apiErr = error as Error & { status?: number; error?: unknown };
    logger.warn("OpenRouter API call failed", {
      model,
      status: apiErr.status,
      message: apiErr.message,
      errorBody: apiErr.error,
    });

    // Handle length limit errors — response was truncated, retrying won't help
    if (error instanceof LengthFinishReasonError) {
      logger.error("OpenRouter API response hit max token limit (LengthFinishReasonError)");
      throw error;
    }

    // Handle parsing errors - retry immediately
    if (retry && isParsingError(error)) {
      logger.warn("OpenRouter API parsing error (likely malformed response). Retrying immediately.");
      return defaultCompletion(messages, model, temperature, zodSchema, uid, false, maxTokens);
    }

    // Handle retryable errors (network, 429, 5xx, transient 404) - retry after delay
    if (retry && isRetryableError(error)) {
      const err = error as Error & { status?: number };
      const errorType = isNetworkError(error) ?
        "network/socket error" :
        err.status ?
          `HTTP ${err.status}` :
          "unknown";
      const waitSecs = DEFAULT_RETRY_DELAY_MS / 1000;
      logger.warn(`OpenRouter API error (${errorType}). Waiting ${waitSecs}s before retrying.`);
      await delay(DEFAULT_RETRY_DELAY_MS);
      return defaultCompletion(messages, model, temperature, zodSchema, uid, false, maxTokens);
    }

    // Non-retryable error - rethrow
    throw error;
  }
}

function setOpenAIClientForTest(client: OpenAI | null): void {
  openai = client;
}

export {getOpenAIClient, defaultCompletion, DEFAULT_TEMP, DEFAULT_MAX_TOKENS, setOpenAIClientForTest};
