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
  filterFileActionsByScope,
  mergeRevisedProposal,
  normalizeFolderConventionSeparators,
  normalizeFolderPrefixes,
  proposeFileName,
  proposeFilePlacement,
  proposePlacement,
  renumberFoldersContiguously,
  renderFolderTreePlainText,
  scopePlanRevision,
} from "../src/agents/drive/llm";
import * as driveLlm from "../src/agents/drive/llm";
import {prompt as proposeFileNamePrompt} from "../src/agents/drive/prompts/proposeFileName/v1";
import {prompt as proposePlacementPrompt} from "../src/agents/drive/prompts/proposePlacement/v1";
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
  findUsersWithExpiringTokens,
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
  interleaveByParentPath,
  loadSavedPlan,
  mapWithConcurrency,
  organizeExecutionTestHooks,
  processMoveChunk,
  processPlanningChunk,
  pruneOrphanNewDirectories,
  reconcilePlanningChunkResults,
  saveSavedPlan,
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
const STORAGE_BUCKET = `${APP_ID}.firebasestorage.app`;

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
initializeApp({projectId: APP_ID, storageBucket: STORAGE_BUCKET});
const testApp = initializeApp({projectId: APP_ID, storageBucket: STORAGE_BUCKET}, "drive-test");
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
  const queue = results.map((result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return result;
    }
    const normalized = {...result} as Record<string, unknown>;
    if ("proposed_structure" in normalized && !("folder_ignores" in normalized)) {
      normalized.folder_ignores = [];
    }
    if ("patches" in normalized && !("folder_ignores" in normalized)) {
      normalized.folder_ignores = [];
    }
    return normalized;
  });
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

  it("DT00ts2 updateUserTokens preserves token_scope across refresh regardless of refresh-response scope", async function() {
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
    expect(userDoc?.token_scope).to.equal("https://www.googleapis.com/auth/drive");
    expect(userDoc?.access_token).to.equal("new-access");

    await updateUserTokens({
      access_token: "newer-access",
      refresh_token: "newer-refresh",
      expiry_date: 3,
    }, uid, "DriveUsers");

    userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(userDoc?.token_scope).to.equal("https://www.googleapis.com/auth/drive");
    expect(userDoc?.access_token).to.equal("newer-access");
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

describe("Drive revoked OAuth tokens", function() {
  const cleanupDocs: Array<{collection: string; uid: string}> = [];

  afterEach(async function() {
    authHandler.setRefreshAccessTokenForTest(null);
    await Promise.all(cleanupDocs.map((doc) =>
      db.collection(doc.collection).doc(doc.uid).delete(),
    ));
    cleanupDocs.length = 0;
  });

  function trackDoc(collection: string, uid: string): void {
    cleanupDocs.push({collection, uid});
  }

  it("DT00tr1 marks a user revoked when cron refresh sees invalid_grant", async function() {
    const uid = `revoked-invalid-grant-${Date.now()}`;
    trackDoc("DriveUsers", uid);
    await db.collection("DriveUsers").doc(uid).set({
      email: `${uid}@example.com`,
      access_token: "old-access",
      refresh_token: "old-refresh",
      expiry_date: 1,
      token_scope: "https://www.googleapis.com/auth/drive.file",
    });

    const refreshError = new Error("invalid_grant: Token has been expired or revoked.");
    authHandler.setRefreshAccessTokenForTest(async () => {
      throw refreshError;
    });

    try {
      await authHandler.refreshOAuthTokens(uid, "drive");
      throw new Error("Expected refreshOAuthTokens to throw");
    } catch (error) {
      expect(error).to.equal(refreshError);
    }

    const userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(userDoc?.tokens_revoked).to.equal(true);
  });

  it("DT00tr2 findUsersWithExpiringTokens skips revoked users and keeps legacy docs", async function() {
    const collection = `DriveUsersRevokedSkip${Date.now()}`;
    const revokedUid = "revoked";
    const activeUid = "active";
    const legacyUid = "legacy";
    [revokedUid, activeUid, legacyUid].forEach((uid) => trackDoc(collection, uid));

    await db.collection(collection).doc(revokedUid).set({
      email: "revoked@example.com",
      access_token: "revoked-access",
      refresh_token: "revoked-refresh",
      expiry_date: 1,
      tokens_revoked: true,
    });
    await db.collection(collection).doc(activeUid).set({
      email: "active@example.com",
      access_token: "active-access",
      refresh_token: "active-refresh",
      expiry_date: 1,
      tokens_revoked: false,
    });
    await db.collection(collection).doc(legacyUid).set({
      email: "legacy@example.com",
      access_token: "legacy-access",
      refresh_token: "legacy-refresh",
      expiry_date: 1,
    });

    const users = await findUsersWithExpiringTokens(collection);
    const userIds = users.map((user) => user.id);

    expect(userIds).to.include(activeUid);
    expect(userIds).to.include(legacyUid);
    expect(userIds).not.to.include(revokedUid);
  });

  it("DT00tr3 storeUser clears the revoked flag after re-consent", async function() {
    const uid = `revoked-reconsent-${Date.now()}`;
    trackDoc("DriveUsers", uid);
    const user: FirebaseUserRecord = {
      uid,
      email: `${uid}@example.com`,
    };
    await db.collection("DriveUsers").doc(uid).set({
      email: user.email,
      access_token: "old-access",
      refresh_token: "old-refresh",
      expiry_date: 1,
      tokens_revoked: true,
    });

    await storeUser({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expiry_date: 2,
      scope: "https://www.googleapis.com/auth/drive.file",
    }, user, "DriveUsers");

    const userDoc = (await db.collection("DriveUsers").doc(uid).get()).data();
    expect(userDoc?.tokens_revoked).to.equal(false);
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
    organizeProposalTestHooks.setScopePlanRevisionForTest(null);
    organizeProposalTestHooks.setRevisePlanFileActionsForTest(null);
    organizeProposalTestHooks.setHandleOrganizeRevisionForTest(null);
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

describe("filterFileActionsByScope", function() {
  const actions: DriveOrganizeProposal["file_actions"] = [
    {
      file_id: "tax-1",
      current_name: "2025-tax-return.pdf",
      current_path: "Finance/Taxes",
      new_name: "2025-tax-return.pdf",
      new_folder: "01-Finance/Taxes",
      action: "move",
      reason: "Tax file",
    },
    {
      file_id: "ops-1",
      current_name: "financeops-plan.pdf",
      current_path: "FinanceOps",
      new_name: "financeops-plan.pdf",
      new_folder: "09-Operations",
      action: "move",
      reason: "Ops file",
    },
    {
      file_id: "photo-1",
      current_name: "beach.jpg",
      current_path: "Photos/Trips",
      new_name: "beach.jpg",
      new_folder: "01-Personal/Photos",
      action: "move",
      reason: "Photo",
    },
    {
      file_id: "contract-1",
      current_name: "contract-final.docx",
      current_path: "Inbox",
      new_name: "contract-final.docx",
      new_folder: "02-Work/Contracts",
      action: "move",
      reason: "Contract",
    },
  ];

  it("DT00ua1 scopes by folder prefix without matching sibling prefixes", function() {
    const scoped = filterFileActionsByScope(actions, {
      folder_prefixes_in_scope: ["Finance"],
      folder_prefixes_to_ignore: [],
      filename_patterns: [],
      extensions: [],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: false,
      summary: "Finance only",
    });

    expect(scoped.map((action) => action.file_id)).to.deep.equal(["tax-1"]);
  });

  it("DT00ua2 scopes by extension across all folders when no folder prefix is present", function() {
    const scoped = filterFileActionsByScope(actions, {
      folder_prefixes_in_scope: [],
      folder_prefixes_to_ignore: [],
      filename_patterns: [],
      extensions: ["pdf"],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: false,
      summary: "PDFs only",
    });

    expect(scoped.map((action) => action.file_id)).to.deep.equal(["tax-1", "ops-1"]);
  });

  it("DT00ua3 lets ignore prefixes win over in-scope prefixes", function() {
    const scoped = filterFileActionsByScope(actions, {
      folder_prefixes_in_scope: ["01-Personal"],
      folder_prefixes_to_ignore: ["01-Personal/Photos"],
      filename_patterns: [],
      extensions: [],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: false,
      summary: "Ignore photos",
    });

    expect(scoped).to.deep.equal([]);
  });

  it("DT00ua4 includes explicit file hints even when other filters would reject them", function() {
    const scoped = filterFileActionsByScope(actions, {
      folder_prefixes_in_scope: ["01-Personal"],
      folder_prefixes_to_ignore: [],
      filename_patterns: ["tax"],
      extensions: ["pdf"],
      explicit_file_hints: ["contract-final.docx"],
      prefers_folder_operation: false,
      unclear: false,
      summary: "Explicit contract",
    });

    expect(scoped.map((action) => action.file_id)).to.deep.equal(["contract-1"]);
  });

  it("DT00ua5 returns an empty set for an empty scope", function() {
    const scoped = filterFileActionsByScope(actions, {
      folder_prefixes_in_scope: [],
      folder_prefixes_to_ignore: [],
      filename_patterns: [],
      extensions: [],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: false,
      summary: "Empty",
    });

    expect(scoped).to.deep.equal([]);
  });
});

describe("scopePlanRevision prompt construction", function() {
  afterEach(function() {
    setOpenAIClientForTest(null);
  });

  it("DT00ua6 includes trees, samples, ignored folders, and the user request", async function() {
    const proposal: DriveOrganizeProposal = {
      proposed_folders: [
        {folder_path: "01-Finance/Taxes", description: "Tax files"},
        {folder_path: "01-Personal/Photos", description: "Photos"},
      ],
      file_actions: [
        {
          file_id: "tax-1",
          current_name: "2024-tax-return.pdf",
          current_path: "Finance/Taxes",
          new_name: "2024-tax-return.pdf",
          new_folder: "01-Finance/Taxes",
          action: "move",
          reason: "Tax file",
        },
        {
          file_id: "photo-1",
          current_name: "beach.jpg",
          current_path: "Photos",
          new_name: "beach.jpg",
          new_folder: "01-Personal/Photos",
          action: "move",
          reason: "Photo",
        },
      ],
      ignoredFolders: ["01-Personal/Photos"],
      summary: "Initial plan",
    };

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
                    folder_prefixes_in_scope: ["01-Finance/Taxes"],
                    folder_prefixes_to_ignore: ["01-Personal/Photos"],
                    filename_patterns: ["tax"],
                    extensions: ["pdf"],
                    explicit_file_hints: [],
                    prefers_folder_operation: false,
                    unclear: false,
                    summary: "Tax PDFs in Finance",
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

    await scopePlanRevision(
        proposal,
        "Rename the tax PDFs under /Finance and leave Photos alone.",
        ["01-Personal/Photos"],
        "scope-prompt-test",
    );

    const userMessage = capturedMessages.find((message) =>
      typeof message === "object" &&
      message !== null &&
      "role" in (message as Record<string, unknown>) &&
      (message as Record<string, unknown>).role === "user",
    ) as {content: string};
    expect(userMessage.content).to.equal(
        "## User Requested Changes\n" +
        "Rename the tax PDFs under /Finance and leave Photos alone.\n\n" +
        "## Approved Folder Tree\n" +
        "My Drive\n" +
        "├── 01-Finance/  (0 files)\n" +
        "│   └── Taxes/  (1 files)\n" +
        "└── 01-Personal/  (0 files)\n" +
        "    └── Photos/  (1 files)\n\n" +
        "## Original Current-Path Tree\n" +
        "My Drive\n" +
        "├── Finance/  (0 files)\n" +
        "│   └── Taxes/  (1 files)\n" +
        "└── Photos/  (1 files)\n\n" +
        "## Sample Filenames Per Proposed Folder\n" +
        "- 01-Finance/Taxes: 2024-tax-return.pdf\n" +
        "- 01-Personal/Photos: beach.jpg\n\n" +
        "## Previously Ignored Folders\n" +
        "- 01-Personal/Photos\n",
    );
  });
});

describe("plan review affected actions", function() {
  afterEach(function() {
    clearMockData();
  });

  it("DT00ua7 computes affected actions for folder, name, and action changes only", function() {
    const affected = organizeHelpers.computeAffectedActions([
      {
        file_id: "folder-only",
        current_path: "Inbox",
        current_name: "a.pdf",
        new_folder: "01-Docs",
        new_name: "a.pdf",
        action: "move",
        reason: "before",
      },
      {
        file_id: "name-only",
        current_path: "Inbox",
        current_name: "b.pdf",
        new_folder: "01-Docs",
        new_name: "b.pdf",
        action: "move",
        reason: "before",
      },
      {
        file_id: "action-only",
        current_path: "Inbox",
        current_name: "c.pdf",
        new_folder: "01-Docs",
        new_name: "c.pdf",
        action: "move",
        reason: "before",
      },
      {
        file_id: "no-change",
        current_path: "Inbox",
        current_name: "d.pdf",
        new_folder: "01-Docs",
        new_name: "d.pdf",
        action: "move",
        reason: "before",
      },
    ], [
      {
        file_id: "folder-only",
        current_path: "Inbox",
        current_name: "a.pdf",
        new_folder: "02-Archive",
        new_name: "a.pdf",
        action: "move",
        reason: "after",
      },
      {
        file_id: "name-only",
        current_path: "Inbox",
        current_name: "b.pdf",
        new_folder: "01-Docs",
        new_name: "2026.04.24 - b.pdf",
        action: "move_and_rename",
        reason: "after",
      },
      {
        file_id: "action-only",
        current_path: "Inbox",
        current_name: "c.pdf",
        new_folder: "01-Docs",
        new_name: "c.pdf",
        action: "keep",
        reason: "after",
      },
      {
        file_id: "no-change",
        current_path: "Inbox",
        current_name: "d.pdf",
        new_folder: "01-Docs",
        new_name: "d.pdf",
        action: "move",
        reason: "after",
      },
    ]);

    expect(affected.map((action) => action.file_id)).to.deep.equal([
      "folder-only",
      "name-only",
      "action-only",
    ]);
  });

  it("DT00ua8 renders the affected-files block only when affected actions are provided", async function() {
    const proposal = makeOrganizeProposal(
        ["1", "2"],
        {"1": "01-Docs", "2": "01-Docs"},
        ["01-Docs"],
    );
    const sheetUrl = "https://docs.google.com/spreadsheets/d/proposal-sheet";

    await organizeHelpers.sendOrganizePlanReviewEmail(
        "tester@example.com",
        makeTestEmail("review"),
        "proposal-no-affected",
        proposal,
        sheetUrl,
        {totalFiles: 2, filesToMove: 2, filesToRename: 0, filesToKeep: 0},
        "No affected block",
    );

    expect(getLastSentEmail("tester@example.com")?.html).to.not.include("Affected files (");

    clearMockData();

    await organizeHelpers.sendOrganizePlanReviewEmail(
        "tester@example.com",
        makeTestEmail("review"),
        "proposal-with-affected",
        proposal,
        sheetUrl,
        {totalFiles: 2, filesToMove: 2, filesToRename: 0, filesToKeep: 0},
        "With affected block",
        [{
          file_id: "1",
          before: {
            current_path: "Inbox",
            current_name: "invoice.pdf",
            new_folder: "01-Docs",
            new_name: "invoice.pdf",
            action: "move",
          },
          after: {
            new_folder: "02-Archive",
            new_name: "2026.04.24 - invoice.pdf",
            action: "move_and_rename",
          },
        }],
    );

    const html = getLastSentEmail("tester@example.com")?.html || "";
    expect(html).to.include("Affected files (1):");
    expect(html).to.include(sheetUrl);
  });

  it("DT00ua9 creates a proposal sheet in My Drive root when no sheet exists", async function() {
    const createCalls: unknown[] = [];
    const originalDrive = google.drive;
    (google as unknown as {drive: typeof google.drive}).drive = ((() => ({
      files: {
        create: async (params: unknown) => {
          createCalls.push(params);
          return {data: {id: "sheet-create-id", webViewLink: "https://sheet/create"}};
        },
      },
    })) as unknown) as typeof google.drive;

    try {
      const result = await driveHelper.createOrUpdateProposalSheet(
          {} as never,
          "proposal-create",
          Buffer.from("file_id,current_name\n1,invoice.pdf\n"),
      );

      expect(result).to.deep.equal({
        fileId: "sheet-create-id",
        webViewLink: "https://sheet/create",
      });
      expect(createCalls).to.have.length(1);
      const createCall = createCalls[0] as {
        requestBody: {name: string; mimeType: string; parents: string[]};
        media: {mimeType: string; body: NodeJS.ReadableStream};
        fields: string;
      };
      expect(createCall.requestBody).to.deep.equal({
        name: "fwd2drive-proposal-proposal-create",
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: ["root"],
      });
      expect(createCall.media.mimeType).to.equal("text/csv");
      expect(createCall.media.body).to.have.property("read");
      expect(createCall.fields).to.equal("id, webViewLink");
    } finally {
      (google as unknown as {drive: typeof google.drive}).drive = originalDrive;
    }
  });

  it("DT00ub0 updates an existing proposal sheet instead of creating a new one", async function() {
    const updateCalls: unknown[] = [];
    const createCalls: unknown[] = [];
    const originalDrive = google.drive;
    (google as unknown as {drive: typeof google.drive}).drive = ((() => ({
      files: {
        create: async (params: unknown) => {
          createCalls.push(params);
          return {data: {id: "sheet-create-id", webViewLink: "https://sheet/create"}};
        },
        update: async (params: unknown) => {
          updateCalls.push(params);
          return {data: {id: "sheet-existing-id", webViewLink: "https://sheet/update"}};
        },
      },
    })) as unknown) as typeof google.drive;

    try {
      const result = await driveHelper.createOrUpdateProposalSheet(
          {} as never,
          "proposal-update",
          Buffer.from("file_id,current_name\n1,invoice.pdf\n"),
          "sheet-existing-id",
      );

      expect(result).to.deep.equal({
        fileId: "sheet-existing-id",
        webViewLink: "https://sheet/update",
      });
      expect(updateCalls).to.have.length(1);
      expect(createCalls).to.have.length(0);
      const updateCall = updateCalls[0] as {
        fileId: string;
        media: {mimeType: string; body: NodeJS.ReadableStream};
        fields: string;
      };
      expect(updateCall.fileId).to.equal("sheet-existing-id");
      expect(updateCall.media.mimeType).to.equal("text/csv");
      expect(updateCall.media.body).to.have.property("read");
      expect(updateCall.fields).to.equal("id, webViewLink");
    } finally {
      (google as unknown as {drive: typeof google.drive}).drive = originalDrive;
    }
  });

  it("DT00ub1 recreates a proposal sheet when the stored sheet id returns 404", async function() {
    const updateCalls: unknown[] = [];
    const createCalls: unknown[] = [];
    const originalDrive = google.drive;
    (google as unknown as {drive: typeof google.drive}).drive = ((() => ({
      files: {
        create: async (params: unknown) => {
          createCalls.push(params);
          return {data: {id: "sheet-recreated-id", webViewLink: "https://sheet/recreated"}};
        },
        update: async (params: unknown) => {
          updateCalls.push(params);
          const error = new Error("File not found") as Error & {code?: number};
          error.code = 404;
          throw error;
        },
      },
    })) as unknown) as typeof google.drive;

    try {
      const result = await driveHelper.createOrUpdateProposalSheet(
          {} as never,
          "proposal-fallback",
          Buffer.from("file_id,current_name\n1,invoice.pdf\n"),
          "missing-sheet-id",
      );

      expect(result).to.deep.equal({
        fileId: "sheet-recreated-id",
        webViewLink: "https://sheet/recreated",
      });
      expect(updateCalls).to.have.length(1);
      expect(createCalls).to.have.length(1);
    } finally {
      (google as unknown as {drive: typeof google.drive}).drive = originalDrive;
    }
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
      phase: "plan_review",
      createdAt: "2099-01-03T00:00:00.000Z",
      emailId: "email-pending",
      uid: "uid-pending",
    });

    const proposals = await getResumableOrganizeProposals();
    const seeded = proposals.filter((proposal) => String(proposal.id).startsWith(baseId));

    expect(seeded.map((proposal) => proposal.id)).to.deep.equal([
      `${baseId}-pending`,
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

  beforeEach(function() {
    organizeProposalTestHooks.setCreateOrUpdateProposalSheetForTest(async () => ({
      fileId: "sheet-test-id",
      webViewLink: "https://docs.google.com/spreadsheets/d/sheet-test-id",
    }));
  });

  afterEach(function() {
    setOpenAIClientForTest(null);
    organizeProposalTestHooks.setCreateOrUpdateProposalSheetForTest(null);
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

  it("DT00ubeG persists ignored plan-review folders across later revisions", async function() {
    const proposalId = `phase-plan-review-ignore-${Date.now()}`;
    const proposalDoc = makePhaseDoc("plan_review");
    await seedPhaseProposal(proposalId, proposalDoc);
    await saveSavedPlan(proposalId, {
      proposed_folders: [
        {folder_path: "02-Work", description: "Work"},
        {folder_path: "03-Archive", description: "Archive"},
      ],
      file_actions: [
        {
          file_id: "photo-1",
          current_path: "01-Personal/Photos",
          current_name: "beach.jpg",
          new_folder: "03-Archive",
          new_name: "beach.jpg",
          action: "move",
          reason: "Archive older photos",
        },
        {
          file_id: "doc-1",
          current_path: "My Drive",
          current_name: "invoice.pdf",
          new_folder: "02-Work",
          new_name: "invoice.pdf",
          action: "move",
          reason: "Work document",
        },
      ],
      summary: "Initial plan",
    });

    setFakeStructuredCompletions([{
      folder_prefixes_in_scope: [],
      folder_prefixes_to_ignore: ["01-Personal/Photos"],
      filename_patterns: [],
      extensions: [],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: false,
      summary: "Left Photos alone.",
    }, {
      patches: [],
      folder_ignores: ["01-Personal/Photos"],
      unclear: false,
      summary: "Left Photos alone.",
    }]);

    await organizeProposalTestHooks.handlePlanReviewReply(
        makeTestEmail("leave 01-Personal/Photos alone"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "leave 01-Personal/Photos alone",
        false,
    );

    let savedPlan = await loadSavedPlan(proposalId);
    expect(savedPlan.ignoredFolders).to.deep.equal(["01-Personal/Photos"]);
    expect(savedPlan.file_actions.find((action) => action.file_id === "photo-1")).to.deep.include({
      file_id: "photo-1",
      new_folder: "01-Personal/Photos",
      new_name: "beach.jpg",
      action: "keep",
      reason: "Preserved by user: \"01-Personal/Photos\" left as-is",
    });
    expect(getLastSentEmail(sender)?.html).to.include("Photos/&nbsp;&nbsp;(1 files, preserved)");

    setFakeStructuredCompletions([{
      folder_prefixes_in_scope: [],
      folder_prefixes_to_ignore: [],
      filename_patterns: ["invoice"],
      extensions: ["pdf"],
      explicit_file_hints: ["invoice.pdf"],
      prefers_folder_operation: false,
      unclear: false,
      summary: "Rename invoice.",
    }, {
      patches: [{
        file_id: "doc-1",
        new_name: "2026.04.22 - invoice.pdf",
        new_folder: null,
        action: null,
        reason: "Rename invoice",
      }],
      folder_ignores: [],
      unclear: false,
      summary: "Renamed invoice.",
    }]);

    await organizeProposalTestHooks.handlePlanReviewReply(
        makeTestEmail("rename invoice.pdf to 2026.04.22 - invoice.pdf"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "rename invoice.pdf to 2026.04.22 - invoice.pdf",
        false,
    );

    savedPlan = await loadSavedPlan(proposalId);
    expect(savedPlan.ignoredFolders).to.deep.equal(["01-Personal/Photos"]);
    expect(savedPlan.file_actions.find((action) => action.file_id === "photo-1")).to.deep.include({
      file_id: "photo-1",
      new_folder: "01-Personal/Photos",
      action: "keep",
      reason: "Preserved by user: \"01-Personal/Photos\" left as-is",
    });
    expect(savedPlan.file_actions.find((action) => action.file_id === "doc-1")).to.deep.include({
      file_id: "doc-1",
      new_folder: "02-Work",
      new_name: "2026.04.22 - invoice.pdf",
      action: "move_and_rename",
      reason: "Rename invoice",
    });
  });

  it("DT00ubeH scopes plan-review revisions before calling revisePlanFileActions", async function() {
    const proposalId = `phase-plan-review-scoped-${Date.now()}`;
    const proposalDoc = makePhaseDoc("plan_review");
    await seedPhaseProposal(proposalId, proposalDoc);
    await saveSavedPlan(proposalId, {
      proposed_folders: [
        {folder_path: "01-Finance/Taxes", description: "Tax files"},
        {folder_path: "01-Personal/Photos", description: "Photos"},
      ],
      file_actions: [
        {
          file_id: "tax-1",
          current_path: "Finance/Taxes",
          current_name: "2024-tax.pdf",
          new_folder: "01-Finance/Taxes",
          new_name: "2024-tax.pdf",
          action: "move",
          reason: "Tax file",
        },
        {
          file_id: "photo-1",
          current_path: "Photos",
          current_name: "beach.jpg",
          new_folder: "01-Personal/Photos",
          new_name: "beach.jpg",
          action: "move",
          reason: "Photo",
        },
      ],
      summary: "Initial plan",
    });

    let receivedActions: DriveOrganizeProposal["file_actions"] = [];
    organizeProposalTestHooks.setScopePlanRevisionForTest(async () => ({
      folder_prefixes_in_scope: ["01-Finance"],
      folder_prefixes_to_ignore: [],
      filename_patterns: ["tax"],
      extensions: ["pdf"],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: false,
      summary: "Tax PDFs under Finance",
    }));
    organizeProposalTestHooks.setRevisePlanFileActionsForTest(async (fileActions) => {
      receivedActions = fileActions;
      return {
        patches: [{
          file_id: "tax-1",
          new_name: "2024 - tax.pdf",
          new_folder: null,
          action: null,
          reason: "Scoped rename",
        }],
        folder_ignores: [],
        unclear: false,
        summary: "Scoped revision applied",
      };
    });

    await organizeProposalTestHooks.handlePlanReviewReply(
        makeTestEmail("Rename the tax PDFs under /Finance"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "Rename the tax PDFs under /Finance",
        false,
    );

    expect(receivedActions.map((action) => action.file_id)).to.deep.equal(["tax-1"]);
  });

  it("DT00ubeI seeds ignored folders from scope even when revisePlanFileActions omits them", async function() {
    const proposalId = `phase-plan-review-scope-ignore-${Date.now()}`;
    const proposalDoc = makePhaseDoc("plan_review");
    await seedPhaseProposal(proposalId, proposalDoc);
    await saveSavedPlan(proposalId, {
      proposed_folders: [
        {folder_path: "01-Personal/Photos", description: "Photos"},
        {folder_path: "02-Work", description: "Work"},
      ],
      file_actions: [
        {
          file_id: "photo-1",
          current_path: "01-Personal/Photos",
          current_name: "beach.jpg",
          new_folder: "03-Archive",
          new_name: "beach.jpg",
          action: "move",
          reason: "Archive photo",
        },
        {
          file_id: "doc-1",
          current_path: "Inbox",
          current_name: "invoice.pdf",
          new_folder: "02-Work",
          new_name: "invoice.pdf",
          action: "move",
          reason: "Work file",
        },
      ],
      summary: "Initial plan",
    });

    organizeProposalTestHooks.setScopePlanRevisionForTest(async () => ({
      folder_prefixes_in_scope: ["02-Work"],
      folder_prefixes_to_ignore: ["01-Personal/Photos"],
      filename_patterns: ["invoice"],
      extensions: ["pdf"],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: false,
      summary: "Leave Photos alone and rename invoice",
    }));
    organizeProposalTestHooks.setRevisePlanFileActionsForTest(async () => ({
      patches: [{
        file_id: "doc-1",
        new_name: "2026.04.23 - invoice.pdf",
        new_folder: null,
        action: null,
        reason: "Rename invoice",
      }],
      folder_ignores: [],
      unclear: false,
      summary: "Scoped revision applied",
    }));

    await organizeProposalTestHooks.handlePlanReviewReply(
        makeTestEmail("Rename invoice.pdf and leave Photos alone"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "Rename invoice.pdf and leave Photos alone",
        false,
    );

    const savedPlan = await loadSavedPlan(proposalId);
    expect(savedPlan.ignoredFolders).to.deep.equal(["01-Personal/Photos"]);
    expect(savedPlan.file_actions.find((action) => action.file_id === "photo-1")).to.deep.include({
      file_id: "photo-1",
      new_folder: "01-Personal/Photos",
      action: "keep",
    });
    const html = getLastSentEmail(sender)?.html || "";
    expect(html).to.include("Affected files (2):");
    expect(html).to.include("01-Personal/Photos/beach.jpg");
    expect(html).to.include("01-Personal/Photos/beach.jpg (keep)");
    expect(html).to.include("Inbox/invoice.pdf");
    expect(html).to.include("02-Work/2026.04.23 - invoice.pdf");
  });

  it("DT00ubeJ reroutes folder-operation plan-review replies to the folder revision handler", async function() {
    const proposalId = `phase-plan-review-folder-reroute-${Date.now()}`;
    const proposalDoc = makePhaseDoc("plan_review");
    await seedPhaseProposal(proposalId, proposalDoc);
    await saveSavedPlan(proposalId, {
      proposed_folders: [{folder_path: "01-Docs", description: "Docs"}],
      file_actions: [],
      summary: "Initial plan",
    });

    let rerouted = false;
    organizeProposalTestHooks.setScopePlanRevisionForTest(async () => ({
      folder_prefixes_in_scope: [],
      folder_prefixes_to_ignore: [],
      filename_patterns: [],
      extensions: [],
      explicit_file_hints: [],
      prefers_folder_operation: true,
      unclear: false,
      summary: "Rename the folder",
    }));
    organizeProposalTestHooks.setHandleOrganizeRevisionForTest(async () => {
      rerouted = true;
      return {
        totalFiles: 0,
        filesToMove: 0,
        filesToRename: 0,
        totalCost: 0,
        proposalSent: true,
      };
    });

    const result = await organizeProposalTestHooks.handlePlanReviewReply(
        makeTestEmail("Rename folder 01-Docs to 01-Documents"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "Rename folder 01-Docs to 01-Documents",
        false,
    );

    expect(rerouted).to.equal(true);
    expect(result.proposalSent).to.equal(true);
  });

  it("DT00ubeK sends clarification when the scope is unclear", async function() {
    const proposalId = `phase-plan-review-unclear-scope-${Date.now()}`;
    const proposalDoc = makePhaseDoc("plan_review");
    await seedPhaseProposal(proposalId, proposalDoc);
    await saveSavedPlan(proposalId, {
      proposed_folders: [{folder_path: "01-Docs", description: "Docs"}],
      file_actions: [{
        file_id: "doc-1",
        current_path: "Inbox",
        current_name: "invoice.pdf",
        new_folder: "01-Docs",
        new_name: "invoice.pdf",
        action: "move",
        reason: "Doc",
      }],
      summary: "Initial plan",
    });

    let reviseCalled = false;
    organizeProposalTestHooks.setScopePlanRevisionForTest(async () => ({
      folder_prefixes_in_scope: [],
      folder_prefixes_to_ignore: [],
      filename_patterns: [],
      extensions: [],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: true,
      summary: "Please name the exact file to change.",
    }));
    organizeProposalTestHooks.setRevisePlanFileActionsForTest(async () => {
      reviseCalled = true;
      return {
        patches: [],
        folder_ignores: [],
        unclear: false,
        summary: "unused",
      };
    });

    const result = await organizeProposalTestHooks.handlePlanReviewReply(
        makeTestEmail("Make it better"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "Make it better",
        false,
    );

    expect(reviseCalled).to.equal(false);
    expect(result.error).to.equal("Plan revision scope unclear");
    expect(getLastSentEmail(sender)?.html).to.include("Please name the exact file to change.");
  });

  it("DT00ubeL sends clarification when the scoped subset is too broad", async function() {
    const proposalId = `phase-plan-review-overflow-scope-${Date.now()}`;
    const proposalDoc = makePhaseDoc("plan_review");
    await seedPhaseProposal(proposalId, proposalDoc);
    await saveSavedPlan(proposalId, {
      proposed_folders: [{folder_path: "01-Docs", description: "Docs"}],
      file_actions: Array.from({length: 501}, (_value, index) => ({
        file_id: `doc-${index}`,
        current_path: "Inbox",
        current_name: `document-${index}.pdf`,
        new_folder: "01-Docs",
        new_name: `document-${index}.pdf`,
        action: "move" as const,
        reason: "Doc",
      })),
      summary: "Initial plan",
    });

    let reviseCalled = false;
    organizeProposalTestHooks.setScopePlanRevisionForTest(async () => ({
      folder_prefixes_in_scope: [],
      folder_prefixes_to_ignore: [],
      filename_patterns: [],
      extensions: ["pdf"],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: false,
      summary: "That would update every PDF in the plan.",
    }));
    organizeProposalTestHooks.setRevisePlanFileActionsForTest(async () => {
      reviseCalled = true;
      return {
        patches: [],
        folder_ignores: [],
        unclear: false,
        summary: "unused",
      };
    });

    const result = await organizeProposalTestHooks.handlePlanReviewReply(
        makeTestEmail("Rename all PDFs"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "Rename all PDFs",
        false,
    );

    expect(reviseCalled).to.equal(false);
    expect(result.error).to.equal("Plan revision scope too broad");
    const html = getLastSentEmail(sender)?.html || "";
    expect(html).to.include("That would update every PDF in the plan.");
    expect(html).to.include("safe in-email revision");
    expect(html).to.not.include("Move Files");
  });

  it("DT00ubeM sends clarification when scoping returns no matching actions", async function() {
    const proposalId = `phase-plan-review-empty-scope-${Date.now()}`;
    const proposalDoc = makePhaseDoc("plan_review");
    await seedPhaseProposal(proposalId, proposalDoc);
    await saveSavedPlan(proposalId, {
      proposed_folders: [{folder_path: "01-Docs", description: "Docs"}],
      file_actions: [{
        file_id: "doc-1",
        current_path: "Inbox",
        current_name: "invoice.pdf",
        new_folder: "01-Docs",
        new_name: "invoice.pdf",
        action: "move",
        reason: "Doc",
      }],
      summary: "Initial plan",
    });

    let reviseCalled = false;
    organizeProposalTestHooks.setScopePlanRevisionForTest(async () => ({
      folder_prefixes_in_scope: ["02-Archive"],
      folder_prefixes_to_ignore: [],
      filename_patterns: ["tax"],
      extensions: ["pdf"],
      explicit_file_hints: [],
      prefers_folder_operation: false,
      unclear: false,
      summary: "Please name the exact file to change.",
    }));
    organizeProposalTestHooks.setRevisePlanFileActionsForTest(async () => {
      reviseCalled = true;
      return {
        patches: [],
        folder_ignores: [],
        unclear: false,
        summary: "unused",
      };
    });

    const result = await organizeProposalTestHooks.handlePlanReviewReply(
        makeTestEmail("Rename the tax PDF"),
        sender,
        uid,
        proposalId,
        proposalDoc,
        "Rename the tax PDF",
        false,
    );

    expect(reviseCalled).to.equal(false);
    expect(result.error).to.equal("Plan revision scope unclear");
    expect(getLastSentEmail(sender)?.html).to.include("Please name the exact file to change.");
  });

});

describe("organize sequential execution proposal builder", function() {
  beforeEach(function() {
    organizeExecutionTestHooks.setCreateOrUpdateProposalSheetForTest(async () => ({
      fileId: "sheet-test-id",
      webViewLink: "https://docs.google.com/spreadsheets/d/sheet-test-id",
    }));
  });

  afterEach(function() {
    setOpenAIClientForTest(null);
    dispatchHandlerTestHooks.setGetFunctionsClientForTest(null);
    organizeExecutionTestHooks.setCreateOrUpdateProposalSheetForTest(null);
  });

  it("DT00ubeF sends multimodal content from proposeFileName only when imageUrls are present", async function() {
    const capturedRequests: Array<{messages: unknown[]}> = [];
    setOpenAIClientForTest({
      chat: {
        completions: {
          create: async (params: {messages: unknown[]}) => {
            capturedRequests.push(params);
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    file_id: "file-1",
                    current_name: "receipt.png",
                    current_path: "My Drive",
                    new_name: "2026.04.10 - Receipt.png",
                    reason: "Use the approved filename.",
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

    await proposeFileName(
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
        "YYYY.MM.DD - Description.ext",
        "Receipt from a cafe",
        "uid-test",
        ["data:image/png;base64,QUJD", "data:image/png;base64,REVG"],
    );

    expect(capturedRequests[0]?.messages[0]).to.deep.equal({
      role: "system",
      content: proposeFileNamePrompt.prompt,
    });
    expect(capturedRequests[0]?.messages[1]).to.deep.equal({
      role: "user",
      content: [
        {
          type: "text",
          text:
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

    await proposeFileName(
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
        "YYYY.MM.DD - Description.ext",
        "",
        "uid-test",
    );

    expect(capturedRequests[1]?.messages[1]).to.deep.equal({
      role: "user",
      content:
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

  it("DT00ubf keeps placement text-only in proposePlacement", async function() {
    const capturedRequests: Array<{messages: unknown[]}> = [];
    setOpenAIClientForTest({
      chat: {
        completions: {
          create: async (params: {messages: unknown[]}) => {
            capturedRequests.push(params);
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    file_id: "file-1",
                    current_name: "receipt.png",
                    current_path: "My Drive",
                    target_directory: "01-Docs",
                    action: "move",
                    needs_new_directory: false,
                    new_directory: null,
                    reason: "Place it in documents.",
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

    await proposePlacement(
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
        [{folder_path: "01-Docs", description: "Documents"}],
        "Receipt from a cafe",
        "uid-test",
    );

    expect(capturedRequests[0]?.messages[0]).to.deep.equal({
      role: "system",
      content: proposePlacementPrompt.prompt,
    });
    expect(capturedRequests[0]?.messages[1]).to.deep.equal({
      role: "user",
      content:
        "## Approved Directory Tree\n- 01-Docs: Documents\n\n" +
        "## File\n" +
        "ID: file-1\n" +
        "Name: receipt.png\n" +
        "Current Path: My Drive\n" +
        "MIME Type: image/png\n" +
        "Created: 2026-04-10T00:00:00.000Z\n" +
        "Size: 100 bytes\n\n" +
        "## Content Summary\nReceipt from a cafe\n",
    });
  });

  it("DT00ubp synthesizes keep/rename/move/move_and_rename from split naming and placement calls", async function() {
    const files: DriveFileEntry[] = [
      {
        id: "keep",
        name: "2026.04.01 - Receipt.pdf",
        mimeType: "application/pdf",
        parentId: "root",
        parentPath: "01-Docs",
        createdTime: "2026-04-01T00:00:00.000Z",
        size: 100,
        webViewLink: "",
        isFolder: false,
      },
      {
        id: "rename",
        name: "receipt.pdf",
        mimeType: "application/pdf",
        parentId: "root",
        parentPath: "01-Docs",
        createdTime: "2026-04-02T00:00:00.000Z",
        size: 100,
        webViewLink: "",
        isFolder: false,
      },
      {
        id: "move",
        name: "boarding-pass.pdf",
        mimeType: "application/pdf",
        parentId: "root",
        parentPath: "Inbox",
        createdTime: "2026-04-03T00:00:00.000Z",
        size: 100,
        webViewLink: "",
        isFolder: false,
      },
      {
        id: "move-and-rename",
        name: "ticket.pdf",
        mimeType: "application/pdf",
        parentId: "root",
        parentPath: "Inbox",
        createdTime: "2026-04-04T00:00:00.000Z",
        size: 100,
        webViewLink: "",
        isFolder: false,
      },
    ];
    const treeSnapshots: string[][] = [];

    const proposal = await buildSequentialExecutionProposal(
        files,
        [{folder_path: "01-Docs", description: "Documents"}],
        "YYYY.MM.DD - Description.ext",
        "uid-phase3",
        async () => ({contentSummary: "", imageUrls: []}),
        async (file) => ({
          file_id: file.id,
          current_name: file.name,
          current_path: file.parentPath,
          new_name:
            file.id === "rename" ? "2026.04.02 - Receipt.pdf" :
            file.id === "move-and-rename" ? "2026.04.04 - Ticket.pdf" :
            file.name,
          reason: "Name based on content.",
        }),
        async (file, directoryTree) => {
          treeSnapshots.push(directoryTree.map((folder) => folder.folder_path));
          if (file.id === "keep" || file.id === "rename") {
            return {
              file_id: file.id,
              current_name: file.name,
              current_path: file.parentPath,
              target_directory: "01-Docs",
              action: "keep" as const,
              needs_new_directory: false,
              new_directory: null,
              reason: "Already under the correct approved directory.",
            };
          }
          return {
            file_id: file.id,
            current_name: file.name,
            current_path: file.parentPath,
            target_directory: "02-Travel",
            action: "move" as const,
            needs_new_directory: true,
            new_directory: {
              folder_path: "02-Travel",
              description: "Travel documents",
            },
            reason: "Belongs under travel.",
          };
        },
    );

    expect(treeSnapshots[0]).to.deep.equal(["01-Docs"]);
    expect(treeSnapshots[3]).to.deep.equal(["01-Docs", "02-Travel"]);
    expect(proposal.file_actions.map((action) => action.action)).to.deep.equal([
      "keep",
      "rename",
      "move",
      "move_and_rename",
    ]);
    expect(proposal.proposed_folders.map((folder) => folder.folder_path)).to.deep.equal([
      "01-Docs",
      "02-Travel",
    ]);
  });

  it("DT00ubg preserves input order while respecting the concurrency limit", async function() {
    const items = [0, 1, 2, 3, 4, 5];
    const starts: number[] = [];
    const finishes: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapWithConcurrency(items, 2, async (item) => {
      starts.push(item);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5 - (item % 2)));
      finishes.push(item);
      inFlight--;
      return `result-${item}`;
    });

    expect(results).to.deep.equal([
      "result-0",
      "result-1",
      "result-2",
      "result-3",
      "result-4",
      "result-5",
    ]);
    expect(starts).to.deep.equal(items);
    expect(finishes).to.not.deep.equal(items);
    expect(maxInFlight).to.equal(2);
  });

  it("DT00ubh handles empty input and clamps invalid concurrency to one worker", async function() {
    const emptyResults = await mapWithConcurrency([], 8, async (_item: number) => "unreachable");
    expect(emptyResults).to.deep.equal([]);

    const callOrder: number[] = [];
    const results = await mapWithConcurrency([1, 2, 3], Number.NaN, async (item) => {
      callOrder.push(item);
      return item * 10;
    });

    expect(results).to.deep.equal([10, 20, 30]);
    expect(callOrder).to.deep.equal([1, 2, 3]);
  });

  it("DT-ileave-1 interleaves files across parent paths while preserving intra-bucket order", function() {
    const files: DriveFileEntry[] = [
      {id: "a-1", name: "A-1.pdf", mimeType: "application/pdf", parentId: "A", parentPath: "A", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "a-2", name: "A-2.pdf", mimeType: "application/pdf", parentId: "A", parentPath: "A", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "a-3", name: "A-3.pdf", mimeType: "application/pdf", parentId: "A", parentPath: "A", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "b-1", name: "B-1.pdf", mimeType: "application/pdf", parentId: "B", parentPath: "B", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "b-2", name: "B-2.pdf", mimeType: "application/pdf", parentId: "B", parentPath: "B", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "c-1", name: "C-1.pdf", mimeType: "application/pdf", parentId: "C", parentPath: "C", createdTime: "", size: 1, webViewLink: "", isFolder: false},
    ];

    const ordered = interleaveByParentPath(files);

    expect(ordered.map((file) => file.id)).to.deep.equal(["a-1", "b-1", "c-1", "a-2", "b-2", "a-3"]);
    expect(ordered).to.have.length(files.length);
    expect(ordered.filter((file) => file.parentPath === "A").map((file) => file.id)).to.deep.equal(["a-1", "a-2", "a-3"]);
    expect(ordered.filter((file) => file.parentPath === "B").map((file) => file.id)).to.deep.equal(["b-1", "b-2"]);
  });

  it("DT-ileave-2 returns an empty array for empty input", function() {
    expect(interleaveByParentPath([])).to.deep.equal([]);
  });

  it("DT-ileave-3 leaves single-bucket input unchanged", function() {
    const files: DriveFileEntry[] = [
      {id: "a-1", name: "A-1.pdf", mimeType: "application/pdf", parentId: "A", parentPath: "A", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "a-2", name: "A-2.pdf", mimeType: "application/pdf", parentId: "A", parentPath: "A", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "a-3", name: "A-3.pdf", mimeType: "application/pdf", parentId: "A", parentPath: "A", createdTime: "", size: 1, webViewLink: "", isFolder: false},
    ];

    expect(interleaveByParentPath(files).map((file) => file.id)).to.deep.equal(["a-1", "a-2", "a-3"]);
  });

  it("DT-ileave-4 collapses undefined and empty parent paths into one bucket", function() {
    const files: DriveFileEntry[] = [
      {id: "blank-1", name: "blank-1.pdf", mimeType: "application/pdf", parentId: "root", parentPath: "", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "missing-1", name: "missing-1.pdf", mimeType: "application/pdf", parentId: "root", parentPath: "", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "folder-1", name: "folder-1.pdf", mimeType: "application/pdf", parentId: "folder", parentPath: "Folder", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "blank-2", name: "blank-2.pdf", mimeType: "application/pdf", parentId: "root", parentPath: "", createdTime: "", size: 1, webViewLink: "", isFolder: false},
    ];

    expect(interleaveByParentPath(files).map((file) => file.id)).to.deep.equal([
      "blank-1",
      "folder-1",
      "missing-1",
      "blank-2",
    ]);
  });

  it("DT-ileave-5 uses first-seen bucket order instead of lexicographic order", function() {
    const files: DriveFileEntry[] = [
      {id: "z-1", name: "Z-1.pdf", mimeType: "application/pdf", parentId: "Z", parentPath: "Z", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "a-1", name: "A-1.pdf", mimeType: "application/pdf", parentId: "A", parentPath: "A", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "z-2", name: "Z-2.pdf", mimeType: "application/pdf", parentId: "Z", parentPath: "Z", createdTime: "", size: 1, webViewLink: "", isFolder: false},
      {id: "a-2", name: "A-2.pdf", mimeType: "application/pdf", parentId: "A", parentPath: "A", createdTime: "", size: 1, webViewLink: "", isFolder: false},
    ];

    expect(interleaveByParentPath(files).map((file) => file.id)).to.deep.equal(["z-1", "a-1", "z-2", "a-2"]);
  });

  it("DT00ubh1 dedupes parallel new folders during serial reconciliation", function() {
    const runningTree: DriveOrganizeProposal["proposed_folders"] = [{
      folder_path: "01-Docs",
      description: "Documents",
    }];
    const knownDirectories = new Set(runningTree.map((folder) => folder.folder_path));
    const stats = {planned: 0, failed: 0, skipped: 0};
    const results: Parameters<typeof reconcilePlanningChunkResults>[0] = [
      {
        kind: "proposed",
        file: {
          id: "file-1",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          parentId: "root",
          parentPath: "Inbox",
          createdTime: "2026-04-10T00:00:00.000Z",
          size: 100,
          webViewLink: "",
          isFolder: false,
        },
        proposed: {
          file_id: "file-1",
          current_name: "receipt.pdf",
          current_path: "Inbox",
          new_name: "2026.04.10 - Receipt.pdf",
          target_directory: "02-Travel",
          action: "move_and_rename",
          needs_new_directory: true,
          new_directory: {
            folder_path: "02-Travel",
            description: "Travel docs",
          },
          reason: "Travel receipt",
        },
      },
      {
        kind: "proposed",
        file: {
          id: "file-2",
          name: "itinerary.pdf",
          mimeType: "application/pdf",
          parentId: "root",
          parentPath: "Inbox",
          createdTime: "2026-04-11T00:00:00.000Z",
          size: 100,
          webViewLink: "",
          isFolder: false,
        },
        proposed: {
          file_id: "file-2",
          current_name: "itinerary.pdf",
          current_path: "Inbox",
          new_name: "2026.04.11 - Itinerary.pdf",
          target_directory: "02-Travel",
          action: "move_and_rename",
          needs_new_directory: true,
          new_directory: {
            folder_path: "02-Travel",
            description: "Travel docs duplicate",
          },
          reason: "Travel itinerary",
        },
      },
    ];

    const fileActions = reconcilePlanningChunkResults(
        results,
        runningTree,
        knownDirectories,
        stats,
        {proposalId: "proposal-1", chunkIndex: 0},
    );

    expect(runningTree.map((folder) => folder.folder_path)).to.deep.equal(["01-Docs", "02-Travel"]);
    expect(fileActions.map((action) => action.new_folder)).to.deep.equal(["02-Travel", "02-Travel"]);
    expect(stats).to.deep.equal({planned: 2, failed: 0, skipped: 0});
  });

  it("DT00ubh1b uses new_directory.folder_path for reconciled file actions", function() {
    const runningTree: DriveOrganizeProposal["proposed_folders"] = [{
      folder_path: "01-Docs",
      description: "Documents",
    }];
    const knownDirectories = new Set(runningTree.map((folder) => folder.folder_path));
    const stats = {planned: 0, failed: 0, skipped: 0};
    const fileActions = reconcilePlanningChunkResults(
        [{
          kind: "proposed",
          file: {
            id: "file-1",
            name: "receipt.pdf",
            mimeType: "application/pdf",
            parentId: "root",
            parentPath: "Inbox",
            createdTime: "2026-04-10T00:00:00.000Z",
            size: 100,
            webViewLink: "",
            isFolder: false,
          },
          proposed: {
            file_id: "file-1",
            current_name: "receipt.pdf",
            current_path: "Inbox",
            new_name: "2026.04.10 - Receipt.pdf",
            target_directory: "01-Docs",
            action: "move_and_rename",
            needs_new_directory: true,
            new_directory: {
              folder_path: "01-Docs/Receipts",
              description: "Receipt files",
            },
            reason: "Receipt files belong together",
          },
        }],
        runningTree,
        knownDirectories,
        stats,
        {proposalId: "proposal-1", chunkIndex: 0},
    );

    expect(runningTree.map((folder) => folder.folder_path)).to.deep.equal(["01-Docs", "01-Docs/Receipts"]);
    expect(fileActions[0].new_folder).to.equal("01-Docs/Receipts");
  });

  it("DT00ubh1c falls back to target_directory when new_directory is null", function() {
    const runningTree: DriveOrganizeProposal["proposed_folders"] = [{
      folder_path: "01-Docs",
      description: "Documents",
    }];
    const knownDirectories = new Set(runningTree.map((folder) => folder.folder_path));
    const stats = {planned: 0, failed: 0, skipped: 0};
    const fileActions = reconcilePlanningChunkResults(
        [{
          kind: "proposed",
          file: {
            id: "file-1",
            name: "receipt.pdf",
            mimeType: "application/pdf",
            parentId: "root",
            parentPath: "Inbox",
            createdTime: "2026-04-10T00:00:00.000Z",
            size: 100,
            webViewLink: "",
            isFolder: false,
          },
          proposed: {
            file_id: "file-1",
            current_name: "receipt.pdf",
            current_path: "Inbox",
            new_name: "2026.04.10 - Receipt.pdf",
            target_directory: "01-Docs",
            action: "move_and_rename",
            needs_new_directory: true,
            new_directory: null,
            reason: "Receipt files belong together",
          },
        }],
        runningTree,
        knownDirectories,
        stats,
        {proposalId: "proposal-1", chunkIndex: 0},
    );

    expect(fileActions[0].new_folder).to.equal("01-Docs");
  });

  it("DT00ubh2 counts ignored kept files and errors during reconciliation", function() {
    const runningTree: DriveOrganizeProposal["proposed_folders"] = [{
      folder_path: "01-Docs",
      description: "Documents",
    }];
    const knownDirectories = new Set(runningTree.map((folder) => folder.folder_path));
    const stats = {planned: 0, failed: 0, skipped: 0};
    const results: Parameters<typeof reconcilePlanningChunkResults>[0] = [
      {
        kind: "ignored",
        file: {
          id: "file-1",
          name: "beach.jpg",
          mimeType: "image/jpeg",
          parentId: "root",
          parentPath: "01-Personal/Photos",
          createdTime: "2026-04-10T00:00:00.000Z",
          size: 100,
          webViewLink: "",
          isFolder: false,
        },
        ignoredRoot: "01-Personal/Photos",
      },
      {
        kind: "proposed",
        file: {
          id: "file-2",
          name: "invoice.pdf",
          mimeType: "application/pdf",
          parentId: "root",
          parentPath: "01-Docs",
          createdTime: "2026-04-11T00:00:00.000Z",
          size: 100,
          webViewLink: "",
          isFolder: false,
        },
        proposed: {
          file_id: "file-2",
          current_name: "invoice.pdf",
          current_path: "01-Docs",
          new_name: "invoice.pdf",
          target_directory: "01-Docs",
          action: "keep",
          needs_new_directory: false,
          new_directory: null,
          reason: "Already organized",
        },
      },
      {
        kind: "proposed",
        file: {
          id: "file-3",
          name: "contract.pdf",
          mimeType: "application/pdf",
          parentId: "root",
          parentPath: "Inbox",
          createdTime: "2026-04-12T00:00:00.000Z",
          size: 100,
          webViewLink: "",
          isFolder: false,
        },
        proposed: {
          file_id: "file-3",
          current_name: "contract.pdf",
          current_path: "Inbox",
          new_name: "2026.04.12 - Contract.pdf",
          target_directory: "01-Docs",
          action: "move_and_rename",
          needs_new_directory: false,
          new_directory: null,
          reason: "Move into documents",
        },
      },
      {
        kind: "error",
        file: {
          id: "file-4",
          name: "bad.pdf",
          mimeType: "application/pdf",
          parentId: "root",
          parentPath: "Inbox",
          createdTime: "2026-04-13T00:00:00.000Z",
          size: 100,
          webViewLink: "",
          isFolder: false,
        },
        error: new Error("boom"),
      },
    ];

    const fileActions = reconcilePlanningChunkResults(
        results,
        runningTree,
        knownDirectories,
        stats,
        {proposalId: "proposal-2", chunkIndex: 1},
    );

    expect(fileActions).to.have.length(4);
    expect(fileActions[0]).to.deep.include({
      file_id: "file-1",
      action: "keep",
      new_folder: "01-Personal/Photos",
      reason: "Preserved by user: \"01-Personal/Photos\" left as-is",
    });
    expect(fileActions[1]).to.deep.include({
      file_id: "file-2",
      action: "keep",
      new_folder: "01-Docs",
    });
    expect(fileActions[2]).to.deep.include({
      file_id: "file-3",
      action: "move_and_rename",
      new_folder: "01-Docs",
    });
    expect(fileActions[3]).to.deep.include({
      file_id: "file-4",
      action: "keep",
      new_folder: "Inbox",
      reason: "Automatic analysis failed — left in place",
    });
    expect(stats).to.deep.equal({planned: 1, failed: 1, skipped: 2});
  });

  describe("pruneOrphanNewDirectories", function() {
    it("DT00ubpnd1 drops a newly-added folder no file_action targets", function() {
      const proposal: DriveOrganizeProposal = {
        proposed_folders: [
          {folder_path: "01-Docs", description: "Documents"},
          {folder_path: "01-Docs/Receipts", description: "Receipts"},
        ],
        file_actions: [{
          file_id: "file-1",
          current_name: "receipt.pdf",
          current_path: "Inbox",
          new_name: "receipt.pdf",
          new_folder: "01-Docs",
          action: "move",
          reason: "Receipt",
        }],
        summary: "Test",
      };

      const result = pruneOrphanNewDirectories(
          proposal,
          [{folder_path: "01-Docs", description: "Documents"}],
      );

      expect(result.proposed_folders.map((folder) => folder.folder_path)).to.deep.equal(["01-Docs"]);
      expect(result.file_actions).to.deep.equal(proposal.file_actions);
    });

    it("DT00ubpnd2 keeps a newly-added intermediate when a descendant is targeted", function() {
      const proposal: DriveOrganizeProposal = {
        proposed_folders: [
          {folder_path: "01-Docs", description: "Documents"},
          {folder_path: "01-Docs/Client A", description: "Client folder"},
          {folder_path: "01-Docs/Client A/2026", description: "Year folder"},
        ],
        file_actions: [
          {
            file_id: "file-1",
            current_name: "a.pdf",
            current_path: "Inbox",
            new_name: "a.pdf",
            new_folder: "01-Docs/Client A/2026",
            action: "move",
            reason: "Client file",
          },
        ],
        summary: "Test",
      };

      const result = pruneOrphanNewDirectories(
          proposal,
          [{folder_path: "01-Docs", description: "Documents"}],
      );

      expect(result.proposed_folders.map((folder) => folder.folder_path)).to.deep.equal([
        "01-Docs",
        "01-Docs/Client A",
        "01-Docs/Client A/2026",
      ]);
    });

    it("DT00ubpnd3 keeps approved folders with zero targets and no descendants", function() {
      const proposal: DriveOrganizeProposal = {
        proposed_folders: [
          {folder_path: "01-Docs", description: "Documents"},
          {folder_path: "01-Docs/Archive", description: "Archive"},
        ],
        file_actions: [],
        summary: "Test",
      };

      const result = pruneOrphanNewDirectories(
          proposal,
          proposal.proposed_folders,
      );

      expect(result).to.deep.equal(proposal);
    });

    it("DT00ubpnd4 does not modify file_actions", function() {
      const proposal: DriveOrganizeProposal = {
        proposed_folders: [
          {folder_path: "01-Docs", description: "Documents"},
          {folder_path: "01-Docs/Receipts", description: "Receipts"},
        ],
        file_actions: [{
          file_id: "file-1",
          current_name: "1.pdf",
          current_path: "Inbox",
          new_name: "1.pdf",
          new_folder: "01-Docs",
          action: "move",
          reason: "",
        }],
        summary: "Test",
      };

      const result = pruneOrphanNewDirectories(
          proposal,
          [{folder_path: "01-Docs", description: "Documents"}],
      );

      expect(result.file_actions).to.deep.equal(proposal.file_actions);
    });

    it("DT00ubpnd5 is idempotent", function() {
      const proposal: DriveOrganizeProposal = {
        proposed_folders: [
          {folder_path: "01-Docs", description: "Documents"},
          {folder_path: "01-Docs/Receipts", description: "Receipts"},
        ],
        file_actions: [{
          file_id: "file-1",
          current_name: "receipt.pdf",
          current_path: "Inbox",
          new_name: "receipt.pdf",
          new_folder: "01-Docs",
          action: "move",
          reason: "Receipt",
        }],
        summary: "Test",
      };

      const once = pruneOrphanNewDirectories(
          proposal,
          [{folder_path: "01-Docs", description: "Documents"}],
      );
      const twice = pruneOrphanNewDirectories(
          once,
          [{folder_path: "01-Docs", description: "Documents"}],
      );

      expect(twice).to.deep.equal(once);
    });
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

  it("DT00ubj1 allows keep patches that preserve files in their current folder", function() {
    const actions: DriveOrganizeProposal["file_actions"] = [{
      file_id: "file-1",
      current_path: "01-Personal/Photos",
      current_name: "beach.jpg",
      new_folder: "02-Media",
      new_name: "beach.jpg",
      action: "move",
      reason: "Initial",
    }];

    const patched = applyPlanPatches(actions, [{
      file_id: "file-1",
      new_name: "beach.jpg",
      new_folder: "01-Personal/Photos",
      action: "keep",
      reason: "Preserved by user: \"01-Personal/Photos\" left as-is",
    }], [{folder_path: "02-Media", description: "Media"}]);

    expect(patched[0]).to.deep.equal({
      file_id: "file-1",
      current_path: "01-Personal/Photos",
      current_name: "beach.jpg",
      new_folder: "01-Personal/Photos",
      new_name: "beach.jpg",
      action: "keep",
      reason: "Preserved by user: \"01-Personal/Photos\" left as-is",
    });
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
                    action: "move",
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

    expect(llmCalls).to.equal(2);
    expect(proposal.status).to.equal("cancelled");
    expect((proposal.phaseData as {execution?: {completedChunks?: number}} | undefined)?.execution?.completedChunks)
        .to.equal(0);
    expect(planningChunkExists).to.equal(true);
    expect(treeExists).to.equal(true);
    expect(nextChunkExists).to.equal(false);
    expect(planExists).to.equal(false);
  });

  it("DT-ileave-6 saves a complete planning chunk after interleaving parent paths", async function() {
    const uid = "execution-interleave-parent-paths";
    const sender = "execution-interleave-parent-paths@example.com";
    const proposalId = `execution-interleave-parent-paths-${Date.now()}`;
    const storagePath = `organize-proposals/${proposalId}.json`;
    const previousPlanConcurrency = process.env.ORGANIZE_DRIVE_PLAN_CONCURRENCY;
    process.env.ORGANIZE_DRIVE_PLAN_CONCURRENCY = "2";

    const phaseData = {
      directoryLayout: {
        approvedStructure: [{
          folder_path: "01-Docs",
          description: "Documents",
        }],
      },
      filenameConvention: {convention: "YYYY.MM.DD - Description.ext"},
      execution: {chunkSize: 6, totalChunks: 1, completedChunks: 0},
    };
    const chunkFiles: DriveFileEntry[] = [
      {id: "a-1", name: "A-1.pdf", mimeType: "application/pdf", parentId: "folder-a", parentPath: "Folder-A", createdTime: "2026-04-10T00:00:00.000Z", size: 999999999, webViewLink: "", isFolder: false},
      {id: "a-2", name: "A-2.pdf", mimeType: "application/pdf", parentId: "folder-a", parentPath: "Folder-A", createdTime: "2026-04-11T00:00:00.000Z", size: 999999999, webViewLink: "", isFolder: false},
      {id: "a-3", name: "A-3.pdf", mimeType: "application/pdf", parentId: "folder-a", parentPath: "Folder-A", createdTime: "2026-04-12T00:00:00.000Z", size: 999999999, webViewLink: "", isFolder: false},
      {id: "b-1", name: "B-1.pdf", mimeType: "application/pdf", parentId: "folder-b", parentPath: "Folder-B", createdTime: "2026-04-13T00:00:00.000Z", size: 999999999, webViewLink: "", isFolder: false},
      {id: "b-2", name: "B-2.pdf", mimeType: "application/pdf", parentId: "folder-b", parentPath: "Folder-B", createdTime: "2026-04-14T00:00:00.000Z", size: 999999999, webViewLink: "", isFolder: false},
      {id: "b-3", name: "B-3.pdf", mimeType: "application/pdf", parentId: "folder-b", parentPath: "Folder-B", createdTime: "2026-04-15T00:00:00.000Z", size: 999999999, webViewLink: "", isFolder: false},
    ];

    await db.collection("DriveUsers").doc(uid).set({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
    });
    await db.collection("OrganizeProposals").doc(proposalId).set({
      uid,
      senderEmail: sender,
      emailId: "execution-interleave-parent-paths-email-id",
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
      fileEntries: chunkFiles,
      senderEmail: sender,
      phaseData,
    }), {contentType: "application/json"});
    await bucket.file(`organize-proposals/${proposalId}-execution-tree--1.json`).save(JSON.stringify([{
      folder_path: "01-Docs",
      description: "Documents",
    }]), {contentType: "application/json"});

    setOpenAIClientForTest({
      chat: {
        completions: {
          create: async (params: {messages: Array<{content: unknown}>}) => {
            const systemContent = params.messages[0]?.content;
            const userContent = params.messages[1]?.content;
            const promptText = typeof systemContent === "string" ? systemContent : "";
            const requestText = typeof userContent === "string" ?
              userContent :
              Array.isArray(userContent) ?
                userContent.map((part) => typeof part === "object" && part && "text" in part ?
                  String((part as {text?: string}).text || "") :
                  "").join("\n") :
                "";
            const fileIdMatch = requestText.match(/ID:\s*([^\n]+)/);
            const fileNameMatch = requestText.match(/Name:\s*([^\n]+)/);
            const currentPathMatch = requestText.match(/Current Path:\s*([^\n]+)/);
            const fileId = fileIdMatch?.[1]?.trim() || "unknown-file";
            const fileName = fileNameMatch?.[1]?.trim() || "unknown.pdf";
            const currentPath = currentPathMatch?.[1]?.trim() || "My Drive";

            const content: unknown = promptText === proposeFileNamePrompt.prompt ?
              {
                file_id: fileId,
                current_name: fileName,
                current_path: currentPath,
                new_name: `2026.04 - ${fileName}`,
                reason: `Rename ${fileName}`,
              } :
              {
                file_id: fileId,
                current_name: fileName,
                current_path: currentPath,
                target_directory: "01-Docs",
                action: "move",
                needs_new_directory: false,
                new_directory: null,
                reason: `Move ${fileName}`,
              };

            return {
              choices: [{
                message: {
                  content: JSON.stringify(content),
                },
                finish_reason: "stop",
              }],
              usage: {total_tokens: 1},
            };
          },
        },
      },
    } as unknown as OpenAI);

    try {
      await processPlanningChunk(makeTestEmail("plan"), {
        proposalId,
        emailId: "execution-interleave-parent-paths-email-id",
        uid,
        chunkIndex: 0,
      });
    } finally {
      if (previousPlanConcurrency === undefined) {
        delete process.env.ORGANIZE_DRIVE_PLAN_CONCURRENCY;
      } else {
        process.env.ORGANIZE_DRIVE_PLAN_CONCURRENCY = previousPlanConcurrency;
      }
    }

    const [planningChunkContents] = await bucket.file(`organize-proposals/${proposalId}-planning-chunk-0.json`).download();
    const planningChunk = JSON.parse(planningChunkContents.toString()) as {
      file_actions: DriveOrganizeProposal["file_actions"];
      stats: {planned: number; failed: number; skipped: number};
    };

    expect(planningChunk.stats.planned).to.equal(6);
    expect(planningChunk.stats.failed).to.equal(0);
    expect(planningChunk.file_actions.map((action) => action.file_id).sort()).to.deep.equal(
        chunkFiles.map((file) => file.id).sort(),
    );
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

    setFakeStructuredCompletions([
      {
        file_id: options.file.id,
        current_name: options.file.name,
        current_path: options.file.parentPath,
        new_name: options.newName,
        reason: "LLM preserved the filename.",
      },
      {
        file_id: options.file.id,
        current_name: options.file.name,
        current_path: options.file.parentPath,
        target_directory: options.approvedFolder,
        action: options.llmAction === "rename" ? "move" : "keep",
        needs_new_directory: false,
        new_directory: null,
        reason: "LLM incorrectly treated a renamed folder as equivalent",
      },
    ]);

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
    await db.collection("OrganizeProposals").doc(`${baseId}-pending-review`).set({
      status: "pending",
      phase: "plan_review",
      createdAt: "2099-02-04T00:00:00.000Z",
      emailId: "email-pending-review",
      uid: "uid-pending-review",
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
      `${baseId}-pending-review`,
      `${baseId}-failed`,
      `${baseId}-generating`,
    ]);
  });

  describe("admin rerunPlanning", function() {
    beforeEach(function() {
      organizeExecutionTestHooks.setCreateOrUpdateProposalSheetForTest(async () => ({
        fileId: "sheet-test-id",
        webViewLink: "https://docs.google.com/spreadsheets/d/sheet-test-id",
      }));
    });

    afterEach(function() {
      organizeExecutionTestHooks.setCreateOrUpdateProposalSheetForTest(null);
      setOpenAIClientForTest(null);
      clearMockData();
    });

    it("DT00ue performs fresh Drive scan and preserves user-revised folder structure", async function() {
      const proposalId = `admin-rerun-${Date.now()}`;
      const uid = `admin-rerun-uid-${Date.now()}`;
      const senderEmail = "admin-rerun@example.com";
      const storagePath = `organize-proposals/${proposalId}.json`;
      await db.collection("DriveUsers").doc(uid).set({
        email: senderEmail,
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_scope: "https://www.googleapis.com/auth/drive",
      });
      await db.collection("EmailAddress").doc(senderEmail).set({
        uid,
        email: senderEmail,
        default: true,
      });
      await db.collection("OrganizeProposals").doc(proposalId).set({
        uid,
        senderEmail,
        emailId: "original-organize-email-id",
        status: "pending",
        phase: "plan_review",
        createdAt: "2026-04-20T00:00:00.000Z",
        expiresAt: "2099-04-20T00:00:00.000Z",
        storagePath,
        ignoredFolders: ["Inbox"],
        phaseData: {
          directoryLayout: {
            approvedStructure: [{
              folder_path: "01-Documents",
              description: "Documents",
            }],
          },
          filenameConvention: {
            convention: "YYYY.MM.DD - Description.ext",
          },
          execution: {
            chunkSize: 10,
            totalChunks: 3,
            completedChunks: 3,
          },
          planReview: {
            totalFiles: 1,
            csvStoragePath: `organize-proposals/proposal-${proposalId}.csv`,
            planStoragePath: `organize-proposals/proposal-${proposalId}.json`,
            fileActionsVersion: 7,
          },
        },
      });
      await getStorage().bucket().file(storagePath).save(JSON.stringify({
        proposal: {
          proposed_folders: [{
            folder_path: "001-Invoices",
            description: "Invoices",
          }],
          file_actions: [{
            file_id: "stale-1",
            current_name: "invoice.pdf",
            current_path: "Inbox",
            new_name: "invoice.pdf",
            new_folder: "001-Invoices",
            action: "move",
            reason: "stale",
          }],
          summary: "stale plan",
        },
        testDriveScan: {
          rootFolderId: "root",
          rawFiles: [{
            id: "fresh-1",
            name: "invoice-renamed.pdf",
            mimeType: "application/pdf",
            parents: ["folder-inbox"],
            createdTime: "2026-04-11T00:00:00.000Z",
            size: "200",
            webViewLink: "",
          }, {
            id: "folder-inbox",
            name: "Inbox",
            mimeType: "application/vnd.google-apps.folder",
            parents: ["root"],
            createdTime: "2026-04-01T00:00:00.000Z",
            size: "0",
            webViewLink: "",
          }],
        },
        fileEntries: [{
          id: "stale-1",
          name: "invoice.pdf",
          mimeType: "application/pdf",
          parentId: "folder-inbox",
          parentPath: "Inbox",
          createdTime: "2026-04-10T00:00:00.000Z",
          size: 100,
          webViewLink: "",
          isFolder: false,
        }],
        senderEmail,
        phaseData: {
          directoryLayout: {
            approvedStructure: [{
              folder_path: "001-Invoices",
              description: "Invoices",
            }],
          },
          filenameConvention: {
            convention: "YYYY.MM.DD - Description.ext",
          },
        },
      }), {contentType: "application/json"});
      await saveSavedPlan(proposalId, {
        proposed_folders: [{
          folder_path: "001-Invoices",
          description: "Invoices",
        }],
        file_actions: [{
          file_id: "stale-1",
          current_name: "invoice.pdf",
          current_path: "Inbox",
          new_name: "invoice.pdf",
          new_folder: "001-Invoices",
          action: "move",
          reason: "stale",
        }],
        summary: "stale plan",
      });

      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning", proposalId});

      expect(res).to.have.status(200);
      expect(res.body).to.include({proposalId, action: "rerunPlanning", scannedFiles: 2});
      expect(res.body.emailId).to.match(/^admin-organize-rerun-\d+$/);

      const proposal = await getOrganizeProposal(proposalId) as unknown as OrganizeProposalDoc;
      const savedPlan = await loadSavedPlan(proposalId);
      const [savedStateBuffer] = await getStorage().bucket().file(storagePath).download();
      const savedState = JSON.parse(savedStateBuffer.toString()) as {
        fileEntries: DriveFileEntry[];
      };

      expect(proposal.status).to.equal("pending");
      expect(proposal.phase).to.equal("plan_review");
      expect(proposal.emailId).to.match(/^admin-organize-rerun-\d+$/);
      expect(proposal.phaseData?.directoryLayout?.approvedStructure).to.deep.equal([{
        folder_path: "001-Invoices",
        description: "Invoices",
      }]);
      expect(proposal.phaseData?.execution?.completedChunks).to.equal(1);
      expect(proposal.phaseData?.execution?.totalChunks).to.equal(1);
      expect(proposal.phaseData?.planReview?.fileActionsVersion).to.equal(1);
      expect(savedState.fileEntries.map((entry) => entry.id)).to.deep.equal(["fresh-1", "folder-inbox"]);
      expect(savedPlan.file_actions).to.deep.equal([{
        file_id: "fresh-1",
        current_name: "invoice-renamed.pdf",
        current_path: "Inbox",
        new_name: "invoice-renamed.pdf",
        new_folder: "Inbox",
        action: "keep",
        reason: "Preserved by user: \"Inbox\" left as-is",
      }]);
      expect(savedPlan.file_actions.some((action) => action.file_id === "stale-1")).to.equal(false);
    });

    it("DT00uf returns 409 when proposal is not at plan_review", async function() {
      const proposalId = `admin-rerun-not-ready-${Date.now()}`;
      const storagePath = `organize-proposals/${proposalId}.json`;
      await db.collection("OrganizeProposals").doc(proposalId).set({
        uid: "admin-rerun-not-ready-uid",
        senderEmail: "not-ready@example.com",
        emailId: "not-ready-email-id",
        status: "pending",
        phase: "cost_estimate",
        createdAt: "2026-04-20T00:00:00.000Z",
        expiresAt: "2099-04-20T00:00:00.000Z",
        storagePath,
      });
      await getStorage().bucket().file(storagePath).save(JSON.stringify({
        phaseData: {},
      }), {contentType: "application/json"});

      const before = await db.collection("OrganizeProposals").doc(proposalId).get();

      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning", proposalId});

      expect(res).to.have.status(409);
      expect(res.body).to.deep.equal({
        error: "Proposal is not ready for review",
        status: "pending",
        phase: "cost_estimate",
      });

      const after = await db.collection("OrganizeProposals").doc(proposalId).get();
      expect(after.data()).to.deep.equal(before.data());
    });

    it("DT00ug returns 404 when proposal does not exist", async function() {
      const proposalId = `admin-rerun-missing-${Date.now()}`;

      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning", proposalId});

      expect(res).to.have.status(404);
      expect(res.body).to.deep.equal({error: "Proposal not found"});
      expect((await db.collection("OrganizeProposals").doc(proposalId).get()).exists).to.equal(false);
    });

    it("DT00uh returns 422 when proposal has no preserved folder plan", async function() {
      const proposalId = `admin-rerun-no-plan-${Date.now()}`;
      const uid = `admin-rerun-no-plan-uid-${Date.now()}`;
      const storagePath = `organize-proposals/${proposalId}.json`;
      await db.collection("DriveUsers").doc(uid).set({
        email: "no-plan@example.com",
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_scope: "https://www.googleapis.com/auth/drive",
      });
      await db.collection("OrganizeProposals").doc(proposalId).set({
        uid,
        senderEmail: "no-plan@example.com",
        emailId: "no-plan-email-id",
        status: "pending",
        phase: "plan_review",
        createdAt: "2026-04-20T00:00:00.000Z",
        expiresAt: "2099-04-20T00:00:00.000Z",
        storagePath,
      });
      await getStorage().bucket().file(storagePath).save(JSON.stringify({
        proposal: {
          proposed_folders: [],
          file_actions: [],
          summary: "empty",
        },
      }), {contentType: "application/json"});

      const beforeDoc = await db.collection("OrganizeProposals").doc(proposalId).get();
      const [beforeBlob] = await getStorage().bucket().file(storagePath).download();

      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning", proposalId});

      expect(res).to.have.status(422);
      expect(res.body).to.deep.equal({error: "Proposal has no folder plan to preserve"});
      expect((await db.collection("OrganizeProposals").doc(proposalId).get()).data()).to.deep.equal(beforeDoc.data());
      const [afterBlob] = await getStorage().bucket().file(storagePath).download();
      expect(afterBlob.toString()).to.equal(beforeBlob.toString());
    });

    it("DT00ui returns 403 when target user lacks full drive scope", async function() {
      const proposalId = `admin-rerun-limited-scope-${Date.now()}`;
      const uid = `admin-rerun-limited-scope-uid-${Date.now()}`;
      const storagePath = `organize-proposals/${proposalId}.json`;
      await db.collection("DriveUsers").doc(uid).set({
        email: "limited-scope@example.com",
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_scope: "https://www.googleapis.com/auth/drive.file",
      });
      await db.collection("OrganizeProposals").doc(proposalId).set({
        uid,
        senderEmail: "limited-scope@example.com",
        emailId: "limited-scope-email-id",
        status: "pending",
        phase: "plan_review",
        createdAt: "2026-04-20T00:00:00.000Z",
        expiresAt: "2099-04-20T00:00:00.000Z",
        storagePath,
      });
      await getStorage().bucket().file(storagePath).save(JSON.stringify({
        proposal: {
          proposed_folders: [{
            folder_path: "001-Invoices",
            description: "Invoices",
          }],
          file_actions: [],
          summary: "existing",
        },
      }), {contentType: "application/json"});

      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning", proposalId});

      expect(res).to.have.status(403);
      expect(res.body).to.deep.equal({error: "User does not have full drive scope"});
    });

    it("DT00uj returns 502 when Drive scan throws", async function() {
      const proposalId = `admin-rerun-scan-failure-${Date.now()}`;
      const uid = `admin-rerun-scan-failure-uid-${Date.now()}`;
      const storagePath = `organize-proposals/${proposalId}.json`;
      await db.collection("DriveUsers").doc(uid).set({
        email: "scan-failure@example.com",
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_scope: "https://www.googleapis.com/auth/drive",
      });
      await db.collection("OrganizeProposals").doc(proposalId).set({
        uid,
        senderEmail: "scan-failure@example.com",
        emailId: "scan-failure-email-id",
        status: "pending",
        phase: "plan_review",
        createdAt: "2026-04-20T00:00:00.000Z",
        expiresAt: "2099-04-20T00:00:00.000Z",
        storagePath,
      });
      await getStorage().bucket().file(storagePath).save(JSON.stringify({
        proposal: {
          proposed_folders: [{
            folder_path: "001-Invoices",
            description: "Invoices",
          }],
          file_actions: [],
          summary: "existing",
        },
        testDriveScan: {
          scanError: "scan exploded",
        },
        fileEntries: [{
          id: "stale-1",
          name: "invoice.pdf",
          mimeType: "application/pdf",
          parentId: "folder-inbox",
          parentPath: "Inbox",
          createdTime: "2026-04-10T00:00:00.000Z",
          size: 100,
          webViewLink: "",
          isFolder: false,
        }],
        senderEmail: "scan-failure@example.com",
      }), {contentType: "application/json"});
      await saveSavedPlan(proposalId, {
        proposed_folders: [{
          folder_path: "001-Invoices",
          description: "Invoices",
        }],
        file_actions: [],
        summary: "existing",
      });

      const beforeDoc = await db.collection("OrganizeProposals").doc(proposalId).get();
      const [beforeBlob] = await getStorage().bucket().file(storagePath).download();

      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning", proposalId});

      expect(res).to.have.status(502);
      expect(res.body).to.deep.equal({error: "Drive scan failed"});
      expect((await db.collection("OrganizeProposals").doc(proposalId).get()).data()).to.deep.equal(beforeDoc.data());
      const [afterBlob] = await getStorage().bucket().file(storagePath).download();
      expect(afterBlob.toString()).to.equal(beforeBlob.toString());
    });

    it("DT00uk returns 403 when OAuth reports Drive authorization is required", async function() {
      const proposalId = `admin-rerun-auth-failure-${Date.now()}`;
      const uid = `admin-rerun-auth-failure-uid-${Date.now()}`;
      const storagePath = `organize-proposals/${proposalId}.json`;
      await db.collection("DriveUsers").doc(uid).set({
        email: "auth-failure@example.com",
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_scope: "https://www.googleapis.com/auth/drive",
      });
      await db.collection("OrganizeProposals").doc(proposalId).set({
        uid,
        senderEmail: "auth-failure@example.com",
        emailId: "auth-failure-email-id",
        status: "pending",
        phase: "plan_review",
        createdAt: "2026-04-20T00:00:00.000Z",
        expiresAt: "2099-04-20T00:00:00.000Z",
        storagePath,
      });
      await getStorage().bucket().file(storagePath).save(JSON.stringify({
        proposal: {
          proposed_folders: [{
            folder_path: "001-Invoices",
            description: "Invoices",
          }],
          file_actions: [],
          summary: "existing",
        },
        testDriveScan: {
          oauthError: "invalid_grant",
        },
      }), {contentType: "application/json"});

      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning", proposalId});

      expect(res).to.have.status(403);
      expect(res.body).to.deep.equal({error: "Drive authorization required"});
    });

    it("DT00ul returns 400 when proposalId is missing", async function() {
      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning"});

      expect(res).to.have.status(400);
      expect(res.body).to.deep.equal({error: "proposalId is required"});
    });

    it("DT00um returns 400 when limit is not a positive integer", async function() {
      const proposalId = `admin-rerun-bad-limit-${Date.now()}`;
      const storagePath = `organize-proposals/${proposalId}.json`;
      await db.collection("OrganizeProposals").doc(proposalId).set({
        uid: "admin-rerun-bad-limit-uid",
        senderEmail: "bad-limit@example.com",
        emailId: "bad-limit-email-id",
        status: "pending",
        phase: "plan_review",
        createdAt: "2026-04-20T00:00:00.000Z",
        expiresAt: "2099-04-20T00:00:00.000Z",
        storagePath,
      });

      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning", proposalId, limit: -5});

      expect(res).to.have.status(400);
      expect(res.body).to.deep.equal({error: "limit must be a positive integer"});
    });

    it("DT00un randomly samples files when scan exceeds limit", async function() {
      const proposalId = `admin-rerun-limit-${Date.now()}`;
      const uid = `admin-rerun-limit-uid-${Date.now()}`;
      const senderEmail = "limit-sample@example.com";
      const storagePath = `organize-proposals/${proposalId}.json`;
      await db.collection("DriveUsers").doc(uid).set({
        email: senderEmail,
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_scope: "https://www.googleapis.com/auth/drive",
      });
      await db.collection("EmailAddress").doc(senderEmail).set({
        uid,
        email: senderEmail,
        default: true,
      });
      await db.collection("OrganizeProposals").doc(proposalId).set({
        uid,
        senderEmail,
        emailId: "limit-sample-email-id",
        status: "pending",
        phase: "plan_review",
        createdAt: "2026-04-20T00:00:00.000Z",
        expiresAt: "2099-04-20T00:00:00.000Z",
        storagePath,
        phaseData: {
          directoryLayout: {
            approvedStructure: [{
              folder_path: "01-Documents",
              description: "Documents",
            }],
          },
          filenameConvention: {
            convention: "YYYY.MM.DD - Description.ext",
          },
        },
      });
      const totalFiles = 10;
      const rawFiles = [{
        id: "folder-inbox",
        name: "Inbox",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
        createdTime: "2026-04-01T00:00:00.000Z",
        size: "0",
        webViewLink: "",
      }];
      for (let i = 0; i < totalFiles; i++) {
        rawFiles.push({
          id: `file-${i}`,
          name: `doc-${i}.pdf`,
          mimeType: "application/pdf",
          parents: ["folder-inbox"],
          createdTime: "2026-04-10T00:00:00.000Z",
          size: "100",
          webViewLink: "",
        });
      }
      await getStorage().bucket().file(storagePath).save(JSON.stringify({
        testDriveScan: {
          rootFolderId: "root",
          rawFiles,
        },
      }), {contentType: "application/json"});
      await saveSavedPlan(proposalId, {
        proposed_folders: [{
          folder_path: "01-Documents",
          description: "Documents",
        }],
        file_actions: [],
        summary: "existing",
      });

      const canonicalCsvPath = `organize-proposals/proposal-${proposalId}.csv`;
      const sentinelCsvBytes = Buffer.from("sentinel-csv-content");
      await getStorage().bucket().file(canonicalCsvPath).save(sentinelCsvBytes, {
        contentType: "text/csv",
      });

      const res = await chaiWithHttp
        .request(`${DISPATCH_URL}/${APP_ID}/${DISPATCH_REGION}`)
        .post("/v2driveAdminOrganize")
        .set("Content-Type", "application/json")
        .set("x-admin-key", "test-admin-key")
        .send({action: "rerunPlanning", proposalId, limit: 3});

      expect(res).to.have.status(200);
      expect(res.body.fileLimit).to.equal(3);
      expect(res.body.totalFiles).to.equal(totalFiles);
      expect(res.body.sampledFiles).to.equal(3);
      expect(res.body.scannedFiles).to.equal(4);

      const [savedStateBuffer] = await getStorage().bucket().file(storagePath).download();
      const savedState = JSON.parse(savedStateBuffer.toString()) as {
        fileEntries: DriveFileEntry[];
      };
      const sampledFileIds = savedState.fileEntries
          .filter((entry) => !entry.isFolder)
          .map((entry) => entry.id);
      expect(sampledFileIds).to.have.lengthOf(3);
      sampledFileIds.forEach((id) => {
        expect(id).to.match(/^file-\d+$/);
      });
      const uniqueIds = new Set(sampledFileIds);
      expect(uniqueIds.size).to.equal(3);

      const [canonicalAfter] = await getStorage().bucket().file(canonicalCsvPath).download();
      expect(canonicalAfter.equals(sentinelCsvBytes)).to.equal(true);

      const updatedProposal = await getOrganizeProposal(proposalId) as unknown as OrganizeProposalDoc;
      const writtenCsvPath = updatedProposal.phaseData?.planReview?.csvStoragePath;
      expect(writtenCsvPath).to.match(
          new RegExp(`^organize-proposals/proposal-${proposalId}-sample-\\d+\\.csv$`),
      );
      expect(writtenCsvPath).to.not.equal(canonicalCsvPath);
      const [sampledCsvExists] = await getStorage().bucket().file(writtenCsvPath as string).exists();
      expect(sampledCsvExists).to.equal(true);
      expect(updatedProposal.phaseData?.execution?.sampled).to.equal(true);
    });
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
