import {logger} from "firebase-functions/v2";
import {getUserFromEmail, getUserFromUID} from "../../util/firestoreHandler";
import {getOauthClient} from "../../auth/authHandler";
import {sendEmailResend} from "../../util/resend";
import {sendEvent} from "../../util/analytics";
import {
  getSupportEmail,
  DRIVE_EMAIL_ADDRESS,
  MAX_DRIVE_UPLOAD_BYTES,
} from "../../util/config";
import {
  getSenderFromRawEmail,
  verifyEmail,
  getEmailThreadHeaders,
  threadEmailHtml,
} from "../../util/emailUtils";
import {TransformedEmail, ResendClient} from "../../util/types";
import {
  DriveProcessingResult, ProcessedDriveFile, DriveFolder,
  DriveEmbeddedData, DriveAttachment, FileProposal, FileInfo,
} from "./types";
import {driveMailTemplates, driveSignupUrl} from "./mailTemplates";
import {listAttachments, downloadAttachmentBuffer, extractContentSummary, streamFromUrl} from "./fileProcessor";
import {collectImageUrls} from "../../util/imageUtils";
import {
  getDriveFolderTree,
  uploadFile,
  createFolder,
  findFolderInTree,
  getRootFolderId,
  moveFile,
  placeMarkerFile,
  findAgentManagedFolders,
  renameFolder,
  getFolderFileCount,
  getDriveFolderParent,
} from "./driveHelper";
import {proposeFilePlacement, interpretMoveInstructions} from "./llm";
import {fastMatchSkill} from "../../util/skills/matcher";
import {getSkills} from "./skills";
import {handleOrganizeDrive} from "./organizeHandler";
import {Auth} from "googleapis";


// ============================================================================
// HELPERS
// ============================================================================

/**
 * Convert a string to Title Case (e.g. "tax documents" → "Tax Documents").
 * Preserves existing NNN- prefixes if present.
 */
function toTitleCase(str: string): string {
  const prefixMatch = str.match(/^(\d{2,3}-)(.*)$/);
  const category = prefixMatch ? prefixMatch[2] : str;
  const titled = category
      .split(/[\s-]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  return prefixMatch ? `${prefixMatch[1]}${titled}` : titled;
}

/**
 * Get the file extension from a filename
 */
function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filename.slice(lastDot);
}

/**
 * Ensure a filename has a YYYY.MM.DD date prefix.
 * Normalizes YYYY-MM-DD (dashes) to YYYY.MM.DD (dots).
 * Falls back to the email date header or today's date if none present.
 */
function ensureDatePrefix(filename: string, emailDate?: string): string {
  // Already has YYYY.MM.DD prefix
  if (/^\d{4}\.\d{2}\.\d{2}\s/.test(filename)) return filename;

  // Has YYYY-MM-DD prefix — normalize dashes to dots
  const dashMatch = filename.match(/^(\d{4})-(\d{2})-(\d{2})\s/);
  if (dashMatch) {
    return `${dashMatch[1]}.${dashMatch[2]}.${dashMatch[3]}${filename.slice(10)}`;
  }

  // No date prefix — extract from email header or use today
  let date: Date;
  if (emailDate) {
    const parsed = new Date(emailDate);
    date = isNaN(parsed.getTime()) ? new Date() : parsed;
  } else {
    date = new Date();
  }

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd} ${filename}`;
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
 * Compute the next NNN- prefix from existing folder names.
 */
function getNextFolderPrefix(existingFolders: string[]): string {
  let maxNum = 0;
  for (const name of existingFolders) {
    const match = name.match(/^(\d{2,3})-/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return String(maxNum + 1).padStart(2, "0");
}

/**
 * Build embedded drive data for reply detection.
 * Uses a visible link so Gmail preserves it when quoting replies.
 */
function buildEmbeddedDriveData(data: DriveEmbeddedData): string {
  const json = JSON.stringify(data);
  const encoded = Buffer.from(json).toString("base64url");
  const link = `<br><a href="https://www.fwd2cal.com/d?r=${encoded}"` +
    ` style="color:#999;font-size:11px;">Manage your files</a>`;
  return link;
}

/**
 * Parse embedded drive data from an email's HTML (quoted thread).
 * Looks for the visible "Manage your files" link with encoded data.
 */
function parseEmbeddedDriveData(html: string): DriveEmbeddedData | null {
  const linkMatch = html.match(/fwd2cal\.com\/d\?r=([A-Za-z0-9_-]+)/);
  if (linkMatch) {
    try {
      const json = Buffer.from(linkMatch[1], "base64url").toString();
      return JSON.parse(json) as DriveEmbeddedData;
    } catch {
      logger.warn("Drive: Failed to parse embedded drive data from link");
    }
  }
  return null;
}

/**
 * Find a folder in the tree by name (case-insensitive)
 */
function findFolderByName(
    roots: DriveFolder[],
    targetName: string,
): DriveFolder | null {
  const lower = targetName.toLowerCase();
  function search(nodes: DriveFolder[]): DriveFolder | null {
    for (const node of nodes) {
      if (node.name.toLowerCase() === lower) return node;
      const found = search(node.children);
      if (found) return found;
    }
    return null;
  }
  return search(roots);
}

/**
 * Download attachments and extract content summaries for LLM processing.
 */
async function buildFileInfos(
    attachments: DriveAttachment[],
): Promise<FileInfo[]> {
  return Promise.all(attachments.map(async (attachment) => {
    const buffer = await downloadAttachmentBuffer(
        attachment.downloadUrl, attachment.filename,
    );
    const contentSummary = buffer ?
      await extractContentSummary(buffer, attachment.contentType) : "";
    return {
      fileName: attachment.filename,
      mimeType: attachment.contentType,
      fileSize: attachment.size,
      contentSummary,
    };
  }));
}

/**
 * Call proposeFilePlacement with a fallback if LLM fails.
 */
async function callProposalWithFallback(
    fileInfos: FileInfo[],
    emailSubject: string,
    emailBody: string,
    agentFolderNames: string[],
    nextPrefix: string,
    uid: string | null,
    attachments: DriveAttachment[],
    imageUrls: string[] = [],
): Promise<FileProposal> {
  try {
    return await proposeFilePlacement(
        fileInfos, emailSubject, emailBody,
        agentFolderNames, nextPrefix, uid, imageUrls,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive: LLM proposal failed", {error: errMsg});
    return {
      folder_name: `${nextPrefix}-Documents`,
      is_existing_folder: false,
      proposals: attachments.map((att, i) => ({
        file_index: i,
        suggested_name: att.filename,
        reason: "LLM failed, using original filename",
      })),
    };
  }
}

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

// ============================================================================
// PHASE 1 — PROPOSE (runs on every inbound email)
// ============================================================================

/**
 * Main drive handler — processes an inbound email.
 * If the user has OAuth, uploads immediately and tells them they can reply to move.
 * If not, sends an auth-required email with a signup link.
 * Also detects replies for the move-file flow.
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

  // Check for organize-drive skill match
  const skills = getSkills();
  const skillMatch = fastMatchSkill(email.subject || "", "", skills);
  if (skillMatch?.skillId === "organize-drive") {
    logger.info("Drive: organize-drive skill matched", {sender, matchedIn: skillMatch.matchedIn});
    await handleOrganizeDrive(email, emailId);
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: []};
  }

  // Check if this is a REPLY to an existing upload (move request)
  const embeddedData = parseEmbeddedDriveData(email.html || "");
  if (embeddedData) {
    return handleMoveReply(email, sender, embeddedData);
  }

  // Check if user already has OAuth — if so, organize immediately
  const uid = await getUserFromEmail(sender);
  if (uid) {
    try {
      const userData = await getUserFromUID(uid);
      if (userData.driveEnabled && userData.access_token) {
        logger.info("Drive: Returning user — organizing immediately", {sender, uid});
        return processUpload(emailId, uid, resend, email);
      }
    } catch (err) {
      logger.debug("Drive: No OAuth or user lookup failed, falling through to auth flow", {
        uid, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // User doesn't have OAuth — send auth-required email
  logger.info("Drive: New user — sending auth email", {sender});

  // List attachment metadata
  const maxUploadBytes = MAX_DRIVE_UPLOAD_BYTES.value();
  const attachments = await listAttachments(resend, emailId, maxUploadBytes);

  if (attachments.length === 0) {
    logger.info("Drive: No attachments found", {sender});
    const html = applyTemplate(driveMailTemplates.noAttachments.html, {});
    await sendDriveEmailResponse(sender, email, html);
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "No attachments"};
  }

  // Download and extract content summaries for LLM preview
  const fileInfos = await buildFileInfos(attachments);
  const imageUrls = collectImageUrls(attachments);

  // LLM: propose folder + filenames (no agent folders available without OAuth)
  const nextPrefix = getNextFolderPrefix([]);
  const proposal = await callProposalWithFallback(
      fileInfos, email.subject || "", email.text || "",
      [], nextPrefix, uid, attachments, imageUrls,
  );
  logger.info("Drive: LLM proposal", {
    folder: proposal.folder_name,
    isExisting: proposal.is_existing_folder,
    files: proposal.proposals.map((p) => p.suggested_name),
  });

  // Build signup link with emailId + proposal as state (OAuth callback will reuse proposal)
  const statePayload = JSON.stringify({
    emailId,
    proposal: {
      folder_name: proposal.folder_name,
      is_existing_folder: proposal.is_existing_folder,
      proposals: proposal.proposals.map((p) => ({
        file_index: p.file_index,
        suggested_name: p.suggested_name,
        reason: p.reason,
      })),
    },
  });
  const encodedState = Buffer.from(statePayload).toString("base64url");
  const signupLink = `${driveSignupUrl}?state=${encodeURIComponent(encodedState)}`;

  // Send auth-required email showing what we'll organize
  const emailDate = email.headers?.date;
  if (proposal.proposals.length === 1) {
    const file = proposal.proposals[0];
    const extension = getExtension(attachments[0].filename);
    const withExt = file.suggested_name.endsWith(extension) ?
      file.suggested_name : `${file.suggested_name}${extension}`;
    const suggestedName = ensureDatePrefix(withExt, emailDate);
    const html = applyTemplate(driveMailTemplates.fileProposal.html, {
      PROPOSED_NAME: suggestedName,
      PROPOSED_FOLDER: proposal.folder_name,
      SIGNUP_LINK: signupLink,
    });
    await sendDriveEmailResponse(sender, email, html);
  } else {
    const fileListHtml = proposal.proposals.map((p) => {
      const att = attachments[p.file_index];
      const extension = att ? getExtension(att.filename) : "";
      const withExt = p.suggested_name.endsWith(extension) ?
        p.suggested_name : `${p.suggested_name}${extension}`;
      const name = ensureDatePrefix(withExt, emailDate);
      return `<b>${name}</b>`;
    }).join("<br>");
    const html = applyTemplate(driveMailTemplates.multipleFileProposal.html, {
      PROPOSED_FOLDER: proposal.folder_name,
      FILE_LIST: fileListHtml,
      SIGNUP_LINK: signupLink,
    });
    await sendDriveEmailResponse(sender, email, html);
  }

  sendEvent(uid || sender, "driveFileProposed", {
    filesCount: String(attachments.length),
    folder: proposal.folder_name,
  });

  return {
    filesProcessed: attachments.length,
    filesSucceeded: 0,
    filesFailed: 0,
    results: [],
  };
}

// ============================================================================
// PHASE 2 — UPLOAD (triggered by confirm endpoint or OAuth callback)
// ============================================================================

/**
 * Process a pending upload after the user confirms / grants OAuth.
 * Re-fetches email + attachments from Resend, determines placement, uploads.
 */
async function processUpload(
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
    oauth2Client = await getOauthClient(uid, "drive");
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
    // Extract content summaries and propose placement via LLM
    const fileInfos = await buildFileInfos(attachments);
    const imageUrls = collectImageUrls(attachments);
    proposal = await callProposalWithFallback(
        fileInfos, originalEmail.subject || "", originalEmail.text || "",
        agentFolderNames, nextPrefix, uid, attachments, imageUrls,
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

  // Build embedded data for reply/move detection
  const embeddedData: DriveEmbeddedData = {
    files: succeeded.map((r) => ({
      id: r.driveFileId || "",
      folderId: targetFolderId,
      folderPath: r.folderPath,
      filename: r.filename,
      webLink: r.driveWebLink || "",
    })),
  };
  const embeddedHtml = buildEmbeddedDriveData(embeddedData);

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

// ============================================================================
// REPLY HANDLER — MOVE FILES
// ============================================================================

/**
 * Handle a user reply that contains move instructions.
 * Parses embedded data from the quoted thread, moves files, sends confirmation.
 */
async function handleMoveReply(
    email: TransformedEmail,
    sender: string,
    embeddedData: DriveEmbeddedData,
): Promise<DriveProcessingResult> {
  const uid = await getUserFromEmail(sender);
  if (!uid) {
    logger.warn("Drive: Move reply from unknown user", {sender});
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "User not found"};
  }

  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid, "drive");
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
    logger.debug("Drive: Could not fetch folder tree", {
      error: err instanceof Error ? err.message : String(err),
    });
    folderTree = [];
  }

  const agentFolders = await findAgentManagedFolders(oauth2Client);

  // LLM: interpret move instructions (only agent-managed folders)
  const replyText = email.text || "";
  let moveResult;
  try {
    moveResult = await interpretMoveInstructions(
        replyText,
        embeddedData.files,
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
  // Track the resolved folder ID for each file (for embedded data in reply)
  const fileFolderIds = new Map<string, string>(); // filename → folderId

  const results: ProcessedDriveFile[] = [];
  for (const move of moveResult.moves) {
    const file = embeddedData.files[move.file_index];
    if (!file) continue;

    let newFolderId: string;
    let newFolderPath: string;
    let skipMove = false;

    // Resolve target folder
    const needsNewFolder =
      (move.folder_id === "root" && move.folder_path) ||
      (!findFolderInTree(folderTree, move.folder_id) &&
       !findFolderByName(folderTree, move.folder_path || move.folder_id));

    if (needsNewFolder) {
      const targetCategory = toTitleCase(move.folder_path || move.folder_id);
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
            (m) => embeddedData.files[m.file_index]?.folderId === file.folderId,
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
    const updatedEmbedded: DriveEmbeddedData = {
      files: succeeded.map((r) => ({
        id: r.driveFileId || "",
        folderId: fileFolderIds.get(r.filename) || "",
        folderPath: r.folderPath,
        filename: r.filename,
        webLink: r.driveWebLink || "",
      })),
    };

    const embeddedHtml = buildEmbeddedDriveData(updatedEmbedded);

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
    filesProcessed: embeddedData.files.length,
    filesSucceeded: succeeded.length,
    filesFailed: results.filter((r) => r.error).length,
    results,
  };
}

export {handleDriveEmail, processUpload, getNextFolderPrefix, parseEmbeddedDriveData, buildEmbeddedDriveData};
