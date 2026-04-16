import {logger} from "firebase-functions/v2";
import {
  saveDriveFileData, getDriveFileData, getDriveUserPreferences,
} from "../../util/firestoreHandler";
import {sendEmailResend} from "../../util/resend";
import {getSupportEmail} from "../../util/config";
import {AGENT_EMAIL_ADDRESS, AGENT_HOSTING_URL, ORGANIZE_PROMO_HTML} from "./config";
import {isOrganizeDriveEnabled} from "../../util/featureFlags";
import {getEmailThreadHeaders, threadEmailHtml} from "../../util/emailUtils";
import {TransformedEmail} from "../../util/types";
import {
  DriveEmbeddedData, DriveEmbeddedFileData, DriveAttachment,
  DriveFolder, FileProposal, FileInfo, OrganizeEmbeddedData,
} from "./types";
import {downloadAttachmentBuffer, extractContentSummary, extractDocumentImageUrls} from "./fileProcessor";
import {DEFAULT_FILENAME_CONVENTION, DEFAULT_FOLDER_CONVENTION, proposeFilePlacement} from "./llm";
import {Auth} from "googleapis";

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Check if an error message indicates an OAuth/authentication failure.
 * Matches the same error strings as the calendar agent's isAuthError check.
 */
export function isDriveAuthError(errMsg: string): boolean {
  return errMsg.includes("invalid_grant") ||
    errMsg.includes("Token has been expired") ||
    errMsg.includes("No refresh token") ||
    errMsg.includes("Insufficient Permission") ||
    errMsg.includes("unauthorized_client");
}

/**
 * Convert a string to Title Case (e.g. "tax documents" → "Tax Documents").
 * Preserves existing NNN- prefixes if present.
 */
export function toTitleCase(str: string): string {
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
export function getExtension(filename: string): string {
  if (!filename) return "";
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filename.slice(lastDot);
}

/**
 * Check if a file's immediate parent is an agent-managed folder (NNN-Category).
 */
export function isInManagedFolder(parentPath: string): boolean {
  const segments = parentPath.split("/");
  const immediateParent = segments[segments.length - 1];
  return /^\d{2,3}-/.test(immediateParent);
}

/**
 * Check if a file is already organized:
 * - Name starts with a YYYY.MM.DD or YYYY-MM-DD date prefix
 * - Immediate parent folder matches NN(N)-Category pattern
 */
export function isFileOrganized(
    fileName: string, parentPath: string,
): boolean {
  const hasDatePrefix =
    /^\d{4}\.\d{2}\.\d{2}\s/.test(fileName) ||
    /^\d{4}-\d{2}-\d{2}\s/.test(fileName);
  if (!hasDatePrefix) return false;

  return isInManagedFolder(parentPath);
}

/**
 * Extract Google Drive file IDs from email HTML.
 * Gmail auto-saves large attachments to Drive and replaces
 * them with links — these emails arrive with no MIME attachments.
 * Also matches Google Workspace links (docs, sheets, slides, drawings).
 */
export function extractDriveFileIds(...sources: string[]): string[] {
  const html = sources.join(" ");
  const ids = new Set<string>();
  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/g,
    /drive\.google\.com\/(?:open|uc)\?[^"]*id=([a-zA-Z0-9_-]+)/g,
    /docs\.google\.com\/(?:document|spreadsheets|presentation|drawings)\/d\/([a-zA-Z0-9_-]+)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

/**
 * Download files from Google Drive using the agent's OAuth credentials.
 * The agent account has view access because Gmail shares files with the recipient.
 * Returns DriveAttachment objects for files that were accessible.
 */
export async function downloadDriveLinkedFiles(
    agentOauthClient: Auth.OAuth2Client,
    fileIds: string[],
    maxBytes: number,
): Promise<DriveAttachment[]> {
  const {google} = await import("googleapis");
  const drive = google.drive({version: "v3", auth: agentOauthClient});
  const results: DriveAttachment[] = [];

  // Google Workspace MIME types require export (no binary content)
  const DOCX = "application/vnd.openxmlformats-officedocument" +
    ".wordprocessingml.document";
  const XLSX = "application/vnd.openxmlformats-officedocument" +
    ".spreadsheetml.sheet";
  const PPTX = "application/vnd.openxmlformats-officedocument" +
    ".presentationml.presentation";
  const WORKSPACE_EXPORT_MAP: Record<string, {
    mimeType: string; ext: string;
  }> = {
    "application/vnd.google-apps.document": {mimeType: DOCX, ext: ".docx"},
    "application/vnd.google-apps.spreadsheet": {mimeType: XLSX, ext: ".xlsx"},
    "application/vnd.google-apps.presentation": {mimeType: PPTX, ext: ".pptx"},
    "application/vnd.google-apps.drawing": {mimeType: "application/pdf", ext: ".pdf"},
  };

  for (const fileId of fileIds) {
    try {
      // Get file metadata
      const meta = await drive.files.get({
        fileId,
        fields: "name,mimeType,size",
      });
      const name = meta.data.name || `drive-file-${fileId}`;
      const mimeType = meta.data.mimeType || "application/octet-stream";
      const size = parseInt(meta.data.size || "0", 10);

      const exportInfo = WORKSPACE_EXPORT_MAP[mimeType];

      if (!exportInfo && size > maxBytes && size > 0) {
        logger.warn("Drive: Shared Drive file too large, skipping", {fileId, size, maxBytes});
        continue;
      }

      let buffer: Buffer;
      let finalName = name;
      let finalMimeType = mimeType;

      if (exportInfo) {
        // Google Workspace files must be exported (they have no direct binary content)
        const resp = await drive.files.export(
            {fileId, mimeType: exportInfo.mimeType},
            {responseType: "arraybuffer"},
        );
        buffer = Buffer.from(resp.data as ArrayBuffer);
        finalMimeType = exportInfo.mimeType;
        // Append export extension if the name doesn't already have one
        if (!name.match(/\.\w{2,5}$/)) {
          finalName = name + exportInfo.ext;
        }

        if (buffer.length > maxBytes) {
          logger.warn("Drive: Exported Workspace file too large, skipping", {fileId, size: buffer.length, maxBytes});
          continue;
        }
      } else {
        // Regular file — download directly
        const resp = await drive.files.get(
            {fileId, alt: "media"},
            {responseType: "arraybuffer"},
        );
        buffer = Buffer.from(resp.data as ArrayBuffer);
      }

      results.push({
        filename: finalName,
        contentType: finalMimeType,
        size: buffer.length,
        content: buffer,
        downloadUrl: "",
      });
      logger.info("Drive: Downloaded shared Drive file", {fileId, name: finalName, size: buffer.length});
    } catch (error) {
      logger.debug("Drive: Could not access shared Drive file", {
        fileId, error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/**
 * Replace template placeholders in an HTML string
 */
export function applyTemplate(html: string, replacements: Record<string, string>): string {
  let result = html;
  result = result.replace(/%HOSTING_URL%/g, AGENT_HOSTING_URL.value());
  result = result.replace(/%SUPPORT_EMAIL%/g, getSupportEmail(AGENT_EMAIL_ADDRESS.value()));
  result = result.replace(/%ORGANIZE_PROMO%/g, isOrganizeDriveEnabled() ? ORGANIZE_PROMO_HTML : "");
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`%${key}%`, "g"), value);
  }
  return result;
}

/**
 * Send a response email back to the sender
 */
export async function sendDriveEmailResponse(
    sender: string,
    originalEmail: TransformedEmail,
    html: string,
): Promise<void> {
  const threadedHtml = threadEmailHtml(originalEmail, html);
  await sendEmailResend({
    to: sender,
    from: AGENT_EMAIL_ADDRESS.value(),
    subject: originalEmail.subject || "Re: Your file",
    html: threadedHtml,
    headers: getEmailThreadHeaders(originalEmail.headers),
  });
}

/**
 * Compute the next NNN- prefix from existing folder names.
 */
export function getNextFolderPrefix(existingFolders: string[]): string {
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
 * Build the embedded HTML link for a given fileDataId.
 */
export function buildEmbeddedDriveHtml(fileDataId: string): string {
  const embedded: DriveEmbeddedData = {fileDataId};
  const encoded = Buffer.from(JSON.stringify(embedded)).toString("base64url");
  const shortCode = fileDataId.slice(0, 8);
  return `<br><a href="https://www.fwd2drive.com/d?r=${encoded}"` +
    ` style="color:#999;font-size:11px;">ref: ${shortCode}</a>`;
}

/**
 * Build embedded drive data for reply detection.
 * Saves file data to Firestore and embeds only the document ID in the email.
 * Uses a visible link so Gmail preserves it when quoting replies.
 */
export async function buildEmbeddedDriveData(
    uid: string,
    files: DriveEmbeddedFileData[],
): Promise<string> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const fileDataId = await saveDriveFileData({
    uid,
    files,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return buildEmbeddedDriveHtml(fileDataId);
}

export interface ParsedDriveData {
  fileDataId: string | null;
  files: DriveEmbeddedFileData[];
}

/**
 * Parse embedded drive data from an email's HTML (quoted thread).
 * Returns the files array and fileDataId (for reuse on moves).
 * Backwards-compatible with old format that embedded files directly.
 */
export async function parseEmbeddedDriveData(
    html: string,
): Promise<ParsedDriveData | null> {
  const linkMatch = html.match(/fwd2drive\.com\/d\?r=([A-Za-z0-9_-]+)/);
  if (!linkMatch) return null;

  try {
    const json = Buffer.from(linkMatch[1], "base64url").toString();
    const parsed = JSON.parse(json);

    // New format: {fileDataId: "..."} — fetch from Firestore
    if (parsed.fileDataId) {
      const doc = await getDriveFileData(parsed.fileDataId);
      if (!doc) {
        logger.warn("Drive: File data not found in Firestore", {
          fileDataId: parsed.fileDataId,
        });
        return null;
      }
      return {
        fileDataId: parsed.fileDataId,
        files: doc.files as DriveEmbeddedFileData[],
      };
    }

    // Old format: {files: [...]} — use directly (backwards compat)
    if (parsed.files) {
      return {
        fileDataId: null,
        files: parsed.files as DriveEmbeddedFileData[],
      };
    }
  } catch {
    logger.warn("Drive: Failed to parse embedded drive data from link");
  }
  return null;
}

/**
 * Parse embedded organize data from an email's HTML (quoted thread).
 * Looks for the visible "View proposal" link with encoded proposalId.
 */
export function parseOrganizeEmbeddedData(html: string): OrganizeEmbeddedData | null {
  const linkMatch = html.match(/fwd2drive\.com\/d\?o=([A-Za-z0-9_-]+)/);
  if (linkMatch) {
    try {
      const json = Buffer.from(linkMatch[1], "base64url").toString();
      return JSON.parse(json) as OrganizeEmbeddedData;
    } catch {
      logger.warn("Drive: Failed to parse embedded organize data from link");
    }
  }
  return null;
}

/**
 * Find a folder in the tree by name (case-insensitive)
 */
export function findFolderByName(
    roots: DriveFolder[],
    targetName: string,
): DriveFolder | null {
  const lower = targetName.toLowerCase();
  /** Searches a Drive folder tree for the best matching folder. */
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
 * Download attachments and extract content summaries + document images for LLM processing.
 */
export async function buildFileInfos(
    attachments: DriveAttachment[],
): Promise<{fileInfos: FileInfo[]; documentImageUrls: string[]}> {
  const allDocumentImageUrls: string[] = [];

  const fileInfos = await Promise.all(attachments.map(async (attachment) => {
    const buffer = attachment.content ?? await downloadAttachmentBuffer(
        attachment.downloadUrl, attachment.filename,
    );
    const contentSummary = buffer ?
      await extractContentSummary(buffer, attachment.contentType) : "";

    if (buffer) {
      const docImages = await extractDocumentImageUrls(buffer, attachment.contentType);
      allDocumentImageUrls.push(...docImages);
    }

    return {
      fileName: attachment.filename,
      mimeType: attachment.contentType,
      fileSize: attachment.size,
      contentSummary,
    };
  }));

  return {fileInfos, documentImageUrls: allDocumentImageUrls};
}

/**
 * Call proposeFilePlacement with a fallback if LLM fails.
 */
export async function callProposalWithFallback(
    fileInfos: FileInfo[],
    emailSubject: string,
    emailBody: string,
    agentFolderNames: string[],
    nextPrefix: string,
    uid: string | null,
    attachments: DriveAttachment[],
    imageUrls: string[] = [],
    filenameConvention?: string,
): Promise<FileProposal> {
  try {
    let resolvedFilenameConvention = getNonEmptyString(filenameConvention);
    let resolvedFolderConvention = DEFAULT_FOLDER_CONVENTION;
    let resolvedFolderConventionDescription: string | undefined;
    if (uid) {
      const preferences = await getDriveUserPreferences(uid);
      if (!resolvedFilenameConvention) {
        resolvedFilenameConvention = getNonEmptyString(preferences.filenameConvention);
      }
      resolvedFolderConvention = getNonEmptyString(preferences.folderConvention) || DEFAULT_FOLDER_CONVENTION;
      resolvedFolderConventionDescription = getNonEmptyString(preferences.folderConventionDescription);
    }
    if (!resolvedFilenameConvention) {
      resolvedFilenameConvention = DEFAULT_FILENAME_CONVENTION;
    }
    return await proposeFilePlacement(
        fileInfos, emailSubject, emailBody,
        agentFolderNames, nextPrefix, uid, imageUrls,
        resolvedFilenameConvention, resolvedFolderConvention, resolvedFolderConventionDescription,
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
