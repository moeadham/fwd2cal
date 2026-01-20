import {AttachmentInfo, TransformedEmail} from "./email";

// Resend email options
export interface ResendEmailOptions {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html: string;
  headers?: Record<string, string>;
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
