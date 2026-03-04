import {logger} from "firebase-functions/v2";
import {getOauthClient} from "../../auth/authHandler";
import {AGENT_NAME} from "./config";
import {sendEvent} from "../../util/analytics";
import {MAX_DRIVE_UPLOAD_BYTES} from "./config";
import {getSenderFromRawEmail} from "../../util/emailUtils";
import {TransformedEmail, ResendClient} from "../../util/types";
import {
  DriveProcessingResult, ProcessedDriveFile,
  DriveEmbeddedFileData, DriveAttachment, FileProposal,
} from "./types";
import {driveMailTemplates} from "./mailTemplates";
import {listAttachments, streamFromUrl} from "./fileProcessor";
import {collectImageUrls} from "../../util/imageUtils";
import {
  uploadFile, createFolder, getRootFolderId,
  placeMarkerFile, findAgentManagedFolders,
  renameFolder, getDriveFolderParent, moveFile,
} from "./driveHelper";
import {
  toTitleCase, getExtension, ensureDatePrefix,
  applyTemplate, sendDriveEmailResponse, getNextFolderPrefix,
  buildEmbeddedDriveData, buildFileInfos, callProposalWithFallback,
} from "./driveUtils";
import {Auth} from "googleapis";

/**
 * Resolve the target folder for file uploads.
 * Matches existing agent folders by category or creates a new one.
 */
async function resolveTargetFolder(
    oauth2Client: Auth.OAuth2Client,
    proposal: FileProposal,
    agentFolders: Array<{id: string; name: string}>,
    nextPrefix: string,
    rootFolderId: string,
): Promise<{folderId: string; folderPath: string}> {
  const proposedCategory = proposal.folder_name
      .replace(/^\d{2,3}-/, "").toLowerCase();
  const existingMatch = agentFolders.find((f) => {
    const cat = f.name.replace(/^\d{2,3}-/, "").toLowerCase();
    return cat === proposedCategory;
  });

  let targetFolderId: string;
  let targetFolderPath: string;

  if (existingMatch) {
    targetFolderId = existingMatch.id;
    targetFolderPath = existingMatch.name;
    // Rename if existing folder is missing NNN- prefix
    if (!/^\d{2,3}-/.test(targetFolderPath)) {
      const fixedName = `${nextPrefix}-${targetFolderPath}`;
      await renameFolder(oauth2Client, targetFolderId, fixedName);
      targetFolderPath = fixedName;
    }
    // Ensure folder is at root level (not nested under another folder)
    try {
      const folderInfo = await getDriveFolderParent(oauth2Client, targetFolderId);
      if (folderInfo.parentId && folderInfo.parentId !== rootFolderId) {
        await moveFile(oauth2Client, targetFolderId, rootFolderId, folderInfo.parentId);
      }
    } catch (err) {
      logger.debug("Drive: Could not check/move folder to root", {
        folderId: targetFolderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    // Ensure new folder name always has NNN- prefix and Title Case
    const hasPrefix = /^\d{2,3}-/.test(proposal.folder_name);
    const folderName = toTitleCase(hasPrefix ?
      proposal.folder_name : `${nextPrefix}-${proposal.folder_name}`);
    targetFolderId = await createFolder(
        oauth2Client, folderName, rootFolderId,
    );
    targetFolderPath = folderName;
  }

  await placeMarkerFile(oauth2Client, targetFolderId);
  return {folderId: targetFolderId, folderPath: targetFolderPath};
}

/**
 * Upload a single attachment to Drive with fallback to root on failure.
 */
async function uploadSingleFile(
    oauth2Client: Auth.OAuth2Client,
    attachment: DriveAttachment,
    suggestedName: string,
    targetFolderId: string,
    targetFolderPath: string,
    rootFolderId: string,
): Promise<ProcessedDriveFile> {
  try {
    const stream = await streamFromUrl(attachment.downloadUrl);
    const uploaded = await uploadFile(
        oauth2Client, targetFolderId, suggestedName,
        attachment.contentType, stream,
    );
    logger.info("Drive: File uploaded", {
      filename: suggestedName,
      folderPath: targetFolderPath,
      driveFileId: uploaded.id,
    });
    return {
      filename: suggestedName,
      folderPath: targetFolderPath,
      suggestedName,
      driveFileId: uploaded.id,
      driveWebLink: uploaded.webViewLink,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Drive: Failed to upload file", {
      filename: attachment.filename, error: errorMessage,
    });
    // Fallback: upload with original name to root
    try {
      const fallbackStream = await streamFromUrl(attachment.downloadUrl);
      const uploaded = await uploadFile(
          oauth2Client, rootFolderId, attachment.filename,
          attachment.contentType, fallbackStream,
      );
      return {
        filename: attachment.filename,
        folderPath: "My Drive",
        suggestedName: attachment.filename,
        driveFileId: uploaded.id,
        driveWebLink: uploaded.webViewLink,
        error: `Upload to target failed, uploaded to root: ${errorMessage}`,
      };
    } catch (uploadError) {
      const uploadErrorMessage =
        uploadError instanceof Error ? uploadError.message : String(uploadError);
      return {
        filename: attachment.filename,
        folderPath: "",
        suggestedName: attachment.filename,
        error: `Upload failed: ${uploadErrorMessage}`,
      };
    }
  }
}

/**
 * Upload all attachments to Drive in parallel.
 */
async function uploadAttachments(
    oauth2Client: Auth.OAuth2Client,
    attachments: DriveAttachment[],
    proposal: FileProposal,
    targetFolderId: string,
    targetFolderPath: string,
    rootFolderId: string,
    emailDate?: string,
): Promise<ProcessedDriveFile[]> {
  return Promise.all(attachments.map((attachment, i) => {
    const placementProposal = proposal.proposals.find((p) => p.file_index === i);
    const suggestedBase = placementProposal?.suggested_name || attachment.filename;
    const extension = getExtension(attachment.filename);
    const withExt = suggestedBase.endsWith(extension) ?
      suggestedBase : `${suggestedBase}${extension}`;
    const suggestedName = ensureDatePrefix(withExt, emailDate);
    return uploadSingleFile(
        oauth2Client, attachment, suggestedName,
        targetFolderId, targetFolderPath, rootFolderId,
    );
  }));
}

/**
 * Process a pending upload after the user confirms / grants OAuth.
 * Re-fetches email + attachments from Resend, determines placement, uploads.
 */
export async function processUpload(
    resendEmailId: string,
    uid: string,
    resend: ResendClient,
    originalEmail: TransformedEmail,
    savedProposal?: FileProposal,
): Promise<DriveProcessingResult> {
  const sender = getSenderFromRawEmail(originalEmail);
  if (!sender) {
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "No sender"};
  }

  // Get OAuth client
  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid, AGENT_NAME);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive: OAuth failed during upload", {uid, error: errMsg});
    const html = applyTemplate(driveMailTemplates.driveAuthFailed.html, {});
    await sendDriveEmailResponse(sender, originalEmail, html);
    sendEvent(uid, "driveAuthFailed");
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "OAuth failed"};
  }

  // Re-fetch attachments from Resend
  const maxUploadBytes = MAX_DRIVE_UPLOAD_BYTES.value();
  const attachments = await listAttachments(resend, resendEmailId, maxUploadBytes);

  if (attachments.length === 0) {
    logger.warn("Drive: No attachments on re-fetch", {resendEmailId});
    const html = applyTemplate(driveMailTemplates.noAttachments.html, {});
    await sendDriveEmailResponse(sender, originalEmail, html);
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "No attachments"};
  }

  // Get agent-managed folders
  const agentFolders = await findAgentManagedFolders(oauth2Client);
  const agentFolderNames = agentFolders.map((f) => f.name);
  const nextPrefix = getNextFolderPrefix(agentFolderNames);

  // Reuse saved proposal from Phase 1 if available, otherwise call LLM
  let proposal: FileProposal;
  if (savedProposal) {
    logger.info("Drive: Reusing saved proposal from Phase 1", {
      folder: savedProposal.folder_name,
    });
    proposal = savedProposal;
  } else {
    // Extract content summaries + document page images and propose placement via LLM
    const {fileInfos, documentImageUrls} = await buildFileInfos(attachments);
    const allImageUrls = [...collectImageUrls(attachments), ...documentImageUrls];
    proposal = await callProposalWithFallback(
        fileInfos, originalEmail.subject || "", originalEmail.text || "",
        agentFolderNames, nextPrefix, uid, attachments, allImageUrls,
    );
  }

  logger.info("Drive: Proposal result", {
    folder_name: proposal.folder_name,
    is_existing_folder: proposal.is_existing_folder,
    files: proposal.proposals.map((p) => ({
      file_index: p.file_index,
      suggested_name: p.suggested_name,
    })),
  });

  // Resolve target folder
  let rootFolderId: string;
  try {
    rootFolderId = await getRootFolderId(oauth2Client);
  } catch (err) {
    logger.debug("Drive: Could not get root folder ID, using 'root'", {
      error: err instanceof Error ? err.message : String(err),
    });
    rootFolderId = "root";
  }

  const {folderId: targetFolderId, folderPath: targetFolderPath} =
    await resolveTargetFolder(
        oauth2Client, proposal, agentFolders, nextPrefix, rootFolderId,
    );

  // Upload all files in parallel
  const results = await uploadAttachments(
      oauth2Client, attachments, proposal,
      targetFolderId, targetFolderPath, rootFolderId,
      originalEmail.headers?.date,
  );

  const succeeded = results.filter((r) => !r.error || r.driveFileId);
  const failed = results.filter((r) => r.error && !r.driveFileId);

  // Build embedded data for reply/move detection (saved to Firestore)
  const embeddedFiles: DriveEmbeddedFileData[] = succeeded.map((r) => ({
    id: r.driveFileId || "",
    folderId: targetFolderId,
    folderPath: r.folderPath,
    filename: r.filename,
    webLink: r.driveWebLink || "",
  }));
  const embeddedHtml = await buildEmbeddedDriveData(uid, embeddedFiles);

  // Send confirmation email
  if (succeeded.length === 0) {
    const html = applyTemplate(driveMailTemplates.uploadFailed.html, {});
    await sendDriveEmailResponse(sender, originalEmail, html);
  } else if (succeeded.length === 1) {
    const file = succeeded[0];
    const html = applyTemplate(driveMailTemplates.fileUploaded.html, {
      FILE_NAME: file.filename,
      FOLDER_PATH: file.folderPath,
      FILE_LINK: file.driveWebLink || "#",
      EMBEDDED_DATA: embeddedHtml,
    });
    await sendDriveEmailResponse(sender, originalEmail, html);
  } else {
    const fileListHtml = succeeded.map((file) =>
      `<b>${file.filename}</b> → ${file.folderPath}` +
      (file.driveWebLink ? ` (<a href="${file.driveWebLink}">view</a>)` : ""),
    ).join("<br>");
    const html = applyTemplate(driveMailTemplates.multipleFilesUploaded.html, {
      FILE_LIST: fileListHtml,
      EMBEDDED_DATA: embeddedHtml,
    });
    await sendDriveEmailResponse(sender, originalEmail, html);
  }

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
