/**
 * Mock Resend client for testing
 * Returns test data instead of making real API calls
 */

class MockResend {
  constructor() {
    this.testData = {};
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
  }

  // Mock webhooks.verify - always returns true in test mode
  webhooks = {
    verify: async () => {
      return true; // Always valid in test mode
    },
  };

  // Mock emails.get - returns test data
  emails = {
    get: async (emailId) => {
      const data = this.testData[emailId];
      if (!data) {
        // Return a default structure if no test data is set
        return {
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
        };
      }
      return data.emailContent;
    },

    getAttachment: async (emailId, attachmentId) => {
      const data = this.testData[emailId];
      if (!data || !data.attachments || !data.attachments[attachmentId]) {
        return Buffer.from("Mock attachment content");
      }
      return data.attachments[attachmentId];
    },

    send: async (message) => {
      // Mock email sending - just return success
      return {
        id: `mock-email-${Date.now()}`,
        from: message.from,
        to: message.to,
        subject: message.subject,
        created_at: new Date().toISOString(),
      };
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

module.exports = {
  MockResend,
  getMockResendClient,
  setMockData,
  clearMockData,
};