import {
  ResendClient,
  ResendEmailData,
  ResendAttachmentsList,
  ResendAPIResponse,
  MockSentEmail,
} from "../types";
import { AttachmentInfo, TransformedEmail } from "../types";

interface TestData {
  emailContent: TransformedEmail | ResendEmailData;
  attachmentsList: AttachmentInfo[];
}

/**
 * Mock Resend client for testing
 * Returns test data instead of making real API calls
 */
class MockResend implements ResendClient {
  private testData: Record<string, TestData> = {};
  private sentEmails: Record<string, MockSentEmail> = {};

  // Set test data for a specific email ID
  setTestData(
    emailId: string,
    emailContent: TransformedEmail | ResendEmailData,
    attachmentsList: AttachmentInfo[] = []
  ): void {
    this.testData[emailId] = {
      emailContent,
      attachmentsList,
    };
  }

  // Clear all test data
  clearTestData(): void {
    this.testData = {};
    this.sentEmails = {};
  }

  // Get the last sent email to a specific recipient
  getLastSentEmail(to: string): MockSentEmail | null {
    return this.sentEmails[to] || null;
  }

  // Mock webhooks.verify - always returns true in test mode
  webhooks = {
    verify: async (): Promise<boolean> => {
      return true; // Always valid in test mode
    },
  };

  // Mock emails.receiving - matches Resend's receiving API structure
  emails = {
    receiving: {
      get: async (
        emailId: string
      ): Promise<{ data: ResendEmailData; error: null }> => {
        const testData = this.testData[emailId];
        if (!testData) {
          // Return a default structure if no test data is set
          return {
            data: {
              id: emailId,
              subject: "Test Email",
              from: "test@example.com",
              to: ["calendar@fwd2cal.com"],
              text: "Test email content",
              html: "<p>Test email content</p>",
              headers: {
                "authentication-results":
                  "amazonses.com; spf=pass; dkim=pass header.i=@example.com; dmarc=pass",
                from: "test@example.com",
                to: "calendar@fwd2cal.com",
                subject: "Test Email",
                "message-id": `<${emailId}@example.com>`,
              },
            },
            error: null,
          };
        }
        return {
          data: testData.emailContent as ResendEmailData,
          error: null,
        };
      },

      attachments: {
        list: async (options: {
          emailId: string;
        }): Promise<{ data: ResendAttachmentsList; error: null }> => {
          const testData = this.testData[options.emailId];
          console.log(`[MockResend] attachments.list called for emailId: ${options.emailId}`);
          console.log(`[MockResend] testData exists: ${!!testData}, attachmentsList: ${testData?.attachmentsList?.length ?? "undefined"}`);
          if (!testData || !testData.attachmentsList || testData.attachmentsList.length === 0) {
            // Return empty list if no attachments configured
            return {
              data: {
                object: "list",
                has_more: false,
                data: [],
              },
              error: null,
            };
          }
          // Match Resend's nested structure: {data: {object: 'list', data: [...]}}
          console.log(`[MockResend] Returning ${testData.attachmentsList.length} attachments`);
          return {
            data: {
              object: "list",
              has_more: false,
              data: testData.attachmentsList,
            },
            error: null,
          };
        },
      },
    },

    send: async (message: {
      from: string;
      to: string;
      subject: string;
      text?: string;
      html: string;
      headers?: Record<string, string>;
    }): Promise<ResendAPIResponse> => {
      // Store the complete email data for test verification
      const recipient = Array.isArray(message.to) ? message.to[0] : message.to;
      this.sentEmails[recipient] = {
        to: message.to,
        from: message.from,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers || {},
      };

      // Mock email sending - return success in {data, error} format
      return {
        data: {
          id: `mock-email-${Date.now()}`,
        },
        error: undefined,
      };
    },
  };

  // Mock contacts API
  contacts = {
    create: async (_options: {
      email: string;
      unsubscribed: boolean;
    }): Promise<ResendAPIResponse> => {
      return {
        data: {
          id: `mock-contact-${Date.now()}`,
        },
        error: undefined,
      };
    },

    segments: {
      add: async (_options: {
        email: string;
        segmentId: string;
      }): Promise<ResendAPIResponse> => {
        return {
          data: {
            id: `mock-segment-add-${Date.now()}`,
          },
          error: undefined,
        };
      },

      remove: async (_options: {
        email: string;
        segmentId: string;
      }): Promise<ResendAPIResponse> => {
        return {
          data: {
            id: `mock-segment-remove-${Date.now()}`,
          },
          error: undefined,
        };
      },
    },
  };
}

// Global instance for test mode
let mockInstance: MockResend | null = null;

function getMockResendClient(): MockResend {
  if (!mockInstance) {
    mockInstance = new MockResend();
  }
  return mockInstance;
}

function setMockData(
  emailId: string,
  emailContent: TransformedEmail | ResendEmailData,
  attachmentsList: AttachmentInfo[] = []
): void {
  const mock = getMockResendClient();
  mock.setTestData(emailId, emailContent, attachmentsList);
}

function clearMockData(): void {
  const mock = getMockResendClient();
  mock.clearTestData();
}

function getLastSentEmail(to: string): MockSentEmail | null {
  const mock = getMockResendClient();
  return mock.getLastSentEmail(to);
}

export {
  MockResend,
  getMockResendClient,
  setMockData,
  clearMockData,
  getLastSentEmail,
};
