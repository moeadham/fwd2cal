import {createHmac} from "crypto";
import {logger} from "firebase-functions/v2";
import {
  getUserFromEmail,
  getUserFromUID,
  saveOrganizeProposal,
  getOrganizeProposal,
  updateOrganizeProposalStatus,
} from "../../util/firestoreHandler";
import {getOauthClient} from "../../auth/authHandler";
import {sendEvent} from "../../util/analytics";
import {
  getSupportEmail,
  DRIVE_EMAIL_ADDRESS,
  DRIVE_ACTION_SIGNING_KEY,
  ORGANIZE_DRIVE_COST_PER_FILE,
  ORGANIZE_DRIVE_MAX_FILES,
  ORGANIZE_DRIVE_MAX_PREVIEW_ROWS,
  ORGANIZE_DRIVE_CHUNK_SIZE,
} from "../../util/config";
import {
  getSenderFromRawEmail,
  verifyEmail,
  getEmailThreadHeaders,
  threadEmailHtml,
} from "../../util/emailUtils";
import {sendEmailResend} from "../../util/resend";
import {TransformedEmail, ResendOutboundAttachment} from "../../util/types";
import {
  DriveFileEntry,
  DriveOrganizeProposal,
  OrganizeCostBreakdown,
  OrganizeProcessingResult,
  OrganizeEmbeddedData,
  OrganizeProposalDoc,
  OrganizeSnapshotAction,
} from "./types";
import {Auth} from "googleapis";
import {driveMailTemplates, driveFullScopeSignupUrl, driveOrganizeActionUrl} from "./mailTemplates";
import {
  listAllDriveFiles,
  createFolder,
  moveFile,
  renameFile,
  renameFolder,
  placeMarkerFile,
  getRootFolderId,
  getDriveClient,
  findAgentManagedFolders,
  getFolderFileCount,
  deleteFolder,
} from "./driveHelper";
import {proposeOrganization} from "./llm";

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Sign an action token for a propose/undo button URL.
 * HMAC-SHA256 of "proposalId:action" using the server signing key.
 */
function signActionToken(proposalId: string, action: string): string {
  return createHmac("sha256", DRIVE_ACTION_SIGNING_KEY.value())
      .update(`${proposalId}:${action}`)
      .digest("hex");
}

/**
 * Replace template placeholders in an HTML string.
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
 * Send a response email back to the sender.
 */
async function sendOrganizeEmailResponse(
    sender: string,
    originalEmail: TransformedEmail,
    html: string,
    attachments?: ResendOutboundAttachment[],
): Promise<void> {
  const threadedHtml = threadEmailHtml(originalEmail, html);
  await sendEmailResend({
    to: sender,
    from: DRIVE_EMAIL_ADDRESS.value(),
    subject: originalEmail.subject || "Re: Organize your Drive",
    html: threadedHtml,
    headers: getEmailThreadHeaders(originalEmail.headers),
    attachments,
  });
}

/**
 * Check if the user's stored OAuth scope includes full `drive` access
 * (as opposed to just `drive.file` + `drive.metadata`).
 */
function hasFullDriveScope(tokenScope: string): boolean {
  if (!tokenScope) return false;
  const scopes = tokenScope.split(/\s+/);
  return scopes.some((s) =>
    s === "https://www.googleapis.com/auth/drive",
  );
}

/**
 * Convert flat file list into DriveFileEntry[] with computed parent paths.
 */
function buildFileEntries(
    rawFiles: Array<{
      id: string;
      name: string;
      mimeType: string;
      parents: string[];
      createdTime: string;
      size: string;
      webViewLink: string;
    }>,
): DriveFileEntry[] {
  // Build a map of id → name for path computation
  const nameMap = new Map<string, string>();
  for (const f of rawFiles) {
    nameMap.set(f.id, f.name);
  }

  // Build parent paths
  const parentMap = new Map<string, string>();
  for (const f of rawFiles) {
    if (f.parents.length > 0) {
      parentMap.set(f.id, f.parents[0]);
    }
  }

  function getPath(id: string): string {
    const parts: string[] = [];
    let current = parentMap.get(id);
    while (current && nameMap.has(current)) {
      parts.unshift(nameMap.get(current)!);
      current = parentMap.get(current);
    }
    return parts.join("/") || "My Drive";
  }

  return rawFiles.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    parentId: f.parents[0] || null,
    parentPath: getPath(f.id),
    createdTime: f.createdTime,
    size: parseInt(f.size, 10) || 0,
    webViewLink: f.webViewLink,
    isFolder: f.mimeType === "application/vnd.google-apps.folder",
  }));
}

/**
 * Build a text summary of the current Drive structure for the LLM.
 */
function buildDriveStructureSummary(
    files: DriveFileEntry[],
): {treeSummary: string; fileCount: number; folderCount: number} {
  const folders = files.filter((f) => f.isFolder);
  const nonFolders = files.filter((f) => !f.isFolder);

  // Group folders by parent
  const foldersByParent = new Map<string, DriveFileEntry[]>();
  for (const folder of folders) {
    const parentId = folder.parentId || "root";
    if (!foldersByParent.has(parentId)) {
      foldersByParent.set(parentId, []);
    }
    foldersByParent.get(parentId)!.push(folder);
  }

  // Count files per folder
  const fileCountByFolder = new Map<string, number>();
  for (const file of nonFolders) {
    const parentId = file.parentId || "root";
    fileCountByFolder.set(parentId, (fileCountByFolder.get(parentId) || 0) + 1);
  }

  function renderTree(parentId: string, indent: string): string {
    let result = "";
    const children = foldersByParent.get(parentId) || [];
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const count = fileCountByFolder.get(child.id) || 0;
      const countStr = count > 0 ? ` (${count} files)` : "";
      result += `${indent}${child.name}/${countStr}\n`;
      result += renderTree(child.id, indent + "  ");
    }
    return result;
  }

  const rootFileCount = fileCountByFolder.get("root") || 0;
  let treeSummary = `My Drive/ (${rootFileCount} files at root)\n`;
  treeSummary += renderTree("root", "  ");

  // Include folders whose parent isn't in the folder list (root-level)
  const knownFolderIds = new Set(folders.map((f) => f.id));
  for (const folder of folders) {
    if (folder.parentId && !knownFolderIds.has(folder.parentId) &&
        folder.parentId !== "root" && !foldersByParent.has(folder.parentId)) {
      const count = fileCountByFolder.get(folder.id) || 0;
      const countStr = count > 0 ? ` (${count} files)` : "";
      treeSummary += `  ${folder.name}/${countStr}\n`;
      treeSummary += renderTree(folder.id, "    ");
    }
  }

  return {
    treeSummary,
    fileCount: nonFolders.length,
    folderCount: folders.length,
  };
}

/**
 * Calculate the cost of the proposed reorganization.
 */
function calculateOrganizeCost(
    proposal: DriveOrganizeProposal,
): OrganizeCostBreakdown {
  const costPerFile = parseFloat(ORGANIZE_DRIVE_COST_PER_FILE.value());
  const actions = proposal.file_actions;
  const filesToMove = actions.filter(
      (a) => a.action === "move" || a.action === "move_and_rename",
  ).length;
  const filesToRename = actions.filter(
      (a) => a.action === "rename" || a.action === "move_and_rename",
  ).length;
  const filesToKeep = actions.filter((a) => a.action === "keep").length;
  const filesToChange = actions.filter((a) => a.action !== "keep").length;

  return {
    totalFiles: actions.length,
    filesToMove,
    filesToRename,
    filesToKeep,
    costPerFile,
    totalCost: filesToChange * costPerFile,
  };
}

/**
 * Render proposed folder tree as monospace HTML.
 */
function renderFolderTree(proposal: DriveOrganizeProposal): string {
  let tree = "My Drive/<br>";
  for (const folder of proposal.proposed_folders) {
    const fileCount = proposal.file_actions.filter(
        (a) => a.new_folder === folder.folder_name,
    ).length;
    tree += `&nbsp;&nbsp;${folder.folder_name}/&nbsp;&nbsp;(${fileCount} files)<br>`;
    if (folder.subfolders) {
      for (const sub of folder.subfolders) {
        const subPath = `${folder.folder_name}/${sub.subfolder_name}`;
        const subCount = proposal.file_actions.filter(
            (a) => a.new_folder === subPath,
        ).length;
        tree += `&nbsp;&nbsp;&nbsp;&nbsp;${sub.subfolder_name}/&nbsp;&nbsp;(${subCount} files)<br>`;
      }
    }
  }
  return tree;
}

/**
 * Render file changes preview as HTML table.
 */
function renderFileChangesPreview(
    proposal: DriveOrganizeProposal,
): string {
  const maxPreviewRows = ORGANIZE_DRIVE_MAX_PREVIEW_ROWS.value();
  const changes = proposal.file_actions.filter((a) => a.action !== "keep");
  const shown = changes.slice(0, maxPreviewRows);

  let html = "<table style=\"width:100%;border-collapse:collapse;font-size:13px;\">";
  html += "<tr style=\"border-bottom:1px solid #eee;\">" +
    "<th style=\"text-align:left;padding:4px 8px;\">Current</th>" +
    "<th style=\"text-align:left;padding:4px 8px;\">Proposed</th></tr>";

  for (const change of shown) {
    html += "<tr style=\"border-bottom:1px solid #f5f5f5;\">";
    html += `<td style="padding:4px 8px;color:#999;">${change.current_path}/${change.current_name}</td>`;
    html += `<td style="padding:4px 8px;"><b>${change.new_folder}/${change.new_name}</b></td>`;
    html += "</tr>";
  }

  html += "</table>";

  if (changes.length > maxPreviewRows) {
    html += `<br><em>...and ${changes.length - maxPreviewRows} more files</em>`;
  }

  return html;
}

/**
 * Escape a value for CSV (double-quote if it contains commas, quotes, or newlines).
 */
function csvEscape(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

/**
 * Generate a CSV string from the full proposal (all file actions).
 */
function buildProposalCsv(proposal: DriveOrganizeProposal): string {
  const header = "Action,Current Path,Current Name,New Folder,New Name,Reason";
  const rows = proposal.file_actions.map((a) =>
    [
      csvEscape(a.action),
      csvEscape(a.current_path),
      csvEscape(a.current_name),
      csvEscape(a.new_folder),
      csvEscape(a.new_name),
      csvEscape(a.reason),
    ].join(","),
  );
  return header + "\n" + rows.join("\n");
}

/**
 * Build embedded organize data for proposal tracking.
 */
function buildOrganizeEmbeddedData(data: OrganizeEmbeddedData): string {
  const json = JSON.stringify(data);
  const encoded = Buffer.from(json).toString("base64url");
  const link = `<br><a href="https://www.fwd2cal.com/d?o=${encoded}"` +
    ` style="color:#999;font-size:11px;">View proposal</a>`;
  return link;
}

/**
 * Extract root-level folders from Drive, deduplicate by base name
 * (case-insensitive), normalize NNN prefix format, and assign
 * sequential prefixes.
 */
function seedFoldersFromDrive(
    fileEntries: DriveFileEntry[],
): {
  seedFolders: DriveOrganizeProposal["proposed_folders"];
  folderRenameActions: DriveOrganizeProposal["file_actions"];
} {
  // Find root-level folders (directly under My Drive)
  const rootFolders = fileEntries.filter(
      (f) => f.isFolder && f.parentPath === "My Drive",
  );

  // Sort alphabetically for deterministic NNN assignment
  rootFolders.sort((a, b) => a.name.localeCompare(b.name));

  const seedFolders: DriveOrganizeProposal["proposed_folders"] = [];
  const folderRenameActions: DriveOrganizeProposal["file_actions"] = [];

  // Track seen base names (case-insensitive) to merge duplicates
  const seenNames = new Map<string, string>(); // normalized → seed folder_name
  let nextPrefix = 1;

  for (const folder of rootFolders) {
    // Strip any existing NNN prefix to get the base name
    const baseName = folder.name.replace(/^\d{2,3}\s*-\s*/, "").trim();
    const normalizedName = baseName.toLowerCase();

    // Duplicate (case-insensitive) — merge into the first occurrence
    if (seenNames.has(normalizedName)) {
      const targetFolderName = seenNames.get(normalizedName)!;
      folderRenameActions.push({
        file_id: folder.id,
        current_name: folder.name,
        current_path: "My Drive",
        new_name: targetFolderName,
        new_folder: "My Drive",
        action: "rename",
        reason: `Merged duplicate folder into "${targetFolderName}"`,
      });
      continue;
    }

    const prefix = String(nextPrefix).padStart(2, "0");
    nextPrefix++;
    const newName = `${prefix} - ${baseName}`;

    seenNames.set(normalizedName, newName);

    seedFolders.push({
      folder_name: newName,
      description: `Existing folder "${folder.name}"`,
      subfolders: null,
    });

    folderRenameActions.push({
      file_id: folder.id,
      current_name: folder.name,
      current_path: "My Drive",
      new_name: newName,
      new_folder: "My Drive",
      action: folder.name === newName ? "keep" : "rename",
      reason: folder.name === newName ?
        "Already correctly named" :
        "Renamed with numerical prefix for consistency",
    });
  }

  return {seedFolders, folderRenameActions};
}

/**
 * Build an empty OrganizeProcessingResult with an optional error.
 */
function emptyResult(
    error?: string,
    totalFiles = 0,
): OrganizeProcessingResult {
  return {
    totalFiles,
    filesToMove: 0,
    filesToRename: 0,
    totalCost: 0,
    proposalSent: false,
    error,
  };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Entry point for the organize-drive flow.
 * Called from handleDriveEmail() when the "organize-drive" skill is matched.
 */
async function handleOrganizeDrive(
    email: TransformedEmail,
    emailId: string,
): Promise<OrganizeProcessingResult> {
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    return emptyResult("No sender found");
  }

  // Verify email sender
  if (!verifyEmail(email)) {
    logger.warn("Drive organize: Unverified email", {sender});
    return emptyResult("Unverified email");
  }

  // Check if user has OAuth
  const uid = await getUserFromEmail(sender);
  if (!uid) {
    return sendOrganizeAuthRequiredEmail(email, sender, emailId);
  }

  let userData;
  try {
    userData = await getUserFromUID(uid, "drive");
  } catch (err) {
    logger.debug("Drive organize: User lookup failed", {
      uid, error: err instanceof Error ? err.message : String(err),
    });
    return sendOrganizeAuthRequiredEmail(email, sender, emailId);
  }

  if (!userData.access_token) {
    return sendOrganizeAuthRequiredEmail(email, sender, emailId);
  }

  // Check for full drive scope
  if (!hasFullDriveScope(userData.token_scope)) {
    return sendOrganizeScopeUpgradeEmail(email, sender, emailId);
  }

  // User has full scope — proceed with organization
  return scanAndPropose(email, sender, emailId, uid);
}

/**
 * Send auth-required email with link to full-scope OAuth.
 */
async function sendOrganizeAuthRequiredEmail(
    email: TransformedEmail,
    sender: string,
    emailId: string,
): Promise<OrganizeProcessingResult> {
  const statePayload = JSON.stringify({emailId, organize: true});
  const encodedState = Buffer.from(statePayload).toString("base64url");
  const signupLink = `${driveFullScopeSignupUrl}?state=${encodeURIComponent(encodedState)}`;

  const html = applyTemplate(driveMailTemplates.organizeAuthRequired.html, {
    FULL_SCOPE_SIGNUP_LINK: signupLink,
  });
  await sendOrganizeEmailResponse(sender, email, html);

  logger.info("Drive organize: Sent auth-required email", {sender});
  return emptyResult();
}

/**
 * Send scope-upgrade email for users with limited scope.
 */
async function sendOrganizeScopeUpgradeEmail(
    email: TransformedEmail,
    sender: string,
    emailId: string,
): Promise<OrganizeProcessingResult> {
  const statePayload = JSON.stringify({emailId, organize: true});
  const encodedState = Buffer.from(statePayload).toString("base64url");
  const signupLink = `${driveFullScopeSignupUrl}?state=${encodeURIComponent(encodedState)}`;

  const html = applyTemplate(driveMailTemplates.organizeAuthRequired.html, {
    FULL_SCOPE_SIGNUP_LINK: signupLink,
  });
  await sendOrganizeEmailResponse(sender, email, html);

  logger.info("Drive organize: Sent scope-upgrade email", {sender});
  return emptyResult();
}

/**
 * Scan the entire Drive and send a reorganization proposal.
 */
async function scanAndPropose(
    email: TransformedEmail,
    sender: string,
    emailId: string,
    uid: string,
): Promise<OrganizeProcessingResult> {
  const maxFiles = ORGANIZE_DRIVE_MAX_FILES.value();

  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid, "drive");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize: OAuth failed", {uid, error: errMsg});
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("OAuth failed");
  }

  // Scan entire Drive
  logger.info("Drive organize: Scanning drive", {uid, sender});
  let rawFiles;
  try {
    rawFiles = await listAllDriveFiles(oauth2Client);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize: Failed to list files", {
      uid, error: errMsg,
    });
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Drive scan failed");
  }

  // Build file entries with computed paths
  logger.info("Drive organize: Raw files from API", {
    rawCount: rawFiles.length,
  });
  const fileEntries = buildFileEntries(rawFiles);
  const nonFolderFiles = fileEntries.filter((f) => !f.isFolder);
  const folderFiles = fileEntries.filter((f) => f.isFolder);
  logger.info("Drive organize: File breakdown", {
    total: fileEntries.length,
    files: nonFolderFiles.length,
    folders: folderFiles.length,
  });

  // Check for empty drive
  if (nonFolderFiles.length === 0) {
    const html = applyTemplate(driveMailTemplates.organizeNoFiles.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult();
  }

  // Check for drives that are too large
  if (nonFolderFiles.length > maxFiles) {
    await sendOrganizeEmailResponse(sender, email,
        `Your Google Drive has over ${maxFiles.toLocaleString()} files. ` +
        `We currently support drives with up to ${maxFiles.toLocaleString()} files. ` +
        `We're working on expanding this limit!<br><br>` +
        `You can always ask for help: <a href="mailto:${getSupportEmail()}">${getSupportEmail()}</a>`);
    return {
      totalFiles: nonFolderFiles.length, filesToMove: 0, filesToRename: 0,
      totalCost: 0, proposalSent: false, error: "Drive too large",
    };
  }

  // Build structure summary
  const {treeSummary} = buildDriveStructureSummary(fileEntries);

  // Seed folders from existing Drive structure (rename with NNN prefix)
  const {seedFolders, folderRenameActions} = seedFoldersFromDrive(fileEntries);
  logger.info("Drive organize: Seeded folders from existing structure", {
    seedCount: seedFolders.length,
    folderRenames: folderRenameActions.filter((a) => a.action === "rename").length,
  });

  // Call LLM for reorganization proposal (chunked)
  logger.info("Drive organize: Calling LLM", {
    uid, fileCount: nonFolderFiles.length,
  });
  let proposal: DriveOrganizeProposal;
  try {
    const chunkSize = ORGANIZE_DRIVE_CHUNK_SIZE.value();
    proposal = await proposeOrganization(
        treeSummary, fileEntries, chunkSize, uid, seedFolders,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize: LLM proposal failed", {
      uid, error: errMsg,
    });
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("LLM failed", nonFolderFiles.length);
  }

  // Merge folder rename actions into the proposal
  proposal.file_actions.push(...folderRenameActions);

  // Calculate cost
  const cost = calculateOrganizeCost(proposal);

  // Save proposal to Firestore
  let proposalId: string;
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    proposalId = await saveOrganizeProposal({
      uid,
      senderEmail: sender,
      emailId,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      proposal,
      cost,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize: Failed to save proposal", {
      uid, error: errMsg,
    });
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Save failed", nonFolderFiles.length);
  }

  // Build embedded data
  const embeddedData: OrganizeEmbeddedData = {proposalId};
  const embeddedHtml = buildOrganizeEmbeddedData(embeddedData);

  // Render proposal email
  const folderTreeHtml = renderFolderTree(proposal);
  const fileChangesHtml = renderFileChangesPreview(proposal);

  const approveToken = signActionToken(proposalId, "approve");
  const approveLink = `${driveOrganizeActionUrl}?proposalId=${proposalId}&action=approve&token=${approveToken}`;

  const html = applyTemplate(driveMailTemplates.organizeProposal.html, {
    SUMMARY: proposal.summary,
    TOTAL_FILES: String(cost.totalFiles),
    FILES_TO_CHANGE: String(cost.totalFiles - cost.filesToKeep),
    FILES_TO_KEEP: String(cost.filesToKeep),
    FOLDER_TREE: folderTreeHtml,
    FILE_CHANGES_PREVIEW: fileChangesHtml,
    TOTAL_COST: `$${cost.totalCost.toFixed(2)}`,
    COST_PER_FILE: `$${cost.costPerFile.toFixed(2)}`,
    EMBEDDED_DATA: embeddedHtml,
    APPROVE_LINK: approveLink,
  });

  // Build CSV attachment with the full proposal
  const csvContent = buildProposalCsv(proposal);
  const csvAttachment: ResendOutboundAttachment = {
    content: Buffer.from(csvContent, "utf-8"),
    filename: "drive-reorganization-proposal.csv",
    content_type: "text/csv",
  };

  await sendOrganizeEmailResponse(sender, email, html, [csvAttachment]);

  sendEvent(uid, "driveOrganizeProposed", {
    totalFiles: String(cost.totalFiles),
    filesToChange: String(cost.totalFiles - cost.filesToKeep),
    totalCost: cost.totalCost.toFixed(2),
  });

  logger.info("Drive organize: Proposal sent", {
    uid, totalFiles: cost.totalFiles,
    filesToChange: cost.totalFiles - cost.filesToKeep,
    totalCost: cost.totalCost,
    proposalId,
  });

  return {
    totalFiles: cost.totalFiles,
    filesToMove: cost.filesToMove,
    filesToRename: cost.filesToRename,
    totalCost: cost.totalCost,
    proposalSent: true,
  };
}

// ============================================================================
// APPROVAL HANDLER
// ============================================================================

/**
 * Handle a user's approval reply to an organize-drive proposal.
 * Called from driveHandler when ?o= embedded data is detected.
 */
async function handleOrganizeApproval(
    email: TransformedEmail,
    proposalId: string,
): Promise<OrganizeProcessingResult> {
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    return emptyResult("No sender found");
  }

  // Look up user
  const uid = await getUserFromEmail(sender);
  if (!uid) {
    logger.warn("Drive organize approval: Unknown user", {sender});
    return emptyResult("User not found");
  }

  // Fetch proposal from Firestore
  let proposalDoc: OrganizeProposalDoc;
  try {
    const raw = await getOrganizeProposal(proposalId);
    if (!raw) {
      logger.warn("Drive organize approval: Proposal not found", {proposalId});
      const html = applyTemplate(driveMailTemplates.organizeError.html, {});
      await sendOrganizeEmailResponse(sender, email, html);
      return emptyResult("Proposal not found");
    }
    proposalDoc = raw as unknown as OrganizeProposalDoc;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize approval: Failed to fetch proposal", {
      proposalId, error: errMsg,
    });
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Proposal fetch failed");
  }

  // Validate proposal ownership
  if (proposalDoc.uid !== uid) {
    logger.warn("Drive organize: UID mismatch", {
      proposalUid: proposalDoc.uid, senderUid: uid,
    });
    return emptyResult("Unauthorized");
  }

  // Check if this is an undo request
  const replyText = (email.text || "").toLowerCase().trim();
  const isUndo = /\bundo\b/.test(replyText);

  if (isUndo && proposalDoc.status === "completed") {
    return handleOrganizeUndo(email, sender, uid, proposalId, proposalDoc);
  }

  if (proposalDoc.status !== "pending" && proposalDoc.status !== "executing") {
    logger.warn("Drive organize: Proposal not pending", {
      proposalId, status: proposalDoc.status,
    });
    const html = `This proposal has already been ${proposalDoc.status}. ` +
      `Send a new &quot;organize my drive&quot; email to create a fresh proposal.` +
      `<br><br>You can always ask for help: <a href="mailto:${getSupportEmail()}">${getSupportEmail()}</a><br>`;
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult(`Proposal already ${proposalDoc.status}`);
  }

  const now = new Date();
  if (new Date(proposalDoc.expiresAt) < now) {
    logger.warn("Drive organize: Proposal expired", {proposalId});
    const html = `This proposal has expired. ` +
      `Send a new &quot;organize my drive&quot; email to create a fresh proposal.` +
      `<br><br>You can always ask for help: <a href="mailto:${getSupportEmail()}">${getSupportEmail()}</a><br>`;
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Proposal expired");
  }

  // Mark as executing
  await updateOrganizeProposalStatus(proposalId, "executing");

  // Get OAuth client
  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid, "drive");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize approval: OAuth failed", {uid, error: errMsg});
    await updateOrganizeProposalStatus(proposalId, "pending");
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("OAuth failed");
  }

  // Execute the proposal
  const proposal = proposalDoc.proposal;
  let execResult;
  try {
    execResult = await executeOrganizeProposal(oauth2Client, proposal);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize approval: Execution failed", {
      proposalId, error: errMsg,
    });
    await updateOrganizeProposalStatus(proposalId, "pending");
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Execution failed");
  }

  // Integrity check — undo everything if mismatches found
  const mismatches = await verifyOrganizeResults(
      oauth2Client, proposal, execResult.folderMap,
  );

  if (mismatches.length > 0) {
    logger.warn("Drive organize approval: Integrity check failed, undoing", {
      proposalId, mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 10),
    });

    await undoOrganizeActions(oauth2Client, execResult.snapshot);
    await updateOrganizeProposalStatus(proposalId, "pending");

    const html = `We ran into some issues while organizing your Drive and ` +
      `have reverted all changes. Your files are back where they were.` +
      `<br><br>Please try again by sending a new &quot;organize my drive&quot; email.` +
      `<br><br>You can always ask for help: <a href="mailto:${getSupportEmail()}">${getSupportEmail()}</a><br>`;
    await sendOrganizeEmailResponse(sender, email, html);

    sendEvent(uid, "driveOrganizeFailed", {
      proposalId,
      mismatches: String(mismatches.length),
    });

    return emptyResult("Integrity check failed — changes reverted");
  }

  // All good — save snapshot and mark completed
  await updateOrganizeProposalStatus(proposalId, "completed", {
    snapshot: execResult.snapshot,
    completedAt: now.toISOString(),
  });

  // Clean up empty managed folders left behind after reorganization
  await cleanupEmptyManagedFolders(oauth2Client);

  // Send completion email
  const folderTreeHtml = renderFolderTree(proposal);
  const filesChanged = execResult.stats.moved + execResult.stats.renamed;
  const embeddedData: OrganizeEmbeddedData = {proposalId};
  const embeddedHtml = buildOrganizeEmbeddedData(embeddedData);

  const undoToken = signActionToken(proposalId, "undo");
  const undoLink = `${driveOrganizeActionUrl}?proposalId=${proposalId}&action=undo&token=${undoToken}`;

  const html = applyTemplate(driveMailTemplates.organizeComplete.html, {
    SUMMARY: proposal.summary,
    FILES_CHANGED: String(filesChanged),
    FOLDER_TREE: folderTreeHtml,
    EMBEDDED_DATA: embeddedHtml,
    UNDO_LINK: undoLink,
  });
  await sendOrganizeEmailResponse(sender, email, html);

  sendEvent(uid, "driveOrganizeCompleted", {
    filesChanged: String(filesChanged),
    failed: String(execResult.stats.failed),
  });

  logger.info("Drive organize approval: Complete", {
    proposalId, uid,
    moved: execResult.stats.moved,
    renamed: execResult.stats.renamed,
    failed: execResult.stats.failed,
  });

  return {
    totalFiles: proposal.file_actions.length,
    filesToMove: execResult.stats.moved,
    filesToRename: execResult.stats.renamed,
    totalCost: proposalDoc.cost.totalCost,
    proposalSent: false,
  };
}

// ============================================================================
// EXECUTION
// ============================================================================

/**
 * Execute the reorganization proposal on the user's Drive.
 * Creates folders, moves files, renames files, and builds a snapshot for undo.
 */
async function executeOrganizeProposal(
    oauth2Client: Auth.OAuth2Client,
    proposal: DriveOrganizeProposal,
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
        proposal.proposed_folders.some((f) => f.folder_name === action.new_name)) {
      folderMap.set(action.new_name, action.file_id);
    }
  }

  for (const folder of proposal.proposed_folders) {
    // Already mapped from a managed/rename action, or exists at root with the name
    let folderId = folderMap.get(folder.folder_name) ||
      existingRootFolders.get(folder.folder_name);
    if (!folderId) {
      folderId = await createFolder(oauth2Client, folder.folder_name, rootFolderId);
      await placeMarkerFile(oauth2Client, folderId);
    }
    folderMap.set(folder.folder_name, folderId);

    // Create subfolders
    if (folder.subfolders) {
      for (const sub of folder.subfolders) {
        const subPath = `${folder.folder_name}/${sub.subfolder_name}`;
        const existingSubId = await findSubfolder(
            drive, folderId, sub.subfolder_name,
        );
        if (existingSubId) {
          folderMap.set(subPath, existingSubId);
        } else {
          const subId = await createFolder(
              oauth2Client, sub.subfolder_name, folderId,
          );
          folderMap.set(subPath, subId);
        }
      }
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

  const fileParents = new Map<string, string>(); // file_id → current parent_id
  for (let i = 0; i < fileIds.length; i += 100) {
    const batch = fileIds.slice(i, i + 100);
    const fetches = batch.map(async (fileId) => {
      try {
        const resp = await drive.files.get({
          fileId, fields: "id, parents",
        });
        const parentId = resp.data.parents?.[0];
        if (parentId) fileParents.set(fileId, parentId);
      } catch {
        logger.warn("Drive organize: Could not fetch file parent", {fileId});
      }
    });
    await Promise.all(fetches);
  }

  for (const action of proposal.file_actions) {
    if (action.action === "keep") {
      stats.skipped++;
      continue;
    }

    const currentParentId = fileParents.get(action.file_id);
    if (!currentParentId) {
      logger.warn("Drive organize: No parent found for file, skipping", {
        fileId: action.file_id, name: action.current_name,
      });
      stats.failed++;
      continue;
    }

    // Record snapshot entry for undo
    const snapshotEntry: OrganizeSnapshotAction = {
      fileId: action.file_id,
      originalName: action.current_name,
      originalParentId: currentParentId,
      originalParentPath: action.current_path,
    };

    try {
      if (action.action === "move" || action.action === "move_and_rename") {
        const targetFolderId = folderMap.get(action.new_folder);
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
          proposal.proposed_folders.some((f) => f.folder_name === action.new_name);
        if (isFolder) {
          await renameFolder(oauth2Client, action.file_id, action.new_name);
        } else {
          await renameFile(oauth2Client, action.file_id, action.new_name);
        }
        snapshotEntry.newName = action.new_name;
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
async function findSubfolder(
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
// INTEGRITY CHECK
// ============================================================================

/**
 * Verify that executed actions match the proposal.
 * Fetches current state for each changed file and compares against expected.
 */
async function verifyOrganizeResults(
    oauth2Client: Auth.OAuth2Client,
    proposal: DriveOrganizeProposal,
    folderMap: Map<string, string>,
): Promise<Array<{fileId: string; expected: string; actual: string}>> {
  const drive = getDriveClient(oauth2Client);
  const mismatches: Array<{fileId: string; expected: string; actual: string}> = [];

  const actionsToVerify = proposal.file_actions.filter(
      (a) => a.action !== "keep",
  );

  // Verify in batches of 50
  for (let i = 0; i < actionsToVerify.length; i += 50) {
    const batch = actionsToVerify.slice(i, i + 50);
    const checks = batch.map(async (action) => {
      try {
        const resp = await drive.files.get({
          fileId: action.file_id,
          fields: "id, name, parents",
        });

        const actualName = resp.data.name || "";
        const actualParentId = resp.data.parents?.[0] || "";

        // Check name
        if (action.action === "rename" || action.action === "move_and_rename") {
          if (actualName !== action.new_name) {
            mismatches.push({
              fileId: action.file_id,
              expected: `name="${action.new_name}"`,
              actual: `name="${actualName}"`,
            });
          }
        }

        // Check parent
        if (action.action === "move" || action.action === "move_and_rename") {
          const expectedParentId = folderMap.get(action.new_folder);
          if (expectedParentId && actualParentId !== expectedParentId) {
            mismatches.push({
              fileId: action.file_id,
              expected: `parent="${action.new_folder}"`,
              actual: `parent="${actualParentId}"`,
            });
          }
        }
      } catch {
        mismatches.push({
          fileId: action.file_id,
          expected: "accessible",
          actual: "not found or inaccessible",
        });
      }
    });
    await Promise.all(checks);
  }

  return mismatches;
}

// ============================================================================
// UNDO
// ============================================================================

/**
 * Handle an undo request for a completed organize-drive proposal.
 */
async function handleOrganizeUndo(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
): Promise<OrganizeProcessingResult> {
  const snapshot = proposalDoc.snapshot;

  if (!snapshot || snapshot.length === 0) {
    logger.warn("Drive organize undo: No snapshot found", {proposalId});
    const html = `Unable to undo &mdash; no snapshot was saved for this proposal.` +
      `<br><br>You can always ask for help: <a href="mailto:${getSupportEmail()}">${getSupportEmail()}</a><br>`;
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("No snapshot");
  }

  // Check 30-day undo window
  const completedAt = proposalDoc.completedAt;
  if (completedAt) {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (new Date().getTime() - new Date(completedAt).getTime() > thirtyDaysMs) {
      const html = `The 30-day undo window has expired for this proposal.` +
        `<br><br>You can always ask for help: <a href="mailto:${getSupportEmail()}">${getSupportEmail()}</a><br>`;
      await sendOrganizeEmailResponse(sender, email, html);
      return emptyResult("Undo window expired");
    }
  }

  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid, "drive");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize undo: OAuth failed", {uid, error: errMsg});
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("OAuth failed");
  }

  logger.info("Drive organize undo: Starting", {proposalId, actions: snapshot.length});
  await undoOrganizeActions(oauth2Client, snapshot);
  await updateOrganizeProposalStatus(proposalId, "undone");

  const html = applyTemplate(driveMailTemplates.organizeUndone.html, {});
  await sendOrganizeEmailResponse(sender, email, html);

  sendEvent(uid, "driveOrganizeUndone", {
    proposalId,
    filesReverted: String(snapshot.length),
  });

  logger.info("Drive organize undo: Complete", {
    proposalId, uid, filesReverted: snapshot.length,
  });

  return emptyResult();
}

/**
 * Delete any empty agent-managed folders (those with a marker file but no other files).
 */
async function cleanupEmptyManagedFolders(
    oauth2Client: Auth.OAuth2Client,
): Promise<void> {
  try {
    const managedFolders = await findAgentManagedFolders(oauth2Client);
    let deleted = 0;
    for (const folder of managedFolders) {
      const fileCount = await getFolderFileCount(oauth2Client, folder.id);
      if (fileCount === 0) {
        await deleteFolder(oauth2Client, folder.id);
        deleted++;
      }
    }
    if (deleted > 0) {
      logger.info("Drive organize: Deleted empty managed folders", {deleted});
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn("Drive organize: Failed to clean up empty folders", {
      error: errMsg,
    });
  }
}

/**
 * Undo organize actions by moving/renaming files back to their original state,
 * then delete any empty agent-managed folders left behind.
 */
async function undoOrganizeActions(
    oauth2Client: Auth.OAuth2Client,
    snapshot: OrganizeSnapshotAction[],
): Promise<void> {
  // Undo file actions in reverse order
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const entry = snapshot[i];
    try {
      // Undo rename first (restore original name)
      if (entry.newName) {
        await renameFile(oauth2Client, entry.fileId, entry.originalName);
      }

      // Undo move (restore original parent)
      if (entry.newParentId && entry.newParentId !== entry.originalParentId) {
        await moveFile(
            oauth2Client, entry.fileId,
            entry.originalParentId, entry.newParentId,
        );
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Drive organize undo: Failed to revert action", {
        fileId: entry.fileId, error: errMsg,
      });
    }
  }

  logger.info("Drive organize undo: Reverted actions", {
    count: snapshot.length,
  });

  await cleanupEmptyManagedFolders(oauth2Client);
}

export {handleOrganizeDrive, hasFullDriveScope, handleOrganizeApproval, signActionToken};
