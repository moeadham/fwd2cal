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
import {applyTemplate, toTitleCase} from "../driveUtils";
import {
  DriveFileEntry,
  DriveOrganizeProposal,
  OrganizeCostBreakdown,
  OrganizeEmbeddedData,
  OrganizeProcessingResult,
} from "../types";
import {driveMailTemplates, driveOrganizeActionUrl} from "../mailTemplates";
import {normalizeFolderPrefixes} from "../llm";
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
    parentId: f.parents[0] || null,
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
): {treeSummary: string; fileCount: number; folderCount: number} {
  const folders = files.filter((f) => f.isFolder);
  const nonFolders = files.filter((f) => !f.isFolder);
  const foldersByParent = new Map<string, DriveFileEntry[]>();
  for (const folder of folders) {
    const parentId = folder.parentId || "root";
    if (!foldersByParent.has(parentId)) {
      foldersByParent.set(parentId, []);
    }
    foldersByParent.get(parentId)!.push(folder);
  }
  const fileCountByFolder = new Map<string, number>();
  for (const file of nonFolders) {
    const parentId = file.parentId || "root";
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
  const rootFileCount = fileCountByFolder.get("root") || 0;
  let treeSummary = `My Drive/ (${rootFileCount} files at root)\n`;
  treeSummary += renderTree("root", "  ");
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
  const mimeMap = new Map<string, string>();
  for (const entry of fileEntries) {
    mimeMap.set(entry.id, entry.mimeType);
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
    const mime = mimeMap.get(action.file_id) || "";
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
/** Calculates organize proposal cost from stored MIME metadata. */
export function calculateOrganizeCostFromMimeMap(
    proposal: DriveOrganizeProposal,
    mimeMap: Record<string, string>,
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
    const mime = mimeMap[action.file_id] || "text/plain";
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
type CanonicalRootFolder = {
  prefix: string;
  name: string;
  description: string;
  patterns: RegExp[];
};
export const CANONICAL_ROOT_FOLDERS: CanonicalRootFolder[] = [
  {
    prefix: "01",
    name: "Documents",
    description: "Contracts, legal, medical, insurance, housing, vehicles",
    patterns: [
      /document|contract|legal|medical|health|insurance|policy/i,
      /housing|home|property|lease|mortgage|vehicle|car|auto|registration/i,
    ],
  },
  {
    prefix: "02",
    name: "Finance",
    description: "Tax returns, invoices, receipts, bank statements, budgets",
    patterns: [
      /financ|tax|invoice|receipt|bank|budget|accounting|bill|payment/i,
    ],
  },
  {
    prefix: "03",
    name: "Work",
    description: "Employment, pay stubs, resumes, work projects, clients",
    patterns: [/work|job|employ|career|resume|cv|pay.?stub|client|business|office/i],
  },
  {
    prefix: "04",
    name: "Media",
    description: "Photos, videos, screenshots, creative assets",
    patterns: [/photo|picture|image|video|camera|screenshot|media|film|movie/i],
  },
  {
    prefix: "05",
    name: "Projects",
    description: "Side projects, hobbies, volunteer, creative work",
    patterns: [/project|hobby|creative|volunteer|side|craft/i],
  },
  {
    prefix: "06",
    name: "Personal",
    description: "Identity docs, vital records, family, correspondence",
    patterns: [/personal|family|identity|passport|birth|vital|correspondence|letter/i],
  },
  {
    prefix: "07",
    name: "Education",
    description: "Transcripts, diplomas, coursework, certifications, training",
    patterns: [/educat|school|university|college|course|class|diploma|transcript|certif|training|learn/i],
  },
  {
    prefix: "08",
    name: "Travel",
    description: "Itineraries, bookings, passport copies, visa docs",
    patterns: [/travel|trip|vacation|flight|booking|itinerar|visa|hotel/i],
  },
  {
    prefix: "09",
    name: "Archive",
    description: "Old/inactive files, completed projects, historical records",
    patterns: [/archive|old|backup|legacy|completed|inactive/i],
  },
];
/** Normalizes folder names for canonical category matching. */
export function normalizeFolderNameForMatching(name: string): string {
  return name
      .replace(/^\d{2,3}\s*-\s*/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
}
/** Builds the canonical numbered folder path. */
export function canonicalFolderPath(folder: CanonicalRootFolder): string {
  return `${folder.prefix}-${folder.name}`;
}
/** Finds the canonical root folder that matches a name. */
export function matchCanonicalRootFolder(name: string): CanonicalRootFolder | undefined {
  const normalizedName = normalizeFolderNameForMatching(name);
  return CANONICAL_ROOT_FOLDERS.find((folder) =>
    normalizedName === folder.name.toLowerCase() ||
    folder.patterns.some((matcher) => matcher.test(normalizedName)),
  );
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
/** Creates seed folders and root-folder rename actions from current Drive structure. */
export function seedFoldersFromDrive(
    fileEntries: DriveFileEntry[],
): {
  seedFolders: DriveOrganizeProposal["proposed_folders"];
  folderRenameActions: DriveOrganizeProposal["file_actions"];
} {
  const rootFolders = fileEntries.filter(
      (f) => f.isFolder && f.parentPath === "My Drive",
  );
  rootFolders.sort((a, b) => a.name.localeCompare(b.name));
  const seedFolders: DriveOrganizeProposal["proposed_folders"] = CANONICAL_ROOT_FOLDERS.map((folder) => ({
    folder_path: canonicalFolderPath(folder),
    description: folder.description,
  }));
  const folderRenameActions: DriveOrganizeProposal["file_actions"] = [];
  const seededPaths = new Set(seedFolders.map((folder) => folder.folder_path));
  const seenNames = new Map<string, string>();
  let nextCustomPrefix = 10;
  for (const folder of rootFolders) {
    const baseName = folder.name.replace(/^\d{2,3}\s*-\s*/, "").trim();
    const normalizedFolderName = normalizeFolderNameForMatching(folder.name);
    if (seenNames.has(normalizedFolderName)) {
      const targetFolderName = seenNames.get(normalizedFolderName)!;
      folderRenameActions.push({
        file_id: folder.id,
        current_name: folder.name,
        current_path: "My Drive",
        new_name: targetFolderName,
        new_folder: "My Drive",
        action: targetFolderName === folder.name ? "keep" : "rename",
        reason: `Merged duplicate folder into "${targetFolderName}"`,
      });
      continue;
    }
    const canonicalFolder = matchCanonicalRootFolder(folder.name);
    if (canonicalFolder) {
      const targetFolderPath = canonicalFolderPath(canonicalFolder);
      seenNames.set(normalizedFolderName, targetFolderPath);
      folderRenameActions.push({
        file_id: folder.id,
        current_name: folder.name,
        current_path: "My Drive",
        new_name: targetFolderPath,
        new_folder: "My Drive",
        action: folder.name === targetFolderPath ? "keep" : "rename",
        reason: folder.name === targetFolderPath ?
          "Already using canonical root category" :
          `Mapped to canonical category ${targetFolderPath}`,
      });
      continue;
    }
    const customFolderPath =
      `${String(nextCustomPrefix).padStart(2, "0")}-${toTitleCase(baseName)}`;
    nextCustomPrefix++;
    seenNames.set(normalizedFolderName, customFolderPath);
    if (!seededPaths.has(customFolderPath)) {
      seedFolders.push({
        folder_path: customFolderPath,
        description: `Existing folder "${folder.name}"`,
      });
      seededPaths.add(customFolderPath);
    }
    folderRenameActions.push({
      file_id: folder.id,
      current_name: folder.name,
      current_path: "My Drive",
      new_name: customFolderPath,
      new_folder: "My Drive",
      action: folder.name === customFolderPath ? "keep" : "rename",
      reason: folder.name === customFolderPath ?
        "Already correctly named" :
        `Renamed unmatched folder with custom prefix ${customFolderPath}`,
    });
  }
  return {seedFolders, folderRenameActions};
}
/** Merges chunk-level proposed folders into the accumulated proposal. */
export function mergeChunkProposalFolders(
    accumulatedFolders: DriveOrganizeProposal["proposed_folders"],
    chunkProposal: DriveOrganizeProposal,
): DriveOrganizeProposal["proposed_folders"] {
  const existingPaths = new Set(accumulatedFolders.map((folder) => folder.folder_path));
  chunkProposal.proposed_folders = [
    ...accumulatedFolders,
    ...chunkProposal.proposed_folders,
  ];
  normalizeFolderPrefixes(chunkProposal);
  const mergedFolders = [...accumulatedFolders];
  const mergedPaths = new Set(existingPaths);
  for (const folder of chunkProposal.proposed_folders) {
    if (mergedPaths.has(folder.folder_path)) {
      continue;
    }
    mergedFolders.push(folder);
    mergedPaths.add(folder.folder_path);
  }
  chunkProposal.proposed_folders = mergedFolders;
  return mergedFolders;
}
/** Returns the next chunk indexes to dispatch after a batch completes. */
export function getParallelBatchChunkIndexes(
    completedChunks: number,
    totalChunks: number,
    parallelChunkLimit: number,
): number[] {
  if (completedChunks <= 0 || completedChunks > totalChunks) {
    return [];
  }
  const currentBatchEnd = Math.min(
      totalChunks,
      Math.ceil(completedChunks / parallelChunkLimit) * parallelChunkLimit,
  );
  if (completedChunks !== currentBatchEnd || currentBatchEnd >= totalChunks) {
    return [];
  }
  const nextBatchEnd = Math.min(currentBatchEnd + parallelChunkLimit, totalChunks);
  return Array.from(
      {length: nextBatchEnd - currentBatchEnd},
      (_value, index) => currentBatchEnd + index,
  );
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
