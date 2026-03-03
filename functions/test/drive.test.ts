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
  driveDeleteAccount,
} from "./bindings/resendBindings";

chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5002";
const DRIVE_CALLBACK_ENDPOINT = "/v2/driveInboundCallback";
const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT || "";
const DRIVE_EMAIL_ADDRESS = process.env.DRIVE_EMAIL_ADDRESS || "drive@fwd2cal.com";
const DISPATCH_URL = "http://127.0.0.1:5001";
const DISPATCH_REGION = "us-central1";
const APP_ID = process.env.GCLOUD_PROJECT || "fwd2cal-dev-2578e";

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

// Helper: send Resend webhook and dispatch to drive handler (Phase 1 — proposal)
async function sendDriveWebhook(testData: ResendTestData, attachmentsList: AttachmentWithUrl[] = []): Promise<DriveDispatchResponse> {
  const webhookWithMock: WebhookWithMock = {
    ...testData.webhook,
    mockData: {
      emailContent: testData.emailContent,
      attachmentsList: attachmentsList,
    },
  };

  // Step 1: Send to drive callback endpoint (sets up mock data)
  const callbackResponse = await chaiWithHttp.request(apiURL)
    .post(DRIVE_CALLBACK_ENDPOINT)
    .set("Content-Type", "application/json")
    .set("svix-id", "msg_test_" + Date.now())
    .set("svix-timestamp", Math.floor(Date.now() / 1000).toString())
    .set("svix-signature", "v1,dummy_signature_for_testing")
    .send(webhookWithMock);
  const webhookData = callbackResponse.body.webhookData;

  // Step 2: Dispatch to drive test endpoint
  const response = await chaiWithHttp
    .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
    .post("/v2testDriveInboundDispatch")
    .set("Content-Type", "application/json")
    .send({data: webhookData});
  return response as unknown as DriveDispatchResponse;
}

// Helper: call processUpload test endpoint (Phase 2 — upload after auth)
async function sendDriveProcessUpload(testData: ResendTestData): Promise<DriveDispatchResponse> {
  const response = await chaiWithHttp
    .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
    .post("/v2testDriveProcessUpload")
    .set("Content-Type", "application/json")
    .send({
      emailId: testData.webhook.data.email_id,
      mockData: {
        emailContent: testData.emailContent,
        attachmentsList: testData.attachmentsList || [],
      },
    });
  return response as unknown as DriveDispatchResponse;
}

// Shared state: upload confirmation HTML is saved in DT03 and used by DT04
let uploadConfirmationHtml = "";

describe("fwd2cal Drive Agent", function() {
  it("DT01 propose folder and filename for a single PDF attachment", async function() {
    const testMessage = driveEmailWithPDF;
    const res = await sendDriveWebhook(testMessage, testMessage.attachmentsList || []);
    expect(res).to.have.status(200);
    console.log("DRIVE PROPOSAL RESPONSE:", res.body);

    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");
    expect(res.body.data).to.not.have.property("error");

    // Phase 1: proposal only — no files uploaded yet
    expect(res.body.data.filesProcessed).to.equal(1);
    expect(res.body.data.filesSucceeded).to.equal(0);
    expect(res.body.data.filesFailed).to.equal(0);

    // Verify proposal email was sent
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.be.a("string");
    expect(res.body.sentEmail.html).to.include("organize your file");

    // Verify auth signup link is present
    expect(res.body.sentEmail.html).to.include("Grant Drive Access");
    expect(res.body.sentEmail.html).to.include("driveSignup");

    // Verify threading headers
    expect(res.body.sentEmail.headers).to.be.an("object");
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-drive-pdf> ${incomingMessageId}`);
  });

  it("DT02 get Drive login URL and wait for tester to authorize Drive scope", function(done) {
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

  it("DT03 upload file to Drive right after auth", async function() {
    const res = await sendDriveProcessUpload(driveEmailWithPDF);
    console.log("DRIVE UPLOAD RESPONSE:", res.body);
    expect(res).to.have.status(200);

    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");
    expect(res.body.data).to.not.have.property("error");

    // Phase 2: file should be uploaded
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

    // Verify confirmation email
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.be.a("string");
    expect(res.body.sentEmail.html).to.include("saved to Google Drive");

    // Verify embedded drive data for reply/move detection (visible link with ref code)
    expect(res.body.sentEmail.html).to.include("fwd2drive.com/d?r=");
    expect(res.body.sentEmail.html).to.include("ref:");

    // Verify "reply to move" message
    expect(res.body.sentEmail.html).to.include("reply to this email");

    // Save the confirmation HTML for the reply/move test (DT04)
    uploadConfirmationHtml = res.body.sentEmail.html;
  });

  it("DT04 reply to move file to a different folder", async function() {
    // Build a reply email dynamically using embedded data from DT03
    expect(uploadConfirmationHtml).to.not.be.empty;

    // Gmail preserves visible links in quoted replies
    const gmailSanitizedHtml = uploadConfirmationHtml;

    const replyEmailId = "test-drive-reply-move";
    const replyMessageId = `<test-drive-reply-${Date.now()}@mail.gmail.com>`;
    const moveInstructions = "Please move this to a folder called Receipts";
    const domain = TESTER_PRIMARY_GOOGLE_ACCT.split("@")[1] || "gmail.com";

    const replyWebhook = {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: replyEmailId,
        message_id: replyMessageId,
        from: TESTER_PRIMARY_GOOGLE_ACCT,
        to: [DRIVE_EMAIL_ADDRESS],
        cc: [] as string[],
        bcc: [] as string[],
        subject: "Re: Fwd: Conference Registration",
        created_at: new Date().toISOString(),
        attachments: [] as unknown[],
      },
    };

    const replyEmailContent = {
      id: replyEmailId,
      subject: "Re: Fwd: Conference Registration",
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [DRIVE_EMAIL_ADDRESS],
      html: `<p>${moveInstructions}</p><blockquote>${gmailSanitizedHtml}</blockquote>`,
      text: moveInstructions,
      headers: {
        "authentication-results": `amazonses.com; spf=pass (spfCheck: domain of _spf.${domain} designates 209.85.214.171 as permitted sender) client-ip=209.85.214.171; envelope-from=${TESTER_PRIMARY_GOOGLE_ACCT}; helo=mail.${domain}; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain};`,
        "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
        "to": DRIVE_EMAIL_ADDRESS,
        "subject": "Re: Fwd: Conference Registration",
        "date": new Date().toUTCString(),
        "message-id": replyMessageId,
        "in-reply-to": driveEmailWithPDF.emailContent.headers["message-id"],
        "references": driveEmailWithPDF.emailContent.headers["message-id"],
      },
    };

    const webhookWithMock = {
      ...replyWebhook,
      mockData: {
        emailContent: replyEmailContent,
        attachmentsList: [] as AttachmentWithUrl[],
      },
    };

    // Step 1: Send to drive callback endpoint (sets up mock data)
    const callbackResponse = await chaiWithHttp.request(apiURL)
      .post(DRIVE_CALLBACK_ENDPOINT)
      .set("Content-Type", "application/json")
      .set("svix-id", "msg_test_" + Date.now())
      .set("svix-timestamp", Math.floor(Date.now() / 1000).toString())
      .set("svix-signature", "v1,dummy_signature_for_testing")
      .send(webhookWithMock);
    const webhookData = callbackResponse.body.webhookData;

    // Step 2: Dispatch to drive handler (will detect reply + embedded data)
    const res = await chaiWithHttp
      .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
      .post("/v2testDriveInboundDispatch")
      .set("Content-Type", "application/json")
      .send({data: webhookData}) as unknown as DriveDispatchResponse;

    expect(res).to.have.status(200);
    console.log("DRIVE MOVE RESPONSE:", res.body);

    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");

    // Verify file was moved
    expect(res.body.data.filesSucceeded).to.be.greaterThanOrEqual(1);

    // Verify move confirmation email
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.be.a("string");
    expect(res.body.sentEmail.html).to.include("has been moved");

    // Verify embedded data still present (for further moves)
    expect(res.body.sentEmail.html).to.include("fwd2drive.com/d?r=");
  });

  it("DT05 delete account via drive agent", async function() {
    const testMessage = driveDeleteAccount;
    const res = await sendDriveWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log("DRIVE DELETE RESPONSE:", res.body);
    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");
    expect(res.body.data).to.not.have.property("error");

    // Verify deletion confirmation email was sent
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.be.a("string");
    expect(res.body.sentEmail.html).to.include("account has been deleted");
  });
});
