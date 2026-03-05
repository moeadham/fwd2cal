import {logger} from "firebase-functions/v2";
import {
  getUserFromEmail, updateDriveFileData,
} from "../../util/firestoreHandler";
import {getOauthClient} from "../../auth/authHandler";
import {AGENT_NAME} from "./config";
import {sendEvent} from "../../util/analytics";
import {TransformedEmail} from "../../util/types";
import {
  DriveProcessingResult, ProcessedDriveFile,
  DriveFolder, DriveEmbeddedFileData,
} from "./types";
import {driveMailTemplates} from "./mailTemplates";
import {
  getDriveFolderTree, findFolderInTree, getRootFolderId,
  moveFile, createFolder, placeMarkerFile,
  findAgentManagedFolders, renameFolder, getFolderFileCount,
} from "./driveHelper";
import {interpretMoveInstructions} from "./llm";
import {
  toTitleCase, applyTemplate, sendDriveEmailResponse,
  getNextFolderPrefix, buildEmbeddedDriveHtml,
  buildEmbeddedDriveData, findFolderByName, isDriveAuthError,
} from "./driveUtils";

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
      sendEvent(uid, "driveAuthFailed");
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
      sendEvent(uid, "driveAuthFailed");
      return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "Auth failed"};
    }
    throw err;
  }

  // LLM: interpret move instructions (only agent-managed folders)
  const replyText = email.text || "";
  let moveResult;
  try {
    moveResult = await interpretMoveInstructions(
        replyText,
        files,
        agentFolders.map((f) => ({name: f.name, id: f.id})),
        uid,
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
    })),
  });

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
  for (const move of moveResult.moves) {
    const file = files[move.file_index];
    if (!file) continue;

    let newFolderId: string;
    let newFolderPath: string;
    let skipMove = false;

    // Normalize target category for dedup
    const rawCategory = toTitleCase(move.folder_path || move.folder_id);
    const categoryKey = rawCategory.replace(/^\d{2,3}-/, "").toLowerCase();

    // Check if we already resolved this category in a previous iteration
    const alreadyResolved = resolvedCategories.get(categoryKey);
    if (alreadyResolved) {
      newFolderId = alreadyResolved.folderId;
      newFolderPath = alreadyResolved.folderPath;
      // Skip move if the file is already in this folder (e.g., folder was renamed)
      skipMove = file.folderId === newFolderId;
    } else {
      // Resolve target folder
      const needsNewFolder =
        (move.folder_id === "root" && move.folder_path) ||
        (!findFolderInTree(folderTree, move.folder_id) &&
         !findFolderByName(folderTree, move.folder_path || move.folder_id));

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
        if (sourceAgent && !renamedFolders.has(file.folderId)) {
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
        } else if (renamedFolders.has(file.folderId)) {
          // Folder already renamed for a previous file in this batch
          newFolderId = file.folderId;
          newFolderPath = renamedFolders.get(file.folderId)!;
          skipMove = true;
        } else {
          newFolderId = await createFolder(
              oauth2Client, targetName, rootFolderId,
          );
          newFolderPath = targetName;
          await placeMarkerFile(oauth2Client, newFolderId);
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
          const targetName = toTitleCase(move.folder_path || move.folder_id);
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

      // Cache the resolved category for subsequent files
      resolvedCategories.set(categoryKey, {folderId: newFolderId, folderPath: newFolderPath});
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
      if (skipMove) {
        // File is already in the renamed folder
        fileFolderIds.set(file.filename, newFolderId);
        results.push({
          filename: file.filename,
          folderPath: newFolderPath,
          suggestedName: file.filename,
          driveFileId: file.id,
          driveWebLink: file.webLink,
        });
      } else {
        const moved = await moveFile(
            oauth2Client, file.id, newFolderId, file.folderId,
        );
        await placeMarkerFile(oauth2Client, newFolderId);
        fileFolderIds.set(file.filename, newFolderId);

        results.push({
          filename: file.filename,
          folderPath: newFolderPath,
          suggestedName: file.filename,
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
        sendEvent(uid, "driveAuthFailed");
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

  if (succeeded.length === 0) {
    const html = applyTemplate(driveMailTemplates.moveFailed.html, {});
    await sendDriveEmailResponse(sender, email, html);
  } else {
    const updatedFiles: DriveEmbeddedFileData[] = succeeded.map((r) => ({
      id: r.driveFileId || "",
      folderId: fileFolderIds.get(r.filename) || "",
      folderPath: r.folderPath,
      filename: r.filename,
      webLink: r.driveWebLink || "",
    }));

    let embeddedHtml: string;
    if (fileDataId) {
      await updateDriveFileData(fileDataId, updatedFiles);
      embeddedHtml = buildEmbeddedDriveHtml(fileDataId);
    } else {
      embeddedHtml = await buildEmbeddedDriveData(uid, updatedFiles);
    }

    if (succeeded.length === 1) {
      const file = succeeded[0];
      const html = applyTemplate(driveMailTemplates.fileMoved.html, {
        FILE_NAME: file.filename,
        NEW_PATH: file.folderPath,
        FILE_LINK: file.driveWebLink || "#",
        EMBEDDED_DATA: embeddedHtml,
      });
      await sendDriveEmailResponse(sender, email, html);
    } else {
      const fileListHtml = succeeded.map((file) =>
        `<b>${file.filename}</b> → ${file.folderPath}` +
        (file.driveWebLink ? ` (<a href="${file.driveWebLink}">view</a>)` : ""),
      ).join("<br>");
      const html = applyTemplate(driveMailTemplates.multipleFilesMoved.html, {
        FILE_LIST: fileListHtml,
        EMBEDDED_DATA: embeddedHtml,
      });
      await sendDriveEmailResponse(sender, email, html);
    }
  }

  sendEvent(uid, "driveFileMoved", {
    filesMoved: String(succeeded.length),
  });

  return {
    filesProcessed: files.length,
    filesSucceeded: succeeded.length,
    filesFailed: results.filter((r) => r.error).length,
    results,
  };
}
