import {logger} from "firebase-functions/v2";
import {
  getDriveUserPreferences, getUserFromEmail, saveDriveUserPreferences, updateDriveFileData,
} from "../../../util/firestoreHandler";
import {getOauthClient} from "../../../auth/authHandler";
import {AGENT_NAME} from "../config";
import {sendEvent} from "../../../util/analytics";
import {TransformedEmail} from "../../../util/types";
import {
  DriveProcessingResult, ProcessedDriveFile,
  DriveFolder, DriveEmbeddedFileData, MoveInstruction,
} from "../types";
import {driveMailTemplates, PreferenceChange, renderPreferencesUpdatedBlock} from "../mailTemplates";
import {
  getDriveFolderTree, findFolderInTree, getRootFolderId,
  moveFile, createFolder, placeMarkerFile,
  findAgentManagedFolders, renameFolder, getFolderFileCount,
  findSubfolderByName, trashFile, renameFile,
} from "../driveHelper";
import {DEFAULT_FILENAME_CONVENTION, DEFAULT_FOLDER_CONVENTION, interpretMoveInstructions} from "../llm";
import {
  toTitleCase, applyTemplate, sendDriveEmailResponse,
  getNextFolderPrefix, buildEmbeddedDriveHtml,
  buildEmbeddedDriveData, findFolderByName, isDriveAuthError,
} from "../driveUtils";

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Persists preference updates returned by move-instruction parsing. */
export async function persistMovePreferenceUpdates(
    uid: string,
    moveResult: MoveInstruction,
): Promise<{
  preferencesUpdatedBlock: string;
  folderConvention: string;
  filenameConvention: string;
}> {
  const existingPreferences = await getDriveUserPreferences(uid);
  const currentFolderConvention = getNonEmptyString(existingPreferences.folderConvention) ||
    DEFAULT_FOLDER_CONVENTION;
  const currentFilenameConvention = getNonEmptyString(existingPreferences.filenameConvention) ||
    DEFAULT_FILENAME_CONVENTION;
  const preferenceUpdates: Record<string, string> = {};
  const preferenceChanges: PreferenceChange[] = [];
  const nextFolderConvention = getNonEmptyString(moveResult.folder_convention_update);
  const nextFilenameConvention = getNonEmptyString(moveResult.filename_convention_update);
  if (nextFolderConvention && nextFolderConvention !== currentFolderConvention) {
    preferenceUpdates.folderConvention = nextFolderConvention;
    preferenceChanges.push({
      label: "Folder convention",
      before: currentFolderConvention,
      after: nextFolderConvention,
    });
  }
  if (nextFilenameConvention && nextFilenameConvention !== currentFilenameConvention) {
    preferenceUpdates.filenameConvention = nextFilenameConvention;
    preferenceChanges.push({
      label: "Filename convention",
      before: currentFilenameConvention,
      after: nextFilenameConvention,
    });
  }
  if (Object.keys(preferenceUpdates).length > 0) {
    await saveDriveUserPreferences(uid, preferenceUpdates);
  }
  return {
    preferencesUpdatedBlock: renderPreferencesUpdatedBlock(
        preferenceChanges,
        "Saved this preference for future Drive organization.",
    ),
    folderConvention: preferenceUpdates.folderConvention || currentFolderConvention,
    filenameConvention: preferenceUpdates.filenameConvention || currentFilenameConvention,
  };
}

/**
 * Handle a user reply that contains move instructions.
 * Parses embedded data from the quoted thread, moves files, sends confirmation.
 */
export async function handleMoveReply(
    email: TransformedEmail,
    sender: string,
    files: DriveEmbeddedFileData[],
    fileDataId: string | null,
): Promise<DriveProcessingResult> {
  const uid = await getUserFromEmail(sender);
  if (!uid) {
    logger.warn("Drive: Move reply from unknown user", {sender});
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "User not found"};
  }

  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid, AGENT_NAME);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive: OAuth failed for move", {uid, error: errMsg});
    const html = applyTemplate(driveMailTemplates.driveAuthFailed.html, {});
    await sendDriveEmailResponse(sender, email, html);
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "OAuth failed"};
  }

  // Get folder tree + agent folders
  let folderTree: DriveFolder[];
  try {
    folderTree = await getDriveFolderTree(oauth2Client);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isDriveAuthError(errMsg)) {
      logger.warn("Drive: Auth error fetching folder tree", {uid, error: errMsg});
      const html = applyTemplate(driveMailTemplates.driveAuthFailed.html, {});
      await sendDriveEmailResponse(sender, email, html);
      sendEvent(uid, "driveAuthFailed", "drive");
      return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "Auth failed"};
    }
    logger.debug("Drive: Could not fetch folder tree", {error: errMsg});
    folderTree = [];
  }

  let agentFolders;
  try {
    agentFolders = await findAgentManagedFolders(oauth2Client);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isDriveAuthError(errMsg)) {
      logger.warn("Drive: Auth error fetching agent folders", {uid, error: errMsg});
      const html = applyTemplate(driveMailTemplates.driveAuthFailed.html, {});
      await sendDriveEmailResponse(sender, email, html);
      sendEvent(uid, "driveAuthFailed", "drive");
      return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "Auth failed"};
    }
    throw err;
  }

  // LLM: interpret move instructions (only agent-managed folders)
  const replyText = email.text || "";
  const movePreferences = await getDriveUserPreferences(uid);
  const moveFilenameConvention = getNonEmptyString(movePreferences.filenameConvention) ||
    DEFAULT_FILENAME_CONVENTION;
  let moveResult;
  try {
    moveResult = await interpretMoveInstructions(
        replyText,
        files,
        agentFolders.map((f) => ({name: f.name, id: f.id})),
        uid,
        moveFilenameConvention,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive: LLM move interpretation failed", {error: errMsg});
    const html = applyTemplate(driveMailTemplates.moveFailed.html, {});
    await sendDriveEmailResponse(sender, email, html);
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "LLM failed"};
  }

  logger.info("Drive: LLM move result", {
    moves: moveResult.moves.map((m) => ({
      file_index: m.file_index,
      folder_id: m.folder_id,
      folder_path: m.folder_path,
      new_filename: m.new_filename,
    })),
  });

  const {
    preferencesUpdatedBlock,
    folderConvention: finalFolderConvention,
    filenameConvention: finalFilenameConvention,
  } = await persistMovePreferenceUpdates(uid, moveResult);

  // Resolve target folder and move files
  let rootFolderId: string;
  try {
    rootFolderId = await getRootFolderId(oauth2Client);
  } catch (err) {
    logger.debug("Drive: Could not get root folder ID, using 'root'", {
      error: err instanceof Error ? err.message : String(err),
    });
    rootFolderId = "root";
  }

  // Track source folders already renamed so we don't rename twice
  const renamedFolders = new Map<string, string>(); // folderId → newName
  // Track resolved categories to prevent duplicate folder creation
  // category (lowercase) → {folderId, folderPath}
  const resolvedCategories = new Map<string, {folderId: string; folderPath: string}>();
  // Track the resolved folder ID for each file (for embedded data in reply)
  const fileFolderIds = new Map<string, string>(); // filename → folderId

  const results: ProcessedDriveFile[] = [];
  const trashedFiles: string[] = []; // filenames of trashed files
  for (const move of moveResult.moves) {
    const file = files[move.file_index];
    if (!file) continue;

    // Handle trash action — delete the file instead of moving it
    if (move.action === "trash") {
      try {
        await trashFile(oauth2Client, file.id);
        trashedFiles.push(file.filename);
        results.push({
          filename: file.filename,
          folderPath: "Trash",
          suggestedName: file.filename,
          driveFileId: file.id,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (isDriveAuthError(errMsg)) {
          logger.warn("Drive: Auth error during trash", {uid, fileId: file.id, error: errMsg});
          const html = applyTemplate(driveMailTemplates.driveAuthFailed.html, {});
          await sendDriveEmailResponse(sender, email, html);
          sendEvent(uid, "driveAuthFailed", "drive");
          return {
            filesProcessed: files.length, filesSucceeded: 0,
            filesFailed: files.length, results: [], error: "Auth failed",
          };
        }
        logger.error("Drive: Failed to trash file", {fileId: file.id, error: errMsg});
        results.push({
          filename: file.filename,
          folderPath: file.folderPath,
          suggestedName: file.filename,
          error: `Trash failed: ${errMsg}`,
        });
      }
      continue;
    }

    let newFolderId: string;
    let newFolderPath: string;
    let skipMove = false;

    // Split path into root folder and subdirectories
    const rawPath = move.folder_path || move.folder_id;
    const pathSegments = rawPath.split("/").filter((s) => s.trim());
    const rootSegment = pathSegments[0] || rawPath;
    const subSegments = pathSegments.slice(1).map((s) => toTitleCase(s));

    // Normalize target category for dedup (use full path for uniqueness)
    const rawCategory = toTitleCase(rootSegment);
    const fullPathKey = [rawCategory, ...subSegments].join("/")
        .replace(/^\d{2,3}-/, "").toLowerCase();

    // Check if we already resolved this full path in a previous iteration
    const alreadyResolved = resolvedCategories.get(fullPathKey);
    if (alreadyResolved) {
      newFolderId = alreadyResolved.folderId;
      newFolderPath = alreadyResolved.folderPath;
      // Skip move if the file is already in this folder (e.g., folder was renamed)
      skipMove = file.folderId === newFolderId;
    } else {
      // Resolve target root folder
      const needsNewFolder =
        (move.folder_id === "root" && move.folder_path) ||
        (!findFolderInTree(folderTree, move.folder_id) &&
         !findFolderByName(folderTree, rootSegment));

      if (needsNewFolder) {
        const targetCategory = rawCategory;
        // Ensure targetName always has NNN- prefix and Title Case
        const hasPrefix = /^\d{2,3}-/.test(targetCategory);
        const targetName = hasPrefix ? targetCategory :
          `${getNextFolderPrefix(agentFolders.map((f) => f.name))}-${targetCategory}`;

        const sourceAgent = agentFolders.find(
            (f) => f.id === file.folderId,
        );

        // If source is agent-managed and will be empty, rename instead
        // (only when no subdirectories — rename doesn't make sense with subdirs)
        if (sourceAgent && !renamedFolders.has(file.folderId) &&
            subSegments.length === 0) {
          const fileCount = await getFolderFileCount(
              oauth2Client, file.folderId,
          );
          const movingOut = moveResult.moves.filter(
              (m) => files[m.file_index]?.folderId === file.folderId,
          ).length;

          if (fileCount <= movingOut) {
            // Preserve the source folder's existing NNN- prefix
            const sourcePrefixMatch = sourceAgent.name.match(/^(\d{2,3}-)/);
            const renameTo = sourcePrefixMatch ?
              `${sourcePrefixMatch[1]}${targetCategory}` : targetName;
            await renameFolder(oauth2Client, file.folderId, renameTo);
            renamedFolders.set(file.folderId, renameTo);
            newFolderId = file.folderId;
            newFolderPath = renameTo;
            skipMove = true;
          } else {
            newFolderId = await createFolder(
                oauth2Client, targetName, rootFolderId,
            );
            newFolderPath = targetName;
            await placeMarkerFile(oauth2Client, newFolderId);
          }
        } else if (renamedFolders.has(file.folderId) &&
            subSegments.length === 0) {
          // Folder already renamed for a previous file in this batch
          newFolderId = file.folderId;
          newFolderPath = renamedFolders.get(file.folderId)!;
          skipMove = true;
        } else {
          // Check if the target root folder already exists as an agent-managed folder
          // (e.g. moving to "03-Finance/Invoices" when "03-Finance" already exists)
          const existingAgent = agentFolders.find((f) => {
            const fBase = f.name.replace(/^\d{2,3}-\s*/, "").toLowerCase();
            const tBase = targetCategory.replace(/^\d{2,3}-\s*/, "").toLowerCase();
            return f.name === targetName || fBase === tBase;
          });
          if (existingAgent) {
            newFolderId = existingAgent.id;
            newFolderPath = existingAgent.name;
          } else {
            newFolderId = await createFolder(
                oauth2Client, targetName, rootFolderId,
            );
            newFolderPath = targetName;
            await placeMarkerFile(oauth2Client, newFolderId);
          }
        }
      } else {
        // Target folder exists — only use it if it's agent-managed
        const isAgentTarget = agentFolders.some(
            (f) => f.id === move.folder_id,
        );
        if (isAgentTarget) {
          const agentFolder = agentFolders.find(
              (f) => f.id === move.folder_id,
          )!;
          newFolderId = agentFolder.id;
          newFolderPath = agentFolder.name;
        } else {
          // LLM picked a non-agent folder — create agent-managed one
          const targetName = toTitleCase(rootSegment);
          const nextPfx = getNextFolderPrefix(
              agentFolders.map((f) => f.name),
          );
          const agentName = `${nextPfx}-${targetName}`;
          newFolderId = await createFolder(
              oauth2Client, agentName, rootFolderId,
          );
          newFolderPath = agentName;
          await placeMarkerFile(oauth2Client, newFolderId);
        }
      }

      // Resolve subdirectories within the root folder
      const rootFolderIdForMarker = newFolderId;
      for (const subName of subSegments) {
        const existingSubId = await findSubfolderByName(
            oauth2Client, newFolderId, subName,
        );
        if (existingSubId) {
          newFolderId = existingSubId;
        } else {
          newFolderId = await createFolder(oauth2Client, subName, newFolderId);
        }
        newFolderPath = `${newFolderPath}/${subName}`;
      }

      // Place marker in root agent folder (if subdirs were created)
      if (subSegments.length > 0) {
        await placeMarkerFile(oauth2Client, rootFolderIdForMarker);
      }

      // Cache the resolved path for subsequent files
      resolvedCategories.set(fullPathKey, {folderId: newFolderId, folderPath: newFolderPath});
    }

    // Safety net: ensure folder name has NNN- prefix — only rename managed folders
    const isManaged = agentFolders.some((f) => f.id === newFolderId);
    if (!/^\d{2,3}-/.test(newFolderPath) && isManaged) {
      const safePfx = getNextFolderPrefix(agentFolders.map((f) => f.name));
      logger.warn("Drive: Managed folder missing NNN- prefix, renaming", {
        original: newFolderPath, prefix: safePfx,
      });
      const safeName = `${safePfx}-${newFolderPath}`;
      await renameFolder(oauth2Client, newFolderId, safeName);
      newFolderPath = safeName;
    }

    try {
      const displayName = move.new_filename || file.filename;
      if (skipMove) {
        // File is already in the renamed folder
        if (move.new_filename) {
          await renameFile(oauth2Client, file.id, move.new_filename);
        }
        fileFolderIds.set(file.filename, newFolderId);
        results.push({
          filename: file.filename,
          folderPath: newFolderPath,
          suggestedName: displayName,
          driveFileId: file.id,
          driveWebLink: file.webLink,
        });
      } else {
        const moved = await moveFile(
            oauth2Client, file.id, newFolderId, file.folderId,
        );
        if (move.new_filename) {
          await renameFile(oauth2Client, file.id, move.new_filename);
        }
        await placeMarkerFile(oauth2Client, newFolderId);
        fileFolderIds.set(file.filename, newFolderId);

        results.push({
          filename: file.filename,
          folderPath: newFolderPath,
          suggestedName: displayName,
          driveFileId: moved.id,
          driveWebLink: moved.webViewLink,
        });
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (isDriveAuthError(errMsg)) {
        logger.warn("Drive: Auth error during move", {uid, fileId: file.id, error: errMsg});
        const html = applyTemplate(driveMailTemplates.driveAuthFailed.html, {});
        await sendDriveEmailResponse(sender, email, html);
        sendEvent(uid, "driveAuthFailed", "drive");
        return {
          filesProcessed: files.length, filesSucceeded: 0,
          filesFailed: files.length, results: [], error: "Auth failed",
        };
      }
      logger.error("Drive: Failed to move file", {
        fileId: file.id, error: errMsg,
      });
      results.push({
        filename: file.filename,
        folderPath: file.folderPath,
        suggestedName: file.filename,
        error: `Move failed: ${errMsg}`,
      });
    }
  }

  const succeeded = results.filter((r) => !r.error);
  const movedFiles = succeeded.filter((r) => !trashedFiles.includes(r.filename));

  if (succeeded.length === 0) {
    const html = preferencesUpdatedBlock ?
      applyTemplate(driveMailTemplates.preferencesUpdated.html, {
        PREFERENCES_UPDATED: preferencesUpdatedBlock,
        CURRENT_FOLDER_CONVENTION: finalFolderConvention,
        CURRENT_FILENAME_CONVENTION: finalFilenameConvention,
      }) :
      applyTemplate(driveMailTemplates.moveFailed.html, {});
    await sendDriveEmailResponse(sender, email, html);
  } else if (trashedFiles.length > 0 && movedFiles.length === 0) {
    // All files were trashed
    if (trashedFiles.length === 1) {
      const html = applyTemplate(driveMailTemplates.fileTrashed.html, {
        FILE_NAME: trashedFiles[0],
        PREFERENCES_UPDATED: preferencesUpdatedBlock,
      });
      await sendDriveEmailResponse(sender, email, html);
    } else {
      const fileListHtml = trashedFiles.map((f) => `<b>${f}</b>`).join("<br>");
      const html = applyTemplate(driveMailTemplates.multipleFilesTrashed.html, {
        FILE_LIST: fileListHtml,
        PREFERENCES_UPDATED: preferencesUpdatedBlock,
      });
      await sendDriveEmailResponse(sender, email, html);
    }
  } else {
    // Some or all files were moved (not trashed)
    const updatedFiles: DriveEmbeddedFileData[] = movedFiles.map((r) => ({
      id: r.driveFileId || "",
      folderId: fileFolderIds.get(r.filename) || "",
      folderPath: r.folderPath,
      filename: r.suggestedName,
      webLink: r.driveWebLink || "",
    }));

    let embeddedHtml: string;
    if (fileDataId) {
      await updateDriveFileData(fileDataId, updatedFiles);
      embeddedHtml = buildEmbeddedDriveHtml(fileDataId);
    } else {
      embeddedHtml = await buildEmbeddedDriveData(uid, updatedFiles);
    }

    if (movedFiles.length === 1) {
      const file = movedFiles[0];
      const html = applyTemplate(driveMailTemplates.fileMoved.html, {
        FILE_NAME: file.suggestedName,
        NEW_PATH: file.folderPath,
        FILE_LINK: file.driveWebLink || "#",
        PREFERENCES_UPDATED: preferencesUpdatedBlock,
        EMBEDDED_DATA: embeddedHtml,
      });
      await sendDriveEmailResponse(sender, email, html);
    } else {
      const fileListHtml = movedFiles.map((file) =>
        `<b>${file.suggestedName}</b> → ${file.folderPath}` +
        (file.driveWebLink ? ` (<a href="${file.driveWebLink}">view</a>)` : ""),
      ).join("<br>");
      const html = applyTemplate(driveMailTemplates.multipleFilesMoved.html, {
        FILE_LIST: fileListHtml,
        PREFERENCES_UPDATED: preferencesUpdatedBlock,
        EMBEDDED_DATA: embeddedHtml,
      });
      await sendDriveEmailResponse(sender, email, html);
    }
  }

  sendEvent(uid, trashedFiles.length > 0 ? "driveFileTrashed" : "driveFileMoved", "drive", {
    filesMoved: String(movedFiles.length),
    filesTrashed: String(trashedFiles.length),
  });

  return {
    filesProcessed: files.length,
    filesSucceeded: succeeded.length,
    filesFailed: results.filter((r) => r.error).length,
    results,
  };
}
