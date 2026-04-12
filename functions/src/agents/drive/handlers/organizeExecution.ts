import {logger} from "firebase-functions/v2";
import {Auth} from "googleapis";
import {MAX_DRIVE_UPLOAD_BYTES} from "../config";
import {DriveOrganizeProposal, FileInfo, OrganizeSnapshotAction} from "../types";
import {extractContentSummary, extractDocumentImageUrls} from "../fileProcessor";
import {proposeFilePlacement} from "../llm";
import {getNextFolderPrefix, toTitleCase} from "../driveUtils";
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

/** Executes a finalized organization proposal and records a snapshot for undo. */
export async function executeOrganizeProposal(
    oauth2Client: Auth.OAuth2Client,
    proposal: DriveOrganizeProposal,
    uid: string | null = null,
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
        // For folder renames (from seedFoldersFromDrive), use renameFolder
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
