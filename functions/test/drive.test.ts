/* eslint-disable max-len */
import chai from "chai";
import chaiHttp from "chai-http";
import {exec} from "child_process";
import type {Response} from "superagent";

const chaiWithHttp = chai as typeof chai & {
  request: (url: string) => ChaiHttp.Agent;
};

import {
  ResendTestData,
  AttachmentWithUrl,
  driveEmailWithPDF,
  driveEmailNoAttachments,
  driveEmailMultipleAttachments,
  deleteAccount,
} from "./bindings/resendBindings";

chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5002";
const CALLBACK_ENDPOINT = "/v2/resendInboundCallback";
const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT || "";

interface WebhookWithMock {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    message_id: string;
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    created_at: string;
    attachments: unknown[];
  };
  mockData: {
    emailContent: unknown;
    attachmentsList: AttachmentWithUrl[];
  };
}

interface DriveDispatchResponse {
  body: {
    message: string;
    data: {
      filesProcessed: number;
      filesSucceeded: number;
      filesFailed: number;
      results: Array<{
        filename: string;
        folderPath: string;
        suggestedName: string;
        driveFileId?: string;
        driveWebLink?: string;
        error?: string;
      }>;
      error?: string;
    };
    sentEmail: {
      html: string;
      headers: {
        "In-Reply-To"?: string;
        References?: string;
      };
    };
  };
  status: number;
}

// Helper function to send Resend webhook and dispatch to drive handler
async function sendDriveWebhook(testData: ResendTestData, attachmentsList: AttachmentWithUrl[] = []): Promise<DriveDispatchResponse> {
  const webhookWithMock: WebhookWithMock = {
    ...testData.webhook,
    mockData: {
      emailContent: testData.emailContent,
      attachmentsList: attachmentsList,
    },
  };

  // Step 1: Send to callback endpoint (sets up mock data)
  const callbackResponse = await chaiWithHttp.request(apiURL)
    .post(CALLBACK_ENDPOINT)
    .set("Content-Type", "application/json")
    .set("svix-id", "msg_test_" + Date.now())
    .set("svix-timestamp", Math.floor(Date.now() / 1000).toString())
    .set("svix-signature", "v1,dummy_signature_for_testing")
    .send(webhookWithMock);
  const webhookData = callbackResponse.body.webhookData;

  // Step 2: Dispatch to drive test endpoint
  const DISPATCH_URL = "http://127.0.0.1:5001";
  const DISPATCH_REGION = "us-central1";
  const APP_ID = process.env.GCLOUD_PROJECT || "fwd2cal-dev-2578e";
  const response = await chaiWithHttp
    .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
    .post("/v2testDriveInboundDispatch")
    .set("Content-Type", "application/json")
    .send({data: webhookData});
  return response as unknown as DriveDispatchResponse;
}

// Helper to send calendar webhook (for delete account)
async function sendResendWebhook(testData: ResendTestData): Promise<{body: {data: {result?: string}}; status: number}> {
  const webhookWithMock: WebhookWithMock = {
    ...testData.webhook,
    mockData: {
      emailContent: testData.emailContent,
      attachmentsList: [],
    },
  };
  const callbackResponse = await chaiWithHttp.request(apiURL)
    .post(CALLBACK_ENDPOINT)
    .set("Content-Type", "application/json")
    .set("svix-id", "msg_test_" + Date.now())
    .set("svix-timestamp", Math.floor(Date.now() / 1000).toString())
    .set("svix-signature", "v1,dummy_signature_for_testing")
    .send(webhookWithMock);
  const webhookData = callbackResponse.body.webhookData;
  const DISPATCH_URL = "http://127.0.0.1:5001";
  const DISPATCH_REGION = "us-central1";
  const APP_ID = process.env.GCLOUD_PROJECT || "fwd2cal-dev-2578e";
  const response = await chaiWithHttp
    .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
    .post("/v2testResendInboundDispatch")
    .set("Content-Type", "application/json")
    .send({data: webhookData});
  return response as unknown as {body: {data: {result?: string}}; status: number};
}

describe("fwd2cal Drive Agent", function() {
  before("DT00 get Drive login URL and wait for tester to authorize Drive scope", function(done) {
    chaiWithHttp.request(apiURL)
      .get("/v2/driveSignup")
      .redirects(0)
      .end((err: Error | null, res: Response) => {
        expect(res).to.have.status(302);
        if (err) {
          console.error("Error fetching drive signup URL:", err);
          done(err);
        } else {
          console.log("If you want to test Drive - complete this Google Authorization in the next 60 seconds!");
          console.log(`PLEASE LOGIN WITH: ${TESTER_PRIMARY_GOOGLE_ACCT}`);
          console.log("-------------------------------------------");
          console.log("Redirect URL:", res.headers.location);
          exec(`open -a "Google Chrome" "${res.headers.location}"`, (error, stdout, stderr) => {
            if (error) {
              console.error("Error opening Google Chrome, maybe this isn't a mac?", error);
            }
            console.log(`stdout: ${stdout}`);
            console.error(`stderr: ${stderr}`);
          });
          setTimeout(() => {
            done();
          }, 60000);
        }
      });
  });

  it("DT01 upload a single PDF attachment to Drive", async function() {
    const testMessage = driveEmailWithPDF;
    const res = await sendDriveWebhook(testMessage, testMessage.attachmentsList || []);
    expect(res).to.have.status(200);
    console.log("DRIVE RESPONSE:", res.body);

    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");
    expect(res.body.data).to.not.have.property("error");

    // Verify processing counts
    expect(res.body.data.filesProcessed).to.equal(1);
    expect(res.body.data.filesSucceeded).to.equal(1);
    expect(res.body.data.filesFailed).to.equal(0);

    // Verify the uploaded file result
    expect(res.body.data.results).to.be.an("array").with.lengthOf(1);
    const result = res.body.data.results[0];
    expect(result.filename).to.be.a("string").and.not.be.empty;
    expect(result.folderPath).to.be.a("string").and.not.be.empty;
    expect(result.driveFileId).to.be.a("string").and.not.be.empty;
    expect(result.driveWebLink).to.be.a("string");

    // Verify confirmation email was sent
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.be.a("string");
    expect(res.body.sentEmail.html).to.include("saved to Google Drive");

    // Verify threading headers
    expect(res.body.sentEmail.headers).to.be.an("object");
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-drive-pdf> ${incomingMessageId}`);
  });

  it("DT02 email to drive with no attachments returns error", async function() {
    const testMessage = driveEmailNoAttachments;
    const res = await sendDriveWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log("DRIVE NO-ATTACH RESPONSE:", res.body);

    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");

    // Should report "No attachments" error
    expect(res.body.data.error).to.equal("No attachments");
    expect(res.body.data.filesProcessed).to.equal(0);
    expect(res.body.data.filesSucceeded).to.equal(0);
    expect(res.body.data.filesFailed).to.equal(0);

    // Should still send a response email
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.include("didn't have any attachments");
  });

  it("DT03 upload multiple attachments to Drive", async function() {
    const testMessage = driveEmailMultipleAttachments;
    const res = await sendDriveWebhook(testMessage, testMessage.attachmentsList || []);
    expect(res).to.have.status(200);
    console.log("DRIVE MULTI RESPONSE:", res.body);

    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");
    expect(res.body.data).to.not.have.property("error");

    // Verify batch processing counts
    expect(res.body.data.filesProcessed).to.equal(2);
    expect(res.body.data.filesSucceeded).to.equal(2);
    expect(res.body.data.filesFailed).to.equal(0);

    // Verify each file was uploaded
    expect(res.body.data.results).to.be.an("array").with.lengthOf(2);
    for (const result of res.body.data.results) {
      expect(result.filename).to.be.a("string").and.not.be.empty;
      expect(result.folderPath).to.be.a("string").and.not.be.empty;
      expect(result.driveFileId).to.be.a("string").and.not.be.empty;
    }

    // Verify "multiple files" confirmation email
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.include("files have been saved");

    // Verify threading headers
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-drive-multi> ${incomingMessageId}`);
  });

  it("DT04 delete account", async function() {
    const testMessage = deleteAccount;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log(res.body);
    expect(res.body).to.be.an("object");
    expect(res.body.data.result).to.include("deleted");
  });
});
