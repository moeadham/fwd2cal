/* eslint-disable max-len */
import chai from "chai";
import chaiHttp from "chai-http";
import {exec} from "child_process";
import * as fs from "fs";
import * as path from "path";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import OpenAI from "openai";
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
  driveEmailWithJapaneseConferenceInvitationPDF,
  automatedReplyEmail,
} from "./bindings/resendBindings";
import {extractDocumentImages} from "../src/util/documentParser";
import {
  applyFolderOperations,
  mergeRevisedProposal,
  normalizeFolderPrefixes,
  renumberFoldersContiguously,
  reconcileFileActions,
  refineOrganizationProposal,
  renderFolderTreePlainText,
} from "../src/agents/drive/llm";
import {ORGANIZE_DRIVE_CHUNK_SIZE} from "../src/agents/drive/config";
import {DriveOrganizeProposal, FolderOperation, MoveInstructionSchema} from "../src/agents/drive/types";
import {
  mergeChunkProposalFolders,
  getParallelBatchChunkIndexes,
  seedFoldersFromDrive,
} from "../src/agents/drive/organizeHandler";
import {defaultCompletion, setOpenAIClientForTest} from "../src/util/openai";
import {
  getResumableOrganizeProposals,
  claimChunkProcessing,
  releaseChunkProcessing,
  claimOrganizeProposalFinalization,
  incrementOrganizeCompletedChunks,
} from "../src/util/firestoreHandler";


chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5002";
const DRIVE_CALLBACK_ENDPOINT = "/drive/v2/inboundCallback";
const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT || "";
const DRIVE_EMAIL_ADDRESS = process.env.DRIVE_EMAIL_ADDRESS || "drive@fwd2drive.com";
const MOCK_LLM = process.env.MOCK_LLM !== "false";
const DISPATCH_URL = "http://127.0.0.1:5001";
const DISPATCH_REGION = "us-central1";
const APP_ID = process.env.GCLOUD_PROJECT || "fwd2cal-dev-2578e";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
initializeApp({projectId: APP_ID});
const testApp = initializeApp({projectId: APP_ID}, "drive-test");
const db = getFirestore(testApp);

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

function extractEmbeddedFileDataId(html: string): string {
  const linkMatch = html.match(/fwd2drive\.com\/d\?r=([A-Za-z0-9_-]+)/);
  expect(linkMatch, "embedded drive link should be present").to.not.equal(null);
  const json = Buffer.from(linkMatch![1], "base64url").toString();
  const parsed = JSON.parse(json) as {fileDataId?: string};
  expect(parsed.fileDataId, "embedded fileDataId should be present").to.be.a("string").and.not.be.empty;
  return parsed.fileDataId!;
}

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

describe("renumberFoldersContiguously", function() {
  it("DT00r1 renumbers prefixed top-level folders without gaps", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2", "3", "4"],
        {
          "1": "05-Projects",
          "2": "06-Personal",
          "3": "12-Important",
          "4": "16-Trading",
        },
        ["05-Projects", "06-Personal", "12-Important", "16-Trading"],
    );

    renumberFoldersContiguously(proposal);

    expect(proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal(["01-Projects", "02-Personal", "03-Important", "04-Trading"]);
    expect(proposal.file_actions.map((action) => action.new_folder))
        .to.deep.equal(["01-Projects", "02-Personal", "03-Important", "04-Trading"]);
  });

  it("DT00r2 appends unprefixed folders alphabetically after prefixed folders", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2", "3"],
        {"1": "02-Foo", "2": "Bar", "3": "Apple"},
        ["02-Foo", "Bar", "Apple"],
    );

    renumberFoldersContiguously(proposal);

    expect(proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal(["01-Foo", "02-Apple", "03-Bar"]);
    expect(proposal.file_actions.map((action) => action.new_folder))
        .to.deep.equal(["01-Foo", "03-Bar", "02-Apple"]);
  });

  it("DT00r3 leaves already-contiguous folders unchanged", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2", "3"],
        {"1": "01-A/Sub", "2": "02-B", "3": "03-C/Nested"},
        ["01-A", "01-A/Sub", "02-B", "03-C", "03-C/Nested"],
    );
    const beforeFolders = proposal.proposed_folders.map((folder) => folder.folder_path);
    const beforeActions = proposal.file_actions.map((action) => action.new_folder);

    renumberFoldersContiguously(proposal);

    expect(proposal.proposed_folders.map((folder) => folder.folder_path)).to.deep.equal(beforeFolders);
    expect(proposal.file_actions.map((action) => action.new_folder)).to.deep.equal(beforeActions);
  });

  it("DT00r4 rewrites only the root segment for nested folders and actions", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2"],
        {
          "1": "12-Important/Sub",
          "2": "16-Trading/Nested/Deep",
        },
        ["12-Important", "12-Important/Sub", "16-Trading", "16-Trading/Nested/Deep"],
    );

    renumberFoldersContiguously(proposal);

    expect(proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal([
          "01-Important",
          "01-Important/Sub",
          "02-Trading",
          "02-Trading/Nested/Deep",
        ]);
    expect(proposal.file_actions.map((action) => action.new_folder))
        .to.deep.equal(["01-Important/Sub", "02-Trading/Nested/Deep"]);
  });

  it("DT00r5 keeps distinct folders when prefixed and unprefixed names converge", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2"],
        {"1": "Documents", "2": "01-Documents"},
        ["Documents", "01-Documents"],
    );

    renumberFoldersContiguously(proposal);

    expect(proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal(["01-Documents", "02-Documents"]);
    expect(proposal.file_actions.map((action) => action.new_folder))
        .to.deep.equal(["02-Documents", "01-Documents"]);
  });

  it("DT00r6 leaves unrelated file action folders unchanged", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "05-Projects"},
        ["05-Projects"],
    );
    proposal.file_actions.push({
      file_id: "2",
      current_name: "unknown.pdf",
      current_path: "Inbox",
      new_name: "unknown.pdf",
      new_folder: "99-Unknown",
      action: "move",
      reason: "Reason 2",
    });

    renumberFoldersContiguously(proposal);

    expect(proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal(["01-Projects"]);
    expect(proposal.file_actions.find((action) => action.file_id === "1")?.new_folder)
        .to.equal("01-Projects");
    expect(proposal.file_actions.find((action) => action.file_id === "2")?.new_folder)
        .to.equal("99-Unknown");
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

describe("applyFolderOperations", function() {
  function runOps(
      proposal: DriveOrganizeProposal,
      operations: FolderOperation[],
      summary = "revised summary",
  ): { proposal: DriveOrganizeProposal; preservedRootPaths: Set<string> } {
    return applyFolderOperations(proposal, operations, summary);
  }

  it("DT00k rename cascades to file_actions and descendants", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2"],
        {"1": "03-Work", "2": "03-Work/Clients"},
        ["03-Work", "03-Work/Clients"],
    );
    proposal.file_actions[0].action = "keep";
    proposal.file_actions[1].action = "rename";

    const result = runOps(proposal, [{
      action: "rename",
      path: null,
      from: "03-Work",
      to: "Business",
      description: "Client and business documents",
      into: null,
      source_path: null,
    }]);

    expect(result.proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal(["Business", "Business/Clients"]);
    expect(result.proposal.proposed_folders[0].description).to.equal("Client and business documents");
    expect(result.proposal.file_actions.map((action) => action.new_folder))
        .to.deep.equal(["Business", "Business/Clients"]);
    expect(result.proposal.file_actions.map((action) => action.action))
        .to.deep.equal(["move", "move_and_rename"]);
  });

  it("DT00l merge moves files and prunes source", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2"],
        {"1": "07-Old", "2": "07-Old"},
        ["07-Old", "09-Archive"],
    );
    proposal.file_actions.forEach((action) => {
      action.action = "keep";
    });

    const result = runOps(proposal, [{
      action: "merge",
      path: null,
      description: null,
      from: "07-Old",
      to: null,
      into: "09-Archive",
      source_path: null,
    }]);

    expect(result.proposal.file_actions.map((action) => action.new_folder))
        .to.deep.equal(["09-Archive", "09-Archive"]);
    expect(result.proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal(["09-Archive"]);
  });

  it("DT00m merge preserves subpath", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "03-Work/Taxes"},
        ["03-Work", "03-Work/Taxes", "09-Archive"],
    );

    const result = runOps(proposal, [{
      action: "merge",
      path: null,
      description: null,
      from: "03-Work",
      to: null,
      into: "09-Archive",
      source_path: null,
    }]);

    expect(result.proposal.file_actions[0].new_folder).to.equal("09-Archive/Taxes");
  });

  it("DT00n create adds folder", function() {
    const proposal = makeOrganizeProposal(["1"], {"1": "03-Work"}, ["03-Work"]);

    const result = runOps(proposal, [{
      action: "create",
      path: "Travel",
      description: "Trips and itineraries",
      from: null,
      to: null,
      into: null,
      source_path: null,
    }]);

    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "Travel")).to.equal(true);
  });

  it("DT00o delete reverts files in non-empty folder", function() {
    const proposal = makeOrganizeProposal(["1"], {"1": "04-Media"}, ["04-Media"]);

    const result = runOps(proposal, [{
      action: "delete",
      path: "04-Media",
      description: null,
      from: null,
      to: null,
      into: null,
      source_path: null,
    }]);

    expect(result.proposal.file_actions[0].action).to.equal("keep");
    expect(result.proposal.file_actions[0].new_folder).to.equal("Inbox");
    expect(result.proposal.file_actions[0].new_name).to.equal("file-1.pdf");
    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "04-Media")).to.equal(false);
    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "Inbox")).to.equal(true);
  });

  it("DT00p delete removes empty folder", function() {
    const proposal = makeOrganizeProposal(["1"], {"1": "03-Work"}, ["03-Work", "04-Media"]);

    const result = runOps(proposal, [{
      action: "delete",
      path: "04-Media",
      description: null,
      from: null,
      to: null,
      into: null,
      source_path: null,
    }]);

    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "04-Media")).to.equal(false);
  });

  it("DT00oa delete non-empty folder reverted folders not prefixed", function() {
    const proposal = makeOrganizeProposal(["1"], {"1": "Others"}, ["Others"]);

    const result = runOps(proposal, [{
      action: "delete",
      path: "Others",
      description: null,
      from: null,
      to: null,
      into: null,
      source_path: null,
    }]);

    normalizeFolderPrefixes(result.proposal, result.preservedRootPaths);

    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "Inbox")).to.equal(true);
    expect(result.proposal.proposed_folders.some((folder) => /^(\d{2,3})-Inbox$/.test(folder.folder_path))).to.equal(false);
  });

  it("DT00q preserve_source resets files to original location", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2"],
        {"1": "04-Media", "2": "04-Media"},
        ["04-Media"],
    );
    proposal.file_actions[0].current_path = "VAULT/Sub";
    proposal.file_actions[0].current_name = "original-a.pdf";
    proposal.file_actions[0].new_name = "renamed-a.pdf";
    proposal.file_actions[0].action = "move_and_rename";
    proposal.file_actions[1].current_path = "Other";

    const result = runOps(proposal, [{
      action: "preserve_source",
      path: null,
      description: null,
      from: null,
      to: null,
      into: null,
      source_path: "VAULT",
    }]);

    expect(result.proposal.file_actions[0].new_folder).to.equal("VAULT/Sub");
    expect(result.proposal.file_actions[0].new_name).to.equal("original-a.pdf");
    expect(result.proposal.file_actions[0].action).to.equal("keep");
    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "VAULT")).to.equal(true);
    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "VAULT/Sub")).to.equal(true);
  });

  it("DT00qa preserve_source preserved folders not prefixed", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "04-Media"},
        ["04-Media"],
    );
    proposal.file_actions[0].current_path = "VAULT/Sub";

    const result = runOps(proposal, [{
      action: "preserve_source",
      path: null,
      description: null,
      from: null,
      to: null,
      into: null,
      source_path: "VAULT",
    }]);

    normalizeFolderPrefixes(result.proposal, result.preservedRootPaths);

    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "VAULT")).to.equal(true);
    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "VAULT/Sub")).to.equal(true);
    expect(result.proposal.proposed_folders.some((folder) => /^(\d{2,3})-VAULT$/.test(folder.folder_path))).to.equal(false);
  });

  it("DT00r operation ordering matters", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2"],
        {"1": "03-Work/Clients", "2": "06-Personal"},
        ["03-Work", "03-Work/Clients", "06-Personal"],
    );

    const result = runOps(proposal, [
      {action: "rename", path: null, from: "03-Work", to: "Business", description: null, into: null, source_path: null},
      {action: "merge", path: null, description: null, from: "06-Personal", to: null, into: "Business", source_path: null},
    ]);

    expect(result.proposal.file_actions.find((action) => action.file_id === "1")?.new_folder)
        .to.equal("Business/Clients");
    expect(result.proposal.file_actions.find((action) => action.file_id === "2")?.new_folder)
        .to.equal("Business");
  });

  it("DT00s prune removes unreferenced folders", function() {
    const proposal = makeOrganizeProposal(
        ["1"],
        {"1": "09-Archive"},
        ["03-Work", "09-Archive", "13-Pavonis"],
    );

    const result = runOps(proposal, [{
      action: "merge",
      path: null,
      description: null,
      from: "03-Work",
      to: null,
      into: "09-Archive",
      source_path: null,
    }]);

    expect(result.proposal.proposed_folders.some((folder) => folder.folder_path === "13-Pavonis")).to.equal(false);
  });

  it("DT00ka rename description only updates target folder", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2", "3"],
        {"1": "03-Work", "2": "03-Work/Clients", "3": "09-Archive"},
        ["03-Work", "03-Work/Clients", "09-Archive"],
    );
    proposal.proposed_folders = [
      {folder_path: "03-Work", description: "Work root"},
      {folder_path: "03-Work/Clients", description: "Client folders"},
      {folder_path: "09-Archive", description: "Archive root"},
    ];

    const result = runOps(proposal, [{
      action: "rename",
      path: null,
      from: "03-Work",
      to: "Business",
      description: "Biz docs",
      into: null,
      source_path: null,
    }]);

    expect(result.proposal.proposed_folders.find((folder) => folder.folder_path === "Business")?.description)
        .to.equal("Biz docs");
    expect(result.proposal.proposed_folders.find((folder) => folder.folder_path === "Business/Clients")?.description)
        .to.equal("Client folders");
    expect(result.proposal.proposed_folders.find((folder) => folder.folder_path === "09-Archive")?.description)
        .to.equal("Archive root");
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

describe("mergeChunkProposalFolders", function() {
  it("DT00ta merges only new chunk folders and normalizes prefixes against accumulated folders", function() {
    const accumulatedFolders = [
      {
        folder_path: "01-Personal",
        description: "Existing personal folder",
      },
    ];
    const chunkProposal = makeOrganizeProposal(
        ["1", "2"],
        {
          "1": "Work/Client",
          "2": "01-Personal",
        },
        ["01-Personal", "Work", "Work/Client"],
    );

    const mergedFolders = mergeChunkProposalFolders(accumulatedFolders, chunkProposal);

    expect(mergedFolders.map((folder) => folder.folder_path)).to.deep.equal([
      "01-Personal",
      "02-Work",
      "02-Work/Client",
    ]);
    expect(chunkProposal.proposed_folders.map((folder) => folder.folder_path)).to.deep.equal([
      "01-Personal",
      "02-Work",
      "02-Work/Client",
    ]);
    expect(chunkProposal.file_actions.find((action) => action.file_id === "1")?.new_folder)
        .to.equal("02-Work/Client");
    expect(chunkProposal.file_actions.find((action) => action.file_id === "2")?.new_folder)
        .to.equal("01-Personal");
  });
});

describe("MoveInstructionSchema", function() {
  it("DT00t accepts optional new_filename and still allows omission", function() {
    const withRename = MoveInstructionSchema.parse({
      moves: [{
        file_index: 0,
        action: "move",
        folder_id: "folder-123",
        folder_path: "01-Receipts",
        reason: "Rename in English",
        new_filename: "Conference Registration.pdf",
      }],
    });

    const withoutRename = MoveInstructionSchema.parse({
      moves: [{
        file_index: 0,
        action: "move",
        folder_id: "folder-123",
        folder_path: "01-Receipts",
        reason: "Keep original name",
      }],
    });

    const withNullRename = MoveInstructionSchema.parse({
      moves: [{
        file_index: 0,
        action: "move",
        folder_id: "folder-123",
        folder_path: "01-Receipts",
        reason: "Model returned null for unused field",
        new_filename: null,
      }],
    });

    expect(withRename.moves[0].new_filename).to.equal("Conference Registration.pdf");
    expect(withoutRename.moves[0]).to.not.have.property("new_filename");
    expect(withNullRename.moves[0].new_filename).to.equal(null);
  });
});

describe("defaultCompletion", function() {
  afterEach(function() {
    setOpenAIClientForTest(null);
  });

  it("DT00ta1 forwards an explicit max token override to the OpenRouter request", async function() {
    let capturedRequest: {max_tokens?: number} | null = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (request: {max_tokens?: number}) => {
            capturedRequest = request;
            return {
              choices: [{
                message: {
                  content: "ok",
                },
                finish_reason: "stop",
              }],
              usage: {total_tokens: 1},
            };
          },
        },
      },
    } as unknown as OpenAI;
    setOpenAIClientForTest(fakeClient);

    const result = await defaultCompletion(
        [{role: "user", content: "hello"}],
        "openai/gpt-4.1",
        undefined,
        null,
        null,
        {maxTokens: 32768},
    );

    expect(result).to.equal("ok");
    expect(capturedRequest?.max_tokens).to.equal(32768);
  });
});

describe("drive config", function() {
  it("DT00ta2 defaults organize chunk size to 30 files", function() {
    expect(ORGANIZE_DRIVE_CHUNK_SIZE.options.default).to.equal(30);
  });
});

describe("refineOrganizationProposal", function() {
  afterEach(function() {
    setOpenAIClientForTest(null);
  });

  it("DT00tb applies folder rename mappings from the refinement result", async function() {
    this.timeout(60000);
    const refinedResult = {
      refined_folders: [
        {
          folder_path: "05-Financial",
          description: "Finance documents",
        },
        {
          folder_path: "05-Financial/Taxes",
          description: "Tax records",
        },
        {
          folder_path: "05-Financial/Taxes/2024",
          description: "2024 taxes",
        },
        {
          folder_path: "07-Travel",
          description: "Travel documents",
        },
      ],
      folder_renames: [
        {old_path: "05-Finance", new_path: "05-Financial"},
      ],
      summary: "Grouped finance records under a cleaner Financial hierarchy.",
    };
    if (MOCK_LLM) {
      const fakeClient = {
        chat: {
          completions: {
            parse: async () => ({
              choices: [{
                message: {parsed: refinedResult},
                finish_reason: "stop",
              }],
              usage: {total_tokens: 21},
            }),
            create: async () => ({
              choices: [{
                message: {
                  content: JSON.stringify(refinedResult),
                },
                finish_reason: "stop",
              }],
              usage: {total_tokens: 21},
            }),
          },
        },
      } as unknown as OpenAI;
      setOpenAIClientForTest(fakeClient);
    }
    const proposal = makeOrganizeProposal(
        ["1", "2"],
        {
          "1": "05-Finance/Taxes/2024",
          "2": "07-Travel",
        },
        ["05-Finance", "05-Finance/Taxes", "05-Finance/Taxes/2024", "07-Travel"],
    );

    const result = await refineOrganizationProposal(proposal);

    if (MOCK_LLM) {
      expect(result.summary).to.equal("Grouped finance records under a cleaner Financial hierarchy.");
      expect(result.proposed_folders.map((folder) => folder.folder_path)).to.deep.equal([
        "05-Financial",
        "05-Financial/Taxes",
        "05-Financial/Taxes/2024",
        "07-Travel",
      ]);
      expect(result.file_actions.find((action) => action.file_id === "1")?.new_folder)
          .to.equal("05-Financial/Taxes/2024");
      expect(result.file_actions.find((action) => action.file_id === "2")?.new_folder)
          .to.equal("07-Travel");
    } else {
      console.log("Live refined folders:", result.proposed_folders.map((f) => f.folder_path));
      console.log("Live summary:", result.summary);
      expect(result.proposed_folders).to.be.an("array").with.length.greaterThan(0);
      expect(result.file_actions).to.have.length(2);
      expect(result.summary).to.be.a("string").with.length.greaterThan(0);
    }
  });

});

describe("renderFolderTreePlainText", function() {
  it("DT00u renders a plain-text folder tree with counts", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2", "3"],
        {
          "1": "01-Personal",
          "2": "02-Work/Clients",
          "3": "02-Work/Clients",
        },
        ["01-Personal", "02-Work", "02-Work/Clients"],
    );

    const tree = renderFolderTreePlainText(proposal);

    expect(tree).to.equal(
        "My Drive\n" +
        "├── 01-Personal/  (1 files)\n" +
        "└── 02-Work/  (0 files)\n" +
        "    └── Clients/  (2 files)",
    );
  });
});

describe("admin resume helpers", function() {
  it("DT00ua lists resumable organize proposals sorted by createdAt desc", async function() {
    const baseId = `resume-list-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(`${baseId}-failed`).set({
      status: "failed",
      createdAt: "2099-01-02T00:00:00.000Z",
      emailId: "email-failed",
      uid: "uid-failed",
    });
    await db.collection("OrganizeProposals").doc(`${baseId}-generating`).set({
      status: "generating",
      createdAt: "2099-01-01T00:00:00.000Z",
      emailId: "email-generating",
      uid: "uid-generating",
    });
    await db.collection("OrganizeProposals").doc(`${baseId}-pending`).set({
      status: "pending",
      createdAt: "2099-01-03T00:00:00.000Z",
      emailId: "email-pending",
      uid: "uid-pending",
    });

    const proposals = await getResumableOrganizeProposals();
    const seeded = proposals.filter((proposal) => String(proposal.id).startsWith(baseId));

    expect(seeded.map((proposal) => proposal.id)).to.deep.equal([
      `${baseId}-failed`,
      `${baseId}-generating`,
    ]);
  });
});

describe("organize chunk helpers", function() {
  it("DT00uaa seeds canonical roots for an empty drive", function() {
    const {seedFolders, folderRenameActions} = seedFoldersFromDrive([]);

    expect(seedFolders.map((folder) => folder.folder_path)).to.deep.equal([
      "01-Documents",
      "02-Finance",
      "03-Work",
      "04-Media",
      "05-Projects",
      "06-Personal",
      "07-Education",
      "08-Travel",
      "09-Archive",
    ]);
    expect(folderRenameActions).to.deep.equal([]);
  });

  it("DT00uab maps matching folders, preserves unmatched folders, merges duplicates, and keeps canonical names", function() {
    const {seedFolders, folderRenameActions} = seedFoldersFromDrive([
      {
        id: "folder-docs",
        name: "Medical Insurance",
        mimeType: "application/vnd.google-apps.folder",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-01-01T00:00:00.000Z",
        size: 0,
        webViewLink: "",
        isFolder: true,
      },
      {
        id: "folder-taxes",
        name: "taxes",
        mimeType: "application/vnd.google-apps.folder",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-01-02T00:00:00.000Z",
        size: 0,
        webViewLink: "",
        isFolder: true,
      },
      {
        id: "folder-random",
        name: "Random",
        mimeType: "application/vnd.google-apps.folder",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-01-03T00:00:00.000Z",
        size: 0,
        webViewLink: "",
        isFolder: true,
      },
      {
        id: "folder-random-dup",
        name: "random",
        mimeType: "application/vnd.google-apps.folder",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-01-04T00:00:00.000Z",
        size: 0,
        webViewLink: "",
        isFolder: true,
      },
      {
        id: "folder-finance-canonical",
        name: "02-Finance",
        mimeType: "application/vnd.google-apps.folder",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-01-05T00:00:00.000Z",
        size: 0,
        webViewLink: "",
        isFolder: true,
      },
      {
        id: "folder-finance-wrong-prefix",
        name: "05-Finance",
        mimeType: "application/vnd.google-apps.folder",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-01-06T00:00:00.000Z",
        size: 0,
        webViewLink: "",
        isFolder: true,
      },
    ]);

    expect(seedFolders.map((folder) => folder.folder_path)).to.include.members([
      "01-Documents",
      "02-Finance",
      "09-Archive",
      "10-Random",
    ]);
    expect(seedFolders).to.have.length(10);

    expect(folderRenameActions).to.deep.include({
      file_id: "folder-docs",
      current_name: "Medical Insurance",
      current_path: "My Drive",
      new_name: "01-Documents",
      new_folder: "My Drive",
      action: "rename",
      reason: "Mapped to canonical category 01-Documents",
    });
    expect(folderRenameActions).to.deep.include({
      file_id: "folder-taxes",
      current_name: "taxes",
      current_path: "My Drive",
      new_name: "02-Finance",
      new_folder: "My Drive",
      action: "rename",
      reason: "Mapped to canonical category 02-Finance",
    });
    expect(folderRenameActions).to.deep.include({
      file_id: "folder-random-dup",
      current_name: "random",
      current_path: "My Drive",
      new_name: "10-Random",
      new_folder: "My Drive",
      action: "rename",
      reason: "Renamed unmatched folder with custom prefix 10-Random",
    });
    expect(folderRenameActions).to.deep.include({
      file_id: "folder-random",
      current_name: "Random",
      current_path: "My Drive",
      new_name: "10-Random",
      new_folder: "My Drive",
      action: "rename",
      reason: 'Merged duplicate folder into "10-Random"',
    });
    expect(folderRenameActions).to.deep.include({
      file_id: "folder-finance-canonical",
      current_name: "02-Finance",
      current_path: "My Drive",
      new_name: "02-Finance",
      new_folder: "My Drive",
      action: "keep",
      reason: "Already using canonical root category",
    });
    expect(folderRenameActions).to.deep.include({
      file_id: "folder-finance-wrong-prefix",
      current_name: "05-Finance",
      current_path: "My Drive",
      new_name: "02-Finance",
      new_folder: "My Drive",
      action: "rename",
      reason: 'Merged duplicate folder into "02-Finance"',
    });
  });

  it("DT00uac increments completed chunk count once per chunk index", async function() {
    const proposalId = `chunk-counter-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({
      status: "generating",
      completedChunks: 0,
      completedChunkIndices: [],
    });

    const first = await incrementOrganizeCompletedChunks(proposalId, 0);
    const duplicate = await incrementOrganizeCompletedChunks(proposalId, 0);
    const second = await incrementOrganizeCompletedChunks(proposalId, 1);
    const storedDoc = await db.collection("OrganizeProposals").doc(proposalId).get();

    expect(first).to.deep.equal({count: 1, wasNew: true});
    expect(duplicate).to.deep.equal({count: 1, wasNew: false});
    expect(second).to.deep.equal({count: 2, wasNew: true});
    expect(storedDoc.data()?.completedChunks).to.equal(2);
    expect(storedDoc.data()?.completedChunkIndices).to.deep.equal([0, 1]);
  });

  it("DT00uae reports wasNew false when a completed chunk is replayed at totalChunks", async function() {
    const proposalId = `chunk-counter-final-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({
      status: "generating",
      completedChunks: 3,
      completedChunkIndices: [0, 1, 2],
      totalChunks: 3,
    });

    const result = await incrementOrganizeCompletedChunks(proposalId, 2);

    expect(result).to.deep.equal({count: 3, wasNew: false});
  });

  it("DT00uaf claims a chunk lock on first processing attempt", async function() {
    const proposalId = `chunk-lock-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({status: "generating"});

    const claimed = await claimChunkProcessing(proposalId, 5, 15);
    const storedDoc = await db.collection("OrganizeProposals").doc(proposalId).get();
    const lockValue = storedDoc.data()?.processingChunks?.["5"];

    expect(claimed).to.equal(true);
    expect(lockValue).to.be.a("string");
    expect(Date.parse(lockValue)).to.be.greaterThan(Date.now());
  });

  it("DT00uag rejects a duplicate chunk lock claim", async function() {
    const proposalId = `chunk-lock-dup-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({status: "generating"});

    await claimChunkProcessing(proposalId, 5, 15);
    const before = await db.collection("OrganizeProposals").doc(proposalId).get();
    const duplicate = await claimChunkProcessing(proposalId, 5, 15);
    const after = await db.collection("OrganizeProposals").doc(proposalId).get();

    expect(duplicate).to.equal(false);
    expect(after.data()?.processingChunks).to.deep.equal(before.data()?.processingChunks);
  });

  it("DT00uah allows distinct chunk lock claims to coexist", async function() {
    const proposalId = `chunk-lock-multi-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({status: "generating"});

    const first = await claimChunkProcessing(proposalId, 5, 15);
    const second = await claimChunkProcessing(proposalId, 6, 15);
    const storedDoc = await db.collection("OrganizeProposals").doc(proposalId).get();

    expect(first).to.equal(true);
    expect(second).to.equal(true);
    expect(storedDoc.data()?.processingChunks).to.have.keys(["5", "6"]);
  });

  it("DT00uai reclaims an expired chunk lock", async function() {
    const proposalId = `chunk-lock-expired-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({
      status: "generating",
      processingChunks: {"5": "2020-01-01T00:00:00.000Z"},
    });

    const claimed = await claimChunkProcessing(proposalId, 5, 15);
    const storedDoc = await db.collection("OrganizeProposals").doc(proposalId).get();
    const lockValue = storedDoc.data()?.processingChunks?.["5"];

    expect(claimed).to.equal(true);
    expect(lockValue).to.be.a("string");
    expect(lockValue).to.not.equal("2020-01-01T00:00:00.000Z");
    expect(Date.parse(lockValue)).to.be.greaterThan(Date.now());
  });

  it("DT00uaj grants exactly one chunk lock claim under contention", async function() {
    const proposalId = `chunk-lock-race-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({status: "generating"});

    const results = await Promise.all([
      claimChunkProcessing(proposalId, 5, 15),
      claimChunkProcessing(proposalId, 5, 15),
    ]);

    expect(results.filter(Boolean)).to.have.length(1);
    expect(results.filter((result) => !result)).to.have.length(1);
  });

  it("DT00uak releases an active chunk lock", async function() {
    const proposalId = `chunk-lock-release-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({
      status: "generating",
      processingChunks: {"5": "2099-01-01T00:00:00.000Z"},
    });

    await releaseChunkProcessing(proposalId, 5);
    const storedDoc = await db.collection("OrganizeProposals").doc(proposalId).get();

    expect(storedDoc.data()?.processingChunks).to.deep.equal({});
  });

  it("DT00ual ignores release requests for missing chunk locks", async function() {
    const proposalId = `chunk-lock-missing-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({status: "generating"});

    await releaseChunkProcessing(proposalId, 5);
    const storedDoc = await db.collection("OrganizeProposals").doc(proposalId).get();

    expect(storedDoc.data()?.processingChunks).to.equal(undefined);
  });

  it("DT00uam claims finalization once for a generating proposal", async function() {
    const proposalId = `finalization-claim-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({status: "generating"});

    const claimed = await claimOrganizeProposalFinalization(proposalId);
    const storedDoc = await db.collection("OrganizeProposals").doc(proposalId).get();
    const sentAt = storedDoc.data()?.proposalEmailSentAt;

    expect(claimed).to.equal(true);
    expect(sentAt).to.be.a("string");
    expect(Number.isNaN(Date.parse(sentAt))).to.equal(false);
  });

  it("DT00uan rejects duplicate finalization claims", async function() {
    const proposalId = `finalization-dup-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({
      status: "generating",
      proposalEmailSentAt: "2026-04-10T00:00:00.000Z",
    });

    const claimed = await claimOrganizeProposalFinalization(proposalId);
    const storedDoc = await db.collection("OrganizeProposals").doc(proposalId).get();

    expect(claimed).to.equal(false);
    expect(storedDoc.data()?.proposalEmailSentAt).to.equal("2026-04-10T00:00:00.000Z");
  });

  it("DT00uao rejects finalization claims when the proposal is not generating", async function() {
    const proposalId = `finalization-status-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({status: "pending"});

    const claimed = await claimOrganizeProposalFinalization(proposalId);
    const storedDoc = await db.collection("OrganizeProposals").doc(proposalId).get();

    expect(claimed).to.equal(false);
    expect(storedDoc.data()?.proposalEmailSentAt).to.equal(undefined);
  });

  it("DT00uap grants exactly one finalization claim under contention", async function() {
    const proposalId = `finalization-race-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(proposalId).set({status: "generating"});

    const results = await Promise.all([
      claimOrganizeProposalFinalization(proposalId),
      claimOrganizeProposalFinalization(proposalId),
    ]);

    expect(results.filter(Boolean)).to.have.length(1);
    expect(results.filter((result) => !result)).to.have.length(1);
  });

  it("DT00uad dispatches the next chunk batch only at batch boundaries", function() {
    expect(getParallelBatchChunkIndexes(1, 12, 10)).to.deep.equal([]);
    expect(getParallelBatchChunkIndexes(10, 12, 10)).to.deep.equal([10, 11]);
    expect(getParallelBatchChunkIndexes(12, 12, 10)).to.deep.equal([]);
    expect(getParallelBatchChunkIndexes(11, 25, 10)).to.deep.equal([]);
    expect(getParallelBatchChunkIndexes(20, 25, 10)).to.deep.equal([20, 21, 22, 23, 24]);
  });
});

describe("move instruction fast-path", function() {
  it("DT00v handles explicit move-to-folder phrasing without LLM assistance", async function() {
    const {interpretMoveInstructions} = await import("../src/agents/drive/llm");

    const result = await interpretMoveInstructions(
        "Please move this to a folder called Receipts",
        [{
          id: "file-1",
          folderId: "folder-1",
          folderPath: "01-Inbox",
          filename: "receipt.pdf",
          webLink: "https://example.com/file-1",
        }],
        [],
    );

    expect(result.moves).to.deep.equal([{
      file_index: 0,
      action: "move",
      folder_id: "root",
      folder_path: "Receipts",
      reason: "Fast-path parser detected an explicit move destination",
    }]);
  });

  it("DT00w handles explicit trash requests without LLM assistance", async function() {
    const {interpretMoveInstructions} = await import("../src/agents/drive/llm");

    const result = await interpretMoveInstructions(
        "Please delete this",
        [{
          id: "file-1",
          folderId: "folder-1",
          folderPath: "01-Inbox",
          filename: "receipt.pdf",
          webLink: "https://example.com/file-1",
        }],
        [],
    );

    expect(result.moves).to.deep.equal([{
      file_index: 0,
      action: "trash",
      folder_id: "",
      folder_path: "",
      reason: "Fast-path parser detected a trash request",
    }]);
  });
});

describe("admin resume routes", function() {
  it("DT00ub rejects admin list without x-admin-key", async function() {
    const res = await chaiWithHttp
      .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
      .post("/v2driveAdminOrganize")
      .set("Content-Type", "application/json")
      .send({action: "list"});

    expect(res).to.have.status(401);
    expect(res.body).to.deep.equal({error: "Unauthorized"});
  });

  it("DT00uc rejects standalone retry without x-admin-key", async function() {
    const res = await chaiWithHttp
      .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
      .get("/v2driveRetryOrganizeProposal")
      .query({proposalId: "missing-proposal"})
      .set("Content-Type", "application/json");

    expect(res).to.have.status(401);
    expect(res.body).to.deep.equal({error: "Unauthorized"});
  });

  it("DT00ud returns resumable proposals from admin list", async function() {
    const baseId = `admin-list-${Date.now()}`;
    await db.collection("OrganizeProposals").doc(`${baseId}-failed`).set({
      status: "failed",
      createdAt: "2099-02-02T00:00:00.000Z",
      emailId: "email-failed",
      uid: "uid-failed",
    });
    await db.collection("OrganizeProposals").doc(`${baseId}-generating`).set({
      status: "generating",
      createdAt: "2099-02-01T00:00:00.000Z",
      emailId: "email-generating",
      uid: "uid-generating",
    });
    await db.collection("OrganizeProposals").doc(`${baseId}-completed`).set({
      status: "completed",
      createdAt: "2099-02-03T00:00:00.000Z",
      emailId: "email-completed",
      uid: "uid-completed",
    });

    const res = await chaiWithHttp
      .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
      .post("/v2driveAdminOrganize")
      .set("Content-Type", "application/json")
      .set("x-admin-key", "test-admin-key")
      .send({action: "list"});

    expect(res).to.have.status(200);
    const seeded = (res.body as Array<{id: string}>)
      .filter((proposal) => proposal.id.startsWith(baseId))
      .map((proposal) => proposal.id);
    expect(seeded).to.deep.equal([
      `${baseId}-failed`,
      `${baseId}-generating`,
    ]);
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
        subject: "Re: Fwd: Japanese Conference Invitation",
        created_at: new Date().toISOString(),
        attachments: [] as unknown[],
      },
    };

    const replyEmailContent = {
      id: replyEmailId,
      subject: "Re: Fwd: Japanese Conference Invitation",
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [DRIVE_EMAIL_ADDRESS],
      html: `<p>${moveInstructions}</p><blockquote>${gmailSanitizedHtml}</blockquote>`,
      text: moveInstructions,
      headers: {
        "authentication-results": `amazonses.com; spf=pass (spfCheck: domain of _spf.${domain} designates 209.85.214.171 as permitted sender) client-ip=209.85.214.171; envelope-from=${TESTER_PRIMARY_GOOGLE_ACCT}; helo=mail.${domain}; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain};`,
        "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
        "to": DRIVE_EMAIL_ADDRESS,
        "subject": "Re: Fwd: Japanese Conference Invitation",
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

  it("DT04c reply to rename file in English", async function() {
    const japaneseSourceFilename = "日本会議招待状_20260402090250.pdf";
    const uploadRes = await sendDriveProcessUpload(driveEmailWithJapaneseConferenceInvitationPDF);
    expect(uploadRes).to.have.status(200);
    expect(uploadRes.body.data.filesSucceeded).to.equal(1);

    const gmailSanitizedHtml = uploadRes.body.sentEmail.html;
    const uploadFileDataId = extractEmbeddedFileDataId(uploadRes.body.sentEmail.html);
    const uploadFileDataDoc = await db.collection("DriveFileData").doc(uploadFileDataId).get();
    expect(uploadFileDataDoc.exists).to.equal(true);
    const uploadedFiles = uploadFileDataDoc.data()?.files as Array<{filename: string}>;
    expect(uploadedFiles).to.have.length.greaterThan(0);

    // Confirm the fixture itself uses a Japanese filename even if upload-time naming rewrites it.
    expect(driveEmailWithJapaneseConferenceInvitationPDF.attachmentsList?.[0].filename).to.equal(japaneseSourceFilename);
    expect(driveEmailWithJapaneseConferenceInvitationPDF.webhook.data.attachments[0].filename).to.equal(japaneseSourceFilename);

    const preReplyFilename = uploadedFiles[0].filename;
    const replyEmailId = "test-drive-reply-rename";
    const replyMessageId = `<test-drive-reply-rename-${Date.now()}@mail.gmail.com>`;
    const renameInstructions = "Rename the file in English";
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
      html: `<p>${renameInstructions}</p><blockquote>${gmailSanitizedHtml}</blockquote>`,
      text: renameInstructions,
      headers: {
        "authentication-results": `amazonses.com; spf=pass (spfCheck: domain of _spf.${domain} designates 209.85.214.171 as permitted sender) client-ip=209.85.214.171; envelope-from=${TESTER_PRIMARY_GOOGLE_ACCT}; helo=mail.${domain}; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain};`,
        "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
        "to": DRIVE_EMAIL_ADDRESS,
        "subject": "Re: Fwd: Conference Registration",
        "date": new Date().toUTCString(),
        "message-id": replyMessageId,
        "in-reply-to": driveEmailWithJapaneseConferenceInvitationPDF.emailContent.headers["message-id"],
        "references": driveEmailWithJapaneseConferenceInvitationPDF.emailContent.headers["message-id"],
      },
    };

    const webhookWithMock = {
      ...replyWebhook,
      mockData: {
        emailContent: replyEmailContent,
        attachmentsList: [] as AttachmentWithUrl[],
      },
    };

    const callbackResponse = await chaiWithHttp.request(apiURL)
      .post(DRIVE_CALLBACK_ENDPOINT)
      .set("Content-Type", "application/json")
      .set("svix-id", "msg_test_" + Date.now())
      .set("svix-timestamp", Math.floor(Date.now() / 1000).toString())
      .set("svix-signature", "v1,dummy_signature_for_testing")
      .send(webhookWithMock);
    const webhookData = callbackResponse.body.webhookData;

    const res = await chaiWithHttp
      .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
      .post("/v2testDriveInboundDispatch")
      .set("Content-Type", "application/json")
      .send({data: webhookData}) as unknown as DriveDispatchResponse;

    expect(res).to.have.status(200);
    expect(res.body.data.filesSucceeded).to.be.greaterThanOrEqual(1);
    expect(res.body.sentEmail.html).to.include("has been moved");
    expect(res.body.sentEmail.html).to.include("fwd2drive.com/d?r=");

    const fileDataId = extractEmbeddedFileDataId(res.body.sentEmail.html);
    const fileDataDoc = await db.collection("DriveFileData").doc(fileDataId).get();
    expect(fileDataDoc.exists).to.equal(true);
    const storedFiles = fileDataDoc.data()?.files as Array<{filename: string}>;
    expect(storedFiles[0].filename).to.include("Japanese Conference");
    expect(storedFiles[0].filename).to.match(/\.pdf$/);
    console.log("RENAMED FILE:", storedFiles[0].filename);
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
