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
  setTestData(emailId, emailContent, attachments = {}) {
    this.testData[emailId] = {
      emailContent,
      attachments,
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

  // Mock attachments.receiving
  attachments = {
    receiving: {
      get: async ({id, emailId}) => {
        const testData = this.testData[emailId];
        if (!testData || !testData.attachments || !testData.attachments[id]) {
          return {
            data: Buffer.from("Mock attachment content"),
            error: null,
          };
        }
        return {
          data: testData.attachments[id],
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

function setMockData(emailId, emailContent, attachments = {}) {
  const mock = getMockResendClient();
  mock.setTestData(emailId, emailContent, attachments);
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
