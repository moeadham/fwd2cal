/* eslint-disable max-len */
import chai from "chai";
import chaiHttp from "chai-http";
import {exec} from "child_process";
import * as fs from "fs";
import * as path from "path";
import type {Response} from "superagent";

const chaiWithHttp = chai as typeof chai & {
  request: (url: string) => ChaiHttp.Agent;
};

import {
  ResendTestData,
  AttachmentWithUrl,
  driveEmailWithPDF,
  driveDeleteAccount,
  driveSignup,
  driveEmailWithArtifacts,
  automatedReplyEmail,
} from "./bindings/resendBindings";
import {extractDocumentImages} from "../src/util/documentParser";
import {mergeRevisedProposal, reconcileFileActions} from "../src/agents/drive/llm";
import {DriveOrganizeProposal} from "../src/agents/drive/types";

chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5002";
const DRIVE_CALLBACK_ENDPOINT = "/drive/v2/inboundCallback";
const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT || "";
const DRIVE_EMAIL_ADDRESS = process.env.DRIVE_EMAIL_ADDRESS || "drive@fwd2drive.com";
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

function makeOrganizeProposal(
    fileIds: string[],
    folderByFileId: Record<string, string>,
    proposedFolders?: string[],
): DriveOrganizeProposal {
  const folderPaths = proposedFolders || [...new Set(Object.values(folderByFileId))];
  return {
    proposed_folders: folderPaths.map((folderPath) => ({
      folder_path: folderPath,
      description: `Folder ${folderPath}`,
    })),
    file_actions: fileIds.map((fileId, index) => ({
      file_id: fileId,
      current_name: `file-${fileId}.pdf`,
      current_path: "Inbox",
      new_name: `file-${fileId}.pdf`,
      new_folder: folderByFileId[fileId],
      action: "move",
      reason: `Reason ${index}`,
    })),
    summary: "summary",
  };
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
// Shared state: move confirmation HTML is saved in DT04 and used by DT04b
let moveConfirmationHtml = "";

describe("extractDocumentImages", function() {
  it("DT00 extract page screenshots from a PDF", async function() {
    const pdfBuffer = fs.readFileSync(path.join(__dirname, "bindings", "conference_registration.pdf"));
    const images = await extractDocumentImages(pdfBuffer, "pdf");

    expect(images).to.be.an("array").with.length.greaterThan(0);
    expect(images.length).to.be.at.most(2);
    for (const dataUrl of images) {
      expect(dataUrl).to.match(/^data:image\/(png|jpeg);base64,/);
    }
    console.log(`Extracted ${images.length} page screenshot(s), first image size: ${images[0].length} chars`);
  });
});

describe("Webhook filtering", function() {
  it("DT00b reject emails with automated reply subjects", async function() {
    const webhookWithMock = {
      ...automatedReplyEmail.webhook,
      mockData: {
        emailContent: automatedReplyEmail.emailContent,
        attachmentsList: [] as AttachmentWithUrl[],
      },
    };

    const res = await chaiWithHttp.request(apiURL)
      .post(DRIVE_CALLBACK_ENDPOINT)
      .set("Content-Type", "application/json")
      .set("svix-id", "msg_test_" + Date.now())
      .set("svix-timestamp", Math.floor(Date.now() / 1000).toString())
      .set("svix-signature", "v1,dummy_signature_for_testing")
      .send(webhookWithMock);

    expect(res).to.have.status(200);
    expect(res.body.message).to.equal("Automated reply, skipping");
  });
});

describe("mergeRevisedProposal", function() {
  it("DT00c merges no-op revisions without changing revised actions", function() {
    const original = makeOrganizeProposal(
        ["1", "2", "3", "4", "5"],
        {"1": "01-Docs", "2": "01-Docs", "3": "02-Photos", "4": "02-Photos", "5": "03-Misc"},
    );
    const revised = makeOrganizeProposal(
        ["1", "2", "3", "4", "5"],
        {"1": "01-Docs", "2": "01-Docs", "3": "02-Photos", "4": "02-Photos", "5": "03-Misc"},
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.file_actions).to.deep.equal(revised.file_actions);
    expect(result.file_actions).to.have.length(5);
  });

  it("DT00d backfills actions dropped by the revision output", function() {
    const original = makeOrganizeProposal(
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
        {
          "1": "01-Docs",
          "2": "01-Docs",
          "3": "01-Docs",
          "4": "01-Docs",
          "5": "02-Photos",
          "6": "02-Photos",
          "7": "02-Photos",
          "8": "03-Misc",
          "9": "03-Misc",
          "10": "03-Misc",
        },
    );
    const revised = makeOrganizeProposal(
        ["1", "5", "10"],
        {"1": "01-Docs", "5": "02-Photos", "10": "03-Misc"},
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.file_actions).to.have.length(10);
    expect(result.file_actions.filter((action) => ["1", "5", "10"].includes(action.file_id)))
        .to.deep.equal(revised.file_actions);
    expect(result.file_actions.filter((action) => !["1", "5", "10"].includes(action.file_id)))
        .to.have.length(7);
  });

  it("DT00e updates carried-over actions when a top-level folder is renamed", function() {
    const original = makeOrganizeProposal(
        ["1", "2", "3"],
        {"1": "05-Finance", "2": "05-Finance", "3": "07-Travel"},
        ["05-Finance", "07-Travel"],
    );
    const revised = makeOrganizeProposal(
        ["1"],
        {"1": "05-Financial"},
        ["05-Financial", "07-Travel"],
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.file_actions.find((action) => action.file_id === "2")?.new_folder)
        .to.equal("05-Financial");
  });

  it("DT00f propagates root folder renames to nested subfolders", function() {
    const original = makeOrganizeProposal(
        ["1", "2"],
        {"1": "05-Finance/Taxes/2024", "2": "07-Travel"},
        ["05-Finance", "05-Finance/Taxes", "05-Finance/Taxes/2024", "07-Travel"],
    );
    const revised = makeOrganizeProposal(
        ["2"],
        {"2": "07-Travel"},
        ["05-Financial", "05-Financial/Taxes", "05-Financial/Taxes/2024", "07-Travel"],
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.file_actions.find((action) => action.file_id === "1")?.new_folder)
        .to.equal("05-Financial/Taxes/2024");
  });

  it("DT00g preserves actions with no rename match without re-adding old folders", function() {
    const original = makeOrganizeProposal(
        ["1", "2"],
        {"1": "99-Misc", "2": "01-Docs"},
        ["99-Misc", "01-Docs"],
    );
    const revised = makeOrganizeProposal(
        ["2"],
        {"2": "01-Docs"},
        ["01-Docs"],
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.file_actions.find((action) => action.file_id === "1")?.new_folder)
        .to.equal("99-Misc");
    expect(result.proposed_folders.some((folder) => folder.folder_path === "99-Misc")).to.equal(false);
  });

  it("DT00h keeps only revised folders while remapping renamed nested paths", function() {
    const original = makeOrganizeProposal(
        ["1"],
        {"1": "05-Finance/Taxes/2024"},
        ["05-Finance", "05-Finance/Taxes", "05-Finance/Taxes/2024"],
    );
    const revised = makeOrganizeProposal(
        [],
        {},
        ["05-Financial", "05-Financial/Taxes", "05-Financial/Taxes/2024"],
    );

    const result = mergeRevisedProposal(original, revised);
    const folderPaths = result.proposed_folders.map((folder) => folder.folder_path);

    expect(folderPaths).to.include("05-Financial");
    expect(folderPaths).to.include("05-Financial/Taxes");
    expect(folderPaths).to.include("05-Financial/Taxes/2024");
    expect(folderPaths).to.not.include("05-Finance");
    expect(folderPaths).to.not.include("05-Finance/Taxes");
    expect(folderPaths).to.not.include("05-Finance/Taxes/2024");
    expect(result.file_actions.find((action) => action.file_id === "1")?.new_folder)
        .to.equal("05-Financial/Taxes/2024");
  });

  it("DT00i scales to large proposals while preserving all file actions", function() {
    const fileIds = Array.from({length: 100}, (_, index) => String(index + 1));
    const originalFolders: Record<string, string> = {};
    for (let index = 0; index < fileIds.length; index++) {
      originalFolders[fileIds[index]] = index < 50 ? "01-Docs" : "02-Photos";
    }

    const original = makeOrganizeProposal(fileIds, originalFolders, ["01-Docs", "02-Photos"]);
    const revised = makeOrganizeProposal(
        ["1", "2", "3", "51", "52"],
        {
          "1": "01-Docs",
          "2": "01-Docs",
          "3": "01-Docs",
          "51": "02-Photos",
          "52": "02-Photos",
        },
        ["01-Docs", "02-Photos"],
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.file_actions).to.have.length(100);
  });

  it("DT00j remaps restructured folders using suffix matches", function() {
    const original = makeOrganizeProposal(
        ["1", "2"],
        {"1": "08-Bitaccess/Contract", "2": "08-Bitaccess/Contract"},
        ["08-Bitaccess", "08-Bitaccess/Contract"],
    );
    const revised = makeOrganizeProposal(
        ["1"],
        {"1": "04-Work/Bitaccess/Contract"},
        ["04-Work", "04-Work/Bitaccess", "04-Work/Bitaccess/Contract"],
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.file_actions.find((action) => action.file_id === "2")?.new_folder)
        .to.equal("04-Work/Bitaccess/Contract");
    expect(result.proposed_folders.some((folder) => folder.folder_path === "08-Bitaccess")).to.equal(false);
    expect(result.proposed_folders.some((folder) => folder.folder_path === "08-Bitaccess/Contract")).to.equal(false);
  });

  it("DT00k remaps multiple folders independently via suffix matching", function() {
    const original = makeOrganizeProposal(
        ["1", "2", "3", "4"],
        {
          "1": "08-Bitaccess",
          "2": "08-Bitaccess/Contract",
          "3": "13-Pavonis",
          "4": "13-Pavonis/Invoices",
        },
        [
          "08-Bitaccess",
          "08-Bitaccess/Contract",
          "13-Pavonis",
          "13-Pavonis/Invoices",
        ],
    );
    const revised = makeOrganizeProposal(
        ["1"],
        {"1": "04-Work/Bitaccess"},
        [
          "04-Work",
          "04-Work/Bitaccess",
          "04-Work/Bitaccess/Contract",
          "04-Work/Pavonis",
          "04-Work/Pavonis/Invoices",
        ],
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.file_actions.find((action) => action.file_id === "2")?.new_folder)
        .to.equal("04-Work/Bitaccess/Contract");
    expect(result.file_actions.find((action) => action.file_id === "3")?.new_folder)
        .to.equal("04-Work/Pavonis");
    expect(result.file_actions.find((action) => action.file_id === "4")?.new_folder)
        .to.equal("04-Work/Pavonis/Invoices");
    expect(result.proposed_folders.some((folder) => folder.folder_path === "08-Bitaccess")).to.equal(false);
    expect(result.proposed_folders.some((folder) => folder.folder_path === "13-Pavonis")).to.equal(false);
  });

  it("DT00l1 prunes stale folder when LLM revision includes it with 0 files", function() {
    const original = makeOrganizeProposal(
        ["1", "2"],
        {"1": "13-Pavonis", "2": "13-Pavonis"},
        ["13-Pavonis"],
    );
    // LLM revision moves files to 04-Work/Pavonis but leaves 13-Pavonis in proposed_folders
    const revised = makeOrganizeProposal(
        ["1", "2"],
        {"1": "04-Work/Pavonis", "2": "04-Work/Pavonis"},
        ["04-Work", "04-Work/Pavonis", "13-Pavonis"],
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.proposed_folders.some((f) => f.folder_path === "13-Pavonis")).to.equal(false);
    expect(result.proposed_folders.some((f) => f.folder_path === "04-Work")).to.equal(true);
    expect(result.proposed_folders.some((f) => f.folder_path === "04-Work/Pavonis")).to.equal(true);
    expect(result.file_actions.every((a) => a.new_folder === "04-Work/Pavonis")).to.equal(true);
  });

  it("DT00l falls back gracefully when no suffix match exists", function() {
    const original = makeOrganizeProposal(
        ["1"],
        {"1": "99-Misc"},
        ["99-Misc"],
    );
    const revised = makeOrganizeProposal(
        [],
        {},
        ["01-Docs", "02-Photos"],
    );

    const result = mergeRevisedProposal(original, revised);

    expect(result.file_actions).to.have.length(1);
    expect(result.file_actions[0].new_folder).to.equal("99-Misc");
    expect(result.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal([]);
  });
});

describe("reconcileFileActions", function() {
  it("DT00m reconciles renumbered root folders", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "14-Personal"},
        ["01-Personal"],
    );

    reconcileFileActions(proposal);

    expect(proposal.file_actions[0].new_folder).to.equal("01-Personal");
  });

  it("DT00n reconciles restructured folders via suffix", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "08-Bitaccess"},
        ["04-Work", "04-Work/Bitaccess"],
    );

    reconcileFileActions(proposal);

    expect(proposal.file_actions[0].new_folder).to.equal("04-Work/Bitaccess");
  });

  it("DT00o reconciles subfolders under a renamed root", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "14-Personal/Medical"},
        ["01-Personal", "01-Personal/Medical"],
    );

    reconcileFileActions(proposal);

    expect(proposal.file_actions[0].new_folder).to.equal("01-Personal/Medical");
  });

  it("DT00p keep actions with no match add folders to the proposal", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "03-Photos"},
        ["01-Personal"],
    );
    proposal.file_actions[0].action = "keep";

    reconcileFileActions(proposal);

    expect(proposal.file_actions[0].new_folder).to.equal("03-Photos");
    expect(proposal.proposed_folders.some((folder) => folder.folder_path === "03-Photos")).to.equal(true);
  });

  it("DT00q non-keep actions with no match stay orphaned", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "03-Photos"},
        ["01-Personal"],
    );
    proposal.file_actions[0].action = "move";

    reconcileFileActions(proposal);

    expect(proposal.file_actions[0].new_folder).to.equal("03-Photos");
    expect(proposal.proposed_folders.some((folder) => folder.folder_path === "03-Photos")).to.equal(false);
  });

  it("DT00r raw Drive paths without a prefix map by base name", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "Visibl"},
        ["17-Visibl"],
    );

    reconcileFileActions(proposal);

    expect(proposal.file_actions[0].new_folder).to.equal("17-Visibl");
  });

  it("DT00s reconciles mixed proposals so visible actions match proposed folders", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2", "3", "4", "5"],
        {
          "1": "14-Personal",
          "2": "08-Bitaccess",
          "3": "Visibl",
          "4": "03-Photos",
          "5": "05-Others",
        },
        ["01-Personal", "04-Work", "04-Work/Bitaccess", "17-Visibl"],
    );
    proposal.file_actions[0].action = "keep";
    proposal.file_actions[1].action = "move";
    proposal.file_actions[2].action = "move";
    proposal.file_actions[3].action = "keep";
    proposal.file_actions[4].action = "move";

    reconcileFileActions(proposal);

    const visibleFolderPaths = new Set(proposal.proposed_folders.map((folder) => folder.folder_path));
    expect(proposal.file_actions.find((action) => action.file_id === "1")?.new_folder).to.equal("01-Personal");
    expect(proposal.file_actions.find((action) => action.file_id === "2")?.new_folder).to.equal("04-Work/Bitaccess");
    expect(proposal.file_actions.find((action) => action.file_id === "3")?.new_folder).to.equal("17-Visibl");
    expect(proposal.file_actions.find((action) => action.file_id === "4")?.new_folder).to.equal("03-Photos");
    expect(visibleFolderPaths.has("03-Photos")).to.equal(true);
    expect(proposal.file_actions.find((action) => action.file_id === "5")?.new_folder).to.equal("05-Others");
    expect(visibleFolderPaths.has("05-Others")).to.equal(false);

    for (const action of proposal.file_actions) {
      if (action.file_id === "5") {
        continue;
      }
      expect(visibleFolderPaths.has(action.new_folder)).to.equal(true);
    }
  });
});

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
    expect(res.body.sentEmail.html).to.include("Sign Up with Google");
    expect(res.body.sentEmail.html).to.include("/drive/v2/signup");

    // Verify threading headers
    expect(res.body.sentEmail.headers).to.be.an("object");
    const incomingMessageId = testMessage.emailContent.headers["message-id"];
    expect(res.body.sentEmail.headers["In-Reply-To"]).to.equal(incomingMessageId);
    expect(res.body.sentEmail.headers["References"]).to.equal(`<original-message-drive-pdf> ${incomingMessageId}`);
  });

  it("DT02 get Drive login URL and wait for tester to authorize Drive scope", function(done) {
    chaiWithHttp.request(apiURL)
      .get("/drive/v2/signup")
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

    // Save the move confirmation HTML for the trash test (DT04b)
    moveConfirmationHtml = res.body.sentEmail.html;
  });

  it("DT04b reply to trash file instead of moving it", async function() {
    // Use embedded data from DT04's move confirmation
    expect(moveConfirmationHtml).to.not.be.empty;

    const gmailSanitizedHtml = moveConfirmationHtml;

    const replyEmailId = "test-drive-reply-trash";
    const replyMessageId = `<test-drive-reply-trash-${Date.now()}@mail.gmail.com>`;
    const trashInstructions = "Move to trash";
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
      html: `<p>${trashInstructions}</p><blockquote>${gmailSanitizedHtml}</blockquote>`,
      text: trashInstructions,
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

    // Step 1: Send to drive callback endpoint
    const callbackResponse = await chaiWithHttp.request(apiURL)
      .post(DRIVE_CALLBACK_ENDPOINT)
      .set("Content-Type", "application/json")
      .set("svix-id", "msg_test_" + Date.now())
      .set("svix-timestamp", Math.floor(Date.now() / 1000).toString())
      .set("svix-signature", "v1,dummy_signature_for_testing")
      .send(webhookWithMock);
    const webhookData = callbackResponse.body.webhookData;

    // Step 2: Dispatch to drive handler
    const res = await chaiWithHttp
      .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
      .post("/v2testDriveInboundDispatch")
      .set("Content-Type", "application/json")
      .send({data: webhookData}) as unknown as DriveDispatchResponse;

    expect(res).to.have.status(200);
    console.log("DRIVE TRASH RESPONSE:", res.body);

    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");

    // Verify file was trashed (not moved to a folder)
    expect(res.body.data.filesSucceeded).to.be.greaterThanOrEqual(1);

    // Verify trash confirmation email (not a move confirmation)
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.be.a("string");
    expect(res.body.sentEmail.html).to.include("moved to trash");
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

  it("DT05b email artifact attachments (.eml, .ics, .vcf, .p7s) are filtered out", async function() {
    const testMessage = driveEmailWithArtifacts;
    const res = await sendDriveWebhook(testMessage, testMessage.attachmentsList || []);
    expect(res).to.have.status(200);
    console.log("DRIVE ARTIFACTS RESPONSE:", res.body);

    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");
    expect(res.body.data).to.not.have.property("error");

    // Only the PDF should be processed — .eml, .ics, .vcf, .p7s should all be filtered
    expect(res.body.data.filesProcessed).to.equal(1);
  });

  it("DT06 signup via email — unknown user with no attachments gets signup invitation", async function() {
    const testMessage = driveSignup;
    const res = await sendDriveWebhook(testMessage);
    expect(res).to.have.status(200);
    console.log("DRIVE SIGNUP RESPONSE:", res.body);

    expect(res.body).to.be.an("object");
    expect(res.body.data).to.be.an("object");
    expect(res.body.data).to.not.have.property("error");

    // No files processed
    expect(res.body.data.filesProcessed).to.equal(0);

    // Verify welcome/signup email was sent
    expect(res.body.sentEmail).to.be.an("object");
    expect(res.body.sentEmail.html).to.be.a("string");
    expect(res.body.sentEmail.html).to.include("Welcome to fwd2drive");
    expect(res.body.sentEmail.html).to.include("Sign Up with Google");
    expect(res.body.sentEmail.html).to.include("/drive/v2/signup");

    // Verify it does NOT contain the old "no attachments" error
    expect(res.body.sentEmail.html).to.not.include("didn't have any attachments");
  });
});
