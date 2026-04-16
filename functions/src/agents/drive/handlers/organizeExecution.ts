import {logger} from "firebase-functions/v2";
import {getStorage} from "firebase-admin/storage";
import {Auth} from "googleapis";
import {getOauthClient} from "../../../auth/authHandler";
import {
  finalizeOrganizeProposal,
  getOrganizeIntermediateState,
  getOrganizeProposal,
  updateOrganizeProposalStatus,
} from "../../../util/firestoreHandler";
import {sendEvent} from "../../../util/analytics";
import {TransformedEmail} from "../../../util/types";
import {AGENT_NAME, MAX_DRIVE_UPLOAD_BYTES, ORGANIZE_DRIVE_CHUNK_SIZE} from "../config";
import {driveMailTemplates, driveOrganizeActionUrl} from "../mailTemplates";
import {
  DriveFileEntry,
  DriveOrganizeProposal,
  ExecutionChunkTaskData,
  FileInfo,
  OrganizeEmbeddedData,
  OrganizeIntermediateState,
  OrganizeProcessingResult,
  OrganizeProposalDoc,
  OrganizeSnapshotAction,
} from "../types";
import {buildOrganizeEmbeddedData, renderFolderTree} from "../templates/folderTree";
import {extractContentSummary, extractDocumentImageUrls} from "../fileProcessor";
import {DEFAULT_FOLDER_CONVENTION, proposeFileAction, proposeFilePlacement} from "../llm";
import {ProposeFileActionResult} from "../prompts/proposeFileAction/v1";
import {applyTemplate, getNextFolderPrefix, toTitleCase} from "../driveUtils";
import {
  emptyResult,
  formatSummaryHtml,
  sendOrganizeEmailResponse,
  signActionToken,
} from "./organizeHelpers";
import {
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

type ExecutionChunkResult = {
  file_actions: DriveOrganizeProposal["file_actions"];
  snapshot: OrganizeSnapshotAction[];
  stats: {moved: number; renamed: number; failed: number; skipped: number};
};

type FileSummaryProvider = (file: DriveFileEntry) => Promise<string>;
type FileActionProposer = (
  directoryTree: DriveOrganizeProposal["proposed_folders"],
  convention: string,
  file: DriveFileEntry,
  contentSummary: string,
  uid: string,
) => Promise<ProposeFileActionResult>;

const getExecutionTreePath = (proposalId: string, chunkIndex: number) =>
  `organize-proposals/${proposalId}-execution-tree-${chunkIndex}.json`;
const getExecutionChunkPath = (proposalId: string, chunkIndex: number) =>
  `organize-proposals/${proposalId}-execution-chunk-${chunkIndex}.json`;

/** Builds content-aware actions sequentially while carrying forward newly-created directories. */
export async function buildSequentialExecutionProposal(
    fileEntries: DriveFileEntry[],
    approvedStructure: DriveOrganizeProposal["proposed_folders"],
    convention: string,
    uid: string,
    summarizeFile: FileSummaryProvider,
    proposeAction: FileActionProposer = proposeFileAction,
): Promise<DriveOrganizeProposal> {
  const nonFolderFiles = fileEntries.filter((file) => !file.isFolder);
  const runningTree = approvedStructure.map((folder) => ({...folder}));
  const knownDirectories = new Set(runningTree.map((folder) => folder.folder_path));
  const fileActions: DriveOrganizeProposal["file_actions"] = [];

  for (const file of nonFolderFiles) {
    const contentSummary = await summarizeFile(file);
    const action = await proposeAction(runningTree, convention, file, contentSummary, uid);
    if (action.needs_new_directory && action.new_directory &&
        !knownDirectories.has(action.new_directory.folder_path)) {
      runningTree.push(action.new_directory);
      knownDirectories.add(action.new_directory.folder_path);
    }
    fileActions.push({
      file_id: action.file_id || file.id,
      current_name: action.current_name || file.name,
      current_path: action.current_path || file.parentPath,
      new_name: action.new_name || file.name,
      new_folder: action.target_directory || file.parentPath,
      action: action.action,
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

/** Reads and summarizes a Drive file for content-aware placement. */
async function summarizeExecutionFile(
    oauth2Client: Auth.OAuth2Client,
    file: DriveFileEntry,
): Promise<string> {
  if (file.size > MAX_DRIVE_UPLOAD_BYTES.value()) {
    return "";
  }
  const fileContent = await readDriveFileContent(oauth2Client, file.id, file.mimeType);
  if (!fileContent) {
    return "";
  }
  return extractContentSummary(fileContent.buffer, fileContent.parserMimeType);
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

/** Starts chunked, content-aware execution after the final cost estimate is approved. */
export async function startChunkedExecution(
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

  await updateOrganizeProposalStatus(proposalId, "executing", {
    phase: "executing",
    generationStartedAt: new Date().toISOString(),
    phaseData: {
      ...proposalDoc.phaseData,
      execution: {
        chunkSize,
        totalChunks,
        completedChunks: 0,
      },
    },
  });

  const execStartedHtml = applyTemplate(driveMailTemplates.organizeExecutionStarted.html, {});
  await sendOrganizeEmailResponse(sender, email, execStartedHtml);
  await saveExecutionJson(getExecutionTreePath(proposalId, -1), approvedStructure);

  if (totalChunks === 0) {
    await updateOrganizeProposalStatus(proposalId, "completed", {
      phase: "completed",
      snapshot: [],
      completedAt: new Date().toISOString(),
    });
    return emptyResult();
  }

  const {dispatchExecutionChunkTask} = await import("./dispatchHandler");
  await dispatchExecutionChunkTask({
    proposalId,
    emailId: proposalDoc.emailId,
    uid,
    chunkIndex: 0,
  });

  return emptyResult(undefined, nonFolderFiles.length);
}

/** Processes one chunk of content-aware execution and dispatches the next chunk. */
export async function processExecutionChunk(
    email: TransformedEmail,
    data: ExecutionChunkTaskData,
): Promise<void> {
  const {proposalId, uid, chunkIndex} = data;
  const rawProposal = await getOrganizeProposal(proposalId);
  if (!rawProposal) {
    throw new Error("Organize proposal not found");
  }
  const proposalDoc = rawProposal as unknown as OrganizeProposalDoc;
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
  const folderMap = new Map<string, string>();
  const fileActions: DriveOrganizeProposal["file_actions"] = [];
  const snapshot: OrganizeSnapshotAction[] = [];
  const stats = {moved: 0, renamed: 0, failed: 0, skipped: 0};
  const oauth2Client = await getOauthClient(uid, AGENT_NAME);
  const drive = getDriveClient(oauth2Client);

  for (const file of chunkFiles) {
    try {
      const contentSummary = await summarizeExecutionFile(oauth2Client, file);
      const proposed = await proposeFileAction(runningTree, convention, file, contentSummary, uid);
      if (proposed.needs_new_directory && proposed.new_directory &&
          !knownDirectories.has(proposed.new_directory.folder_path)) {
        runningTree.push(proposed.new_directory);
        knownDirectories.add(proposed.new_directory.folder_path);
      }

      const action = {
        file_id: proposed.file_id || file.id,
        current_name: proposed.current_name || file.name,
        current_path: proposed.current_path || file.parentPath,
        new_name: proposed.new_name || file.name,
        new_folder: proposed.target_directory || file.parentPath,
        action: proposed.action,
        reason: proposed.reason,
      };
      fileActions.push(action);

      if (action.action === "keep") {
        stats.skipped++;
        continue;
      }

      const meta = await drive.files.get({
        fileId: file.id,
        fields: "id, parents, name",
      });
      const currentParentId = meta.data.parents?.[0] || "";
      const snapshotEntry: OrganizeSnapshotAction = {
        fileId: file.id,
        originalName: meta.data.name || file.name,
        originalParentId: currentParentId,
        originalParentPath: file.parentPath,
      };

      if (action.action === "move" || action.action === "move_and_rename") {
        const targetFolderId = await resolveFolderPath(oauth2Client, folderMap, action.new_folder);
        if (targetFolderId !== currentParentId) {
          await moveFile(oauth2Client, file.id, targetFolderId, currentParentId);
          snapshotEntry.newParentId = targetFolderId;
          stats.moved++;
        }
      }
      if (action.action === "rename" || action.action === "move_and_rename") {
        await renameFile(oauth2Client, file.id, action.new_name);
        snapshotEntry.newName = action.new_name;
        stats.renamed++;
      }
      snapshot.push(snapshotEntry);
    } catch (error) {
      stats.failed++;
      logger.error("Drive organize execution chunk: file failed", {
        proposalId,
        chunkIndex,
        fileId: file.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await saveExecutionJson(getExecutionChunkPath(proposalId, chunkIndex), {
    file_actions: fileActions,
    snapshot,
    stats,
  } satisfies ExecutionChunkResult);
  await saveExecutionJson(getExecutionTreePath(proposalId, chunkIndex), runningTree);

  const completedChunks = chunkIndex + 1;
  await updateOrganizeProposalStatus(proposalId, "executing", {
    phaseData: {
      ...proposalDoc.phaseData,
      execution: {chunkSize, totalChunks, completedChunks},
    },
  });

  if (completedChunks < totalChunks) {
    const {dispatchExecutionChunkTask} = await import("./dispatchHandler");
    await dispatchExecutionChunkTask({
      proposalId,
      emailId: data.emailId,
      uid,
      chunkIndex: chunkIndex + 1,
    });
    return;
  }

  const chunkResults = await Promise.all(
      Array.from({length: totalChunks}, async (_value, i) =>
        loadExecutionJson<ExecutionChunkResult>(getExecutionChunkPath(proposalId, i))),
  );
  const proposal: DriveOrganizeProposal = {
    proposed_folders: runningTree,
    file_actions: chunkResults.flatMap((result) => result.file_actions),
    summary: `Organized ${nonFolderFiles.length} files using the approved folder and filename conventions.`,
  };
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
    uid: string | null = null,
    filenameConvention: string = "YYYY.MM.DD - Description.ext",
    folderConvention: string = DEFAULT_FOLDER_CONVENTION,
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
        ` and 'me' in owners and '${rootFolderId}' in parents`,
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
  for (const mf of managedFolders) {
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
        folderId = await createFolder(oauth2Client, folder.folder_path, rootFolderId);
        await placeMarkerFile(oauth2Client, folderId);
      }
      folderMap.set(folder.folder_path, folderId);
      continue;
    }

    let parentId = folderMap.get(segments[0]) || existingRootFolders.get(segments[0]);
    if (!parentId) {
      parentId = await createFolder(oauth2Client, segments[0], rootFolderId);
      await placeMarkerFile(oauth2Client, parentId);
      folderMap.set(segments[0], parentId);
    }

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

      if (action.action === "rename" || action.action === "move_and_rename") {
        // For folder rename actions, use renameFolder.
        const isFolder = action.current_path === "My Drive" &&
          proposal.proposed_folders.some((f) => f.folder_path === action.new_name);
        if (isFolder) {
          await renameFolder(oauth2Client, action.file_id, action.new_name);
          snapshotEntry.newName = action.new_name;
        } else {
          // Content-aware naming: read file, extract content, get LLM-suggested name
          // Skip files exceeding the upload size limit (same as file proposal flow)
          let finalName = action.new_name;
          try {
            let fileContent = meta.size <= MAX_DRIVE_UPLOAD_BYTES.value() ?
              await readDriveFileContent(oauth2Client, action.file_id, meta.mimeType) :
              null;
            if (fileContent) {
              const contentSummary = await extractContentSummary(
                  fileContent.buffer, fileContent.parserMimeType,
              );
              // Mirror file-proposal image extraction (buildFileInfos + collectImageUrls)
              // 1. Document page images (same as buildFileInfos → extractDocumentImageUrls)
              const docImageUrls = await extractDocumentImageUrls(
                  fileContent.buffer, fileContent.parserMimeType,
              );
              // 2. Image files directly as base64 (equivalent to collectImageUrls, but
              //    we already have the buffer instead of a download URL)
              const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"];
              const isImage = imageExtensions.some((ext) =>
                action.current_name.toLowerCase().endsWith(ext));
              const directImageUrls: string[] = [];
              if (isImage && fileContent.buffer.length <= 50 * 1024 * 1024) {
                const base64 = fileContent.buffer.toString("base64");
                directImageUrls.push(`data:${meta.mimeType};base64,${base64}`);
              }
              const imageUrls = [...docImageUrls, ...directImageUrls];
              // Release buffer before LLM call to avoid holding both buffer + base64 in memory
              fileContent = null;

              // Proceed if we have text content OR image data for the LLM
              if (contentSummary || imageUrls.length > 0) {
                const fileInfo: FileInfo = {
                  fileName: action.current_name,
                  mimeType: meta.mimeType,
                  fileSize: meta.size,
                  contentSummary,
                };
                const agentFolderNames = [...folderMap.keys()];
                const nextPrefix = getNextFolderPrefix(agentFolderNames);
                const placement = await proposeFilePlacement(
                    [fileInfo], "", "", agentFolderNames, nextPrefix, uid, imageUrls,
                    filenameConvention, folderConvention,
                );
                if (placement.proposals[0]?.suggested_name) {
                  finalName = placement.proposals[0].suggested_name;
                  logger.info("Drive organize: Content-aware rename", {
                    fileId: action.file_id,
                    metadataName: action.new_name,
                    contentName: finalName,
                  });
                }
              }
            }
          } catch (contentErr) {
            const msg = contentErr instanceof Error ? contentErr.message : String(contentErr);
            logger.warn("Drive organize: Content-aware naming failed, using metadata name", {
              fileId: action.file_id, error: msg,
            });
          }
          await renameFile(oauth2Client, action.file_id, finalName);
          snapshotEntry.newName = finalName;
        }
        stats.renamed++;
      }

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
