import {logger} from "firebase-functions/v2";
import {getUserFromEmail, getUserFromUID} from "../../util/firestoreHandler";
import {getOauthClient} from "../../auth/authHandler";
import {sendEmailResend} from "../../util/resend";
import {sendEvent} from "../../util/analytics";
import {
  getSupportEmail,
  DRIVE_EMAIL_ADDRESS,
} from "../../util/config";
import {
  getSenderFromRawEmail,
  verifyEmail,
  getEmailThreadHeaders,
  threadEmailHtml,
} from "../../util/emailUtils";
import {TransformedEmail} from "../calendar/types";
import {ResendClient} from "../../util/types";
import {DriveProcessingResult, ProcessedDriveFile, DriveFolder} from "./types";
import {driveMailTemplates} from "./mailTemplates";
import {listAttachments, downloadAttachmentBuffer, extractContentSummary, streamFromUrl} from "./fileProcessor";
import {
  getDriveFolderTree,
  formatFolderTreeForLLM,
  uploadFile,
  createFolder,
  findFolderInTree,
  getRootFolderId,
} from "./driveHelper";
import {pickFilePlacements, FileInfo} from "./llm";
import {FilePlacementItem} from "./types";
import {MAX_DRIVE_UPLOAD_BYTES} from "../../util/config";

/**
 * Get the file extension from a filename
 */
function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filename.slice(lastDot);
}

/**
 * Replace template placeholders in an HTML string
 */
function applyTemplate(html: string, replacements: Record<string, string>): string {
  let result = html;
  result = result.replace(/%SUPPORT_EMAIL%/g, getSupportEmail());
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`%${key}%`, "g"), value);
  }
  return result;
}

/**
 * Send a response email back to the sender
 */
async function sendDriveEmailResponse(
    sender: string,
    originalEmail: TransformedEmail,
    html: string,
): Promise<void> {
  const threadedHtml = threadEmailHtml(originalEmail, html);
  await sendEmailResend({
    to: sender,
    from: DRIVE_EMAIL_ADDRESS.value(),
    subject: originalEmail.subject || "Re: Your file",
    html: threadedHtml,
    headers: getEmailThreadHeaders(originalEmail.headers),
  });
}

/**
 * Main drive handler — processes an email and uploads attachments to Drive
 */
async function handleDriveEmail(
    email: TransformedEmail,
    resend: ResendClient,
    emailId: string,
): Promise<DriveProcessingResult> {
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "No sender found"};
  }

  // Verify email sender
  if (!verifyEmail(email)) {
    logger.warn("Drive: Unverified email", {sender});
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "Unverified email"};
  }

  // Look up user
  const uid = await getUserFromEmail(sender);
  if (!uid) {
    logger.warn(`Drive: No user found for ${sender}`);
    const html = applyTemplate(driveMailTemplates.notDriveUser.html, {});
    await sendDriveEmailResponse(sender, email, html);
    sendEvent(sender, "driveUserInvited");
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "User not found"};
  }

  // Check if user has drive enabled
  const userData = await getUserFromUID(uid);
  if (!userData.driveEnabled) {
    logger.warn(`Drive: User ${uid} has not enabled drive`);
    const html = applyTemplate(driveMailTemplates.notDriveUser.html, {});
    await sendDriveEmailResponse(sender, email, html);
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "Drive not enabled"};
  }

  // Get OAuth client
  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive: OAuth failed", {uid, error: errMsg});
    const html = applyTemplate(driveMailTemplates.driveAuthFailed.html, {});
    await sendDriveEmailResponse(sender, email, html);
    sendEvent(uid, "driveAuthFailed");
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "OAuth failed"};
  }

  // List attachment metadata (no downloading yet)
  const maxUploadBytes = parseInt(MAX_DRIVE_UPLOAD_BYTES.value());
  const attachments = await listAttachments(resend, emailId, maxUploadBytes);

  if (attachments.length === 0) {
    logger.info("Drive: No attachments found", {sender});
    const html = applyTemplate(driveMailTemplates.noAttachments.html, {});
    await sendDriveEmailResponse(sender, email, html);
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "No attachments"};
  }

  // Download one at a time, extract content summary, then free buffer
  const fileInfos: FileInfo[] = [];
  for (const attachment of attachments) {
    const buffer = await downloadAttachmentBuffer(
        attachment.downloadUrl, attachment.filename,
    );
    const contentSummary = buffer ?
      await extractContentSummary(buffer, attachment.contentType) : "";
    fileInfos.push({
      fileName: attachment.filename,
      mimeType: attachment.contentType,
      fileSize: attachment.size,
      contentSummary,
    });
  }

  // Read Drive folder tree
  let folderTree: DriveFolder[];
  let folderTreeText: string;
  try {
    folderTree = await getDriveFolderTree(oauth2Client);
    folderTreeText = formatFolderTreeForLLM(folderTree);
    logger.info("Drive: Folder tree loaded", {
      folderCount: folderTreeText.split("\n").length,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive: Failed to read folder tree", {uid, error: errMsg});
    // Fall back to uploading to root with original names
    folderTree = [];
    folderTreeText = "";
  }

  // Get root folder ID for fallback
  let rootFolderId: string;
  try {
    rootFolderId = await getRootFolderId(oauth2Client);
  } catch (_error) {
    rootFolderId = "root";
  }

  // Single LLM call for all files
  let placements: FilePlacementItem[];
  try {
    placements = await pickFilePlacements(
        folderTreeText,
        fileInfos,
        email.subject || "",
        email.text || "",
        uid,
    );
    logger.info("Drive: LLM batch placement", {
      fileCount: attachments.length,
      placements: placements.map((p) => ({
        file_index: p.file_index,
        folder_id: p.folder_id,
        folder_path: p.folder_path,
        suggested_name: p.suggested_name,
        reason: p.reason,
      })),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive: LLM batch placement failed", {error: errMsg});
    // Fall back: one placement per file with original names at root
    placements = attachments.map((att, i) => ({
      file_index: i,
      folder_id: "root",
      folder_path: "",
      suggested_name: att.filename,
      reason: "LLM failed, using original filename",
    }));
  }

  // Resolve the target folder once (all files go to the same folder)
  const firstPlacement = placements[0] || {
    folder_id: "root",
    folder_path: "",
  };
  const {targetFolderId, targetFolderPath} = await resolveTargetFolder(
      firstPlacement,
      folderTree,
      rootFolderId,
      oauth2Client,
  );

  // Upload each file
  const results: ProcessedDriveFile[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const placement = placements.find((p) => p.file_index === i) || {
      file_index: i,
      folder_id: "root",
      folder_path: "",
      suggested_name: attachment.filename,
      reason: "No placement returned",
    };

    try {
      const extension = getExtension(attachment.filename);
      const suggestedName = placement.suggested_name.endsWith(extension) ?
        placement.suggested_name :
        `${placement.suggested_name}${extension}`;

      const stream = await streamFromUrl(attachment.downloadUrl);
      const uploaded = await uploadFile(
          oauth2Client,
          targetFolderId,
          suggestedName,
          attachment.contentType,
          stream,
      );

      results.push({
        filename: suggestedName,
        folderPath: targetFolderPath,
        suggestedName: suggestedName,
        driveFileId: uploaded.id,
        driveWebLink: uploaded.webViewLink,
      });

      logger.info("Drive: File uploaded", {
        filename: suggestedName,
        folderPath: targetFolderPath,
        driveFileId: uploaded.id,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Drive: Failed to upload file", {
        filename: attachment.filename,
        error: errorMessage,
      });

      // Fall back: upload with original name to root
      try {
        const fallbackStream = await streamFromUrl(attachment.downloadUrl);
        const uploaded = await uploadFile(
            oauth2Client,
            rootFolderId,
            attachment.filename,
            attachment.contentType,
            fallbackStream,
        );
        results.push({
          filename: attachment.filename,
          folderPath: "My Drive",
          suggestedName: attachment.filename,
          driveFileId: uploaded.id,
          driveWebLink: uploaded.webViewLink,
          error: `Upload to target failed, uploaded to root: ${errorMessage}`,
        });
      } catch (uploadError) {
        const uploadErrorMessage =
          uploadError instanceof Error ? uploadError.message : String(uploadError);
        results.push({
          filename: attachment.filename,
          folderPath: "",
          suggestedName: attachment.filename,
          error: `Upload failed: ${uploadErrorMessage}`,
        });
      }
    }
  }

  const succeeded = results.filter((r) => !r.error || r.driveFileId);
  const failed = results.filter((r) => r.error && !r.driveFileId);

  // Send response email
  if (succeeded.length === 0) {
    const html = applyTemplate(driveMailTemplates.uploadFailed.html, {});
    await sendDriveEmailResponse(sender, email, html);
  } else if (succeeded.length === 1) {
    const file = succeeded[0];
    const html = applyTemplate(driveMailTemplates.fileUploaded.html, {
      FILE_NAME: file.filename,
      FOLDER_PATH: file.folderPath,
      FILE_LINK: file.driveWebLink || "#",
    });
    await sendDriveEmailResponse(sender, email, html);
  } else {
    const fileListHtml = succeeded.map((file) =>
      `<b>${file.filename}</b> → ${file.folderPath}` +
      (file.driveWebLink ? ` (<a href="${file.driveWebLink}">view</a>)` : ""),
    ).join("<br>");
    const html = applyTemplate(driveMailTemplates.multipleFilesUploaded.html, {
      FILE_LIST: fileListHtml,
    });
    await sendDriveEmailResponse(sender, email, html);
  }

  // Track analytics
  sendEvent(uid, "driveFileUploaded", {
    filesProcessed: String(attachments.length),
    filesSucceeded: String(succeeded.length),
    filesFailed: String(failed.length),
  });

  return {
    filesProcessed: attachments.length,
    filesSucceeded: succeeded.length,
    filesFailed: failed.length,
    results,
  };
}

/**
 * Resolve a placement's folder_id/folder_path to an actual Drive folder ID
 */
async function resolveTargetFolder(
    placement: Pick<FilePlacementItem, "folder_id" | "folder_path">,
    folderTree: DriveFolder[],
    rootFolderId: string,
    oauth2Client: Parameters<typeof createFolder>[0],
): Promise<{targetFolderId: string; targetFolderPath: string}> {
  const isNewPath = (p: string) =>
    p && p !== "/" && p !== "root" && p !== "My Drive";

  if (placement.folder_id === "root") {
    if (isNewPath(placement.folder_path)) {
      const parts = placement.folder_path.split("/").filter(Boolean);
      let currentParentId = rootFolderId;
      let currentPath = "";
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const existing = folderTree.length > 0 ?
          findFolderByPath(folderTree, currentPath) : null;
        if (existing) {
          currentParentId = existing.id;
        } else {
          currentParentId = await createFolder(
              oauth2Client, part, currentParentId,
          );
        }
      }
      return {
        targetFolderId: currentParentId,
        targetFolderPath: placement.folder_path,
      };
    }
    return {targetFolderId: rootFolderId, targetFolderPath: "My Drive"};
  }

  // LLM chose an existing folder
  const existingFolder = findFolderInTree(folderTree, placement.folder_id);
  if (existingFolder) {
    return {
      targetFolderId: existingFolder.id,
      targetFolderPath: existingFolder.path,
    };
  }

  // Folder ID not found — use folder_path if available
  logger.warn("Drive: LLM suggested unknown folder ID, using folder_path", {
    folderId: placement.folder_id,
    folderPath: placement.folder_path,
  });
  if (isNewPath(placement.folder_path)) {
    const parts = placement.folder_path.split("/").filter(Boolean);
    let currentParentId = rootFolderId;
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = folderTree.length > 0 ?
        findFolderByPath(folderTree, currentPath) : null;
      if (existing) {
        currentParentId = existing.id;
      } else {
        currentParentId = await createFolder(
            oauth2Client, part, currentParentId,
        );
      }
    }
    return {
      targetFolderId: currentParentId,
      targetFolderPath: placement.folder_path,
    };
  }
  return {targetFolderId: rootFolderId, targetFolderPath: "My Drive"};
}

/**
 * Find a folder in the tree by its full path
 */
function findFolderByPath(
    roots: DriveFolder[],
    targetPath: string,
): DriveFolder | null {
  for (const root of roots) {
    if (root.path === targetPath) return root;
    const found = findFolderByPath(root.children, targetPath);
    if (found) return found;
  }
  return null;
}

export {handleDriveEmail};
