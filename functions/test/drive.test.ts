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
import {google} from "googleapis";
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
  normalizeFolderConventionSeparators,
  normalizeFolderPrefixes,
  proposeFileAction,
  proposeFilePlacement,
  renumberFoldersContiguously,
  renderFolderTreePlainText,
} from "../src/agents/drive/llm";
import * as driveLlm from "../src/agents/drive/llm";
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
  storeUser,
  updateUserTokens,
} from "../src/util/firestoreHandler";
import {getLastSentEmail, clearMockData} from "../src/util/resendMock";
import {organizeProposalTestHooks} from "../src/agents/drive/handlers/organizeProposal";
import {handleSetPreferences} from "../src/agents/drive/handlers/setPreferencesHandler";
import {persistMovePreferenceUpdates} from "../src/agents/drive/handlers/moveHandler";
import {
  applyPlanPatches,
  buildSequentialExecutionProposal,
  loadSavedPlan,
  processMoveChunk,
  processPlanningChunk,
  writeFileActionsCsv,
} from "../src/agents/drive/handlers/organizeExecution";
import {
  dispatchHandlerTestHooks,
  dispatchPlanningChunkTask,
} from "../src/agents/drive/handlers/dispatchHandler";
import {TransformedEmail} from "../src/util/types";
import type {FirebaseUserRecord, OAuthTokens} from "../src/auth/types";
import * as authHandler from "../src/auth/authHandler";
import * as driveHelper from "../src/agents/drive/driveHelper";
import * as firestoreHandler from "../src/util/firestoreHandler";
import * as organizeHelpers from "../src/agents/drive/handlers/organizeHelpers";
import * as organizeMain from "../src/agents/drive/handlers/organizeMain";
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

  it("DT00r8 preserves the separator from numeric folder convention tokens", function() {
    const proposal = makeOrganizeProposal(
        ["1", "2", "3"],
        {
          "1": "05|Projects",
          "2": "06|Personal",
          "3": "12|Important",
        },
        ["05|Projects", "06|Personal", "12|Important"],
    );

    renumberFoldersContiguously(proposal, undefined, "NN|Category");

    expect(proposal.proposed_folders.map((folder) => folder.folder_path))
        .to.deep.equal(["01|Projects", "02|Personal", "03|Important"]);
    expect(proposal.file_actions.map((action) => action.new_folder))
        .to.deep.equal(["01|Projects", "02|Personal", "03|Important"]);
  });
});

describe("normalizeFolderConventionSeparators", function() {
  it("DT00s1 rewrites drifted root separators to match the convention token", function() {
    const folders = normalizeFolderConventionSeparators([
      {folder_path: "01-Personal", description: "Personal"},
      {folder_path: "02-Work/Nested", description: "Nested"},
      {folder_path: "Archive", description: "Archive"},
    ], "NN|Category");

    expect(folders).to.deep.equal([
      {folder_path: "01|Personal", description: "Personal"},
      {folder_path: "02|Work/Nested", description: "Nested"},
      {folder_path: "Archive", description: "Archive"},
    ]);
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

describe("Drive token scope drift", function() {
  afterEach(function() {
    clearMockData();
  });

  it("DT00ts1 storeUser overwrites a broader stored scope during re-consent", async function() {
    const uid = `scope-store-${Date.now()}`;
    const user: FirebaseUserRecord = {
      uid,
      email: `${uid}@example.com`,
    };
    await db.collection("DriveUsers").doc(uid).set({
      email: user.email,
      access_token: "old-access",
      refresh_token: "old-refresh",
      expiry_date: 1,
      token_scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email",
    });

    const tokens: OAuthTokens = {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expiry_date: 2,
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
    };

    await storeUser(tokens, user, "DriveUsers");

    const userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(userDoc?.token_scope)
        .to.equal("https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email");
  });

  it("DT00ts2 updateUserTokens writes refresh scopes when present and preserves them when absent", async function() {
    const uid = `scope-refresh-${Date.now()}`;
    await db.collection("DriveUsers").doc(uid).set({
      email: `${uid}@example.com`,
      access_token: "old-access",
      refresh_token: "old-refresh",
      expiry_date: 1,
      token_scope: "https://www.googleapis.com/auth/drive",
    });

    await updateUserTokens({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expiry_date: 2,
      scope: "https://www.googleapis.com/auth/drive.file",
    }, uid, "DriveUsers");

    let userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(userDoc?.token_scope).to.equal("https://www.googleapis.com/auth/drive.file");

    await updateUserTokens({
      access_token: "newer-access",
      refresh_token: "newer-refresh",
      expiry_date: 3,
    }, uid, "DriveUsers");

    userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(userDoc?.token_scope).to.equal("https://www.googleapis.com/auth/drive.file");
  });

  it("DT00ts3 scanAndPropose downgrades stale full-drive state and sends the upgrade email", async function() {
    const originalGetOauthClient = authHandler.getOauthClient;
    const originalListAllDriveFiles = driveHelper.listAllDriveFiles;
    const originalUpdateDriveUserTokenScope = firestoreHandler.updateDriveUserTokenScope;
    const originalSendOrganizeScopeUpgradeEmail = organizeMain.sendOrganizeScopeUpgradeEmail;
    const originalSendOrganizeAuthRequiredEmail = organizeMain.sendOrganizeAuthRequiredEmail;
    const originalSendOrganizeEmailResponse = organizeHelpers.sendOrganizeEmailResponse;

    let updatedScope: {uid: string; scope: string} | null = null;
    let upgradeCalls = 0;
    let authRequiredCalls = 0;
    let listCalls = 0;

    const fakeOauthClient = {
      credentials: {
        access_token: "stale-access-token",
      },
      getAccessToken: async () => ({token: "fresh-access-token"}),
      getTokenInfo: async (_accessToken: string) => ({
        scopes: ["https://www.googleapis.com/auth/drive.file"],
      }),
    };

    (authHandler as typeof authHandler & {
      getOauthClient: typeof authHandler.getOauthClient;
    }).getOauthClient = async () => fakeOauthClient as never;
    (driveHelper as typeof driveHelper & {
      listAllDriveFiles: typeof driveHelper.listAllDriveFiles;
    }).listAllDriveFiles = async () => {
      listCalls++;
      return [];
    };
    (firestoreHandler as typeof firestoreHandler & {
      updateDriveUserTokenScope: typeof firestoreHandler.updateDriveUserTokenScope;
    }).updateDriveUserTokenScope = async (uid: string, scope: string) => {
      updatedScope = {uid, scope};
    };
    (organizeMain as typeof organizeMain & {
      sendOrganizeScopeUpgradeEmail: typeof organizeMain.sendOrganizeScopeUpgradeEmail;
      sendOrganizeAuthRequiredEmail: typeof organizeMain.sendOrganizeAuthRequiredEmail;
    }).sendOrganizeScopeUpgradeEmail = async () => {
      upgradeCalls++;
      return organizeHelpers.emptyResult("scope-upgrade");
    };
    (organizeMain as typeof organizeMain & {
      sendOrganizeScopeUpgradeEmail: typeof organizeMain.sendOrganizeScopeUpgradeEmail;
      sendOrganizeAuthRequiredEmail: typeof organizeMain.sendOrganizeAuthRequiredEmail;
    }).sendOrganizeAuthRequiredEmail = async () => {
      authRequiredCalls++;
      return organizeHelpers.emptyResult("auth-required");
    };
    (organizeHelpers as typeof organizeHelpers & {
      sendOrganizeEmailResponse: typeof organizeHelpers.sendOrganizeEmailResponse;
    }).sendOrganizeEmailResponse = async () => undefined;

    try {
      const result = await organizeMain.scanAndPropose(
          makeTestEmail("organize my drive"),
          "tester@example.com",
          "scope-email-id",
          "scope-user-id",
      );

      expect(result).to.deep.equal(organizeHelpers.emptyResult());
      expect(updatedScope).to.deep.equal({
        uid: "scope-user-id",
        scope: "https://www.googleapis.com/auth/drive.file",
      });
      expect(authRequiredCalls).to.equal(0);
      expect(listCalls).to.equal(0);
    } finally {
      (authHandler as typeof authHandler & {
        getOauthClient: typeof authHandler.getOauthClient;
      }).getOauthClient = originalGetOauthClient;
      (driveHelper as typeof driveHelper & {
        listAllDriveFiles: typeof driveHelper.listAllDriveFiles;
      }).listAllDriveFiles = originalListAllDriveFiles;
      (firestoreHandler as typeof firestoreHandler & {
        updateDriveUserTokenScope: typeof firestoreHandler.updateDriveUserTokenScope;
      }).updateDriveUserTokenScope = originalUpdateDriveUserTokenScope;
      (organizeMain as typeof organizeMain & {
        sendOrganizeScopeUpgradeEmail: typeof organizeMain.sendOrganizeScopeUpgradeEmail;
        sendOrganizeAuthRequiredEmail: typeof organizeMain.sendOrganizeAuthRequiredEmail;
      }).sendOrganizeScopeUpgradeEmail = originalSendOrganizeScopeUpgradeEmail;
      (organizeMain as typeof organizeMain & {
        sendOrganizeScopeUpgradeEmail: typeof organizeMain.sendOrganizeScopeUpgradeEmail;
        sendOrganizeAuthRequiredEmail: typeof organizeMain.sendOrganizeAuthRequiredEmail;
      }).sendOrganizeAuthRequiredEmail = originalSendOrganizeAuthRequiredEmail;
      (organizeHelpers as typeof organizeHelpers & {
        sendOrganizeEmailResponse: typeof organizeHelpers.sendOrganizeEmailResponse;
      }).sendOrganizeEmailResponse = originalSendOrganizeEmailResponse;
    }
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
          suggestedConvention: "NN-Category",
          conventionDescription: "Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Documents).",
          topLevelFolderNames: ["Inbox", "Work", "Receipts", "Travel"],
        },
        directoryLayout: {
          currentTreeSummary: "My Drive/\n  Inbox/ (2 files)\n",
          userPrompt: "organize my drive",
          conventionDescription: "Loose topical folders",
          proposedStructure: [
            {folder_path: "01-Documents", description: "Documents"},
            {folder_path: "01-Documents/Inbox", description: "Imported inbox documents"},
          ],
          directoryMoves: [
            {current_path: "Inbox", proposed_path: "01-Documents/Inbox", reason: "Keep loose files under Documents"},
          ],
          addedDirectories: ["01-Documents/Inbox"],
          approvedStructure: [
            {folder_path: "01-Documents", description: "Documents"},
            {folder_path: "01-Documents/Inbox", description: "Imported inbox documents"},
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
    const sentTrees: DriveOrganizeProposal["proposed_folders"][] = [];
    const originalSendOrganizePhase1aEmail = organizeHelpers.sendOrganizePhase1aEmail;
    (organizeHelpers as typeof organizeHelpers & {
      sendOrganizePhase1aEmail: typeof organizeHelpers.sendOrganizePhase1aEmail;
    }).sendOrganizePhase1aEmail = async (
        _sender,
        _email,
        _proposalId,
        _conventionSummary,
        _summary,
        folders,
    ) => {
      sentTrees.push(folders);
    };
    setFakeStructuredCompletions([
      {
        has_existing_convention: false,
        convention_description: "NN-Category root folders",
        proposed_structure: [{
          folder_path: "01-Documents",
          description: "Documents",
          source: "proposed",
        }],
        summary: "Use numbered root folders.",
      },
      {
        directory_moves: [{
          current_path: "Inbox",
          proposed_path: "02-Misc/Inbox",
          reason: "Catch unmatched root files in a fallback bucket",
        }],
        no_changes_needed: false,
        summary: "Add a fallback bucket for loose inbox files.",
      },
      {
        final_directories: [
          {folder_path: "01-Documents", description: "Documents"},
          {folder_path: "02-Misc", description: "Fallback bucket"},
          {folder_path: "02-Misc/Inbox", description: "Imported inbox files"},
        ],
        added_directories: ["02-Misc", "02-Misc/Inbox"],
        summary: "Use numbered root folders with a fallback bucket.",
      },
    ]);

    try {
      await organizeProposalTestHooks.handleOrganizePhaseReply(
          makeTestEmail("approve"),
          sender,
          uid,
          proposalId,
          proposalDoc,
          "approve",
          true,
      );
    } finally {
      (organizeHelpers as typeof organizeHelpers & {
        sendOrganizePhase1aEmail: typeof organizeHelpers.sendOrganizePhase1aEmail;
      }).sendOrganizePhase1aEmail = originalSendOrganizePhase1aEmail;
    }

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    const userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(stored?.phase).to.equal("directory_analysis");
    expect(stored?.phaseData.folderPreferences.confirmedConvention)
        .to.equal("NN-Category");
    expect(stored?.phaseData.directoryLayout.folderConvention)
        .to.equal("NN-Category");
    expect(stored?.phaseData.directoryLayout.conventionDescription)
        .to.equal("Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Documents).");
    expect(stored?.phaseData.directoryLayout.proposedStructure).to.deep.equal([
      {folder_path: "01-Documents", description: "Documents"},
      {folder_path: "02-Misc", description: "Fallback bucket"},
      {folder_path: "02-Misc/Inbox", description: "Imported inbox files"},
    ]);
    expect(stored?.phaseData.directoryLayout.directoryMoves).to.deep.equal([{
      current_path: "Inbox",
      proposed_path: "02-Misc/Inbox",
      reason: "Catch unmatched root files in a fallback bucket",
    }]);
    expect(stored?.phaseData.directoryLayout.addedDirectories).to.deep.equal(["02-Misc", "02-Misc/Inbox"]);
    expect(stored?.phaseData.directoryLayout.summary)
        .to.equal("Use numbered root folders with a fallback bucket.");
    expect(sentTrees).to.deep.equal([stored?.phaseData.directoryLayout.proposedStructure]);
    expect(userDoc?.preferences.folderConvention)
        .to.equal("NN-Category");
  });

  it("DT00ub1 stores a folder_preferences convention revision as a token with description", async function() {
    const proposalId = `phase-0-revision-${Date.now()}`;
    const proposalDoc = makePhaseDoc("folder_preferences");
    await seedPhaseProposal(proposalId, proposalDoc);
    setFakeStructuredCompletions([
      {
        is_change: true,
        new_convention: "NN|Category",
        new_description: "Two-digit zero-padded prefix, a pipe, then the category name (e.g. 01|Finance).",
      },
      {
        has_existing_convention: true,
        convention_description: "Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Finance).",
        proposed_structure: [{
          folder_path: "01-Finance",
          description: "Financial documents",
          source: "proposed",
        }],
        summary: "Use pipe folders.",
      },
      {
        directory_moves: [],
        no_changes_needed: true,
        summary: "No directory moves required.",
      },
      {
        final_directories: [{
          folder_path: "01|Finance",
          description: "Financial documents",
        }],
        added_directories: [],
        summary: "Finalized directory map.",
      },
    ]);

    await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("Use pipe instead of dash"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "Use pipe instead of dash",
        false,
    );

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    const userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(stored?.phase).to.equal("directory_analysis");
    expect(stored?.phaseData.folderPreferences.confirmedConvention)
        .to.equal("NN|Category");
    expect(stored?.phaseData.directoryLayout.folderConvention)
        .to.equal("NN|Category");
    expect(stored?.phaseData.directoryLayout.conventionDescription)
        .to.equal("Two-digit zero-padded prefix, a pipe, then the category name (e.g. 01|Finance).");
    expect(stored?.phaseData.directoryLayout.proposedStructure)
        .to.deep.equal([{folder_path: "01|Finance", description: "Financial documents"}]);
    expect(userDoc?.preferences.folderConvention)
        .to.equal("NN|Category");
    expect(userDoc?.preferences.folderConventionDescription)
        .to.equal("Two-digit zero-padded prefix, a pipe, then the category name (e.g. 01|Finance).");
  });

  it("DT00uba routes directory_analysis approval directly to filename_convention", async function() {
    const proposalId = `phase-1a-${Date.now()}`;
    const proposalDoc = makePhaseDoc("directory_analysis");
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

  it("DT00ubc preserves folder convention description during directory_analysis revisions", async function() {
    const proposalId = `phase-1a-revision-${Date.now()}`;
    const proposalDoc = makePhaseDoc("directory_analysis");
    proposalDoc.phaseData!.folderPreferences!.confirmedConvention = "NN|Category";
    proposalDoc.phaseData!.directoryLayout!.folderConvention = "NN|Category";
    proposalDoc.phaseData!.directoryLayout!.conventionDescription =
      "Two-digit zero-padded prefix, a pipe, then the category name (e.g. 01|Finance).";
    await seedPhaseProposal(proposalId, proposalDoc);
    const sentTrees: DriveOrganizeProposal["proposed_folders"][] = [];
    const originalSendOrganizePhase1aEmail = organizeHelpers.sendOrganizePhase1aEmail;
    (organizeHelpers as typeof organizeHelpers & {
      sendOrganizePhase1aEmail: typeof organizeHelpers.sendOrganizePhase1aEmail;
    }).sendOrganizePhase1aEmail = async (
        _sender,
        _email,
        _proposalId,
        _conventionSummary,
        _summary,
        folders,
    ) => {
      sentTrees.push(folders);
    };
    setFakeStructuredCompletions([
      {
        has_existing_convention: true,
        convention_description: "Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Personal).",
        proposed_structure: [
          {folder_path: "01-Personal", description: "Personal", source: "proposed"},
          {folder_path: "02-Work", description: "Work", source: "proposed"},
          {folder_path: "03-Trading", description: "Trading", source: "proposed"},
        ],
        summary: "Keep only the requested roots.",
      },
      {
        directory_moves: [{
          current_path: "Inbox",
          proposed_path: "03|Trading/Inbox",
          reason: "Keep inbox material under the new Trading branch",
        }],
        no_changes_needed: false,
        summary: "Move Inbox into Trading.",
      },
      {
        final_directories: [
          {folder_path: "01|Personal", description: "Personal"},
          {folder_path: "02|Work", description: "Work"},
          {folder_path: "03|Trading", description: "Trading"},
          {folder_path: "03|Trading/Inbox", description: "Inbox files"},
        ],
        added_directories: ["03|Trading/Inbox"],
        summary: "Keep only the requested roots and add Inbox under Trading.",
      },
    ]);

    try {
      await organizeProposalTestHooks.handleOrganizePhaseReply(
          makeTestEmail("Only keep Personal, Work, Trading"),
          sender,
          uid,
          proposalId,
          proposalDoc,
          "Only keep Personal, Work, Trading",
          false,
      );
    } finally {
      (organizeHelpers as typeof organizeHelpers & {
        sendOrganizePhase1aEmail: typeof organizeHelpers.sendOrganizePhase1aEmail;
      }).sendOrganizePhase1aEmail = originalSendOrganizePhase1aEmail;
    }

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(stored?.phase).to.equal("directory_analysis");
    expect(stored?.phaseData.directoryLayout.conventionDescription)
        .to.equal("Two-digit zero-padded prefix, a pipe, then the category name (e.g. 01|Finance).");
    expect(stored?.phaseData.directoryLayout.proposedStructure).to.deep.equal([
      {folder_path: "01|Personal", description: "Personal"},
      {folder_path: "02|Work", description: "Work"},
      {folder_path: "03|Trading", description: "Trading"},
      {folder_path: "03|Trading/Inbox", description: "Inbox files"},
    ]);
    expect(stored?.phaseData.directoryLayout.directoryMoves).to.deep.equal([{
      current_path: "Inbox",
      proposed_path: "03|Trading/Inbox",
      reason: "Keep inbox material under the new Trading branch",
    }]);
    expect(stored?.phaseData.directoryLayout.addedDirectories).to.deep.equal(["03|Trading/Inbox"]);
    expect(stored?.phaseData.directoryLayout.summary)
        .to.equal("Keep only the requested roots and add Inbox under Trading.");
    expect(sentTrees).to.deep.equal([stored?.phaseData.directoryLayout.proposedStructure]);
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
      {folder_path: "01-Documents/Inbox", description: "Imported inbox documents"},
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
      {folder_path: "01-Documents/Inbox", description: "Imported inbox documents"},
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

  it("DT00ube routes cost_estimate revisions through directory_analysis", async function() {
    const proposalId = `phase-cost-${Date.now()}`;
    const proposalDoc = makePhaseDoc("cost_estimate");
    proposalDoc.phaseData!.directoryLayout!.folderConvention = "NN-Category";
    proposalDoc.phaseData!.directoryLayout!.conventionDescription =
      "Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Documents).";
    proposalDoc.phaseData!.directoryLayout!.proposedStructure = [
      {folder_path: "01-Documents", description: "Documents"},
      {folder_path: "02-Photos", description: "Photos"},
    ];
    await seedPhaseProposal(proposalId, proposalDoc);
    setFakeStructuredCompletions([
      {
        has_existing_convention: true,
        convention_description: "Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Personal).",
        proposed_structure: [
          {folder_path: "01-Documents", description: "Documents", source: "proposed"},
          {folder_path: "02-Media", description: "Media files", source: "proposed"},
        ],
        summary: "Moved photos into Media.",
      },
      {
        directory_moves: [],
        no_changes_needed: true,
        summary: "No directory moves required.",
      },
      {
        final_directories: [
          {folder_path: "01-Documents", description: "Documents"},
          {folder_path: "02-Media", description: "Media files"},
        ],
        added_directories: [],
        summary: "Finalized directory map.",
      },
    ]);

    const result = await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("split photos into a new bucket"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "split photos into a new bucket",
        false,
    );

    expect(result?.proposalSent).to.equal(false);
    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(stored?.phase).to.equal("directory_analysis");
    expect(stored?.phaseData.directoryLayout.returnToCostEstimate).to.equal(true);
    expect(stored?.phaseData.directoryLayout.proposedStructure).to.deep.equal([
      {folder_path: "01-Documents", description: "Documents"},
      {folder_path: "02-Media", description: "Media files"},
    ]);
    expect(stored?.phaseData.filenameConvention.convention).to.equal("YYYY.MM.DD - Description.ext");
    expect(getLastSentEmail(sender)?.html).to.include("revised folder structure");
    expect(getLastSentEmail(sender)?.html).to.include("02-Media");
  });

  it("DT00ubeB returns revised directory approvals to cost_estimate", async function() {
    const proposalId = `phase-cost-approve-${Date.now()}`;
    const proposalDoc = makePhaseDoc("directory_analysis");
    proposalDoc.phaseData!.directoryLayout!.returnToCostEstimate = true;
    proposalDoc.phaseData!.directoryLayout!.folderConvention = "NN-Category";
    proposalDoc.phaseData!.directoryLayout!.proposedStructure = [
      {folder_path: "01-Documents", description: "Documents"},
      {folder_path: "02-Media", description: "Media files"},
    ];
    proposalDoc.phaseData!.filenameConvention!.convention = "YYYY-MM-DD_description.ext";
    await seedPhaseProposal(proposalId, proposalDoc);
    const originalEvaluateDirectoryPlacement = driveLlm.evaluateDirectoryPlacement;
    const originalFinalizeDirectoryMap = driveLlm.finalizeDirectoryMap;
    let evaluateCalls = 0;
    let finalizeCalls = 0;
    (driveLlm as typeof driveLlm & {
      evaluateDirectoryPlacement: typeof driveLlm.evaluateDirectoryPlacement;
      finalizeDirectoryMap: typeof driveLlm.finalizeDirectoryMap;
    }).evaluateDirectoryPlacement = async () => {
      evaluateCalls++;
      throw new Error("evaluateDirectoryPlacement should not run during approval");
    };
    (driveLlm as typeof driveLlm & {
      evaluateDirectoryPlacement: typeof driveLlm.evaluateDirectoryPlacement;
      finalizeDirectoryMap: typeof driveLlm.finalizeDirectoryMap;
    }).finalizeDirectoryMap = async () => {
      finalizeCalls++;
      throw new Error("finalizeDirectoryMap should not run during approval");
    };

    let result;
    try {
      result = await organizeProposalTestHooks.handleOrganizePhaseReply(
          makeTestEmail("approve"),
          sender,
          uid,
          proposalId,
          proposalDoc,
          "approve",
          true,
      );
    } finally {
      (driveLlm as typeof driveLlm & {
        evaluateDirectoryPlacement: typeof driveLlm.evaluateDirectoryPlacement;
        finalizeDirectoryMap: typeof driveLlm.finalizeDirectoryMap;
      }).evaluateDirectoryPlacement = originalEvaluateDirectoryPlacement;
      (driveLlm as typeof driveLlm & {
        evaluateDirectoryPlacement: typeof driveLlm.evaluateDirectoryPlacement;
        finalizeDirectoryMap: typeof driveLlm.finalizeDirectoryMap;
      }).finalizeDirectoryMap = originalFinalizeDirectoryMap;
    }

    expect(result?.proposalSent).to.equal(true);
    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(stored?.phase).to.equal("cost_estimate");
    expect(stored?.phaseData.directoryLayout.returnToCostEstimate).to.equal(undefined);
    expect(evaluateCalls).to.equal(0);
    expect(finalizeCalls).to.equal(0);
    expect(stored?.phaseData.directoryLayout.approvedStructure).to.deep.equal([
      {folder_path: "01-Documents", description: "Documents"},
      {folder_path: "02-Media", description: "Media files"},
    ]);
    expect(stored?.phaseData.filenameConvention.convention).to.equal("YYYY-MM-DD_description.ext");
    expect(getLastSentEmail(sender)?.html).to.include("final check");
    expect(getLastSentEmail(sender)?.html).to.include("01-Documents");
    expect(getLastSentEmail(sender)?.html).to.include("02-Media");
    expect(getLastSentEmail(sender)?.html).to.not.include("start generating file proposals");
  });

  it("DT00ubeC renumbers cost_estimate directory revisions contiguously", async function() {
    const proposalId = `phase-cost-renumber-${Date.now()}`;
    const proposalDoc = makePhaseDoc("cost_estimate");
    proposalDoc.phaseData!.directoryLayout!.folderConvention = "NN-Category";
    proposalDoc.phaseData!.directoryLayout!.conventionDescription =
      "Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Documents).";
    proposalDoc.phaseData!.directoryLayout!.proposedStructure = [
      {folder_path: "04-Work", description: "Work"},
      {folder_path: "07-Personal", description: "Personal"},
    ];
    await seedPhaseProposal(proposalId, proposalDoc);
    setFakeStructuredCompletions([
      {
        has_existing_convention: true,
        convention_description: "Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Personal).",
        proposed_structure: [
          {folder_path: "04-Work", description: "Work", source: "existing"},
          {folder_path: "07-Personal", description: "Personal", source: "existing"},
          {folder_path: "Trading", description: "Trading", source: "proposed"},
        ],
        summary: "Added Trading and normalized prefixes.",
      },
      {
        directory_moves: [],
        no_changes_needed: true,
        summary: "No directory moves required.",
      },
      {
        final_directories: [
          {folder_path: "04-Work", description: "Work"},
          {folder_path: "07-Personal", description: "Personal"},
          {folder_path: "Trading", description: "Trading"},
        ],
        added_directories: [],
        summary: "Finalized directory map.",
      },
    ]);

    await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("add trading and make the roots contiguous"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "add trading and make the roots contiguous",
        false,
    );

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(stored?.phaseData.directoryLayout.proposedStructure).to.deep.equal([
      {folder_path: "01-Work", description: "Work"},
      {folder_path: "02-Personal", description: "Personal"},
      {folder_path: "03-Trading", description: "Trading"},
    ]);
    expect(getLastSentEmail(sender)?.html).to.include("01-Work");
    expect(getLastSentEmail(sender)?.html).to.include("02-Personal");
    expect(getLastSentEmail(sender)?.html).to.include("03-Trading");
    expect(getLastSentEmail(sender)?.html).to.not.include("04-Work");
    expect(getLastSentEmail(sender)?.html).to.not.include("07-Personal");
  });

  it("DT00ubeD resends cost estimate for email-reply approval without executing", async function() {
    const proposalId = `phase-cost-reply-approval-${Date.now()}`;
    const proposalDoc = makePhaseDoc("cost_estimate");
    proposalDoc.cost = {
      totalFiles: 2,
      filesToMove: 1,
      filesToRename: 1,
      filesToKeep: 0,
      textFiles: 2,
      imageFiles: 0,
      costPerTextFile: 0.01,
      costPerImageFile: 0.03,
      totalCost: 0.02,
    };
    proposalDoc.phaseData!.costEstimate = {
      totalFiles: 2,
      textFiles: 2,
      imageFiles: 0,
      totalCost: 0.02,
    };
    proposalDoc.phaseData!.directoryLayout!.approvedStructure = [
      {folder_path: "01-Documents", description: "Documents"},
      {folder_path: "02-Photos", description: "Photos"},
    ];
    proposalDoc.phaseData!.filenameConvention!.convention = "YYYY-MM-DD_description.ext";
    await seedPhaseProposal(proposalId, proposalDoc);
    setFakeStructuredCompletions([{
      examples: [
        "2026-04-20_tax_return.pdf",
        "2026-04-20_project_plan.docx",
        "2026-04-20_receipt.jpg",
      ],
    }]);

    const result = await organizeProposalTestHooks.handleOrganizePhaseReply(
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
    expect(result?.proposalSent).to.equal(false);
    expect(result?.error).to.equal("Awaiting button click");
    expect(stored?.status).to.equal("pending");
    expect(stored?.phase).to.equal("cost_estimate");
    expect(stored?.phaseData.execution).to.equal(undefined);
    expect(getLastSentEmail(sender)?.html).to.include("final check");
    expect(getLastSentEmail(sender)?.html).to.include("Approve &amp; Organize");
    expect(getLastSentEmail(sender)?.html).to.not.include("reorganizing your Google Drive now");
  });

  it("DT00ubeE executes cost estimate approval from action task", async function() {
    const proposalId = `phase-cost-button-approval-${Date.now()}`;
    const proposalDoc = makePhaseDoc("cost_estimate");
    proposalDoc.cost = {
      totalFiles: 0,
      filesToMove: 0,
      filesToRename: 0,
      filesToKeep: 0,
      textFiles: 0,
      imageFiles: 0,
      costPerTextFile: 0.01,
      costPerImageFile: 0.03,
      totalCost: 0,
    };
    proposalDoc.phaseData!.costEstimate = {
      totalFiles: 0,
      textFiles: 0,
      imageFiles: 0,
      totalCost: 0,
    };
    proposalDoc.phaseData!.directoryLayout!.approvedStructure = [
      {folder_path: "01-Documents", description: "Documents"},
    ];
    proposalDoc.phaseData!.filenameConvention!.convention = "YYYY-MM-DD_description.ext";
    await seedPhaseProposal(proposalId, proposalDoc);

    const result = await organizeProposalTestHooks.handleOrganizePhaseReply(
        makeTestEmail("approve"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "approve",
        true,
        true,
    );

    const stored = (await db.collection("OrganizeProposals").doc(proposalId).get()).data();
    if (stored) stored.phaseData = await getOrganizePhaseData(proposalId);
    expect(result?.proposalSent).to.equal(false);
    expect(stored?.status).to.equal("completed");
    expect(stored?.phase).to.equal("completed");
    expect(stored?.phaseData.execution.totalChunks).to.equal(0);
    expect(getLastSentEmail(sender)).to.equal(null);
  });

});

describe("organize sequential execution proposal builder", function() {
  afterEach(function() {
    setOpenAIClientForTest(null);
    dispatchHandlerTestHooks.setGetFunctionsClientForTest(null);
  });

  it("DT00ubeF sends multimodal content from proposeFileAction only when imageUrls are present", async function() {
    const capturedMessages: unknown[] = [];
    setOpenAIClientForTest({
      chat: {
        completions: {
          create: async (params: {messages: unknown[]}) => {
            capturedMessages.push(...params.messages);
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    file_id: "file-1",
                    current_name: "receipt.png",
                    current_path: "My Drive",
                    new_name: "2026.04.10 - Receipt.png",
                    target_directory: "01-Docs",
                    action: "move_and_rename",
                    needs_new_directory: false,
                    new_directory: null,
                    reason: "Use the approved folder and filename.",
                  }),
                },
                finish_reason: "stop",
              }],
              usage: {total_tokens: 1},
            };
          },
        },
      },
    } as unknown as OpenAI);

    await proposeFileAction(
        [{folder_path: "01-Docs", description: "Documents"}],
        "YYYY.MM.DD - Description.ext",
        {
          id: "file-1",
          name: "receipt.png",
          mimeType: "image/png",
          parentId: "root",
          parentPath: "My Drive",
          createdTime: "2026-04-10T00:00:00.000Z",
          size: 100,
          webViewLink: "",
          isFolder: false,
        },
        "Receipt from a cafe",
        "uid-test",
        ["data:image/png;base64,QUJD", "data:image/png;base64,REVG"],
    );

    expect(capturedMessages).to.have.length(2);
    expect(capturedMessages[1]).to.deep.equal({
      role: "user",
      content: [
        {
          type: "text",
          text:
            "## Approved Directory Tree\n- 01-Docs: Documents\n\n" +
            "## Filename Convention\nYYYY.MM.DD - Description.ext\n\n" +
            "## File\n" +
            "ID: file-1\n" +
            "Name: receipt.png\n" +
            "Current Path: My Drive\n" +
            "MIME Type: image/png\n" +
            "Created: 2026-04-10T00:00:00.000Z\n" +
            "Size: 100 bytes\n\n" +
            "## Content Summary\nReceipt from a cafe\n",
        },
        {type: "image_url", image_url: {url: "data:image/png;base64,QUJD"}},
        {type: "image_url", image_url: {url: "data:image/png;base64,REVG"}},
      ],
    });

    capturedMessages.length = 0;
    await proposeFileAction(
        [{folder_path: "01-Docs", description: "Documents"}],
        "YYYY.MM.DD - Description.ext",
        {
          id: "file-2",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          parentId: "root",
          parentPath: "My Drive",
          createdTime: "2026-04-11T00:00:00.000Z",
          size: 200,
          webViewLink: "",
          isFolder: false,
        },
        "",
        "uid-test",
    );

    expect(capturedMessages).to.have.length(2);
    expect(capturedMessages[1]).to.deep.equal({
      role: "user",
      content:
        "## Approved Directory Tree\n- 01-Docs: Documents\n\n" +
        "## Filename Convention\nYYYY.MM.DD - Description.ext\n\n" +
        "## File\n" +
        "ID: file-2\n" +
        "Name: receipt.pdf\n" +
        "Current Path: My Drive\n" +
        "MIME Type: application/pdf\n" +
        "Created: 2026-04-11T00:00:00.000Z\n" +
        "Size: 200 bytes\n\n" +
        "## Content Summary\n(none)\n",
    });
  });

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
        async () => ({contentSummary: "", imageUrls: []}),
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

  it("DT00ubi writes RFC 4180 CSV for file actions", function() {
    const csv = writeFileActionsCsv([{
      file_id: "file-1",
      current_path: "My Drive",
      current_name: "quote, draft.pdf",
      new_folder: "01-Docs",
      new_name: "2026.04.20 - \"Quote\"\nDraft.pdf",
      action: "move_and_rename",
      reason: "Comma, quote, and newline coverage",
    }]).toString("utf8");

    expect(csv).to.equal(
        "\"file_id\",\"action\",\"current_path\",\"current_name\",\"new_folder\",\"new_name\",\"reason\"\r\n" +
        "\"file-1\",\"move_and_rename\",\"My Drive\",\"quote, draft.pdf\",\"01-Docs\"," +
        "\"2026.04.20 - \"\"Quote\"\"\nDraft.pdf\",\"Comma, quote, and newline coverage\"\r\n",
    );
  });

  it("DT00ubj applies only safe plan patches and recomputes omitted actions", function() {
    const actions: DriveOrganizeProposal["file_actions"] = [{
      file_id: "file-1",
      current_path: "My Drive",
      current_name: "receipt.pdf",
      new_folder: "01-Docs",
      new_name: "receipt.pdf",
      action: "move",
      reason: "Initial",
    }];
    const patched = applyPlanPatches(actions, [
      {
        file_id: "file-1",
        new_name: "2026.04.20 - Receipt.pdf",
        new_folder: "01-Docs",
        action: null,
        reason: "User requested rename",
      },
      {
        file_id: "file-2",
        new_folder: "01-Docs",
        action: null,
        reason: "Unknown file",
      },
    ], [{folder_path: "01-Docs", description: "Documents"}]);

    expect(patched).to.have.length(1);
    expect(patched[0].new_name).to.equal("2026.04.20 - Receipt.pdf");
    expect(patched[0].new_folder).to.equal("01-Docs");
    expect(patched[0].action).to.equal("move_and_rename");

    const unsafe = applyPlanPatches(actions, [{
      file_id: "file-1",
      new_folder: "99-Unsafe",
      action: null,
      reason: "Unapproved folder",
    }], [{folder_path: "01-Docs", description: "Documents"}]);
    expect(unsafe[0]).to.deep.equal(actions[0]);
  });

  it("DT00ubk bails planning chunks when proposal status is cancelled", async function() {
    const uid = "execution-cancelled-planning";
    const sender = "cancelled-planning@example.com";
    const proposalId = `execution-cancelled-planning-${Date.now()}`;
    const storagePath = `organize-proposals/${proposalId}.json`;
    const phaseData = {
      directoryLayout: {
        approvedStructure: [{
          folder_path: "01-Docs",
          description: "Documents",
        }],
      },
      filenameConvention: {convention: "YYYY.MM.DD - Description.ext"},
      execution: {chunkSize: 1, totalChunks: 2, completedChunks: 0},
    };
    await db.collection("DriveUsers").doc(uid).set({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
    });
    await db.collection("OrganizeProposals").doc(proposalId).set({
      uid,
      senderEmail: sender,
      emailId: "cancelled-planning-email-id",
      status: "cancelled",
      phase: "plan_review",
      createdAt: "2026-04-16T00:00:00.000Z",
      expiresAt: "2099-04-16T00:00:00.000Z",
      storagePath,
      phaseData,
      cost: {},
    });

    const bucket = getStorage().bucket();
    await bucket.file(storagePath).save(JSON.stringify({
      fileEntries: [{
        id: "file-1",
        name: "receipt.pdf",
        mimeType: "application/pdf",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-04-10T00:00:00.000Z",
        size: 100,
        webViewLink: "",
        isFolder: false,
      }],
      senderEmail: sender,
      phaseData,
    }), {contentType: "application/json"});

    let llmCalls = 0;
    setOpenAIClientForTest({
      chat: {
        completions: {
          create: async () => {
            llmCalls++;
            throw new Error("LLM should not be called for cancelled planning chunks");
          },
        },
      },
    } as unknown as OpenAI);

    await processPlanningChunk(makeTestEmail("plan"), {
      proposalId,
      emailId: "cancelled-planning-email-id",
      uid,
      chunkIndex: 0,
    });

    const proposal = await getOrganizeProposal(proposalId) as unknown as OrganizeProposalDoc;
    const [planningChunkExists] = await bucket.file(`organize-proposals/${proposalId}-planning-chunk-0.json`).exists();
    const [nextTreeExists] = await bucket.file(`organize-proposals/${proposalId}-execution-tree-0.json`).exists();
    const [nextChunkExists] = await bucket.file(`organize-proposals/${proposalId}-planning-chunk-1.json`).exists();

    expect(llmCalls).to.equal(0);
    expect(proposal.status).to.equal("cancelled");
    expect((proposal.phaseData as {execution?: {completedChunks?: number}} | undefined)?.execution?.completedChunks)
        .to.equal(0);
    expect(planningChunkExists).to.equal(false);
    expect(nextTreeExists).to.equal(false);
    expect(nextChunkExists).to.equal(false);
  });

  it("DT00ubm skips planning chunks already marked completed", async function() {
    const uid = "execution-completed-planning";
    const sender = "completed-planning@example.com";
    const proposalId = `execution-completed-planning-${Date.now()}`;
    const storagePath = `organize-proposals/${proposalId}.json`;
    const phaseData = {
      directoryLayout: {
        approvedStructure: [{
          folder_path: "01-Docs",
          description: "Documents",
        }],
      },
      filenameConvention: {convention: "YYYY.MM.DD - Description.ext"},
      execution: {chunkSize: 1, totalChunks: 3, completedChunks: 2},
    };
    await db.collection("OrganizeProposals").doc(proposalId).set({
      uid,
      senderEmail: sender,
      emailId: "completed-planning-email-id",
      status: "planning",
      phase: "plan_review",
      createdAt: "2026-04-16T00:00:00.000Z",
      expiresAt: "2099-04-16T00:00:00.000Z",
      storagePath,
      phaseData,
      cost: {},
    });

    const bucket = getStorage().bucket();
    await bucket.file(storagePath).save(JSON.stringify({
      fileEntries: [],
      senderEmail: sender,
      phaseData,
    }), {contentType: "application/json"});

    let llmCalls = 0;
    setOpenAIClientForTest({
      chat: {
        completions: {
          create: async () => {
            llmCalls++;
            throw new Error("LLM should not be called for completed planning chunks");
          },
        },
      },
    } as unknown as OpenAI);

    await processPlanningChunk(makeTestEmail("plan"), {
      proposalId,
      emailId: "completed-planning-email-id",
      uid,
      chunkIndex: 1,
    });

    const proposal = await getOrganizeProposal(proposalId) as unknown as OrganizeProposalDoc;
    const [planningChunkExists] = await bucket.file(`organize-proposals/${proposalId}-planning-chunk-1.json`).exists();
    const [treeExists] = await bucket.file(`organize-proposals/${proposalId}-execution-tree-1.json`).exists();
    const [nextChunkExists] = await bucket.file(`organize-proposals/${proposalId}-planning-chunk-2.json`).exists();

    expect(llmCalls).to.equal(0);
    expect((proposal.phaseData as {execution?: {completedChunks?: number}} | undefined)?.execution?.completedChunks)
        .to.equal(2);
    expect(planningChunkExists).to.equal(false);
    expect(treeExists).to.equal(false);
    expect(nextChunkExists).to.equal(false);
  });

  it("DT00ubn treats ALREADY_EXISTS enqueue errors as success", async function() {
    const enqueueCalls: Array<{data: unknown; opts?: {dispatchDeadlineSeconds?: number; id?: string}}> = [];
    dispatchHandlerTestHooks.setGetFunctionsClientForTest(() => ({
      taskQueue: (_path: string) => ({
        enqueue: async (data: unknown, opts?: {dispatchDeadlineSeconds?: number; id?: string}) => {
          enqueueCalls.push({data, opts});
          const error = new Error("Requested entity already exists");
          (error as Error & {code?: number}).code = 409;
          throw error;
        },
      }),
    }));

    await dispatchPlanningChunkTask({
      proposalId: "proposal id/with bad chars",
      emailId: "email-id",
      uid: "uid",
      chunkIndex: 3,
    });

    expect(enqueueCalls).to.have.length(1);
    expect(enqueueCalls[0].opts).to.deep.equal({
      dispatchDeadlineSeconds: 60 * 30,
      id: "proposal-id-with-bad-chars-plan-3",
    });
  });

  it("DT00ubo re-throws non-dedupe enqueue errors", async function() {
    dispatchHandlerTestHooks.setGetFunctionsClientForTest(() => ({
      taskQueue: (_path: string) => ({
        enqueue: async () => {
          const error = new Error("queue unavailable");
          (error as Error & {code?: number}).code = 500;
          throw error;
        },
      }),
    }));

    let thrown: unknown;
    try {
      await dispatchPlanningChunkTask({
        proposalId: "proposal-id",
        emailId: "email-id",
        uid: "uid",
        chunkIndex: 1,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as Error).message).to.equal("queue unavailable");
  });

  it("DT00ubl keeps status cancelled when planning is cancelled mid-chunk", async function() {
    const uid = "execution-cancelled-mid-chunk";
    const sender = "cancelled-mid-chunk@example.com";
    const proposalId = `execution-cancelled-mid-chunk-${Date.now()}`;
    const storagePath = `organize-proposals/${proposalId}.json`;
    const phaseData = {
      directoryLayout: {
        approvedStructure: [{
          folder_path: "01-Docs",
          description: "Documents",
        }],
      },
      filenameConvention: {convention: "YYYY.MM.DD - Description.ext"},
      execution: {chunkSize: 1, totalChunks: 2, completedChunks: 0},
    };
    await db.collection("DriveUsers").doc(uid).set({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
    });
    await db.collection("OrganizeProposals").doc(proposalId).set({
      uid,
      senderEmail: sender,
      emailId: "admin-organize-cancelled-mid-chunk",
      status: "planning",
      phase: "plan_review",
      createdAt: "2026-04-16T00:00:00.000Z",
      expiresAt: "2099-04-16T00:00:00.000Z",
      storagePath,
      phaseData,
      cost: {},
    });

    const bucket = getStorage().bucket();
    await bucket.file(storagePath).save(JSON.stringify({
      fileEntries: [
        {
          id: "file-1",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          parentId: "root",
          parentPath: "My Drive",
          createdTime: "2026-04-10T00:00:00.000Z",
          size: 999999999,
          webViewLink: "",
          isFolder: false,
        },
        {
          id: "file-2",
          name: "contract.pdf",
          mimeType: "application/pdf",
          parentId: "root",
          parentPath: "My Drive",
          createdTime: "2026-04-11T00:00:00.000Z",
          size: 999999999,
          webViewLink: "",
          isFolder: false,
        },
      ],
      senderEmail: sender,
      phaseData,
    }), {contentType: "application/json"});
    await bucket.file(`organize-proposals/${proposalId}-execution-tree--1.json`).save(JSON.stringify([{
      folder_path: "01-Docs",
      description: "Documents",
    }]), {contentType: "application/json"});

    let llmCalls = 0;
    setOpenAIClientForTest({
      chat: {
        completions: {
          create: async () => {
            llmCalls++;
            await db.collection("OrganizeProposals").doc(proposalId).update({status: "cancelled"});
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    file_id: "file-1",
                    current_name: "receipt.pdf",
                    current_path: "My Drive",
                    new_name: "2026.04.10 - Receipt.pdf",
                    target_directory: "01-Docs",
                    action: "move_and_rename",
                    needs_new_directory: false,
                    new_directory: null,
                    reason: "Organize receipt",
                  }),
                },
                finish_reason: "stop",
              }],
              usage: {total_tokens: 1},
            };
          },
        },
      },
    } as unknown as OpenAI);

    await processPlanningChunk(makeTestEmail("plan"), {
      proposalId,
      emailId: "admin-organize-cancelled-mid-chunk",
      uid,
      chunkIndex: 0,
    });

    const proposal = await getOrganizeProposal(proposalId) as unknown as OrganizeProposalDoc;
    const [planningChunkExists] = await bucket.file(`organize-proposals/${proposalId}-planning-chunk-0.json`).exists();
    const [treeExists] = await bucket.file(`organize-proposals/${proposalId}-execution-tree-0.json`).exists();
    const [nextChunkExists] = await bucket.file(`organize-proposals/${proposalId}-planning-chunk-1.json`).exists();
    const [planExists] = await bucket.file(`organize-proposals/proposal-${proposalId}.json`).exists();

    expect(llmCalls).to.equal(1);
    expect(proposal.status).to.equal("cancelled");
    expect((proposal.phaseData as {execution?: {completedChunks?: number}} | undefined)?.execution?.completedChunks)
        .to.equal(0);
    expect(planningChunkExists).to.equal(true);
    expect(treeExists).to.equal(true);
    expect(nextChunkExists).to.equal(false);
    expect(planExists).to.equal(false);
  });

  it("DT00ubp forwards planning imageUrls into proposeFileAction", async function() {
    const uid = "planning-images-uid";
    const sender = "planning-images@example.com";
    const proposalId = `planning-images-${Date.now()}`;
    const storagePath = `organize-proposals/${proposalId}.json`;
    const phaseData = {
      directoryLayout: {
        approvedStructure: [{
          folder_path: "01-Docs",
          description: "Documents",
        }],
      },
      filenameConvention: {convention: "YYYY.MM.DD - Description.ext"},
      execution: {chunkSize: 1, totalChunks: 1, completedChunks: 0},
    };
    await db.collection("DriveUsers").doc(uid).set({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
    });
    await db.collection("OrganizeProposals").doc(proposalId).set({
      uid,
      senderEmail: sender,
      emailId: "planning-images-email-id",
      status: "planning",
      phase: "plan_review",
      createdAt: "2026-04-16T00:00:00.000Z",
      expiresAt: "2099-04-16T00:00:00.000Z",
      storagePath,
      phaseData,
      cost: {},
    });

    const bucket = getStorage().bucket();
    await bucket.file(storagePath).save(JSON.stringify({
      fileEntries: [{
        id: "image-file",
        name: "receipt.png",
        mimeType: "image/png",
        parentId: "root",
        parentPath: "My Drive",
        createdTime: "2026-04-10T00:00:00.000Z",
        size: 12,
        webViewLink: "",
        isFolder: false,
      }],
      senderEmail: sender,
      phaseData,
    }), {contentType: "application/json"});
    await bucket.file(`organize-proposals/${proposalId}-execution-tree--1.json`).save(JSON.stringify([{
      folder_path: "01-Docs",
      description: "Documents",
    }]), {contentType: "application/json"});

    const capturedMessages: unknown[] = [];
    setOpenAIClientForTest({
      chat: {
        completions: {
          create: async (params: {messages: unknown[]}) => {
            capturedMessages.push(...params.messages);
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    file_id: "image-file",
                    current_name: "receipt.png",
                    current_path: "My Drive",
                    new_name: "2026.04.10 - Receipt.png",
                    target_directory: "01-Docs",
                    action: "move_and_rename",
                    needs_new_directory: false,
                    new_directory: null,
                    reason: "Use the visible receipt content.",
                  }),
                },
                finish_reason: "stop",
              }],
              usage: {total_tokens: 1},
            };
          },
        },
      },
    } as unknown as OpenAI);

    const originalDrive = google.drive;
    (google as unknown as {drive: typeof google.drive}).drive = ((() => ({
      files: {
        get: async (params: {fileId?: string; alt?: string}) => {
          if (params.alt === "media") {
            return {data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 65, 66, 67, 68]).buffer};
          }
          if (params.fileId === "root") {
            return {data: {id: "root"}};
          }
          return {data: {id: "image-file", parents: ["root"], name: "receipt.png"}};
        },
      },
    })) as unknown) as typeof google.drive;

    try {
      await processPlanningChunk(makeTestEmail("plan"), {
        proposalId,
        emailId: "planning-images-email-id",
        uid,
        chunkIndex: 0,
      });
    } finally {
      (google as unknown as {drive: typeof google.drive}).drive = originalDrive;
    }

    expect(capturedMessages).to.have.length(2);
    expect(capturedMessages[1]).to.deep.equal({
      role: "user",
      content: [
        {
          type: "text",
          text:
            "## Approved Directory Tree\n- 01-Docs: Documents\n\n" +
            "## Filename Convention\nYYYY.MM.DD - Description.ext\n\n" +
            "## File\n" +
            "ID: image-file\n" +
            "Name: receipt.png\n" +
            "Current Path: My Drive\n" +
            "MIME Type: image/png\n" +
            "Created: 2026-04-10T00:00:00.000Z\n" +
            "Size: 12 bytes\n\n" +
            "## Content Summary\n(none)\n",
        },
        {type: "image_url", image_url: {url: "data:image/png;base64,iVBORw0KGgpBQkNE"}},
      ],
    });
  });

  async function runProcessExecutionOverrideCase(options: {
    testId: string;
    file: DriveFileEntry;
    approvedFolder: string;
    llmAction: "keep" | "rename";
    newName: string;
    expectedAction: "move" | "move_and_rename";
  }): Promise<{proposal: OrganizeProposalDoc; planned: DriveOrganizeProposal; updateCalls: unknown[]}> {
    const uid = `execution-override-${options.testId}`;
    const sender = `${options.testId}@example.com`;
    const proposalId = `execution-override-${options.testId}-${Date.now()}`;
    const storagePath = `organize-proposals/${proposalId}.json`;
    const approvedStructure = [{
      folder_path: options.approvedFolder,
      description: "Approved target folder",
    }];
    const phaseData = {
      directoryLayout: {approvedStructure},
      filenameConvention: {convention: "YYYY.MM.DD - Description.ext"},
      execution: {chunkSize: 1, totalChunks: 1, completedChunks: 0},
    };
    await db.collection("DriveUsers").doc(uid).set({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
    });
    await db.collection("OrganizeProposals").doc(proposalId).set({
      uid,
      senderEmail: sender,
      emailId: `${options.testId}-email-id`,
      status: "planning",
      phase: "plan_review",
      createdAt: "2026-04-16T00:00:00.000Z",
      expiresAt: "2099-04-16T00:00:00.000Z",
      storagePath,
      phaseData,
      cost: {},
    });
    const bucket = getStorage().bucket();
    await bucket.file(storagePath).save(JSON.stringify({
      fileEntries: [options.file],
      senderEmail: sender,
      phaseData,
    }), {contentType: "application/json"});
    await bucket.file(`organize-proposals/${proposalId}-execution-tree--1.json`)
        .save(JSON.stringify(approvedStructure), {contentType: "application/json"});

    setFakeStructuredCompletions([{
      file_id: options.file.id,
      current_name: options.file.name,
      current_path: options.file.parentPath,
      new_name: options.newName,
      target_directory: options.approvedFolder,
      action: options.llmAction,
      needs_new_directory: false,
      new_directory: null,
      reason: "LLM incorrectly treated a renamed folder as equivalent",
    }]);

    const updateCalls: unknown[] = [];
    const targetSegments = options.approvedFolder.split("/");
    const originalDrive = google.drive;
    (google as unknown as {drive: typeof google.drive}).drive = ((() => ({
      files: {
        get: async (params: {fileId: string}) => {
          if (params.fileId === "root") {
            return {data: {id: "root"}};
          }
          return {
            data: {
              id: options.file.id,
              parents: ["old-parent-id"],
              name: options.file.name,
            },
          };
        },
        list: async (params: {q?: string}) => {
          const query = params.q || "";
          if (query.includes(`name = '${targetSegments[0]}'`)) {
            return {data: {files: [{id: "target-root-id"}]}};
          }
          if (query.includes(`name = '${targetSegments[1]}'`)) {
            return {data: {files: [{id: "target-leaf-id"}]}};
          }
          return {data: {files: []}};
        },
        create: async () => ({data: {id: "created-folder-id"}}),
        update: async (params: unknown) => {
          updateCalls.push(params);
          return {data: {id: options.file.id, webViewLink: "", parents: ["target-leaf-id"]}};
        },
      },
    })) as unknown) as typeof google.drive;

    try {
      await processPlanningChunk(makeTestEmail("plan"), {
        proposalId,
        emailId: `${options.testId}-email-id`,
        uid,
        chunkIndex: 0,
      });
      const planned = await loadSavedPlan(proposalId);
      expect(updateCalls).to.deep.equal([]);

      await db.collection("OrganizeProposals").doc(proposalId).update({
        status: "executing",
        phase: "executing",
      });
      const postPlanBulkFile = getStorage().bucket().file(storagePath);
      const [postPlanBulkContents] = await postPlanBulkFile.download();
      const postPlanBulkData = JSON.parse(postPlanBulkContents.toString()) as Record<string, unknown>;
      const postPlanPhaseData = (postPlanBulkData.phaseData || {}) as Record<string, unknown>;
      const postPlanExecution = (postPlanPhaseData.execution || {}) as Record<string, unknown>;
      postPlanBulkData.phaseData = {
        ...postPlanPhaseData,
        execution: {...postPlanExecution, completedChunks: 0},
      };
      await postPlanBulkFile.save(JSON.stringify(postPlanBulkData), {contentType: "application/json"});

      let movePhaseLlmCalls = 0;
      setOpenAIClientForTest({
        chat: {
          completions: {
            create: async () => {
              movePhaseLlmCalls++;
              throw new Error("LLM should not be called during move execution");
            },
          },
        },
      } as unknown as OpenAI);

      await processMoveChunk(makeTestEmail("move"), {
        proposalId,
        emailId: `${options.testId}-email-id`,
        uid,
        chunkIndex: 0,
      });
      expect(movePhaseLlmCalls).to.equal(0);
      const proposal = await getOrganizeProposal(proposalId) as unknown as OrganizeProposalDoc;
      return {proposal, planned, updateCalls};
    } finally {
      (google as unknown as {drive: typeof google.drive}).drive = originalDrive;
    }
  }

  it("DT00ubg overrides keep when the file is in an unapproved old-convention folder", async function() {
    const {planned, proposal} = await runProcessExecutionOverrideCase({
      testId: "keep-old-folder",
      file: {
        id: "photo-file",
        name: "photo.pdf",
        mimeType: "application/pdf",
        parentId: "old-parent-id",
        parentPath: "01-Personal/Photos",
        createdTime: "2026-04-10T00:00:00.000Z",
        size: 999999999,
        webViewLink: "",
        isFolder: false,
      },
      approvedFolder: "01 | Personal/Photos",
      llmAction: "keep",
      newName: "photo.pdf",
      expectedAction: "move",
    });

    expect(planned.file_actions[0].action).to.equal("move");
    expect(proposal.proposal?.file_actions[0].action).to.equal("move");
    expect(proposal.snapshot?.[0].newParentId).to.equal("target-leaf-id");
  });

  it("DT00ubh overrides rename when the target folder differs from the current folder", async function() {
    const {planned, proposal, updateCalls} = await runProcessExecutionOverrideCase({
      testId: "rename-different-folder",
      file: {
        id: "project-file",
        name: "brief.pdf",
        mimeType: "application/pdf",
        parentId: "old-parent-id",
        parentPath: "03-Projects/Active",
        createdTime: "2026-04-10T00:00:00.000Z",
        size: 999999999,
        webViewLink: "",
        isFolder: false,
      },
      approvedFolder: "03 | Projects/Active",
      llmAction: "rename",
      newName: "2026.04.10 - Brief.pdf",
      expectedAction: "move_and_rename",
    });

    expect(planned.file_actions[0].action).to.equal("move_and_rename");
    expect(proposal.proposal?.file_actions[0].action).to.equal("move_and_rename");
    expect(proposal.snapshot?.[0].newParentId).to.equal("target-leaf-id");
    expect(proposal.snapshot?.[0].newName).to.equal("2026.04.10 - Brief.pdf");
    expect(updateCalls).to.deep.include({
      fileId: "project-file",
      requestBody: {name: "2026.04.10 - Brief.pdf"},
    });
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
