import {createHmac} from "crypto";
import {
  AGENT_EMAIL_ADDRESS,
  DRIVE_ACTION_SIGNING_KEY,
  ORGANIZE_DRIVE_COST_PER_M_INPUT_TOKENS,
  ORGANIZE_DRIVE_IMAGE_MAX_TOKENS,
  ORGANIZE_DRIVE_TEXT_MAX_TOKENS,
} from "../config";
import {DRIVE_REVISION_EMAIL_AFFECTED_CAP} from "../../../util/config";
import {getEmailThreadHeaders, threadEmailHtml} from "../../../util/emailUtils";
import {sendEmailResend} from "../../../util/resend";
import {TransformedEmail} from "../../../util/types";
import {applyTemplate} from "../driveUtils";
import {
  DriveFileEntry,
  DriveOrganizeProposal,
  OrganizeCostBreakdown,
  OrganizeEmbeddedData,
  OrganizeProcessingResult,
  PlacementSetupData,
  PlacementRulesData,
} from "../types";
import {driveMailTemplates, driveOrganizeActionUrl} from "../mailTemplates";
import {updateOrganizeProposalStatus} from "../../../util/firestoreHandler";
import {renderFolderTree, buildOrganizeEmbeddedData} from "../templates/folderTree";

export interface AffectedAction {
  file_id: string;
  before: {
    current_path: string;
    current_name: string;
    new_folder: string;
    new_name: string;
    action: string;
  };
  after: {
    new_folder: string;
    new_name: string;
    action: string;
  };
}

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
/** Escapes text for small HTML template fragments. */
function escapeHtml(value: string): string {
  return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/** Returns files whose proposed plan changed between the previous and revised versions. */
export function computeAffectedActions(
    beforeActions: DriveOrganizeProposal["file_actions"],
    afterActions: DriveOrganizeProposal["file_actions"],
): AffectedAction[] {
  const afterByFileId = new Map(afterActions.map((action) => [action.file_id, action]));
  return beforeActions.flatMap((before) => {
    const after = afterByFileId.get(before.file_id);
    if (!after) {
      return [];
    }
    if (
      before.action === after.action &&
      before.new_folder === after.new_folder &&
      before.new_name === after.new_name
    ) {
      return [];
    }
    return [{
      file_id: before.file_id,
      before: {
        current_path: before.current_path || "My Drive",
        current_name: before.current_name,
        new_folder: before.new_folder,
        new_name: before.new_name,
        action: before.action,
      },
      after: {
        new_folder: after.new_folder,
        new_name: after.new_name,
        action: after.action,
      },
    }];
  });
}

/** Renders the affected-files block for revision plan-review emails. */
function renderAffectedFilesHtml(affectedActions?: AffectedAction[]): string {
  if (!affectedActions || affectedActions.length === 0) {
    return "";
  }
  const cap = DRIVE_REVISION_EMAIL_AFFECTED_CAP.value();
  const sortedActions = [...affectedActions].sort((left, right) => {
    const leftKey = `${left.after.new_folder}\u0000${left.after.new_name}\u0000${left.file_id}`;
    const rightKey = `${right.after.new_folder}\u0000${right.after.new_name}\u0000${right.file_id}`;
    return leftKey.localeCompare(rightKey);
  });
  const visibleActions = sortedActions.slice(0, cap);
  const rows = visibleActions.map((action) =>
    `${escapeHtml(action.before.current_path)}/${escapeHtml(action.before.current_name)} ` +
    `&rarr; ${escapeHtml(action.after.new_folder)}/${escapeHtml(action.after.new_name)} ` +
    `(${escapeHtml(action.after.action)})`,
  );
  const hiddenCount = sortedActions.length - visibleActions.length;
  if (hiddenCount > 0) {
    rows.push(`... and ${hiddenCount} more`);
  }
  const blockStyle =
    "font-family:monospace;background:#f7f7f7;padding:16px;border-radius:8px;" +
    "font-size:13px;line-height:1.6;";
  return `<b>Affected files (${sortedActions.length}):</b>` +
    `<br>` +
    `<div style="${blockStyle}">` +
    `${rows.join("<br>")}` +
    `</div>` +
    `<br>`;
}
/** Sends the plan-review email with a proposal sheet link and Move Files action link. */
export async function sendOrganizePlanReviewEmail(
    sender: string,
    originalEmail: TransformedEmail,
    proposalId: string,
    proposal: DriveOrganizeProposal,
    sheetUrl: string,
    counts: {totalFiles: number; filesToMove: number; filesToRename: number; filesToKeep: number},
    revisionNote = "",
    affectedActions?: AffectedAction[],
): Promise<void> {
  const moveToken = signActionToken(proposalId, "move");
  const moveLink = `${driveOrganizeActionUrl()}?proposalId=${proposalId}&action=move&token=${moveToken}`;
  const preservedFolderPaths = new Set(
      (proposal.ignoredFolders || [])
          .map((folderPath) => folderPath.split("/").map((segment) => segment.trim()).filter(Boolean).join("/"))
          .filter(Boolean),
  );
  const preservedRootPaths = new Set(
      (proposal.ignoredFolders || [])
          .map((folderPath) => folderPath.split("/").map((segment) => segment.trim()).filter(Boolean))
          .filter((segments) => segments.length === 1)
          .map((segments) => segments[0])
          .filter((root): root is string => Boolean(root && root !== "My Drive")),
  );
  const hasAffectedFiles = Boolean(affectedActions && affectedActions.length > 0);
  const previewBlock = hasAffectedFiles ?
    "" :
    (() => {
      const preview = proposal.file_actions.slice(0, 20).map((action) =>
        `${escapeHtml(action.current_path)}/${escapeHtml(action.current_name)} &rarr; ` +
        `${escapeHtml(action.new_folder)}/${escapeHtml(action.new_name)} ` +
        `(${escapeHtml(action.action)})`,
      ).join("<br>") || "(no file actions)";
      return `<b>Preview:</b>
<br>
<div style="font-family:monospace;background:#f7f7f7;padding:16px;border-radius:8px;font-size:13px;line-height:1.6;">
${preview}
</div>
<br>
`;
    })();
  const noteHtml = revisionNote ?
    `<br><br><span style="color:#666;font-size:13px;">${escapeHtml(revisionNote)}</span>` :
    "";
  const html = applyTemplate(driveMailTemplates.organizePlanReview.html, {
    TOTAL_FILES: String(counts.totalFiles),
    FILES_TO_MOVE: String(counts.filesToMove),
    FILES_TO_RENAME: String(counts.filesToRename),
    FILES_TO_KEEP: String(counts.filesToKeep),
    FOLDER_TREE: renderFolderTree(proposal, preservedRootPaths, preservedFolderPaths),
    AFFECTED_FILES: renderAffectedFilesHtml(affectedActions),
    PREVIEW_BLOCK: previewBlock,
    MOVE_LINK: moveLink,
    SHEET_URL: sheetUrl,
    REVISION_NOTE: noteHtml,
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
  const threadedHtml = threadEmailHtml(originalEmail, html);
  await sendEmailResend({
    to: sender,
    from: AGENT_EMAIL_ADDRESS.value(),
    subject: originalEmail.subject || "Re: Organize your Drive",
    html: threadedHtml,
    headers: getEmailThreadHeaders(originalEmail.headers),
  });
}

/** Sends the scope-too-broad clarification email with the current proposal sheet link. */
export async function sendOrganizePlanReviewScopeTooBroadEmail(
    sender: string,
    originalEmail: TransformedEmail,
    proposalId: string,
    proposal: DriveOrganizeProposal,
    sheetUrl: string,
    counts: {totalFiles: number; filesToMove: number; filesToRename: number; filesToKeep: number},
    revisionNote = "",
): Promise<void> {
  const preservedFolderPaths = new Set(
      (proposal.ignoredFolders || [])
          .map((folderPath) => folderPath.split("/").map((segment) => segment.trim()).filter(Boolean).join("/"))
          .filter(Boolean),
  );
  const preservedRootPaths = new Set(
      (proposal.ignoredFolders || [])
          .map((folderPath) => folderPath.split("/").map((segment) => segment.trim()).filter(Boolean))
          .filter((segments) => segments.length === 1)
          .map((segments) => segments[0])
          .filter((root): root is string => Boolean(root && root !== "My Drive")),
  );
  const preview = proposal.file_actions.slice(0, 20).map((action) =>
    `${escapeHtml(action.current_path)}/${escapeHtml(action.current_name)} &rarr; ` +
    `${escapeHtml(action.new_folder)}/${escapeHtml(action.new_name)} ` +
    `(${escapeHtml(action.action)})`,
  ).join("<br>") || "(no file actions)";
  const noteHtml = revisionNote ?
    `<br><br><span style="color:#666;font-size:13px;">${escapeHtml(revisionNote)}</span>` :
    "";
  const html = applyTemplate(driveMailTemplates.organizePlanReviewScopeTooBroad.html, {
    TOTAL_FILES: String(counts.totalFiles),
    FILES_TO_MOVE: String(counts.filesToMove),
    FILES_TO_RENAME: String(counts.filesToRename),
    FILES_TO_KEEP: String(counts.filesToKeep),
    FOLDER_TREE: renderFolderTree(proposal, preservedRootPaths, preservedFolderPaths),
    ACTION_PREVIEW: preview,
    SHEET_URL: sheetUrl,
    REVISION_NOTE: noteHtml,
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
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
/** Renders directory paths and descriptions for phase emails. */
function renderDirectoryList(
    folders: DriveOrganizeProposal["proposed_folders"],
    preservedFolderPaths?: Set<string>,
): string {
  if (folders.length === 0) {
    return "(no folders proposed)";
  }

  type TreeNode = {
    children: Map<string, TreeNode>;
    description: string;
    fullPath: string;
  };

  const root: TreeNode = {children: new Map(), description: "", fullPath: ""};
  const allPaths = new Set<string>();
  for (const folder of folders) {
    allPaths.add(folder.folder_path);
  }
  for (const preserved of preservedFolderPaths || []) {
    allPaths.add(preserved);
  }

  const descriptions = new Map(folders.map((folder) => [folder.folder_path, folder.description]));
  for (const folderPath of [...allPaths].sort((a, b) => a.localeCompare(b))) {
    const segments = folderPath.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      if (!current.children.has(seg)) {
        current.children.set(seg, {children: new Map(), description: "", fullPath: currentPath});
      }
      const child = current.children.get(seg)!;
      if (i === segments.length - 1 && descriptions.has(folderPath)) {
        child.description = descriptions.get(folderPath) || "";
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
      const isPreserved = preservedFolderPaths?.has(child.fullPath);
      const desc = isPreserved ?
        "&nbsp;&nbsp;<span style=\"color:#888\">(preserved)</span>" :
        child.description ?
          `&nbsp;&nbsp;<span style="color:#888">` +
          `${escapeHtml(child.description)}</span>` :
          "";
      html += `${prefix}${branch}${escapeHtml(name)}/${desc}<br>`;
      render(child, `${prefix}${isLast ? "&nbsp;&nbsp;&nbsp;&nbsp;" : "│&nbsp;&nbsp;&nbsp;"}`);
    }
  }
  render(root, "");
  return html;
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
    preservedFolderPaths?: Set<string>,
): Promise<void> {
  const header = isRevision ?
    "Here's the revised folder structure:" :
    "Here's a first pass at your Google Drive folder structure:";
  const html = applyTemplate(driveMailTemplates.organizePhase1aProposal.html, {
    PHASE1A_HEADER: header,
    CONVENTION_SUMMARY: escapeHtml(conventionSummary || "No existing convention detected."),
    SUMMARY: formatSummaryHtml(escapeHtml(summary || "")),
    FOLDER_TREE: renderDirectoryList(folders, preservedFolderPaths),
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

const GRANULARITY_DESCRIPTIONS: Array<{value: PlacementSetupData["granularity"]; description: string}> = [
  {value: "by_entity", description: "each company, client, project, or organization gets its own folder"},
  {value: "by_document_type", description: "group by document type (Receipts, Contracts, Invoices, Statements)"},
  {value: "by_date", description: "group by year or period (e.g. 2024/, 2025-Q1/)"},
  {value: "mixed", description: "entity folders for ongoing work, document-type folders for one-offs"},
];

function renderGranularityOptions(current: PlacementSetupData["granularity"]): string {
  return GRANULARITY_DESCRIPTIONS
      .map(({value, description}) => {
        const marker = value === current ? " <i>(current)</i>" : "";
        const label = value === current ? `<b>${value}</b>` : value;
        return `- ${label}${marker} &mdash; ${escapeHtml(description)}`;
      })
      .join("<br>");
}

/** Sends the placement-setup phase email. */
export async function sendOrganizePlacementSetupEmail(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    defaults: PlacementSetupData,
): Promise<void> {
  const html = applyTemplate(driveMailTemplates.organizePlacementSetup.html, {
    GRANULARITY_OPTIONS: renderGranularityOptions(defaults.granularity),
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
  await sendOrganizeEmailResponse(sender, email, html);
}

/** Sends the placement-rules phase email. */
export async function sendOrganizePlacementRulesEmail(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    defaults: PlacementRulesData,
): Promise<void> {
  const edgeCaseRules = defaults.edgeCaseRules.length ?
    defaults.edgeCaseRules.map((rule) => `- ${escapeHtml(rule)}`).join("<br>") :
    "Reply with any rules — for placement, filenames, or other organize-drive decisions.";
  const examples = defaults.examples.length ?
    defaults.examples.map((example) => `- ${escapeHtml(example)}`).join("<br>") :
    "Reply with 2-3 file-to-folder examples if you want to guide placement.";
  const html = applyTemplate(driveMailTemplates.organizePlacementRules.html, {
    EDGE_CASE_RULES_PLACEHOLDER: edgeCaseRules,
    EXAMPLES_PLACEHOLDER: examples,
    EMBEDDED_DATA: phaseEmbeddedHtml(proposalId),
  });
  await sendOrganizeEmailResponse(sender, email, html);
}
function renderCostEmailPlacementRulesBlock(
    placementRules: PlacementRulesData | null | undefined,
): string {
  if (!placementRules) {
    return "";
  }
  const rules = Array.isArray(placementRules.edgeCaseRules) ? placementRules.edgeCaseRules : [];
  const examples = Array.isArray(placementRules.examples) ? placementRules.examples : [];
  if (rules.length === 0 && examples.length === 0) {
    return "";
  }
  const sections: string[] = [];
  if (rules.length > 0) {
    const items = rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("");
    sections.push(`<b>Placement rules:</b><br><ul style="margin:4px 0;">${items}</ul>`);
  }
  if (examples.length > 0) {
    const items = examples.map((example) => `<li>${escapeHtml(example)}</li>`).join("");
    sections.push(`<b>Examples:</b><br><ul style="margin:4px 0;">${items}</ul>`);
  }
  return `<br><br>${sections.join("")}`;
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
    preservedFolderPaths?: Set<string>,
    placementRules?: PlacementRulesData | null,
): Promise<void> {
  const examples = filenameExamples
      .map((example) => `- ${escapeHtml(example)}`)
      .join("<br>");
  const approveToken = signActionToken(proposalId, "approve");
  const approveLink = `${driveOrganizeActionUrl()}?proposalId=${proposalId}&action=approve&token=${approveToken}`;
  const html = applyTemplate(driveMailTemplates.organizeCostEstimate.html, {
    FOLDER_TREE: renderDirectoryList(folders, preservedFolderPaths),
    FILENAME_CONVENTION: escapeHtml(filenameConvention),
    FILENAME_EXAMPLES: examples,
    PLACEMENT_RULES: renderCostEmailPlacementRulesBlock(placementRules ?? null),
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
/** Sends the folder preference confirmation email. */
export async function sendOrganizeFolderPreferencesEmail(
    sender: string,
    email: TransformedEmail,
    proposalId: string,
    topLevelFolderNames: string[],
    detectedConvention: string,
    suggestedConvention: string,
    conventionDescription: string = "",
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
  const descriptionBlock = hasDetectedConvention && conventionDescription.trim() ?
    `<span style="color:#666;font-size:13px;">${escapeHtml(conventionDescription.trim())}</span><br>` :
    "";
  const html = applyTemplate(driveMailTemplates.organizeFolderPreferences.html, {
    DETECTED_CONVENTION: escapeHtml(detectedConvention || "No convention detected."),
    CONVENTION_DESCRIPTION: descriptionBlock,
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
