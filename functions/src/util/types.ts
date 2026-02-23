import {Request} from "express";

// ============================================================================
// SHARED EMAIL TYPES
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

// Attachment info from Resend
export interface AttachmentInfo {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  download_url: string;
  content_id?: string;
  content_disposition?: string;
}

// Email thread headers for reply
export interface EmailThreadHeaders {
  "In-Reply-To"?: string;
  References?: string;
  [key: string]: string | undefined;
}

// ============================================================================
// SHARED LLM TYPES
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

// ============================================================================
// COMMON TYPES
// ============================================================================

// Error with code
export interface ErrorWithCode extends Error {
  code?: number | string;
}

// Express request with query params
export interface RequestWithQuery extends Request {
  query: {
    uuid?: string;
    uid?: string;
    eventId?: string;
    attendees?: string | string[];
    calendarId?: string;
    code?: string;
  };
}

// Task dispatch options
export interface TaskDispatchOptions {
  functionName: string;
  data: unknown;
  deadline?: number;
  scheduleDelaySeconds?: number;
  location?: string;
}

// Async result tuple
export type AsyncResult<T> = [Error | null, T | null];

// Analytics event params
export interface AnalyticsEventParams {
  traffic_type?: string;
  action?: string;
  reason?: string;
  error_type?: string;
  result?: string;
  operation?: string;
  [key: string]: string | undefined;
}

// ============================================================================
// RESEND API TYPES
// ============================================================================

// Resend outbound attachment
export interface ResendOutboundAttachment {
  content: string | Buffer;
  filename: string;
  content_type?: string;
}

// Resend email options
export interface ResendEmailOptions {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html: string;
  headers?: Record<string, string>;
  attachments?: ResendOutboundAttachment[];
}

// Resend API response
export interface ResendAPIResponse {
  id?: string;
  data?: { id: string };
  error?: { message: string };
}

// Webhook data from Resend
export interface ResendWebhookData {
  type: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    attachments?: AttachmentInfo[];
  };
  mockData?: {
    emailContent: TransformedEmail;
    attachmentsList?: AttachmentInfo[];
  };
}

// Resend client interface (for both real and mock)
export interface ResendClient {
  webhooks: {
    verify: (options: {
      payload: string;
      headers: { id: string; timestamp: string; signature: string };
      webhookSecret: string;
    }) => Promise<boolean>;
  };
  emails: {
    receiving: {
      get: (emailId: string) => Promise<{ data: ResendEmailData; error: ResendError | null }>;
      attachments: {
        list: (options: { emailId: string }) => Promise<{ data: ResendAttachmentsList; error: ResendError | null }>;
      };
    };
    send: (message: ResendSendMessage) => Promise<ResendAPIResponse>;
  };
  contacts: {
    create: (options: { email: string; unsubscribed: boolean }) => Promise<ResendAPIResponse>;
    segments: {
      add: (options: { email: string; segmentId: string }) => Promise<ResendAPIResponse>;
      remove: (options: { email: string; segmentId: string }) => Promise<ResendAPIResponse>;
    };
  };
}

// Resend email data from receiving API
export interface ResendEmailData {
  id: string;
  subject: string;
  from: string;
  to: string | string[];
  text: string;
  html: string;
  headers: Record<string, string>;
}

// Resend attachments list response
export interface ResendAttachmentsList {
  object: string;
  has_more: boolean;
  data: AttachmentInfo[];
}

// Resend error
export interface ResendError {
  message: string;
}

// Resend send message
export interface ResendSendMessage {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html: string;
  headers?: Record<string, string>;
  attachments?: ResendOutboundAttachment[];
}

// Mock sent email storage
export interface MockSentEmail {
  to: string | string[];
  from: string;
  subject: string;
  text?: string;
  html: string;
  headers: Record<string, string>;
}

// Test data for mock Resend client
export interface TestData {
  emailContent: TransformedEmail | ResendEmailData;
  attachmentsList: AttachmentInfo[];
}

// Task queue request wrapper
export interface TaskRequest {
  data: ResendWebhookData;
}

// Task dispatch result
export interface DispatchResult {
  message: string;
  data?: unknown;
  sentEmail?: unknown;
  error?: string;
}
