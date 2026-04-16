/* eslint-disable max-len */
import chai from "chai";
import chaiHttp from "chai-http";
import {exec} from "child_process";
import * as fs from "fs";
import * as path from "path";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";
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
  DEFAULT_FOLDER_CONVENTION,
  detectFolderConvention,
  mergeRevisedProposal,
  normalizeFolderPrefixes,
  proposeFilePlacement,
  renumberFoldersContiguously,
  renderFolderTreePlainText,
} from "../src/agents/drive/llm";
import {
  DriveFileEntry,
  DriveOrganizeProposal,
  FolderOperation,
  MoveInstructionSchema,
  OrganizeProposalDoc,
} from "../src/agents/drive/types";
import {defaultCompletion, setOpenAIClientForTest} from "../src/util/openai";
import {
  finalizeOrganizeProposal,
  getOrganizeProposal,
  getResumableOrganizeProposals,
  getOrganizePhaseData,
  getDriveUserPreferences,
  saveOrganizeProposal,
} from "../src/util/firestoreHandler";
import {getLastSentEmail, clearMockData} from "../src/util/resendMock";
import {organizeProposalTestHooks} from "../src/agents/drive/handlers/organizeProposal";
import {handleSetPreferences} from "../src/agents/drive/handlers/setPreferencesHandler";
import {persistMovePreferenceUpdates} from "../src/agents/drive/handlers/moveHandler";
import {buildSequentialExecutionProposal} from "../src/agents/drive/handlers/organizeExecution";
import {TransformedEmail} from "../src/util/types";
import {getSkills} from "../src/agents/drive/skills";
import {fastMatchSkill} from "../src/util/skills/matcher";


chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5002";
const DRIVE_CALLBACK_ENDPOINT = "/drive/v2/inboundCallback";
const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT || "";
const DRIVE_EMAIL_ADDRESS = process.env.DRIVE_EMAIL_ADDRESS || "drive@fwd2drive.com";
const DISPATCH_URL = "http://127.0.0.1:5001";
const DISPATCH_REGION = "us-central1";
const APP_ID = process.env.GCLOUD_PROJECT || "fwd2cal-dev-2578e";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
initializeApp({projectId: APP_ID, storageBucket: `${APP_ID}.appspot.com`});
const testApp = initializeApp({projectId: APP_ID, storageBucket: `${APP_ID}.appspot.com`}, "drive-test");
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

function makeTestEmail(text: string): TransformedEmail {
  return {
    from: "Tester <tester@example.com>",
    to: ["drive@fwd2drive.com"],
    subject: "Re: Organize my Drive",
    text,
    html: text,
    headers: {
      "message-id": `<email-${Date.now()}@example.com>`,
      "references": "<original@example.com>",
    },
    SPF: "pass",
    dkim: "pass",
  };
}

function setFakeStructuredCompletions(results: unknown[]): void {
  const queue = [...results];
  const fakeClient = {
    chat: {
      completions: {
        create: async () => {
          const result = queue.shift();
          if (!result) {
            throw new Error("No fake LLM completion queued");
          }
          return {
            choices: [{
              message: {
                content: JSON.stringify(result),
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

    renumberFoldersContiguously(proposal, undefined, "NN-Category");

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

    renumberFoldersContiguously(proposal, undefined, "NN-Category");

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

    renumberFoldersContiguously(proposal, undefined, "NN-Category");

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

    renumberFoldersContiguously(proposal, undefined, "NN-Category");

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

    renumberFoldersContiguously(proposal, undefined, "NN-Category");

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

    renumberFoldersContiguously(proposal, undefined, "NN-Category");

    expect(proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal(["01-Projects"]);
    expect(proposal.file_actions.find((action) => action.file_id === "1")?.new_folder)
        .to.equal("01-Projects");
    expect(proposal.file_actions.find((action) => action.file_id === "2")?.new_folder)
        .to.equal("99-Unknown");
  });

  it("DT00r7 skips renumbering when convention has no numeric prefix", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2"],
        {"1": "Acme-Contracts", "2": "BigCo-Invoices"},
        ["Acme-Contracts", "BigCo-Invoices"],
    );
    const beforeFolders = proposal.proposed_folders.map((folder) => folder.folder_path);

    renumberFoldersContiguously(proposal, undefined, "ClientName-Project");

    expect(proposal.proposed_folders.map((folder) => folder.folder_path)).to.deep.equal(beforeFolders);
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

  it("DT00t2 accepts optional convention updates at the top level", function() {
    const result = MoveInstructionSchema.parse({
      folder_convention_update: "ClientName-Project",
      filename_convention_update: "YYYY-MM-DD Title.ext",
      moves: [],
    });

    expect(result.folder_convention_update).to.equal("ClientName-Project");
    expect(result.filename_convention_update).to.equal("YYYY-MM-DD Title.ext");
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

describe("proposeFilePlacement", function() {
  afterEach(function() {
    setOpenAIClientForTest(null);
  });

  it("DT00ta2 includes the saved filename convention in the user message", async function() {
    let capturedRequest: OpenAI.ChatCompletionCreateParams | null = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (request: OpenAI.ChatCompletionCreateParams) => {
            capturedRequest = request;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    folder_name: "01-Invoices",
                    is_existing_folder: true,
                    proposals: [{
                      file_index: 0,
                      suggested_name: "2024-03-15_invoice.pdf",
                      reason: "Follows the saved convention",
                    }],
                  }),
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

    await proposeFilePlacement(
        [{
          fileName: "invoice.pdf",
          mimeType: "application/pdf",
          fileSize: 1234,
          contentSummary: "Invoice dated March 15, 2024",
        }],
        "Invoice",
        "",
        ["01-Invoices"],
        "02",
        "test-uid",
        [],
        "YYYY-MM-DD_desc.ext",
        "ClientName-Project",
    );

    const userContent = capturedRequest?.messages[1]?.content;
    expect(userContent).to.be.a("string");
    expect(userContent).to.include("## Folder Convention");
    expect(userContent).to.include("Use this exact pattern for folder_name and folder paths: ClientName-Project");
    expect(userContent).to.include("## Filename Convention");
    expect(userContent).to.include("Use this exact pattern for suggested_name: YYYY-MM-DD_desc.ext");
  });

  it("DT00ta3 can inject the default folder convention fallback", async function() {
    let capturedRequest: OpenAI.ChatCompletionCreateParams | null = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (request: OpenAI.ChatCompletionCreateParams) => {
            capturedRequest = request;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    folder_name: "01-Invoices",
                    is_existing_folder: false,
                    proposals: [{
                      file_index: 0,
                      suggested_name: "invoice.pdf",
                      reason: "Fallback",
                    }],
                  }),
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

    await proposeFilePlacement(
        [{
          fileName: "invoice.pdf",
          mimeType: "application/pdf",
          fileSize: 1234,
          contentSummary: "Invoice",
        }],
        "Invoice",
        "",
        [],
        "01",
        "test-uid",
        [],
        undefined,
        DEFAULT_FOLDER_CONVENTION,
    );

    const userContent = capturedRequest?.messages[1]?.content;
    expect(userContent).to.be.a("string");
    expect(userContent).to.include(`Use this exact pattern for folder_name and folder paths: ${DEFAULT_FOLDER_CONVENTION}`);
  });
});

describe("detectFolderConvention", function() {
  afterEach(function() {
    setOpenAIClientForTest(null);
  });

  it("DT00dfc1 detects NNN-Category from 3-digit zero-padded folders", async function() {
    this.timeout(60000);
    setOpenAIClientForTest(null);
    const treeSummary = `My Drive/ (15 files at root)
  001-Personal/ (1 file)
  002-Work/ (1 file)
`;
    const result = await detectFolderConvention(treeSummary, null);
    expect(result.has_convention).to.equal(true);
    expect(result.detected_convention).to.match(/NNN-Category/);
  });

  it("DT00dfc2 detects NN-Category from 2-digit zero-padded folders", async function() {
    this.timeout(60000);
    setOpenAIClientForTest(null);
    const treeSummary = `My Drive/
  01-Finance/
  02-Work/
  03-Personal/
`;
    const result = await detectFolderConvention(treeSummary, null);
    expect(result.has_convention).to.equal(true);
    expect(result.detected_convention).to.match(/NN-Category/);
  });

  it("DT00dfc3 trusts observed folders over a mismatched fallback preference", async function() {
    this.timeout(60000);
    setOpenAIClientForTest(null);
    const treeSummary = `My Drive/
  001-Personal/
  002-Work/
`;
    const result = await detectFolderConvention(treeSummary, null, "N-Category");
    expect(result.has_convention).to.equal(true);
    expect(result.detected_convention).to.match(/NNN-Category/);
  });

  it("DT00dfc5 detects a numeric convention when mixed with unprefixed folders", async function() {
    this.timeout(60000);
    setOpenAIClientForTest(null);
    const treeSummary = `My Drive/ (5 files at root)
  001-Hobbies/
  002-Clients/
  003-Household/
  01-Archive/
  02-Legacy/
  Bitaccess/
  Contracts/
  Miscellaneous/
  Old Stuff/
  Personal/
`;
    const result = await detectFolderConvention(treeSummary, null, "NN-Category");
    expect(result.has_convention).to.equal(true);
    expect(result.detected_convention).to.match(/N{1,4}-Category/);
    expect(result.convention_description).to.be.a("string");
    expect(result.convention_description.length).to.be.greaterThan(10);
  });

  it("DT00dfc4 detects NNN-Category on a deeply nested realistic tree", async function() {
    this.timeout(60000);
    setOpenAIClientForTest(null);
    const treeSummary = `My Drive/ (8 files at root)
  001-Hobbies/ (2 files)
    Gardening/
    Photography/
      Trips/
        Iceland/
        Kyoto/
    Reading/
  002-Clients/ (3 files)
    Alpha Corp/
      Contracts/
      Invoices/
      Meetings/
    Beta LLC/
      Proposals/
      Statements/
  003-Household/ (1 files)
    Bills/
      Electric/
      Internet/
    Maintenance/
`;
    const result = await detectFolderConvention(treeSummary, null);
    expect(result.has_convention).to.equal(true);
    expect(result.detected_convention).to.match(/NNN-Category/);
  });
});

describe("set-preferences", function() {
  afterEach(function() {
    setOpenAIClientForTest(null);
    clearMockData();
  });

  it("DT00tp1 matches the set-preferences skill from the email body", function() {
    const match = fastMatchSkill(
        "question",
        "Please update my folder convention and filename convention",
        getSkills(),
    );

    expect(match?.skillId).to.equal("set-preferences");
  });

  it("DT00tp2 persists folder and filename conventions and sends a before-after block", async function() {
    const sender = `prefs-${Date.now()}@example.com`;
    const uid = `prefs-uid-${Date.now()}`;
    await db.collection("EmailAddress").doc(sender).set({uid, email: sender, default: true});
    await db.collection("DriveUsers").doc(uid).set({
      email: sender,
      preferences: {
        folderConvention: "Old folders",
        filenameConvention: "Old files.ext",
      },
    });
    setFakeStructuredCompletions([{
      folderConvention: "ClientName-Project",
      filenameConvention: "YYYY-MM-DD Title.ext",
      summary: "Updated both conventions.",
    }]);

    await handleSetPreferences({
      ...makeTestEmail("Use ClientName-Project for folders and YYYY-MM-DD Title.ext for files"),
      from: sender,
      subject: "set my preferences",
    }, "prefs-email-id");

    const prefs = await getDriveUserPreferences(uid);
    const sent = getLastSentEmail(sender);
    expect(prefs.folderConvention).to.equal("ClientName-Project");
    expect(prefs.filenameConvention).to.equal("YYYY-MM-DD Title.ext");
    expect(sent?.html).to.include("Preferences updated");
    expect(sent?.html).to.include("Old folders");
    expect(sent?.html).to.include("ClientName-Project");
    expect(sent?.html).to.include("Old files.ext");
    expect(sent?.html).to.include("YYYY-MM-DD Title.ext");
  });

  it("DT00tp3 leaves unspecified conventions unchanged", async function() {
    const sender = `prefs-partial-${Date.now()}@example.com`;
    const uid = `prefs-partial-uid-${Date.now()}`;
    await db.collection("EmailAddress").doc(sender).set({uid, email: sender, default: true});
    await db.collection("DriveUsers").doc(uid).set({
      email: sender,
      preferences: {
        folderConvention: "ClientName-Project",
        filenameConvention: "YYYY.MM.DD - Description.ext",
      },
    });
    setFakeStructuredCompletions([{
      filenameConvention: "YYYY-MM-DD Title.ext",
      summary: "Updated filename convention.",
    }]);

    await handleSetPreferences({
      ...makeTestEmail("From now on use YYYY-MM-DD Title.ext for filenames"),
      from: sender,
      subject: "filename convention",
    }, "prefs-partial-email-id");

    const prefs = await getDriveUserPreferences(uid);
    expect(prefs.folderConvention).to.equal("ClientName-Project");
    expect(prefs.filenameConvention).to.equal("YYYY-MM-DD Title.ext");
    expect(getLastSentEmail(sender)?.html).to.include("ClientName-Project");
  });

  it("DT00tp4 persists convention updates returned by move instructions", async function() {
    const uid = `prefs-move-uid-${Date.now()}`;
    await db.collection("DriveUsers").doc(uid).set({
      preferences: {
        folderConvention: "Old folders",
        filenameConvention: "Old files.ext",
      },
    });

    const result = await persistMovePreferenceUpdates(uid, {
      moves: [],
      folder_convention_update: "ClientName-Project",
      filename_convention_update: "YYYY-MM-DD Title.ext",
    });

    const prefs = await getDriveUserPreferences(uid);
    expect(prefs.folderConvention).to.equal("ClientName-Project");
    expect(prefs.filenameConvention).to.equal("YYYY-MM-DD Title.ext");
    expect(result.preferencesUpdatedBlock).to.include("Preferences updated");
    expect(result.preferencesUpdatedBlock).to.include("Old folders");
    expect(result.preferencesUpdatedBlock).to.include("ClientName-Project");
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

describe("organize proposal persistence", function() {
  const emptyProposal: DriveOrganizeProposal = {
    proposed_folders: [],
    file_actions: [],
    summary: "No changes",
  };
  const emptyCost = {
    totalFiles: 0,
    filesToMove: 0,
    filesToRename: 0,
    filesToKeep: 0,
    textFiles: 0,
    imageFiles: 0,
    costPerTextFile: 0,
    costPerImageFile: 0,
    totalCost: 0,
  };

  it("DT00ub saves organize proposals without MIME lookup data", async function() {
    const proposalId = await saveOrganizeProposal({
      uid: "mime-save-uid",
      senderEmail: "mime-save@example.com",
      emailId: `mime-save-${Date.now()}`,
      status: "pending",
      createdAt: "2026-04-15T00:00:00.000Z",
      expiresAt: "2099-04-15T00:00:00.000Z",
      proposal: emptyProposal,
      cost: emptyCost,
    });

    const doc = await db.collection("OrganizeProposals").doc(proposalId).get();
    const hydrated = await getOrganizeProposal(proposalId);

    expect(doc.data()).to.not.have.property("mimeMap");
    expect(hydrated).to.not.have.property("mimeMap");
  });

  it("DT00uc finalizes organize proposals without MIME lookup data", async function() {
    const proposalId = await saveOrganizeProposal({
      uid: "mime-finalize-uid",
      senderEmail: "mime-finalize@example.com",
      emailId: `mime-finalize-${Date.now()}`,
      status: "pending",
      createdAt: "2026-04-15T00:00:00.000Z",
      expiresAt: "2099-04-15T00:00:00.000Z",
      proposal: emptyProposal,
      cost: emptyCost,
    });

    await finalizeOrganizeProposal(
        proposalId,
        emptyProposal as unknown as Record<string, unknown>,
        emptyCost as unknown as Record<string, unknown>,
    );

    const hydrated = await getOrganizeProposal(proposalId);
    expect(hydrated).to.not.have.property("mimeMap");
  });
});

describe("organize phased proposal flow", function() {
  const sender = "tester@example.com";
  const uid = "phase-test-uid";

  afterEach(function() {
    setOpenAIClientForTest(null);
    clearMockData();
  });

  async function seedPhaseProposal(
      proposalId: string,
      proposalDoc: OrganizeProposalDoc,
  ): Promise<void> {
    const storagePath = `organize-proposals/${proposalId}.json`;
    await db.collection("OrganizeProposals").doc(proposalId).set({
      uid: proposalDoc.uid,
      senderEmail: proposalDoc.senderEmail,
      emailId: proposalDoc.emailId,
      status: proposalDoc.status,
      phase: proposalDoc.phase,
      createdAt: proposalDoc.createdAt,
      expiresAt: proposalDoc.expiresAt,
      storagePath,
    });
    const intermediateState = {
      driveStructureSummary:
        proposalDoc.phaseData?.directoryLayout?.currentTreeSummary ||
        "My Drive/\n  Inbox/ (2 files)\n",
      fileEntries: [] as unknown[],
      senderEmail: proposalDoc.senderEmail,
      phaseData: proposalDoc.phaseData,
    };
    const bucket = getStorage().bucket();
    await bucket.file(storagePath).save(
        JSON.stringify(intermediateState),
        {contentType: "application/json"},
    );
  }

  function makePhaseDoc(phase: OrganizeProposalDoc["phase"]): OrganizeProposalDoc {
    return {
      uid,
      senderEmail: sender,
      emailId: "phase-email-id",
      status: "pending",
      phase,
      createdAt: "2026-04-13T00:00:00.000Z",
      expiresAt: "2099-04-13T00:00:00.000Z",
      storagePath: "unused",
      phaseData: {
        folderPreferences: {
          detectedConvention: "",
          suggestedConvention: "NN-Category root folders like 01-Documents",
          topLevelFolderNames: ["Inbox", "Work", "Receipts", "Travel"],
        },
        directoryLayout: {
          currentTreeSummary: "My Drive/\n  Inbox/ (2 files)\n",
          userPrompt: "organize my drive",
          conventionDescription: "Loose topical folders",
          proposedStructure: [
            {folder_path: "01-Documents", description: "Documents"},
          ],
          directoryMoves: [
            {current_path: "Inbox", proposed_path: "01-Documents/Inbox", reason: "Nest inbox docs"},
          ],
          approvedStructure: [
            {folder_path: "01-Documents", description: "Documents"},
          ],
        },
        filenameConvention: {
          convention: "YYYY.MM.DD - Description.ext",
        },
      },
    };
  }

  it("DT00ub0 routes folder_preferences approval to directory_analysis", async function() {
    const proposalId = `phase-0-${Date.now()}`;
    const proposalDoc = makePhaseDoc("folder_preferences");
    await seedPhaseProposal(proposalId, proposalDoc);
    setFakeStructuredCompletions([{
      has_existing_convention: false,
      convention_description: "NN-Category root folders",
      proposed_structure: [{
        folder_path: "01-Documents",
        description: "Documents",
        source: "proposed",
      }],
      summary: "Use numbered root folders.",
    }]);

    await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("approve"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "approve",
        true,
    );

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    const userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(stored?.phase).to.equal("directory_analysis");
    expect(stored?.phaseData.folderPreferences.confirmedConvention)
        .to.equal("NN-Category root folders like 01-Documents");
    expect(stored?.phaseData.directoryLayout.folderConvention)
        .to.equal("NN-Category root folders like 01-Documents");
    expect(userDoc?.preferences.folderConvention)
        .to.equal("NN-Category root folders like 01-Documents");
    expect(getLastSentEmail(sender)?.html).to.include("first pass");
  });

  it("DT00ub1 treats a folder_preferences revision as the confirmed convention", async function() {
    const proposalId = `phase-0-revision-${Date.now()}`;
    const proposalDoc = makePhaseDoc("folder_preferences");
    await seedPhaseProposal(proposalId, proposalDoc);
    setFakeStructuredCompletions([
      {
        is_change: true,
        new_convention: "Client - Project folder names",
      },
      {
        has_existing_convention: true,
        convention_description: "Client - Project folders",
        proposed_structure: [{
          folder_path: "Acme - Contracts",
          description: "Client contract documents",
          source: "proposed",
        }],
        summary: "Use client-project folder names.",
      },
    ]);

    await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("Use Client - Project folder names"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "Use Client - Project folder names",
        false,
    );

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    const userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(stored?.phase).to.equal("directory_analysis");
    expect(stored?.phaseData.folderPreferences.confirmedConvention)
        .to.equal("Client - Project folder names");
    expect(stored?.phaseData.directoryLayout.folderConvention)
        .to.equal("Client - Project folder names");
    expect(userDoc?.preferences.folderConvention)
        .to.equal("Client - Project folder names");
  });

  it("DT00uba routes directory_analysis approval directly to filename_convention", async function() {
    const proposalId = `phase-1a-${Date.now()}`;
    const proposalDoc = makePhaseDoc("directory_analysis");
    await seedPhaseProposal(proposalId, proposalDoc);
    setFakeStructuredCompletions([
      {
        directory_moves: [{
          current_path: "Inbox",
          proposed_path: "01-Documents/Inbox",
          reason: "Keep loose files under Documents",
        }],
        no_changes_needed: false,
        summary: "Move Inbox under Documents.",
      },
      {
        final_directories: [
          {folder_path: "01-Documents", description: "Documents"},
          {folder_path: "01-Documents/Inbox", description: "Imported inbox documents"},
        ],
        added_directories: ["01-Documents/Inbox"],
        summary: "Finalized folder map.",
      },
    ]);

    await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("approve"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "approve",
        true,
    );

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(stored?.phase).to.equal("filename_convention");
    expect(stored?.phaseData.directoryLayout.directoryMoves).to.deep.equal([{
      current_path: "Inbox",
      proposed_path: "01-Documents/Inbox",
      reason: "Keep loose files under Documents",
    }]);
    expect(stored?.phaseData.directoryLayout.approvedStructure).to.deep.equal([
      {folder_path: "01-Documents", description: "Documents"},
      {folder_path: "01-Documents/Inbox", description: "Imported inbox documents"},
    ]);
    expect(stored?.phaseData.directoryLayout.addedDirectories).to.deep.equal(["01-Documents/Inbox"]);
    expect(stored?.phaseData.filenameConvention.convention).to.equal("YYYY.MM.DD - Description.ext");
    expect(getLastSentEmail(sender)?.html).to.include("filename convention");
  });

  it("DT00ubb routes in-flight directory_placement replies to filename_convention", async function() {
    const proposalId = `phase-1b-${Date.now()}`;
    const proposalDoc = makePhaseDoc("directory_placement");
    await seedPhaseProposal(proposalId, proposalDoc);

    await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("put Work under the Work root"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "put Work under the Work root",
        false,
    );

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(stored?.phase).to.equal("filename_convention");
    expect(stored?.phaseData.directoryLayout.approvedStructure).to.deep.equal([
      {folder_path: "01-Documents", description: "Documents"},
    ]);
    expect(getLastSentEmail(sender)?.html).to.include("filename convention");
  });

  it("DT00ubc routes in-flight directory_additions replies to filename_convention", async function() {
    const proposalId = `phase-1c-${Date.now()}`;
    const proposalDoc = makePhaseDoc("directory_additions");
    await seedPhaseProposal(proposalId, proposalDoc);

    await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("approve"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "approve",
        true,
    );

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(stored?.phase).to.equal("filename_convention");
    expect(stored?.phaseData.filenameConvention.convention).to.equal("YYYY.MM.DD - Description.ext");
    expect(stored?.phaseData.directoryLayout.approvedStructure).to.deep.equal([
      {folder_path: "01-Documents", description: "Documents"},
    ]);
    expect(getLastSentEmail(sender)?.html).to.include("filename convention");
  });

  it("DT00ubd routes filename convention revision and stays in that phase", async function() {
    const proposalId = `phase-2-${Date.now()}`;
    const proposalDoc = makePhaseDoc("filename_convention");
    await seedPhaseProposal(proposalId, proposalDoc);
    setFakeStructuredCompletions([{
      is_change: true,
      new_convention: "YYYY-MM-DD_description.ext",
    }]);

    await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("use underscores instead"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "use underscores instead",
        false,
    );

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(stored?.phase).to.equal("filename_convention");
    expect(stored?.phaseData.filenameConvention.convention).to.equal("YYYY-MM-DD_description.ext");
    expect(getLastSentEmail(sender)?.html).to.include("YYYY-MM-DD_description.ext");
  });

  it("DT00ube routes cost_estimate filename revisions back to filename_convention", async function() {
    const proposalId = `phase-cost-${Date.now()}`;
    const proposalDoc = makePhaseDoc("cost_estimate");
    await seedPhaseProposal(proposalId, proposalDoc);

    const result = await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("change the filename convention"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "change the filename convention",
        false,
    );

    expect(result?.proposalSent).to.equal(false);
    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(stored?.phase).to.equal("filename_convention");
  });

  it("DT00ubeA routes cost_estimate folder revisions back to directory_analysis", async function() {
    const proposalId = `phase-cost-folders-${Date.now()}`;
    const proposalDoc = makePhaseDoc("cost_estimate");
    await seedPhaseProposal(proposalId, proposalDoc);

    const result = await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("change the folders"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "change the folders",
        false,
    );

    expect(result?.proposalSent).to.equal(false);
    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    expect(stored?.phase).to.equal("directory_analysis");
    expect(getLastSentEmail(sender)?.html).to.include("revised folder structure");
  });

});

describe("organize sequential execution proposal builder", function() {
  it("DT00ubf carries a new directory from file N into file N+1 prompt context", async function() {
    const files: DriveFileEntry[] = [
      {
        id: "file-1",
        name: "ticket.pdf",
        mimeType: "application/pdf",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-04-01T00:00:00.000Z",
        size: 100,
        webViewLink: "",
        isFolder: false,
      },
      {
        id: "file-2",
        name: "boarding-pass.pdf",
        mimeType: "application/pdf",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-04-02T00:00:00.000Z",
        size: 100,
        webViewLink: "",
        isFolder: false,
      },
    ];
    const treeSnapshots: string[][] = [];

    const proposal = await buildSequentialExecutionProposal(
        files,
        [{folder_path: "01-Documents", description: "Documents"}],
        "YYYY.MM.DD - Description.ext",
        "uid-phase3",
        async () => "",
        async (directoryTree, _convention, file) => {
          treeSnapshots.push(directoryTree.map((folder) => folder.folder_path));
          if (file.id === "file-1") {
            return {
              file_id: file.id,
              current_name: file.name,
              current_path: file.parentPath,
              new_name: "2026.04.01 - Ticket.pdf",
              target_directory: "02-Travel",
              action: "move_and_rename",
              needs_new_directory: true,
              new_directory: {
                folder_path: "02-Travel",
                description: "Travel documents",
              },
              reason: "Travel ticket",
            };
          }
          return {
            file_id: file.id,
            current_name: file.name,
            current_path: file.parentPath,
            new_name: "2026.04.02 - Boarding Pass.pdf",
            target_directory: "02-Travel",
            action: "move_and_rename",
            needs_new_directory: false,
            new_directory: null,
            reason: "Related travel document",
          };
        },
    );

    expect(treeSnapshots[0]).to.deep.equal(["01-Documents"]);
    expect(treeSnapshots[1]).to.deep.equal(["01-Documents", "02-Travel"]);
    expect(proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal(["01-Documents", "02-Travel"]);
    expect(proposal.file_actions.map((action) => action.new_folder))
        .to.deep.equal(["02-Travel", "02-Travel"]);
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
