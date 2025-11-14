/* eslint-disable require-jsdoc */
/* eslint-disable max-len */

/**
 * Mock Resend client for testing
 * Returns test data instead of making real API calls
 */

class MockResend {
  constructor() {
    this.testData = {};
    this.sentEmails = {}; // Store sent emails for verification
  }

  // Set test data for a specific email ID
  setTestData(emailId, emailContent, attachmentsList = []) {
    this.testData[emailId] = {
      emailContent,
      attachmentsList,
    };
  }

  // Clear all test data
  clearTestData() {
    this.testData = {};
    this.sentEmails = {};
  }

  // Get the last sent email to a specific recipient
  getLastSentEmail(to) {
    return this.sentEmails[to] || null;
  }

  // Mock webhooks.verify - always returns true in test mode
  webhooks = {
    verify: async () => {
      return true; // Always valid in test mode
    },
  };

  // Mock emails.receiving - matches Resend's receiving API structure
  emails = {
    receiving: {
      get: async (emailId) => {
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
                "authentication-results": "amazonses.com; spf=pass; dkim=pass header.i=@example.com; dmarc=pass",
                "from": "test@example.com",
                "to": "calendar@fwd2cal.com",
                "subject": "Test Email",
                "message-id": `<${emailId}@example.com>`,
              },
            },
            error: null,
          };
        }
        return {
          data: testData.emailContent,
          error: null,
        };
      },

      attachments: {
        list: async ({emailId}) => {
          const testData = this.testData[emailId];
          if (!testData || !testData.attachmentsList) {
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

    send: async (message) => {
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
          from: message.from,
          to: message.to,
          subject: message.subject,
          created_at: new Date().toISOString(),
        },
        error: null,
      };
    },
  };


  // Mock contacts API
  contacts = {
    create: async ({email, unsubscribed}) => {
      return {
        data: {
          id: `mock-contact-${Date.now()}`,
          email: email,
          unsubscribed: unsubscribed,
          created_at: new Date().toISOString(),
        },
        error: null,
      };
    },

    segments: {
      add: async ({email, segmentId}) => {
        return {
          data: {
            id: `mock-segment-add-${Date.now()}`,
            email: email,
            segment_id: segmentId,
          },
          error: null,
        };
      },

      remove: async ({email, segmentId}) => {
        return {
          data: {
            id: `mock-segment-remove-${Date.now()}`,
            email: email,
            segment_id: segmentId,
          },
          error: null,
        };
      },
    },
  };
}

// Global instance for test mode
let mockInstance = null;

function getMockResendClient() {
  if (!mockInstance) {
    mockInstance = new MockResend();
  }
  return mockInstance;
}

function setMockData(emailId, emailContent, attachmentsList = []) {
  const mock = getMockResendClient();
  mock.setTestData(emailId, emailContent, attachmentsList);
}

function clearMockData() {
  const mock = getMockResendClient();
  mock.clearTestData();
}

function getLastSentEmail(to) {
  const mock = getMockResendClient();
  return mock.getLastSentEmail(to);
}

module.exports = {
  MockResend,
  getMockResendClient,
  setMockData,
  clearMockData,
  getLastSentEmail,
};
