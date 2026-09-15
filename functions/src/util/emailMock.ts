import {MockSentEmail, SendEmailOptions} from "./types";

const sentEmails: Record<string, MockSentEmail> = {};

function recordMockSentEmail(message: SendEmailOptions): void {
  sentEmails[message.to] = {
    to: message.to,
    from: message.from,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: message.headers || {},
  };
}

function getLastSentEmail(to: string): MockSentEmail | null {
  return sentEmails[to] || null;
}

function clearMockSentEmails(): void {
  for (const recipient of Object.keys(sentEmails)) {
    delete sentEmails[recipient];
  }
}

export {recordMockSentEmail, getLastSentEmail, clearMockSentEmails};
