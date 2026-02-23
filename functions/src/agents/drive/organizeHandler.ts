import {logger} from "firebase-functions/v2";
import {getUserFromEmail, getUserFromUID, saveOrganizeProposal} from "../../util/firestoreHandler";
import {getOauthClient} from "../../auth/authHandler";
import {sendEvent} from "../../util/analytics";
import {
  getSupportEmail,
  DRIVE_EMAIL_ADDRESS,
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
} from "./types";
import {driveMailTemplates, driveFullScopeSignupUrl} from "./mailTemplates";
import {listAllDriveFiles} from "./driveHelper";
import {proposeOrganization} from "./llm";

// ============================================================================
// HELPERS
// ============================================================================

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
      modifiedTime: string;
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
    modifiedTime: f.modifiedTime,
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
    userData = await getUserFromUID(uid);
  } catch (err) {
    logger.debug("Drive organize: User lookup failed", {
      uid, error: err instanceof Error ? err.message : String(err),
    });
    return sendOrganizeAuthRequiredEmail(email, sender, emailId);
  }

  if (!userData.driveEnabled || !userData.access_token) {
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

export {handleOrganizeDrive, hasFullDriveScope};
