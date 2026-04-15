import {createHmac} from "crypto";
import {
  AGENT_EMAIL_ADDRESS,
  DRIVE_ACTION_SIGNING_KEY,
  ORGANIZE_DRIVE_COST_PER_M_INPUT_TOKENS,
  ORGANIZE_DRIVE_IMAGE_MAX_TOKENS,
  ORGANIZE_DRIVE_TEXT_MAX_TOKENS,
} from "../config";
import {getEmailThreadHeaders, threadEmailHtml} from "../../../util/emailUtils";
import {sendEmailResend} from "../../../util/resend";
import {TransformedEmail} from "../../../util/types";
import {applyTemplate} from "../driveUtils";
import {
  DriveFileEntry,
  DriveOrganizeProposal,
  DirectoryMoveData,
  OrganizeCostBreakdown,
  OrganizeEmbeddedData,
  OrganizeProcessingResult,
} from "../types";
import {driveMailTemplates, driveOrganizeActionUrl} from "../mailTemplates";
import {updateOrganizeProposalStatus} from "../../../util/firestoreHandler";
import {renderFolderTree, buildOrganizeEmbeddedData} from "../templates/folderTree";
/** Signs organize action URLs with the configured HMAC key. */
export function signActionToken(proposalId: string, action: string): string {
  return createHmac("sha256", DRIVE_ACTION_SIGNING_KEY.value())
      .update(`${proposalId}:${action}`)
      .digest("hex");
}
/** Sends a threaded organize-drive email response. */
export async function sendOrganizeEmailResponse(
    sender: string,
    originalEmail: TransformedEmail,
    html: string,
): Promise<void> {
  const threadedHtml = threadEmailHtml(originalEmail, html);
  await sendEmailResend({
    to: sender,
    from: AGENT_EMAIL_ADDRESS.value(),
    subject: originalEmail.subject || "Re: Organize your Drive",
    html: threadedHtml,
    headers: getEmailThreadHeaders(originalEmail.headers),
  });
}
/** Checks whether a stored OAuth scope includes full Drive access. */
export function hasFullDriveScope(tokenScope: string): boolean {
  if (!tokenScope) return false;
  const scopes = tokenScope.split(/\s+/);
  return scopes.some((s) =>
    s === "https://www.googleapis.com/auth/drive",
  );
}
/**
 * Builds Drive file entries with computed parent paths and a My Drive membership helper.
 *
 * @example
 * ```ts
 * const rootFolderId = "root";
 * const {entries, isDrivePath} = buildFileEntries([
 *   {id: "folder1", name: "Work", parents: [rootFolderId], ...metadata},
 *   {id: "f1", name: "report.pdf", parents: ["folder1"], ...metadata},
 * ], rootFolderId);
 *
 * entries.find((entry) => entry.id === "f1")?.parentPath; // "Work"
 * isDrivePath("f1"); // true
 * ```
 */
export function buildFileEntries(
    rawFiles: Array<{
      id: string;
      name: string;
      mimeType: string;
      parents: string[];
      createdTime: string;
      size: string;
      webViewLink: string;
    }>,
    rootFolderId: string,
): {entries: DriveFileEntry[]; isDrivePath: (id: string) => boolean} {
  const nameMap = new Map<string, string>();
  for (const f of rawFiles) {
    nameMap.set(f.id, f.name);
  }
  const parentMap = new Map<string, string>();
  for (const f of rawFiles) {
    if (f.parents.length > 0) {
      parentMap.set(f.id, f.parents[0]);
    }
  }
  const cache = new Map<string, boolean>();
  /** Checks whether a file parent chain reaches the My Drive root. */
  function isDrivePath(id: string): boolean {
    if (cache.has(id)) return cache.get(id)!;
    const parent = parentMap.get(id);
    if (!parent) {
      cache.set(id, false);
      return false;
    }
    if (parent === rootFolderId) {
      cache.set(id, true);
      return true;
    }
    const result = isDrivePath(parent);
    cache.set(id, result);
    return result;
  }
  /** Computes a display path for a Drive item from the parent map. */
  function getPath(id: string): string {
    const parts: string[] = [];
    let current = parentMap.get(id);
    while (current && nameMap.has(current)) {
      parts.unshift(nameMap.get(current)!);
      current = parentMap.get(current);
    }
    return parts.join("/") || "My Drive";
  }
  const entries = rawFiles.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    parentId: parentMap.get(f.id) || null,
    parentPath: getPath(f.id),
    createdTime: f.createdTime,
    size: parseInt(f.size, 10) || 0,
    webViewLink: f.webViewLink,
    isFolder: f.mimeType === "application/vnd.google-apps.folder",
  }));
  return {entries, isDrivePath};
}
/**
 * Builds compact folder and tree summaries of the current Drive for LLM prompt context.
 *
 * @example
 * ```ts
 * const {treeSummary} = buildDriveStructureSummary(entries);
 * treeSummary;
 * // "My Drive/ (2 files at root)\n  Work/ (3 files)\n    Reports/ (1 files)\n"
 * ```
 */
export function buildDriveStructureSummary(
    files: DriveFileEntry[],
    rootFolderId?: string,
): {treeSummary: string; fileCount: number; folderCount: number} {
  const rootId = rootFolderId || "root";
  const folders = files.filter((f) => f.isFolder);
  const nonFolders = files.filter((f) => !f.isFolder);
  const foldersByParent = new Map<string, DriveFileEntry[]>();
  for (const folder of folders) {
    const parentId = folder.parentId || rootId;
    if (!foldersByParent.has(parentId)) {
      foldersByParent.set(parentId, []);
    }
    foldersByParent.get(parentId)!.push(folder);
  }
  const fileCountByFolder = new Map<string, number>();
  for (const file of nonFolders) {
    const parentId = file.parentId || rootId;
    fileCountByFolder.set(parentId, (fileCountByFolder.get(parentId) || 0) + 1);
  }
  /** Renders a nested folder tree summary for prompt context. */
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
  const rootFileCount = fileCountByFolder.get(rootId) || 0;
  let treeSummary = `My Drive/ (${rootFileCount} files at root)\n`;
  treeSummary += renderTree(rootId, "  ");
  return {
    treeSummary,
    fileCount: nonFolders.length,
    folderCount: folders.length,
  };
}
/** Checks whether a MIME type should be treated as an image. */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}
/** Calculates organize proposal cost from file entries. */
export function calculateOrganizeCost(
    proposal: DriveOrganizeProposal,
    fileEntries: DriveFileEntry[],
): OrganizeCostBreakdown {
  const textMaxTokens = ORGANIZE_DRIVE_TEXT_MAX_TOKENS.value();
  const imageMaxTokens = ORGANIZE_DRIVE_IMAGE_MAX_TOKENS.value();
  const costPerMTokens = parseFloat(ORGANIZE_DRIVE_COST_PER_M_INPUT_TOKENS.value());
  const costPerTextFile = (textMaxTokens * costPerMTokens) / 1_000_000;
  const costPerImageFile = (imageMaxTokens * costPerMTokens) / 1_000_000;
  const mimeTypesByFileId = new Map<string, string>();
  for (const entry of fileEntries) {
    mimeTypesByFileId.set(entry.id, entry.mimeType);
  }
  const actions = proposal.file_actions;
  const filesToMove = actions.filter(
      (a) => a.action === "move" || a.action === "move_and_rename",
  ).length;
  const filesToRename = actions.filter(
      (a) => a.action === "rename" || a.action === "move_and_rename",
  ).length;
  const filesToKeep = actions.filter((a) => a.action === "keep").length;
  const changedActions = actions.filter((a) => a.action !== "keep");
  let textFiles = 0;
  let imageFiles = 0;
  for (const action of changedActions) {
    const mime = mimeTypesByFileId.get(action.file_id) || "";
    if (isImageMimeType(mime)) {
      imageFiles++;
    } else {
      textFiles++;
    }
  }
  const totalCost =
    textFiles * costPerTextFile + imageFiles * costPerImageFile;
  return {
    totalFiles: actions.length,
    filesToMove,
    filesToRename,
    filesToKeep,
    textFiles,
    imageFiles,
    costPerTextFile,
    costPerImageFile,
    totalCost,
  };
}
/** Calculates the cost estimate before content-aware execution. */
export function calculateOrganizeCostEstimate(
    fileEntries: DriveFileEntry[],
): OrganizeCostBreakdown {
  const textMaxTokens = ORGANIZE_DRIVE_TEXT_MAX_TOKENS.value();
  const imageMaxTokens = ORGANIZE_DRIVE_IMAGE_MAX_TOKENS.value();
  const costPerMTokens = parseFloat(ORGANIZE_DRIVE_COST_PER_M_INPUT_TOKENS.value());
  const costPerTextFile = (textMaxTokens * costPerMTokens) / 1_000_000;
  const costPerImageFile = (imageMaxTokens * costPerMTokens) / 1_000_000;
  const nonFolderFiles = fileEntries.filter((file) => !file.isFolder);
  const imageFiles = nonFolderFiles.filter((file) => isImageMimeType(file.mimeType)).length;
  const textFiles = nonFolderFiles.length - imageFiles;
  const totalCost = textFiles * costPerTextFile + imageFiles * costPerImageFile;
  return {
    totalFiles: nonFolderFiles.length,
    filesToMove: nonFolderFiles.length,
    filesToRename: nonFolderFiles.length,
    filesToKeep: 0,
    textFiles,
    imageFiles,
    costPerTextFile,
    costPerImageFile,
    totalCost,
  };
}
/** Calculates organize proposal cost from MIME metadata keyed by file id. */
export function calculateOrganizeCostFromMimeTypesByFileId(
    proposal: DriveOrganizeProposal,
    mimeTypesByFileId: Record<string, string>,
): OrganizeCostBreakdown {
  const textMaxTokens = ORGANIZE_DRIVE_TEXT_MAX_TOKENS.value();
  const imageMaxTokens = ORGANIZE_DRIVE_IMAGE_MAX_TOKENS.value();
  const costPerMTokens = parseFloat(ORGANIZE_DRIVE_COST_PER_M_INPUT_TOKENS.value());
  const costPerTextFile = (textMaxTokens * costPerMTokens) / 1_000_000;
  const costPerImageFile = (imageMaxTokens * costPerMTokens) / 1_000_000;
  const actions = proposal.file_actions;
  const filesToMove = actions.filter(
      (a) => a.action === "move" || a.action === "move_and_rename",
  ).length;
  const filesToRename = actions.filter(
      (a) => a.action === "rename" || a.action === "move_and_rename",
  ).length;
  const filesToKeep = actions.filter((a) => a.action === "keep").length;
  const changedActions = actions.filter((a) => a.action !== "keep");
  let textFiles = 0;
  let imageFiles = 0;
  for (const action of changedActions) {
    const mime = mimeTypesByFileId[action.file_id] || "text/plain";
    if (isImageMimeType(mime)) {
      imageFiles++;
    } else {
      textFiles++;
    }
  }
  const totalCost =
    textFiles * costPerTextFile + imageFiles * costPerImageFile;
  return {
    totalFiles: actions.length,
    filesToMove,
    filesToRename,
    filesToKeep,
    textFiles,
    imageFiles,
    costPerTextFile,
    costPerImageFile,
    totalCost,
  };
}
/** Extracts the user-authored part of an email reply. */
export function extractReplyBody(text: string): string {
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^On .+ wrote:$/i.test(trimmed) ||
      /^---Original Message---$/i.test(trimmed) ||
      trimmed.startsWith(">")) {
      break;
    }
    collected.push(line);
  }
  return collected.join("\n").trim();
}
/** Detects approval wording in a proposal reply. */
export function isApprovalText(text: string): boolean {
  const replyBody = extractReplyBody(text).toLowerCase().trim();
  if (!replyBody) {
    return false;
  }
  const approvalPattern = new RegExp(
      "^(approve[d]?|yes|yep|yeah|ok|okay|sure|go ahead|do it|" +
      "go for it|looks good|lgtm|confirm(ed)?|execute|proceed|" +
      "sounds good|perfect|great)[.?!]?$",
      "i",
  );
  return approvalPattern.test(replyBody);
}
/** Formats a plain-text organize summary for email HTML. */
export function formatSummaryHtml(summary: string): string {
  let html = summary.replace(/\.\s+/g, ".<br>");
  html = html.replace(/\d{4}\.\d{2}\.\d{2}\s*-\s*\S+/g, (match) => `<b>${match}</b>`);
  return html;
}
/** Escapes text for small HTML template fragments. */
function escapeHtml(value: string): string {
  return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}
/** Renders directory paths and descriptions for phase emails. */
function renderDirectoryList(
    folders: DriveOrganizeProposal["proposed_folders"],
): string {
  if (folders.length === 0) {
    return "(no folders proposed)";
  }

  type TreeNode = {
    children: Map<string, TreeNode>;
    description: string;
  };

  const root: TreeNode = {children: new Map(), description: ""};

  for (const folder of [...folders].sort((a, b) => a.folder_path.localeCompare(b.folder_path))) {
    const segments = folder.folder_path.split("/").filter(Boolean);
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!current.children.has(seg)) {
        current.children.set(seg, {children: new Map(), description: ""});
      }
      const child = current.children.get(seg)!;
      if (i === segments.length - 1) {
        child.description = folder.description;
      }
      current = child;
    }
  }

  let html = "My Drive/<br>";
  function render(node: TreeNode, prefix: string): void {
    const entries = [...node.children.entries()];
    for (let i = 0; i < entries.length; i++) {
      const [name, child] = entries[i];
      const isLast = i === entries.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const desc = child.description ?
        `&nbsp;&nbsp;<span style="color:#888">` +
        `${escapeHtml(child.description)}</span>` : "";
      html += `${prefix}${branch}${escapeHtml(name)}/${desc}<br>`;
      render(child, `${prefix}${isLast ? "&nbsp;&nbsp;&nbsp;&nbsp;" : "│&nbsp;&nbsp;&nbsp;"}`);
    }
  }
  render(root, "");
  return html;
}
/** Renders directory move recommendations for phase emails. */
function renderDirectoryMoves(moves: DirectoryMoveData[]): string {
  if (moves.length === 0) {
    return "No directory moves needed.";
  }
  return moves
      .map((move) => `<div><b>${escapeHtml(move.current_path)}</b> -> ` +
        `<b>${escapeHtml(move.proposed_path)}</b><br>` +
        `${escapeHtml(move.reason)}</div>`)
      .join("<br>");
}
/** Builds embedded proposal metadata for phase emails. */
function phaseEmbeddedHtml(proposalId: string): string {
  const embeddedData: OrganizeEmbeddedData = {proposalId};
  return buildOrganizeEmbeddedData(embeddedData);
}
/** Sends the initial directory structure phase email. */
export async function sendOrganizePhase1aEmail(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    conventionSummary: string,
    summary: string,
    folders: DriveOrganizeProposal["proposed_folders"],
    isRevision = false,
): Promise<void> {
  const header = isRevision ?
    "Here's the revised folder structure:" :
    "Here's a first pass at your Google Drive folder structure:";
  const html = applyTemplate(driveMailTemplates.organizePhase1aProposal.html, {
    PHASE1A_HEADER: header,
    CONVENTION_SUMMARY: escapeHtml(conventionSummary || "No existing convention detected."),
    SUMMARY: formatSummaryHtml(escapeHtml(summary || "")),
    FOLDER_TREE: renderDirectoryList(folders),
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
  await sendOrganizeEmailResponse(sender, email, html);
}
/** Sends the directory placement phase email. */
export async function sendOrganizePhase1bEmail(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    summary: string,
    moves: DirectoryMoveData[],
): Promise<void> {
  const html = applyTemplate(driveMailTemplates.organizePhase1bProposal.html, {
    SUMMARY: formatSummaryHtml(escapeHtml(summary || "")),
    DIRECTORY_MOVES: renderDirectoryMoves(moves),
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
  await sendOrganizeEmailResponse(sender, email, html);
}
/** Sends the final directory structure phase email. */
export async function sendOrganizePhase1cEmail(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    summary: string,
    folders: DriveOrganizeProposal["proposed_folders"],
    addedDirectories: string[],
): Promise<void> {
  const addedHtml = addedDirectories.length > 0 ?
    addedDirectories.map((path) => `- ${escapeHtml(path)}`).join("<br>") :
    "No additional directories.";
  const html = applyTemplate(driveMailTemplates.organizePhase1cProposal.html, {
    SUMMARY: formatSummaryHtml(escapeHtml(summary || "")),
    FOLDER_TREE: renderDirectoryList(folders),
    ADDED_DIRECTORIES: addedHtml,
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
  await sendOrganizeEmailResponse(sender, email, html);
}
/** Sends the filename convention phase email. */
export async function sendOrganizePhase2Email(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    convention: string,
    filenameExamples: string[],
): Promise<void> {
  const examples = filenameExamples
      .map((example) => `- ${escapeHtml(example)}`)
      .join("<br>");
  const html = applyTemplate(driveMailTemplates.organizePhase2Proposal.html, {
    FILENAME_CONVENTION: escapeHtml(convention),
    FILENAME_EXAMPLES: examples,
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
  await sendOrganizeEmailResponse(sender, email, html);
}
/** Sends the final cost estimate before execution. */
export async function sendOrganizeCostEstimateEmail(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    folders: DriveOrganizeProposal["proposed_folders"],
    filenameConvention: string,
    cost: OrganizeCostBreakdown,
    filenameExamples: string[],
): Promise<void> {
  const examples = filenameExamples
      .map((example) => `- ${escapeHtml(example)}`)
      .join("<br>");
  const approveToken = signActionToken(proposalId, "approve");
  const approveLink = `${driveOrganizeActionUrl()}?proposalId=${proposalId}&action=approve&token=${approveToken}`;
  const html = applyTemplate(driveMailTemplates.organizeCostEstimate.html, {
    FOLDER_TREE: renderDirectoryList(folders),
    FILENAME_CONVENTION: escapeHtml(filenameConvention),
    FILENAME_EXAMPLES: examples,
    TOTAL_FILES: String(cost.totalFiles),
    TEXT_FILES: String(cost.textFiles),
    IMAGE_FILES: String(cost.imageFiles),
    TOTAL_COST: `$${cost.totalCost.toFixed(2)}`,
    TEXT_COST: `$${(cost.textFiles * cost.costPerTextFile).toFixed(2)}`,
    IMAGE_COST: `$${(cost.imageFiles * cost.costPerImageFile).toFixed(2)}`,
    APPROVE_LINK: approveLink,
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
  await sendOrganizeEmailResponse(sender, email, html);
}
/** Sends an organize proposal email with approval metadata. */
export async function sendOrganizeProposalEmail(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    proposal: DriveOrganizeProposal,
    cost: OrganizeCostBreakdown,
    preservedRootPaths?: Set<string>,
): Promise<void> {
  const embeddedData: OrganizeEmbeddedData = {proposalId};
  const embeddedHtml = buildOrganizeEmbeddedData(embeddedData);
  const folderTreeHtml = renderFolderTree(proposal, preservedRootPaths);
  const approveToken = signActionToken(proposalId, "approve");
  const approveLink = `${driveOrganizeActionUrl()}?proposalId=${proposalId}&action=approve&token=${approveToken}`;
  const html = applyTemplate(driveMailTemplates.organizeProposal.html, {
    SUMMARY: formatSummaryHtml(proposal.summary),
    TOTAL_FILES: String(cost.totalFiles),
    FILES_TO_CHANGE: String(cost.totalFiles - cost.filesToKeep),
    FILES_TO_KEEP: String(cost.filesToKeep),
    FOLDER_TREE: folderTreeHtml,
    TOTAL_COST: `$${cost.totalCost.toFixed(2)}`,
    TEXT_FILES: String(cost.textFiles),
    TEXT_COST: `$${(cost.textFiles * cost.costPerTextFile).toFixed(2)}`,
    IMAGE_FILES: String(cost.imageFiles),
    IMAGE_COST: `$${(cost.imageFiles * cost.costPerImageFile).toFixed(2)}`,
    EMBEDDED_DATA: embeddedHtml,
    APPROVE_LINK: approveLink,
  });
  await sendOrganizeEmailResponse(sender, email, html);
}
/** Sends the folder preference confirmation email. */
export async function sendOrganizeFolderPreferencesEmail(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    topLevelFolderNames: string[],
    detectedConvention: string,
    suggestedConvention: string,
): Promise<void> {
  const hasDetectedConvention = detectedConvention.trim().length > 0;
  const conventionLooksNumbered = /\bNN\b|\d{2,3}[-\s]/i.test(suggestedConvention);
  const matchingFolders = hasDetectedConvention && conventionLooksNumbered ?
    topLevelFolderNames.filter((folder) => /^\d{2,3}[-\s]/.test(folder)) :
    topLevelFolderNames;
  const selectedExamples = (matchingFolders.length > 0 ? matchingFolders : topLevelFolderNames).slice(0, 3);
  const examples = selectedExamples.length > 0 ?
    selectedExamples.map((example) => `- ${escapeHtml(example)}`) :
    ["- No top-level folders found"];
  if (!hasDetectedConvention && topLevelFolderNames.length > selectedExamples.length) {
    examples.push("- ...");
  }
  const html = applyTemplate(driveMailTemplates.organizeFolderPreferences.html, {
    DETECTED_CONVENTION: escapeHtml(detectedConvention || "No convention detected."),
    SUGGESTED_CONVENTION: escapeHtml(suggestedConvention),
    FOLDER_EXAMPLES: examples.join("<br>"),
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
  await sendOrganizeEmailResponse(sender, email, html);
}
/** Marks proposal generation as failed and notifies the sender. */
export async function failOrganizeGeneration(
    proposalId: string,
    sender: string,
    email: TransformedEmail,
    errorMessage: string,
): Promise<void> {
  await updateOrganizeProposalStatus(proposalId, "failed", {
    generationStartedAt: null,
    lastError: errorMessage,
  });
  const html = applyTemplate(driveMailTemplates.organizeError.html, {});
  await sendOrganizeEmailResponse(sender, email, html);
}
/** Builds an empty organize processing result. */
export function emptyResult(
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
