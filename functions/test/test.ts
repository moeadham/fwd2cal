/* eslint-disable max-len */
import chai from "chai";
import chaiHttp from "chai-http";
import { exec } from "child_process";
import type { Response } from "superagent";

// Extend chai with chaiHttp types
const chaiWithHttp = chai as typeof chai & {
  request: (url: string) => ChaiHttp.Agent;
};

import {
  ResendTestData,
  AttachmentWithUrl,
  emailFromMain,
  addEmailAddress,
  removeEmailAddress,
  deleteAccount,
  eventEmailFromSecondEmail,
  basicDetailedEmail,
  basicEmailFuture,
  emailWithICSAttachment,
  emailWithPDFAttachment,
  multipleEventsEmail,
  emailWithImageAttachment,
  familyEvent,
  workEventVisibl,
} from "./bindings/resendBindings";

// Using Resend for email service
const EMAIL_SERVICE = "resend";

chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5002"; // URL of your Vercel dev server

// Resend webhook endpoint
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

interface DispatchResponse {
  body: {
    webhookData: unknown;
    data: {
      error?: string;
      kind?: string;
      verificationCode?: string;
      result?: string;
      inviteOthersLink?: string;
      calendarId?: string;
      summary?: string;
      start?: unknown;
      end?: unknown;
    } | Array<{
      kind: string;
      summary: string;
      start: unknown;
      end: unknown;
    }>;
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

// Helper function to send Resend webhook with mocked API responses
async function sendResendWebhook(testData: ResendTestData, attachmentsList: AttachmentWithUrl[] = []): Promise<DispatchResponse> {
  // Include mock data in the webhook payload for test mode
  const webhookWithMock: WebhookWithMock = {
    ...testData.webhook,
    mockData: {
      emailContent: testData.emailContent,
      attachmentsList: attachmentsList,
    },
  };

  // Create the request with proper headers
  const callbackResponse = await chaiWithHttp.request(apiURL)
    .post(CALLBACK_ENDPOINT)
    .set("Content-Type", "application/json")
    .set("svix-id", "msg_test_" + Date.now())
    .set("svix-timestamp", Math.floor(Date.now() / 1000).toString())
    .set("svix-signature", "v1,dummy_signature_for_testing")
    .send(webhookWithMock);
  const webhookData = callbackResponse.body.webhookData;
  const DISPATCH_URL = `http://127.0.0.1:5001`;
  const DISPATCH_REGION = `us-central1`;
  const APP_ID = `fwd2cal`;
  const response = await chaiWithHttp
    .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
    .post("/v2testResendInboundDispatch").set("Content-Type", "application/json")
    .send({ data: webhookData });
  return response as unknown as DispatchResponse;
}

describe(`fwd2cal (${EMAIL_SERVICE.toUpperCase()})`, function() {
  before("UT00 get login URL and wait for tester to create account", function(done) {
    chaiWithHttp.request(apiURL)
      .get("/v2/signup")
      .redirects(0) // Prevent automatic following of redirects
      .end((err: Error | null, res: Response) => {
        expect(res).to.have.status(302); // Check that the status is 302
        if (err) {
          console.error("Error fetching signup URL:", err);
          done(err);
        } else {
          console.log(`If you want to test - you need to complete this Google Authorization in the next 60 seconds!`);
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

  it("UT01 test generating an event", async function() {
    const testMessage = emailFromMain;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log("RESPONSE FROM DISPATCH");
    console.log(res.body);
    expect(res.body).to.be.an("object");
    // We should get an event
    expect(res.body.data).to.not.have.property("error");
    expect((res.body.data as { kind: string }).kind).to.equal("calendar#event");

    // Verify sent email (confirmation email sent back to user)
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.be.a("string");
    expect(res.body.sentEmail.html).to.include("Event added");

    // Verify threading headers
    expect(res.body.sentEmail.headers).to.be.an("object");
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-1> ${incomingMessageId}`);
  });

  let verificationCode = "";
  it("UT02 test adding a new email address", async function() {
    const testMessage = addEmailAddress;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log(res.body);
    // Should get a verification code.
    expect(res.body).to.be.an("object");
    expect((res.body.data as { verificationCode: string }).verificationCode).to.be.a("String");
    verificationCode = (res.body.data as { verificationCode: string }).verificationCode;
  });

  it("UT03 try to email from secondary email address", async function() {
    const testMessage = eventEmailFromSecondEmail;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log(res.body);
    expect(res.body).to.be.an("object");
    expect((res.body.data as { result: string }).result).to.be.a("string");
    expect((res.body.data as { result: string }).result).to.contain("has been invited to signup");
  });

  it("UT04 approve new email address via request", function(done) {
    const req = chaiWithHttp.request(apiURL).post("/v2/verifyAdditionalEmail").query({ uuid: verificationCode });
    req.end((err: Error | null, res: Response) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body);
      // should get a webpage thanking us.
      expect(res.body).to.be.an("object");
      expect(res.body.data).to.equal(TESTER_PRIMARY_GOOGLE_ACCT);
      done();
    });
  });

  it("UT05 try to email from secondary email address", async function() {
    const testMessage = eventEmailFromSecondEmail;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log(res.body);
    // Should get added to owners calendar.
    expect(res.body).to.be.an("object");

    // Verify sent email and threading headers
    expect(res.body.sentEmail).to.be.an("object");
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-5> ${incomingMessageId}`);
  });

  it("UT06 try a basic email with no forward but instructions", async function() {
    const testMessage = basicDetailedEmail;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log((res.body.data as object));
    // Should get added to owners calendar.
    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");
    expect(res.body.data).to.not.have.property("error");
    expect((res.body.data as { kind: string }).kind).to.equal("calendar#event");

    // Verify sent email and threading headers
    expect(res.body.sentEmail).to.be.an("object");
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-6> ${incomingMessageId}`);
  });

  let invitationLink: string;
  it("UT07 try a basic email in the future to add invitees later.", async function() {
    const testMessage = JSON.parse(JSON.stringify(basicEmailFuture)) as ResendTestData; // Deep clone to avoid mutation

    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
    const formattedDate = threeDaysFromNow.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

    // For Resend format, update the nested emailContent fields
    if (testMessage.emailContent) {
      if (testMessage.emailContent.text) {
        testMessage.emailContent.text = testMessage.emailContent.text.replace(/%DATE_IN_THE_FUTURE%/g, formattedDate);
      }
      if (testMessage.emailContent.html) {
        testMessage.emailContent.html = testMessage.emailContent.html.replace(/%DATE_IN_THE_FUTURE%/g, formattedDate);
      }
    }

    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log((res.body.data as object));
    console.log(res.body.sentEmail);
    // Should get added to owners calendar.
    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");
    expect(res.body.data).to.not.have.property("error");
    expect((res.body.data as { kind: string }).kind).to.equal("calendar#event");
    expect((res.body.data as { inviteOthersLink: string }).inviteOthersLink).to.be.a("string");
    invitationLink = (res.body.data as { inviteOthersLink: string }).inviteOthersLink;

    // Verify sent email and threading headers
    expect(res.body.sentEmail).to.be.an("object");
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-7> ${incomingMessageId}`);

    // Verify sent email HTML contains invite link
    expect(res.body.sentEmail.html).to.be.a("string");
    expect(res.body.sentEmail.html).to.include("/v2/inviteAdditionalAttendees");
  });

  it("UT08 invite additional guests via URL", function(done) {
    chaiWithHttp.request(invitationLink).get("").redirects(0).end((err: Error | null, res: Response) => {
      expect(err).to.be.null;
      expect(res).to.have.status(302);
      done();
    });
  });

  it("UT09 add an event with an ics attachment.", async function() {
    const testMessage = emailWithICSAttachment;

    const res = await sendResendWebhook(testMessage, testMessage.attachmentsList);
    expect(res).to.have.status(200);
    console.log(res.body);
    expect(res.body).to.be.an("object");
    // We should get an event
    expect(res.body.data).to.not.have.property("error");
    expect((res.body.data as { kind: string }).kind).to.equal("calendar#event");

    // Verify sent email and threading headers
    expect(res.body.sentEmail).to.be.an("object");
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-8> ${incomingMessageId}`);
  });

  it("UT10 remove secondary email address", async function() {
    const testMessage = removeEmailAddress;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log(res.body);
    // Should get added to owners calendar.
    expect(res.body).to.be.an("object");
    expect((res.body.data as { result: string }).result).to.include("removed");
  });

  it("UT10.5 email with PDF attachment containing event", async function() {
    const testMessage = emailWithPDFAttachment;

    const res = await sendResendWebhook(testMessage, testMessage.attachmentsList);
    expect(res).to.have.status(200);
    console.log(res.body);
    expect(res.body).to.be.an("object");
    // Should successfully create event from PDF document
    expect(res.body.data).to.not.have.property("error");
    expect((res.body.data as { kind: string }).kind).to.equal("calendar#event");

    // Verify sent email
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.include("Event added");

    // Verify threading headers
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-pdf> ${incomingMessageId}`);
  });

  it("UT11 multiple events in one email", async function() {
    const testMessage = multipleEventsEmail;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log(res.body);
    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("array");
    expect(res.body.data).to.have.lengthOf(3);
    // Check each event was created
    (res.body.data as Array<{ kind: string; summary: string; start: unknown; end: unknown }>).forEach((event) => {
      expect(event.kind).to.equal("calendar#event");
      expect(event).to.have.property("summary");
      expect(event).to.have.property("start");
      expect(event).to.have.property("end");
    });

    // Verify sent email and threading headers
    expect(res.body.sentEmail).to.be.an("object");
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-9> ${incomingMessageId}`);
  });

  it("UT12 test email with image attachment", async function() {
    const testMessage = emailWithImageAttachment;

    const res = await sendResendWebhook(testMessage, testMessage.attachmentsList);
    expect(res).to.have.status(200);
    console.log(res.body);
    expect(res.body).to.be.an("object");
    // Should successfully create event from image
    expect(res.body.data).to.not.have.property("error");
    expect((res.body.data as { kind: string }).kind).to.equal("calendar#event");

    // Verify sent email
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.include("Event added");

    // Verify threading headers
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-10> ${incomingMessageId}`);
  });

  it("UT13 family event should select Family Calendar", async function() {
    const testMessage = familyEvent;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log(res.body);
    expect(res.body).to.be.an("object");
    // Should successfully create event from image
    expect(res.body.data).to.not.have.property("error");
    expect((res.body.data as { kind: string }).kind).to.equal("calendar#event");

    // Verify sent email
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.include("Event added");

    // Verify event was created on Family Calendar (group calendar)
    if ((res.body.data as { calendarId?: string }).calendarId) {
      console.log(`Event added to calendar: ${(res.body.data as { calendarId: string }).calendarId}`);
      expect((res.body.data as { calendarId: string }).calendarId).to.include("group.calendar.google.com");
    }
  });

  it("UT14 work event should select moe@visibl.ai calendar", async function() {
    const testMessage = workEventVisibl;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log(res.body);
    expect(res.body).to.be.an("object");
    // Should successfully create event from image
    expect(res.body.data).to.not.have.property("error");
    expect((res.body.data as { kind: string }).kind).to.equal("calendar#event");

    // Verify sent email
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.include("Event added");

    // Verify event was created on visibl.ai calendar
    if ((res.body.data as { calendarId?: string }).calendarId) {
      console.log(`Event added to calendar: ${(res.body.data as { calendarId: string }).calendarId}`);
      expect((res.body.data as { calendarId: string }).calendarId).to.include("visibl.ai");
    }
  });

  it("UT15 delete account", async function() {
    const testMessage = deleteAccount;
    const res = await sendResendWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log(res.body);
    expect(res.body).to.be.an("object");
    expect((res.body.data as { result: string }).result).to.include("deleted");
  });
});
