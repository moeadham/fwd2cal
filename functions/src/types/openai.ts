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
