import {logger} from "firebase-functions/v2";
import {getStorage} from "firebase-admin/storage";
import {Auth} from "googleapis";
import {getOauthClient} from "../../../auth/authHandler";
import {ENVIRONMENT_NAME} from "../../../util/config";
import {
  finalizeOrganizeProposal,
  getOrganizeIntermediateState,
  getOrganizeProposal,
  updateOrganizeProposalStatus,
} from "../../../util/firestoreHandler";
import {sendEvent} from "../../../util/analytics";
import {TransformedEmail} from "../../../util/types";
import {
  AGENT_NAME,
  MAX_DRIVE_UPLOAD_BYTES,
  ORGANIZE_DRIVE_CHUNK_SIZE,
  ORGANIZE_DRIVE_PLAN_CONCURRENCY,
} from "../config";
import {driveMailTemplates, driveOrganizeActionUrl} from "../mailTemplates";
import {
  DriveFileEntry,
  DriveOrganizeProposal,
  MoveChunkTaskData,
  OrganizeEmbeddedData,
  OrganizeIntermediateState,
  OrganizeProcessingResult,
  OrganizeProposalDoc,
  OrganizeSnapshotAction,
  PlanningChunkTaskData,
} from "../types";
import {buildOrganizeEmbeddedData, renderFolderTree} from "../templates/folderTree";
import {extractContentSummary, extractDocumentImageUrls} from "../fileProcessor";
import {DEFAULT_FOLDER_CONVENTION, proposeFileName, proposePlacement as defaultProposePlacement} from "../llm";
import {ProposeFileNameResult} from "../prompts/proposeFileName/v1";
import {ProposePlacementResult} from "../prompts/proposePlacement/v1";
import {applyTemplate, toTitleCase} from "../driveUtils";
import {
  emptyResult,
  formatSummaryHtml,
  sendOrganizePlanReviewEmail,
  sendOrganizeEmailResponse,
  signActionToken,
} from "./organizeHelpers";
import {
  createOrUpdateProposalSheet,
  createFolder,
  findAgentManagedFolders,
  findSubfolderByName,
  getDriveClient,
  getRootFolderId,
  moveFile,
  placeMarkerFile,
  readDriveFileContent,
  renameFile,
  renameFolder,
} from "../driveHelper";
import {cleanupAllEmptyFolders} from "./organizeUndo";

type ExecutionChunkResult = {
  file_actions: DriveOrganizeProposal["file_actions"];
  snapshot: OrganizeSnapshotAction[];
  stats: {moved: number; renamed: number; failed: number; skipped: number};
};

type PlanningChunkResult = {
  file_actions: DriveOrganizeProposal["file_actions"];
  stats: {planned: number; failed: number; skipped: number};
};

type FileSummaryProvider = (file: DriveFileEntry) => Promise<{contentSummary: string; imageUrls: string[]}>;
type FileNameProposer = (
  file: DriveFileEntry,
  convention: string,
  contentSummary: string,
  uid: string,
  imageUrls?: string[],
) => Promise<ProposeFileNameResult>;
type FilePlacementProposer = (
  file: DriveFileEntry,
  directoryTree: DriveOrganizeProposal["proposed_folders"],
  contentSummary: string,
  uid: string,
) => Promise<ProposePlacementResult>;
type OrganizeFileActionType = DriveOrganizeProposal["file_actions"][number]["action"];
type DerivedFileActionProposal = {
  file_id: string;
  current_name: string;
  current_path: string;
  new_name: string;
  target_directory: string;
  action: OrganizeFileActionType;
  needs_new_directory: boolean;
  new_directory: ProposePlacementResult["new_directory"];
  reason: string;
};
type PlanningWorkerResult =
  | {kind: "ignored"; file: DriveFileEntry; ignoredRoot: string}
  | {kind: "proposed"; file: DriveFileEntry; proposed: DerivedFileActionProposal}
  | {kind: "error"; file: DriveFileEntry; error: unknown};

function combineActionReasons(nameReason: string, placementReason: string): string {
  if (nameReason && placementReason && nameReason !== placementReason) {
    return `${placementReason} Filename: ${nameReason}`;
  }
  return placementReason || nameReason || "";
}

function synthesizeFileActionProposal(
    file: DriveFileEntry,
    nameResult: ProposeFileNameResult,
    placementResult: ProposePlacementResult,
): DerivedFileActionProposal {
  const currentName = nameResult.current_name || placementResult.current_name || file.name;
  const currentPath = placementResult.current_path || nameResult.current_path || file.parentPath || "My Drive";
  const newName = nameResult.new_name || file.name;
  const action: OrganizeFileActionType = placementResult.action === "keep" ?
    (newName === currentName ? "keep" : "rename") :
    (newName === currentName ? "move" : "move_and_rename");

  return {
    file_id: nameResult.file_id || placementResult.file_id || file.id,
    current_name: currentName,
    current_path: currentPath,
    new_name: newName,
    target_directory: placementResult.target_directory || file.parentPath || "My Drive",
    action,
    needs_new_directory: placementResult.needs_new_directory,
    new_directory: placementResult.new_directory,
    reason: combineActionReasons(nameResult.reason, placementResult.reason),
  };
}

const getExecutionTreePath = (proposalId: string, chunkIndex: number) =>
  `organize-proposals/${proposalId}-execution-tree-${chunkIndex}.json`;
const getPlanningChunkPath = (proposalId: string, chunkIndex: number) =>
  `organize-proposals/${proposalId}-planning-chunk-${chunkIndex}.json`;
const getMoveChunkPath = (proposalId: string, chunkIndex: number) =>
  `organize-proposals/${proposalId}-move-chunk-${chunkIndex}.json`;
export const getPlanStoragePath = (proposalId: string) =>
  `organize-proposals/proposal-${proposalId}.json`;
export const getPlanCsvStoragePath = (proposalId: string) =>
  `organize-proposals/proposal-${proposalId}.csv`;
let createOrUpdateProposalSheetImpl = createOrUpdateProposalSheet;

function getProposalSheetRef(
    proposalId: string,
    existingFileId?: string,
): {fileId: string; webViewLink: string} {
  const fileId = existingFileId || `local-proposal-sheet-${proposalId}`;
  return {
    fileId,
    webViewLink: `https://docs.google.com/spreadsheets/d/${fileId}`,
  };
}

export async function mapWithConcurrency<T, U>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }

  const clampedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex++;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  };

  await Promise.all(Array.from({length: Math.min(clampedLimit, items.length)}, () => worker()));
  return results;
}

export function interleaveByParentPath(files: DriveFileEntry[]): DriveFileEntry[] {
  if (files.length === 0) {
    return [];
  }

  const buckets = new Map<string, DriveFileEntry[]>();
  const bucketOrder: string[] = [];

  for (const file of files) {
    const bucketKey = file.parentPath || "";
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
      bucketOrder.push(bucketKey);
    }
    buckets.get(bucketKey)?.push(file);
  }

  const bucketIndexes = new Map<string, number>();
  for (const key of bucketOrder) {
    bucketIndexes.set(key, 0);
  }

  const orderedFiles: DriveFileEntry[] = [];
  while (orderedFiles.length < files.length) {
    for (const key of bucketOrder) {
      const bucket = buckets.get(key) || [];
      const index = bucketIndexes.get(key) || 0;
      if (index >= bucket.length) {
        continue;
      }
      orderedFiles.push(bucket[index]);
      bucketIndexes.set(key, index + 1);
    }
  }

  return orderedFiles;
}

async function isOrganizeProposalCancelled(proposalId: string): Promise<boolean> {
  const latestProposal = await getOrganizeProposal(proposalId);
  if (!latestProposal) {
    throw new Error("Organize proposal not found");
  }
  return (latestProposal as unknown as OrganizeProposalDoc).status === "cancelled";
}

/** Corrects contradictory LLM action labels using the actual source and target paths. */
function deriveEffectiveAction(
    proposed: DerivedFileActionProposal,
    file: DriveFileEntry,
    knownDirectories: Set<string>,
): {
  action: OrganizeFileActionType;
  currentPath: string;
  newFolder: string;
  currentInApprovedTree: boolean;
} {
  const currentPath = proposed.current_path || file.parentPath;
  const newFolder = proposed.target_directory || file.parentPath;
  const currentName = proposed.current_name || file.name;
  const newName = proposed.new_name || file.name;
  const currentInApprovedTree = knownDirectories.has(currentPath);
  const targetDiffersFromCurrent = newFolder !== currentPath;
  const nameDiffers = newName !== currentName;

  if (proposed.action === "keep" && !currentInApprovedTree) {
    return {
      action: nameDiffers ? "move_and_rename" : "move",
      currentPath,
      newFolder,
      currentInApprovedTree,
    };
  }

  if (proposed.action === "rename" && targetDiffersFromCurrent) {
    return {
      action: "move_and_rename",
      currentPath,
      newFolder,
      currentInApprovedTree,
    };
  }

  return {
    action: proposed.action,
    currentPath,
    newFolder,
    currentInApprovedTree,
  };
}

export function reconcilePlanningChunkResults(
    results: PlanningWorkerResult[],
    runningTree: DriveOrganizeProposal["proposed_folders"],
    knownDirectories: Set<string>,
    stats: PlanningChunkResult["stats"],
    context: {proposalId: string; chunkIndex: number},
): DriveOrganizeProposal["file_actions"] {
  const fileActions: DriveOrganizeProposal["file_actions"] = [];

  for (const result of results) {
    if (result.kind === "ignored") {
      const {file, ignoredRoot} = result;
      fileActions.push({
        file_id: file.id,
        current_name: file.name,
        current_path: file.parentPath || "My Drive",
        new_name: file.name,
        new_folder: file.parentPath || "My Drive",
        action: "keep",
        reason: `Preserved by user: "${ignoredRoot}" left as-is`,
      });
      stats.skipped++;
      continue;
    }

    if (result.kind === "proposed") {
      const {file, proposed} = result;
      if (proposed.needs_new_directory && proposed.new_directory &&
          !knownDirectories.has(proposed.new_directory.folder_path)) {
        runningTree.push(proposed.new_directory);
        knownDirectories.add(proposed.new_directory.folder_path);
      }
      const effective = deriveEffectiveAction(proposed, file, knownDirectories);
      if (effective.action !== proposed.action) {
        logger.warn("Drive organize: LLM action overridden", {
          proposalId: context.proposalId,
          chunkIndex: context.chunkIndex,
          fileId: file.id,
          llmAction: proposed.action,
          effectiveAction: effective.action,
          currentPath: effective.currentPath,
          newFolder: effective.newFolder,
          currentInApprovedTree: effective.currentInApprovedTree,
        });
      }

      const action = {
        file_id: proposed.file_id || file.id,
        current_name: proposed.current_name || file.name,
        current_path: effective.currentPath,
        new_name: proposed.new_name || file.name,
        new_folder: effective.newFolder,
        action: effective.action,
        reason: proposed.reason,
      };
      fileActions.push(action);
      if (action.action === "keep") {
        stats.skipped++;
      } else {
        stats.planned++;
      }
      continue;
    }

    stats.failed++;
    fileActions.push({
      file_id: result.file.id,
      current_name: result.file.name,
      current_path: result.file.parentPath || "My Drive",
      new_name: result.file.name,
      new_folder: result.file.parentPath || "My Drive",
      action: "keep",
      reason: "Automatic analysis failed — left in place",
    });
    logger.error("Drive organize planning chunk: file failed", {
      proposalId: context.proposalId,
      chunkIndex: context.chunkIndex,
      fileId: result.file.id,
      error: result.error instanceof Error ? result.error.message : String(result.error),
    });
  }

  return fileActions;
}

/** Builds content-aware actions sequentially while carrying forward newly-created directories. */
export async function buildSequentialExecutionProposal(
    fileEntries: DriveFileEntry[],
    approvedStructure: DriveOrganizeProposal["proposed_folders"],
    convention: string,
    uid: string,
    summarizeFile: FileSummaryProvider,
    proposeName: FileNameProposer = proposeFileName,
    proposePlacement: FilePlacementProposer = defaultProposePlacement,
): Promise<DriveOrganizeProposal> {
  const nonFolderFiles = fileEntries.filter((file) => !file.isFolder);
  const runningTree = approvedStructure.map((folder) => ({...folder}));
  const knownDirectories = new Set(runningTree.map((folder) => folder.folder_path));
  const fileActions: DriveOrganizeProposal["file_actions"] = [];
  const proposePlacementFile = proposePlacement;

  for (const file of nonFolderFiles) {
    const {contentSummary, imageUrls} = await summarizeFile(file);
    const nameResult = await proposeName(file, convention, contentSummary, uid, imageUrls);
    const placementResult = await proposePlacementFile(file, runningTree, contentSummary, uid);
    if (placementResult.needs_new_directory && placementResult.new_directory &&
        !knownDirectories.has(placementResult.new_directory.folder_path)) {
      runningTree.push(placementResult.new_directory);
      knownDirectories.add(placementResult.new_directory.folder_path);
    }
    const action = synthesizeFileActionProposal(file, nameResult, placementResult);
    const effective = deriveEffectiveAction(action, file, knownDirectories);
    fileActions.push({
      file_id: action.file_id || file.id,
      current_name: action.current_name || file.name,
      current_path: effective.currentPath,
      new_name: action.new_name || file.name,
      new_folder: effective.newFolder,
      action: effective.action,
      reason: action.reason,
    });
  }

  return {
    proposed_folders: runningTree,
    file_actions: fileActions,
    summary: `Prepared sequential content-aware actions for ${nonFolderFiles.length} files.`,
  };
}

/** Saves an execution artifact in GCS. */
async function saveExecutionJson(path: string, data: unknown): Promise<void> {
  await getStorage().bucket().file(path).save(JSON.stringify(data), {
    contentType: "application/json",
  });
}

/** Loads an execution artifact from GCS. */
async function loadExecutionJson<T>(path: string): Promise<T> {
  const [contents] = await getStorage().bucket().file(path).download();
  return JSON.parse(contents.toString()) as T;
}

/** Loads the saved combined plan from GCS. */
export async function loadSavedPlan(proposalId: string): Promise<DriveOrganizeProposal> {
  return loadExecutionJson<DriveOrganizeProposal>(getPlanStoragePath(proposalId));
}

/** Saves the combined plan JSON artifact. */
export async function saveSavedPlan(proposalId: string, proposal: DriveOrganizeProposal): Promise<void> {
  await saveExecutionJson(getPlanStoragePath(proposalId), proposal);
}

/** Writes RFC 4180 CSV for per-file plan review. */
export function writeFileActionsCsv(fileActions: DriveOrganizeProposal["file_actions"]): Buffer {
  const columns = ["file_id", "action", "current_path", "current_name", "new_folder", "new_name", "reason"];
  const quote = (value: unknown): string => {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, "\"\"")}"`;
  };
  const rows = [
    columns.map(quote).join(","),
    ...fileActions.map((action) => columns.map((column) =>
      quote(action[column as keyof typeof action]),
    ).join(",")),
  ];
  return Buffer.from(rows.join("\r\n") + "\r\n", "utf8");
}

/** Writes CSV to GCS and returns the bytes used for the outbound attachment. */
export async function savePlanCsv(
    proposalId: string,
    fileActions: DriveOrganizeProposal["file_actions"],
): Promise<Buffer> {
  const csvBuffer = writeFileActionsCsv(fileActions);
  await getStorage().bucket().file(getPlanCsvStoragePath(proposalId)).save(csvBuffer, {
    contentType: "text/csv",
  });
  return csvBuffer;
}

function countFileActions(fileActions: DriveOrganizeProposal["file_actions"]): {
  totalFiles: number;
  filesToMove: number;
  filesToRename: number;
  filesToKeep: number;
} {
  return {
    totalFiles: fileActions.length,
    filesToMove: fileActions.filter((a) => a.action === "move" || a.action === "move_and_rename").length,
    filesToRename: fileActions.filter((a) => a.action === "rename" || a.action === "move_and_rename").length,
    filesToKeep: fileActions.filter((a) => a.action === "keep").length,
  };
}

function recomputeAction(
    currentPath: string,
    currentName: string,
    newFolder: string,
    newName: string,
): OrganizeFileActionType {
  const folderChanged = newFolder !== currentPath;
  const nameChanged = newName !== currentName;
  if (folderChanged && nameChanged) return "move_and_rename";
  if (folderChanged) return "move";
  if (nameChanged) return "rename";
  return "keep";
}

/** Applies per-file plan-review patches, dropping unsafe or unknown references. */
export function applyPlanPatches(
    fileActions: DriveOrganizeProposal["file_actions"],
    patches: Array<{
      file_id: string;
      new_name?: string | null;
      new_folder?: string | null;
      action?: OrganizeFileActionType | null;
      reason?: string | null;
    }>,
    approvedFolders: DriveOrganizeProposal["proposed_folders"],
): DriveOrganizeProposal["file_actions"] {
  const approvedPaths = new Set(approvedFolders.map((folder) => folder.folder_path));
  const knownFileIds = new Set(fileActions.map((action) => action.file_id));
  for (const patch of patches) {
    if (!knownFileIds.has(patch.file_id)) {
      logger.warn("Drive organize plan review: dropping patch with unknown file", {
        fileId: patch.file_id,
      });
    }
  }
  const patchesByFileId = new Map(patches.map((patch) => [patch.file_id, patch]));
  return fileActions.map((action) => {
    const patch = patchesByFileId.get(action.file_id);
    if (!patch) {
      return action;
    }
    const isKeepInCurrentFolder = patch.action === "keep" &&
      patch.new_folder === action.current_path;
    if (patch.new_folder && !approvedPaths.has(patch.new_folder) && !isKeepInCurrentFolder) {
      logger.warn("Drive organize plan review: dropping patch with unapproved folder", {
        fileId: patch.file_id,
        newFolder: patch.new_folder,
      });
      return action;
    }
    const newFolder = patch.new_folder ?? action.new_folder;
    const newName = patch.new_name ?? action.new_name;
    return {
      ...action,
      new_folder: newFolder,
      new_name: newName,
      action: patch.action ?? recomputeAction(action.current_path, action.current_name, newFolder, newName),
      reason: patch.reason || action.reason,
    };
  });
}

/** Reads and summarizes a Drive file for content-aware placement. */
async function summarizeExecutionFile(
    oauth2Client: Auth.OAuth2Client,
    file: DriveFileEntry,
): Promise<{contentSummary: string; imageUrls: string[]}> {
  if (file.size > MAX_DRIVE_UPLOAD_BYTES.value()) {
    return {contentSummary: "", imageUrls: []};
  }
  const fileContent = await readDriveFileContent(oauth2Client, file.id, file.mimeType);
  if (!fileContent) {
    return {contentSummary: "", imageUrls: []};
  }
  const contentSummary = await extractContentSummary(fileContent.buffer, fileContent.parserMimeType);
  try {
    const docImageUrls = await extractDocumentImageUrls(fileContent.buffer, fileContent.parserMimeType);
    const isDirectImage = [".png", ".jpg", ".jpeg", ".webp"].some((ext) => file.name.toLowerCase().endsWith(ext));
    const directImageUrls: string[] = [];
    if (isDirectImage && fileContent.buffer.length <= 50 * 1024 * 1024) {
      const base64 = fileContent.buffer.toString("base64");
      directImageUrls.push(`data:${fileContent.parserMimeType};base64,${base64}`);
    }
    return {
      contentSummary,
      imageUrls: [...docImageUrls, ...directImageUrls],
    };
  } catch (error) {
    logger.warn("Drive organize planning chunk: Failed to extract images", {
      fileId: file.id,
      mimeType: fileContent.parserMimeType,
      error: error instanceof Error ? error.message : String(error),
    });
    return {contentSummary, imageUrls: []};
  }
}

/** Resolves or creates a folder path under My Drive. */
async function resolveFolderPath(
    oauth2Client: Auth.OAuth2Client,
    folderMap: Map<string, string>,
    folderPath: string,
): Promise<string> {
  const rootFolderId = await getRootFolderId(oauth2Client);
  const segments = folderPath.split("/").filter(Boolean);
  if (segments.length === 0 || folderPath === "My Drive") {
    return rootFolderId;
  }

  let parentId = rootFolderId;
  let resolvedPath = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    resolvedPath = resolvedPath ? `${resolvedPath}/${segment}` : segment;
    const cached = folderMap.get(resolvedPath);
    if (cached) {
      parentId = cached;
      continue;
    }
    let folderId = await findSubfolderByName(oauth2Client, parentId, segment);
    if (!folderId) {
      folderId = await createFolder(oauth2Client, segment, parentId);
    }
    folderMap.set(resolvedPath, folderId);
    if (i === 0) {
      await placeMarkerFile(oauth2Client, folderId);
    }
    parentId = folderId;
  }
  return parentId;
}

/** Starts chunked, content-aware planning after the final cost estimate is approved. */
export async function startChunkedPlanning(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
): Promise<OrganizeProcessingResult> {
  const state = await getOrganizeIntermediateState(proposalId) as unknown as OrganizeIntermediateState;
  const nonFolderFiles = (state.fileEntries || []).filter((file) => !file.isFolder);
  const approvedStructure =
    proposalDoc.phaseData?.directoryLayout?.approvedStructure ||
    proposalDoc.phaseData?.directoryLayout?.proposedStructure ||
    [];
  const chunkSize = ORGANIZE_DRIVE_CHUNK_SIZE.value();
  const totalChunks = nonFolderFiles.length === 0 ? 0 : Math.ceil(nonFolderFiles.length / chunkSize);
  const planStoragePath = getPlanStoragePath(proposalId);
  const csvStoragePath = getPlanCsvStoragePath(proposalId);

  await updateOrganizeProposalStatus(proposalId, "planning", {
    phase: "plan_review",
    generationStartedAt: new Date().toISOString(),
    phaseData: {
      ...proposalDoc.phaseData,
      execution: {
        chunkSize,
        totalChunks,
        completedChunks: 0,
      },
      planReview: {
        totalFiles: nonFolderFiles.length,
        csvStoragePath,
        planStoragePath,
        fileActionsVersion: 0,
      },
    },
  });

  await saveExecutionJson(getExecutionTreePath(proposalId, -1), approvedStructure);

  if (totalChunks === 0) {
    await updateOrganizeProposalStatus(proposalId, "completed", {
      phase: "completed",
      snapshot: [],
      completedAt: new Date().toISOString(),
    });
    return emptyResult();
  }

  const {dispatchPlanningChunkTask} = await import("./dispatchHandler");
  await dispatchPlanningChunkTask({
    proposalId,
    emailId: proposalDoc.emailId,
    uid,
    chunkIndex: 0,
  });

  return emptyResult(undefined, nonFolderFiles.length);
}

/** Processes one LLM-only planning chunk and dispatches the next chunk. */
export async function processPlanningChunk(
    email: TransformedEmail,
    data: PlanningChunkTaskData,
): Promise<void> {
  const {proposalId, uid, chunkIndex} = data;
  const rawProposal = await getOrganizeProposal(proposalId);
  if (!rawProposal) {
    throw new Error("Organize proposal not found");
  }
  const proposalDoc = rawProposal as unknown as OrganizeProposalDoc;
  const completedChunks = proposalDoc.phaseData?.execution?.completedChunks || 0;
  if (completedChunks > chunkIndex) {
    logger.info("Drive organize planning chunk: Already completed, skipping chunk", {
      proposalId,
      chunkIndex,
      completedChunks,
    });
    return;
  }
  if (proposalDoc.status === "cancelled") {
    logger.info("Drive organize planning chunk: Proposal cancelled, skipping chunk", {
      proposalId,
      chunkIndex,
    });
    return;
  }
  const state = await getOrganizeIntermediateState(proposalId) as unknown as OrganizeIntermediateState;
  const nonFolderFiles = (state.fileEntries || []).filter((file) => !file.isFolder);
  const chunkSize = proposalDoc.phaseData?.execution?.chunkSize || ORGANIZE_DRIVE_CHUNK_SIZE.value();
  const totalChunks = proposalDoc.phaseData?.execution?.totalChunks ||
    Math.ceil(nonFolderFiles.length / chunkSize);
  const chunkFiles = nonFolderFiles.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize);
  const convention =
    proposalDoc.phaseData?.filenameConvention?.convention ||
    "YYYY.MM.DD - Description.ext";
  const runningTree = await loadExecutionJson<DriveOrganizeProposal["proposed_folders"]>(
      getExecutionTreePath(proposalId, chunkIndex - 1),
  );
  const knownDirectories = new Set(runningTree.map((folder) => folder.folder_path));
  const ignoredFolders = (proposalDoc.ignoredFolders ?? [])
      .map((folderPath) => folderPath.split("/").map((segment) => segment.trim()).filter(Boolean).join("/"))
      .filter(Boolean);
  const findIgnoredRoot = (folderPath: string): string | null => {
    const normalized = folderPath.split("/").map((segment) => segment.trim()).filter(Boolean).join("/");
    for (const root of ignoredFolders) {
      if (normalized === root || normalized.startsWith(`${root}/`)) {
        return root;
      }
    }
    return null;
  };
  const stats = {planned: 0, failed: 0, skipped: 0};
  const oauth2Client = await getOauthClient(uid, AGENT_NAME);
  const planConcurrency = ORGANIZE_DRIVE_PLAN_CONCURRENCY.value();
  const orderedChunkFiles = interleaveByParentPath(chunkFiles);
  const results = await mapWithConcurrency(orderedChunkFiles, planConcurrency, async (file) => {
    const ignoredRoot = findIgnoredRoot(file.parentPath || "");
    if (ignoredRoot) {
      return {kind: "ignored", file, ignoredRoot} satisfies PlanningWorkerResult;
    }
    logger.info(`Drive organize planning chunk ${chunkIndex + 1}/${totalChunks}: processing "${file.name}"`, {
      proposalId,
      chunkIndex,
      totalChunks,
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
    });
    const maxAttempts = 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const {contentSummary, imageUrls} = await summarizeExecutionFile(oauth2Client, file);
        const nameResult = await proposeFileName(file, convention, contentSummary, uid, imageUrls);
        const placementResult = await defaultProposePlacement(file, runningTree, contentSummary, uid);
        const proposed = synthesizeFileActionProposal(file, nameResult, placementResult);
        return {kind: "proposed", file, proposed} satisfies PlanningWorkerResult;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          logger.warn("Drive organize planning chunk: file retry", {
            proposalId,
            chunkIndex,
            fileId: file.id,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
    return {kind: "error", file, error: lastError} satisfies PlanningWorkerResult;
  });
  const fileActions = reconcilePlanningChunkResults(
      results,
      runningTree,
      knownDirectories,
      stats,
      {proposalId, chunkIndex},
  );

  await saveExecutionJson(getPlanningChunkPath(proposalId, chunkIndex), {
    file_actions: fileActions,
    stats,
  } satisfies PlanningChunkResult);
  await saveExecutionJson(getExecutionTreePath(proposalId, chunkIndex), runningTree);

  const nextCompletedChunks = chunkIndex + 1;
  const cancelledBeforeNextChunk = await isOrganizeProposalCancelled(proposalId);
  if (cancelledBeforeNextChunk) {
    logger.info("Drive organize planning chunk: Proposal cancelled after chunk, skipping status update", {
      proposalId,
      chunkIndex,
    });
    return;
  }
  await updateOrganizeProposalStatus(proposalId, "planning", {
    phaseData: {
      ...proposalDoc.phaseData,
      execution: {chunkSize, totalChunks, completedChunks: nextCompletedChunks},
    },
  });

  if (nextCompletedChunks < totalChunks) {
    const cancelledBeforeDispatch = await isOrganizeProposalCancelled(proposalId);
    if (cancelledBeforeDispatch) {
      logger.info("Drive organize planning chunk: Proposal cancelled, skipping next chunk dispatch", {
        proposalId,
        chunkIndex,
        nextChunkIndex: chunkIndex + 1,
      });
      return;
    }
    const {dispatchPlanningChunkTask} = await import("./dispatchHandler");
    await dispatchPlanningChunkTask({
      proposalId,
      emailId: data.emailId,
      uid,
      chunkIndex: chunkIndex + 1,
    });
    return;
  }

  const cancelledBeforeFinalize = await isOrganizeProposalCancelled(proposalId);
  if (cancelledBeforeFinalize) {
    logger.info("Drive organize planning chunk: Proposal cancelled, skipping final status update", {
      proposalId,
      chunkIndex,
    });
    return;
  }

  const chunkResults = await Promise.all(
      Array.from({length: totalChunks}, async (_value, i) =>
        loadExecutionJson<PlanningChunkResult>(getPlanningChunkPath(proposalId, i))),
  );
  const proposal: DriveOrganizeProposal = {
    proposed_folders: runningTree,
    file_actions: chunkResults.flatMap((result) => result.file_actions),
    summary: `Prepared file-by-file organization actions for ${nonFolderFiles.length} files.`,
  };
  await saveSavedPlan(proposalId, proposal);
  const csvBuffer = await savePlanCsv(proposalId, proposal.file_actions);
  const sheet =
    ENVIRONMENT_NAME.value() === "local" || ENVIRONMENT_NAME.value() === "test" ?
      getProposalSheetRef(proposalId) :
      await createOrUpdateProposalSheetImpl(oauth2Client, proposalId, csvBuffer);
  const counts = countFileActions(proposal.file_actions);
  const nextPhaseData = {
    ...proposalDoc.phaseData,
    execution: {chunkSize, totalChunks, completedChunks: nextCompletedChunks},
    planReview: {
      totalFiles: proposal.file_actions.length,
      csvStoragePath: getPlanCsvStoragePath(proposalId),
      planStoragePath: getPlanStoragePath(proposalId),
      fileActionsVersion: 1,
      planEmailSentAt: new Date().toISOString(),
      sheetFileId: sheet.fileId,
      sheetWebViewLink: sheet.webViewLink,
    },
  };
  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "plan_review",
    generationStartedAt: null,
    phaseData: nextPhaseData,
  });
  await sendOrganizePlanReviewEmail(proposalDoc.senderEmail, email, proposalId, proposal, sheet.webViewLink, counts);

  sendEvent(uid, "driveOrganizePlanReady", "drive", {
    totalFiles: String(counts.totalFiles),
    filesToMove: String(counts.filesToMove),
    filesToRename: String(counts.filesToRename),
    failed: String(chunkResults.reduce((count, result) => count + result.stats.failed, 0)),
  });
}

/** Starts chunked Drive mutations from a reviewed saved plan. */
export async function startChunkedMove(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
): Promise<OrganizeProcessingResult> {
  const proposal = await loadSavedPlan(proposalId);
  const chunkSize = proposalDoc.phaseData?.execution?.chunkSize || ORGANIZE_DRIVE_CHUNK_SIZE.value();
  const totalChunks = proposal.file_actions.length === 0 ? 0 : Math.ceil(proposal.file_actions.length / chunkSize);
  await updateOrganizeProposalStatus(proposalId, "executing", {
    phase: "executing",
    phaseData: {
      ...proposalDoc.phaseData,
      execution: {chunkSize, totalChunks, completedChunks: 0},
    },
  });
  const execStartedHtml = applyTemplate(driveMailTemplates.organizeExecutionStarted.html, {});
  await sendOrganizeEmailResponse(sender, email, execStartedHtml);

  if (totalChunks === 0) {
    await updateOrganizeProposalStatus(proposalId, "completed", {
      phase: "completed",
      snapshot: [],
      completedAt: new Date().toISOString(),
    });
    return emptyResult();
  }

  const {dispatchMoveChunkTask} = await import("./dispatchHandler");
  await dispatchMoveChunkTask({
    proposalId,
    emailId: proposalDoc.emailId,
    uid,
    chunkIndex: 0,
  });
  return emptyResult(undefined, proposal.file_actions.length);
}

/** Processes one Drive-mutation chunk from the saved plan and dispatches the next chunk. */
export async function processMoveChunk(
    email: TransformedEmail,
    data: MoveChunkTaskData,
): Promise<void> {
  const {proposalId, uid, chunkIndex} = data;
  const rawProposal = await getOrganizeProposal(proposalId);
  if (!rawProposal) {
    throw new Error("Organize proposal not found");
  }
  const proposalDoc = rawProposal as unknown as OrganizeProposalDoc;
  const completedChunks = proposalDoc.phaseData?.execution?.completedChunks || 0;
  if (completedChunks > chunkIndex) {
    logger.info("Drive organize move chunk: Already completed, skipping chunk", {
      proposalId,
      chunkIndex,
      completedChunks,
    });
    return;
  }
  if (proposalDoc.status === "cancelled") {
    logger.info("Drive organize move chunk: Proposal cancelled, skipping chunk", {
      proposalId,
      chunkIndex,
    });
    return;
  }
  const proposal = await loadSavedPlan(proposalId);
  const chunkSize = proposalDoc.phaseData?.execution?.chunkSize || ORGANIZE_DRIVE_CHUNK_SIZE.value();
  const totalChunks = proposalDoc.phaseData?.execution?.totalChunks ||
    Math.ceil(proposal.file_actions.length / chunkSize);
  const chunkActions = proposal.file_actions.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize);
  const oauth2Client = await getOauthClient(uid, AGENT_NAME);
  const drive = getDriveClient(oauth2Client);
  const folderMap = new Map<string, string>();
  const snapshot: OrganizeSnapshotAction[] = [];
  const stats = {moved: 0, renamed: 0, failed: 0, skipped: 0};

  for (const action of chunkActions) {
    if (action.action === "keep") {
      stats.skipped++;
      continue;
    }
    try {
      const meta = await drive.files.get({
        fileId: action.file_id,
        fields: "id, parents, name",
      });
      const currentParentId = meta.data.parents?.[0] || "";
      const snapshotEntry: OrganizeSnapshotAction = {
        fileId: action.file_id,
        originalName: meta.data.name || action.current_name,
        originalParentId: currentParentId,
        originalParentPath: action.current_path,
      };

      if (action.action === "move" || action.action === "move_and_rename") {
        const targetFolderId = await resolveFolderPath(oauth2Client, folderMap, action.new_folder);
        if (targetFolderId !== currentParentId) {
          await moveFile(oauth2Client, action.file_id, targetFolderId, currentParentId);
          snapshotEntry.newParentId = targetFolderId;
          stats.moved++;
        }
      }
      if (action.new_name && action.new_name !== (meta.data.name || action.current_name)) {
        const isFolder = action.current_path === "My Drive" &&
          proposal.proposed_folders.some((f) => f.folder_path === action.new_name);
        if (isFolder) {
          await renameFolder(oauth2Client, action.file_id, action.new_name);
          snapshotEntry.newName = action.new_name;
          stats.renamed++;
        } else {
          await renameFile(oauth2Client, action.file_id, action.new_name);
          snapshotEntry.newName = action.new_name;
          stats.renamed++;
        }
      }
      snapshot.push(snapshotEntry);
    } catch (error) {
      stats.failed++;
      logger.error("Drive organize move chunk: file failed", {
        proposalId,
        chunkIndex,
        fileId: action.file_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await saveExecutionJson(getMoveChunkPath(proposalId, chunkIndex), {
    file_actions: chunkActions,
    snapshot,
    stats,
  } satisfies ExecutionChunkResult);

  const nextCompletedChunks = chunkIndex + 1;
  const cancelledBeforeNextChunk = await isOrganizeProposalCancelled(proposalId);
  if (cancelledBeforeNextChunk) {
    logger.info("Drive organize move chunk: Proposal cancelled after chunk, skipping status update", {
      proposalId,
      chunkIndex,
    });
    return;
  }
  await updateOrganizeProposalStatus(proposalId, "executing", {
    phaseData: {
      ...proposalDoc.phaseData,
      execution: {chunkSize, totalChunks, completedChunks: nextCompletedChunks},
    },
  });

  if (nextCompletedChunks < totalChunks) {
    const cancelledBeforeDispatch = await isOrganizeProposalCancelled(proposalId);
    if (cancelledBeforeDispatch) {
      logger.info("Drive organize move chunk: Proposal cancelled, skipping next chunk dispatch", {
        proposalId,
        chunkIndex,
        nextChunkIndex: chunkIndex + 1,
      });
      return;
    }
    const {dispatchMoveChunkTask} = await import("./dispatchHandler");
    await dispatchMoveChunkTask({
      proposalId,
      emailId: data.emailId,
      uid,
      chunkIndex: chunkIndex + 1,
    });
    return;
  }

  const cancelledBeforeFinalize = await isOrganizeProposalCancelled(proposalId);
  if (cancelledBeforeFinalize) {
    logger.info("Drive organize move chunk: Proposal cancelled, skipping final status update", {
      proposalId,
      chunkIndex,
    });
    return;
  }

  const chunkResults = await Promise.all(
      Array.from({length: totalChunks}, async (_value, i) =>
        loadExecutionJson<ExecutionChunkResult>(getMoveChunkPath(proposalId, i))),
  );
  const fullSnapshot = chunkResults.flatMap((result) => result.snapshot);
  const filesChanged = fullSnapshot.length;

  await finalizeOrganizeProposal(
      proposalId,
      proposal as unknown as Record<string, unknown>,
      (proposalDoc.cost || {}) as unknown as Record<string, unknown>,
  );
  await updateOrganizeProposalStatus(proposalId, "completed", {
    phase: "completed",
    snapshot: fullSnapshot,
    completedAt: new Date().toISOString(),
  });

  await cleanupAllEmptyFolders(oauth2Client);

  const undoToken = signActionToken(proposalId, "undo");
  const undoLink = `${driveOrganizeActionUrl()}?proposalId=${proposalId}&action=undo&token=${undoToken}`;
  const embeddedData: OrganizeEmbeddedData = {proposalId};
  const html = applyTemplate(driveMailTemplates.organizeComplete.html, {
    SUMMARY: formatSummaryHtml(proposal.summary),
    FILES_CHANGED: String(filesChanged),
    FOLDER_TREE: renderFolderTree(proposal),
    EMBEDDED_DATA: buildOrganizeEmbeddedData(embeddedData),
    UNDO_LINK: undoLink,
  });
  await sendOrganizeEmailResponse(proposalDoc.senderEmail, email, html);

  sendEvent(uid, "driveOrganizeCompleted", "drive", {
    filesChanged: String(filesChanged),
    failed: String(chunkResults.reduce((count, result) => count + result.stats.failed, 0)),
  });
}

/** Executes a finalized organization proposal and records a snapshot for undo. */
export async function executeOrganizeProposal(
    oauth2Client: Auth.OAuth2Client,
    proposal: DriveOrganizeProposal,
    _uid: string | null = null,
    _filenameConvention: string = "YYYY.MM.DD - Description.ext",
    _folderConvention: string = DEFAULT_FOLDER_CONVENTION,
    _folderConventionDescription?: string,
): Promise<{
  folderMap: Map<string, string>;
  snapshot: OrganizeSnapshotAction[];
  stats: {moved: number; renamed: number; failed: number; skipped: number};
}> {
  const rootFolderId = await getRootFolderId(oauth2Client);
  const folderMap = new Map<string, string>(); // folder name → folder ID
  const snapshot: OrganizeSnapshotAction[] = [];
  const stats = {moved: 0, renamed: 0, failed: 0, skipped: 0};

  // Phase 1 — Resolve/create folders
  // Fetch existing ROOT-LEVEL folders so we don't create duplicates.
  // Only root-level (parent == rootFolderId) to avoid subfolder name collisions.
  const drive = getDriveClient(oauth2Client);
  const existingRootFolders = new Map<string, string>(); // name → id
  let pageToken: string | undefined;
  do {
    const resp = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false" +
        ` and '${rootFolderId}' in parents`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 1000,
      pageToken,
    });
    for (const f of resp.data.files || []) {
      if (f.id && f.name) {
        existingRootFolders.set(f.name, f.id);
      }
    }
    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);

  // Pre-populate folderMap from existing agent-managed folders (prevents
  // duplicates on repeat organizes) and from folder rename actions.
  const managedFolders = await findAgentManagedFolders(oauth2Client);
  for (const mf of managedFolders.filter((folder) => folder.parentId === rootFolderId)) {
    folderMap.set(mf.name, mf.id);
  }
  for (const action of proposal.file_actions) {
    if (action.action === "rename" && action.current_path === "My Drive" &&
        proposal.proposed_folders.some((f) => f.folder_path === action.new_name)) {
      folderMap.set(action.new_name, action.file_id);
    }
  }

  for (const folder of proposal.proposed_folders) {
    const segments = folder.folder_path.split("/").filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    if (segments.length === 1) {
      let folderId = folderMap.get(folder.folder_path) ||
        existingRootFolders.get(folder.folder_path);
      if (!folderId) {
        folderId = await findSubfolderByName(oauth2Client, rootFolderId, folder.folder_path);
      }
      if (!folderId) {
        folderId = await createFolder(oauth2Client, folder.folder_path, rootFolderId);
      }
      await placeMarkerFile(oauth2Client, folderId);
      folderMap.set(folder.folder_path, folderId);
      continue;
    }

    let parentId = folderMap.get(segments[0]) || existingRootFolders.get(segments[0]);
    if (!parentId) {
      parentId = await findSubfolderByName(oauth2Client, rootFolderId, segments[0]);
    }
    if (!parentId) {
      parentId = await createFolder(oauth2Client, segments[0], rootFolderId);
    }
    await placeMarkerFile(oauth2Client, parentId);
    folderMap.set(segments[0], parentId);

    let resolvedPath = segments[0];
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];
      const currentPath = `${resolvedPath}/${segment}`;
      let folderId = folderMap.get(currentPath);
      if (!folderId) {
        const existingSubId = await findSubfolder(drive, parentId, segment);
        if (existingSubId) {
          folderId = existingSubId;
        } else {
          folderId = await createFolder(oauth2Client, segment, parentId);
        }
        folderMap.set(currentPath, folderId);
      }
      parentId = folderId;
      resolvedPath = currentPath;
    }
  }

  logger.info("Drive organize: Folders resolved", {
    folderCount: folderMap.size,
  });

  // Phase 2 — Execute file actions
  // Batch fetch current parent IDs for files we'll operate on
  const fileIds = proposal.file_actions
      .filter((a) => a.action !== "keep")
      .map((a) => a.file_id);

  // file_id → {parentId, mimeType, size}
  const fileMeta = new Map<string, {parentId: string; mimeType: string; size: number}>();
  for (let i = 0; i < fileIds.length; i += 100) {
    const batch = fileIds.slice(i, i + 100);
    const fetches = batch.map(async (fileId) => {
      try {
        const resp = await drive.files.get({
          fileId, fields: "id, parents, mimeType, size",
        });
        fileMeta.set(fileId, {
          parentId: resp.data.parents?.[0] || "",
          mimeType: resp.data.mimeType || "",
          size: parseInt(resp.data.size || "0", 10),
        });
      } catch {
        logger.warn("Drive organize: Could not fetch file metadata", {fileId});
      }
    });
    await Promise.all(fetches);
  }

  for (const action of proposal.file_actions) {
    if (action.action === "keep") {
      stats.skipped++;
      continue;
    }

    const meta = fileMeta.get(action.file_id);
    if (!meta) {
      logger.warn("Drive organize: No metadata found for file, skipping", {
        fileId: action.file_id, name: action.current_name,
      });
      stats.failed++;
      continue;
    }
    const currentParentId = meta.parentId;

    // Record snapshot entry for undo
    const snapshotEntry: OrganizeSnapshotAction = {
      fileId: action.file_id,
      originalName: action.current_name,
      originalParentId: currentParentId,
      originalParentPath: action.current_path,
    };

    try {
      if (action.action === "move" || action.action === "move_and_rename") {
        let targetFolderId = folderMap.get(action.new_folder);

        // If the full path isn't in the map, resolve by walking/creating
        // subdirectories (e.g. "02-Mld/Invoices/2026")
        if (!targetFolderId && action.new_folder.includes("/")) {
          const segments = action.new_folder.split("/");
          // First segment should already be in folderMap (root agent folder)
          let parentId = folderMap.get(segments[0]);
          if (parentId) {
            let resolvedPath = segments[0];
            for (let si = 1; si < segments.length; si++) {
              const subName = toTitleCase(segments[si]);
              const cachedId = folderMap.get(`${resolvedPath}/${subName}`);
              if (cachedId) {
                parentId = cachedId;
                resolvedPath = `${resolvedPath}/${subName}`;
                continue;
              }
              const existingId = await findSubfolderByName(
                  oauth2Client, parentId, subName,
              );
              if (existingId) {
                parentId = existingId;
              } else {
                parentId = await createFolder(oauth2Client, subName, parentId);
              }
              resolvedPath = `${resolvedPath}/${subName}`;
              folderMap.set(resolvedPath, parentId);
            }
            targetFolderId = parentId;
            folderMap.set(action.new_folder, targetFolderId);
            await placeMarkerFile(oauth2Client, folderMap.get(segments[0])!);
          }
        }

        if (!targetFolderId) {
          logger.warn("Drive organize: Target folder not found", {
            folder: action.new_folder, fileId: action.file_id,
          });
          stats.failed++;
          continue;
        }

        if (targetFolderId !== currentParentId) {
          await moveFile(oauth2Client, action.file_id, targetFolderId, currentParentId);
          snapshotEntry.newParentId = targetFolderId;
          stats.moved++;
        }
      }

      const isFolder = action.current_path === "My Drive" &&
        proposal.proposed_folders.some((f) => f.folder_path === action.new_name);
      if (isFolder) {
        await renameFolder(oauth2Client, action.file_id, action.new_name);
      } else {
        await renameFile(oauth2Client, action.file_id, action.new_name);
      }
      snapshotEntry.newName = action.new_name;
      stats.renamed++;

      snapshot.push(snapshotEntry);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Drive organize: Action failed", {
        fileId: action.file_id, action: action.action, error: errMsg,
      });
      stats.failed++;
    }
  }

  logger.info("Drive organize: Execution complete", stats);
  return {folderMap, snapshot, stats};
}

/**
 * Find a subfolder by name within a parent folder.
 */
export async function findSubfolder(
    drive: ReturnType<typeof getDriveClient>,
    parentId: string,
    name: string,
): Promise<string | null> {
  const resp = await drive.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents ` +
      `and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });
  return resp.data.files?.[0]?.id || null;
}

// ============================================================================

export const organizeExecutionTestHooks = {
  setCreateOrUpdateProposalSheetForTest(fn: typeof createOrUpdateProposalSheetImpl | null): void {
    createOrUpdateProposalSheetImpl = fn || createOrUpdateProposalSheet;
  },
};
