import {logger} from "firebase-functions/v2";
import * as fs from "fs/promises";
import {Readable} from "stream";
import {ReadableStream as WebReadableStream} from "stream/web";
import {DriveAttachment} from "./types";
import {ResendClient} from "../../util/types";
import {AttachmentInfo} from "../calendar/types";
import {DOCUMENT_MIME_TYPES, parseDocument} from "../../util/documentParser";
import {
  MAX_CHARS_PER_DOCUMENT,
  MAX_CHARS_PER_SHEET,
} from "../../util/config";

interface FetchResponse {
  ok: boolean;
  buffer: () => Promise<Buffer>;
  text: () => Promise<string>;
  status?: number;
}

/**
 * Fetch content from a URL, supporting both http(s) and file:// URLs
 */
async function fetchUrl(url: string): Promise<FetchResponse> {
  if (url.startsWith("file://")) {
    const filePath = url.replace("file://", "");
    try {
      const buffer = await fs.readFile(filePath);
      return {
        ok: true,
        buffer: async () => buffer,
        text: async () => buffer.toString("utf-8"),
      };
    } catch (_err) {
      return {
        ok: false,
        buffer: async () => Buffer.from(""),
        text: async () => "",
        status: 404,
      };
    }
  }
  const response = await fetch(url);
  return {
    ok: response.ok,
    buffer: async () => Buffer.from(await response.arrayBuffer()),
    text: () => response.text(),
    status: response.status,
  };
}

/**
 * List attachment metadata from a Resend email (no downloading).
 */
async function listAttachments(
    resend: ResendClient,
    emailId: string,
    maxUploadBytes: number,
): Promise<DriveAttachment[]> {
  let attachmentsList: AttachmentInfo[] = [];
  try {
    const {data, error} = await resend.emails.receiving.attachments.list({
      emailId: emailId,
    });
    if (error) {
      logger.error("Failed to list attachments for drive", {error: error.message});
      return [];
    }
    attachmentsList = data?.data || [];
    logger.info("Drive attachments list received", {
      count: attachmentsList.length,
      filenames: attachmentsList.map((a) => a.filename),
    });
  } catch (listError) {
    const errorMessage =
      listError instanceof Error ? listError.message : String(listError);
    logger.error("Failed to list attachments for drive", {error: errorMessage});
    return [];
  }

  const attachments: DriveAttachment[] = [];
  for (const info of attachmentsList) {
    if (info.size && info.size > maxUploadBytes) {
      logger.warn("Skipping oversized attachment for drive", {
        filename: info.filename,
        size: info.size,
        limit: maxUploadBytes,
      });
      continue;
    }
    attachments.push({
      filename: info.filename,
      contentType: info.content_type || "application/octet-stream",
      size: info.size || 0,
      content: null,
      downloadUrl: info.download_url,
    });
  }
  return attachments;
}

/**
 * Download a single attachment into a Buffer.
 */
async function downloadAttachmentBuffer(
    url: string,
    filename: string,
): Promise<Buffer | null> {
  try {
    const response = await fetchUrl(url);
    if (!response.ok) {
      logger.error("Failed to download attachment for drive", {
        status: response.status,
        filename,
      });
      return null;
    }
    const buffer = await response.buffer();
    logger.info("Downloaded attachment for drive", {filename, size: buffer.length});
    return buffer;
  } catch (fetchError) {
    const errorMessage =
      fetchError instanceof Error ? fetchError.message : String(fetchError);
    logger.error("Failed to download attachment for drive", {
      error: errorMessage,
      filename,
    });
    return null;
  }
}

/**
 * Extract a text summary from a file buffer for LLM context.
 * Returns extracted text, or empty string for unsupported types.
 */
async function extractContentSummary(
    buffer: Buffer,
    contentType: string,
): Promise<string> {
  const docType = DOCUMENT_MIME_TYPES[contentType.toLowerCase()];
  if (!docType) {
    return "";
  }

  try {
    const maxChars = parseInt(MAX_CHARS_PER_DOCUMENT.value());
    const maxCharsSheet = parseInt(MAX_CHARS_PER_SHEET.value());
    return await parseDocument(buffer, docType, maxChars, maxCharsSheet);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    logger.warn("Failed to extract content summary", {
      contentType,
      error: errorMessage,
    });
    return "";
  }
}

/**
 * Stream file content from a URL as a Node.js Readable (no buffering).
 */
async function streamFromUrl(url: string): Promise<Readable> {
  if (url.startsWith("file://")) {
    const filePath = url.replace("file://", "");
    const {createReadStream} = await import("fs");
    return createReadStream(filePath);
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to stream from URL: ${response.status}`);
  }
  return Readable.fromWeb(response.body as WebReadableStream);
}

export {listAttachments, downloadAttachmentBuffer, extractContentSummary, streamFromUrl};
