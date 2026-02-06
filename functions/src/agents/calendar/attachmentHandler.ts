import {logger} from "firebase-functions/v2";
import {
  ICSFile,
  ProcessedAttachments,
  AttachmentInfo,
  ParsedDocument,
} from "./types";
import {ResendClient} from "../../util/types";
import {PDFParse} from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import * as fs from "fs/promises";
import {
  MAX_CHARS_PER_DOCUMENT,
  MAX_TOTAL_DOCUMENT_CHARS,
  MAX_CHARS_PER_SHEET,
} from "../../util/config";

interface FetchResponse {
  ok: boolean;
  buffer: () => Promise<Buffer>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  status?: number;
}

/**
 * Fetch content from a URL, supporting both http(s) and file:// URLs
 * File URLs are used for testing with local fixtures
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
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      };
    } catch (_err) {
      return {
        ok: false,
        buffer: async () => Buffer.from(""),
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
        status: 404,
      };
    }
  }
  const response = await fetch(url);
  return {
    ok: response.ok,
    buffer: async () => Buffer.from(await response.arrayBuffer()),
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
    status: response.status,
  };
}

// Supported document MIME types
const DOCUMENT_MIME_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "text/csv": "csv",
  "text/plain": "txt",
};

/**
 * Parse a PDF file, extracting text from the first 2 pages
 */
async function parsePDF(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({data: buffer});
  const result = await parser.getText({last: 2});
  await parser.destroy();
  return result.text.slice(0, parseInt(MAX_CHARS_PER_DOCUMENT.value()));
}

/**
 * Parse a DOCX file, extracting raw text
 */
async function parseDOCX(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({buffer});
  return result.value.slice(0, parseInt(MAX_CHARS_PER_DOCUMENT.value()));
}

/**
 * Parse an Excel file, converting first 2 sheets to CSV text
 */
function parseExcel(buffer: Buffer): string {
  const workbook = XLSX.read(buffer);
  const sheets = workbook.SheetNames.slice(0, 2);
  return sheets.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
    return `## Sheet: ${name}\n${csv.slice(0, parseInt(MAX_CHARS_PER_SHEET.value()))}`;
  }).join("\n\n").slice(0, parseInt(MAX_CHARS_PER_DOCUMENT.value()));
}

/**
 * Parse a CSV file
 */
function parseCSV(buffer: Buffer): string {
  return buffer.toString("utf-8").slice(0, parseInt(MAX_CHARS_PER_DOCUMENT.value()));
}

/**
 * Parse a plain text file
 */
function parseTXT(buffer: Buffer): string {
  return buffer.toString("utf-8").slice(0, parseInt(MAX_CHARS_PER_DOCUMENT.value()));
}

/**
 * Route to the appropriate parser based on document type
 */
async function parseDocument(buffer: Buffer, docType: string): Promise<string> {
  switch (docType) {
    case "pdf":
      return parsePDF(buffer);
    case "docx":
      return parseDOCX(buffer);
    case "xlsx":
    case "xls":
      return parseExcel(buffer);
    case "csv":
      return parseCSV(buffer);
    case "txt":
      return parseTXT(buffer);
    default:
      return "";
  }
}

/**
 * Process attachments from a Resend email
 * - Downloads ICS files for calendar parsing
 * - Collects image URLs (png, jpg, jpeg, webp) for LLM vision processing
 * - Parses document attachments (PDF, DOCX, Excel, CSV, TXT)
 */
async function processAttachments(
    resend: ResendClient,
    emailId: string,
): Promise<ProcessedAttachments> {
  const icsFiles: ICSFile[] = [];
  const imageUrls: string[] = [];
  const documents: ParsedDocument[] = [];

  // Get detailed attachment info from list endpoint
  let attachmentsList: AttachmentInfo[] = [];
  try {
    logger.info("Fetching attachments for email", {emailId});
    const {data, error} = await resend.emails.receiving.attachments.list({
      emailId: emailId,
    });
    if (error) {
      logger.error("Failed to list attachments", {error: error.message});
    } else {
      // The response has nested data: {data: {object: 'list', data: [...]}}
      attachmentsList = data?.data || [];
      logger.info("Attachments list received", {
        count: attachmentsList.length,
        attachments: attachmentsList.map((a) => a.filename),
      });
    }
  } catch (listError) {
    const errorMessage =
      listError instanceof Error ? listError.message : String(listError);
    logger.error("Failed to list attachments", {error: errorMessage});
  }

  // Process ICS attachments (download them from download_url)
  for (const attachmentInfo of attachmentsList) {
    const filename = attachmentInfo.filename?.toLowerCase() || "";
    const isICS = filename.endsWith(".ics");

    if (isICS) {
      try {
        // Fetch the ICS file content from the download URL
        const response = await fetchUrl(attachmentInfo.download_url);
        if (!response.ok) {
          logger.error("Failed to download ICS attachment", {
            status: response.status,
            attachmentId: attachmentInfo.id,
            filename: attachmentInfo.filename,
          });
          continue;
        }
        const icsContent = await response.text();
        icsFiles.push({
          fieldname: "attachment",
          file: Buffer.from(icsContent),
          filename: {filename: attachmentInfo.filename},
          encoding: "7bit",
          mimetype: attachmentInfo.content_type || "text/calendar",
        });
        logger.info("Downloaded ICS attachment", {
          filename: attachmentInfo.filename,
          size: icsContent.length,
        });
      } catch (fetchError) {
        const errorMessage =
          fetchError instanceof Error ? fetchError.message : String(fetchError);
        logger.error("Failed to download ICS attachment", {
          error: errorMessage,
          attachmentId: attachmentInfo.id,
          filename: attachmentInfo.filename,
        });
      }
    }
  }

  // Process image attachments (get URLs only, up to 50MB total)
  const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"];
  let totalImageSize = 0;
  const maxImagePayloadSize = 50 * 1024 * 1024; // 50MB in bytes

  for (const attachmentInfo of attachmentsList) {
    const filename = attachmentInfo.filename?.toLowerCase() || "";
    const isImage = imageExtensions.some((ext) => filename.endsWith(ext));

    if (isImage) {
      const imageSize = attachmentInfo.size || 0;

      // Check if adding this image would exceed the limit
      if (totalImageSize + imageSize <= maxImagePayloadSize) {
        imageUrls.push(attachmentInfo.download_url);
        totalImageSize += imageSize;
        logger.info("Added image URL for LLM processing", {
          filename: attachmentInfo.filename,
          size: imageSize,
          totalSize: totalImageSize,
        });
      } else {
        logger.warn("Skipping image - would exceed 50MB limit", {
          filename: attachmentInfo.filename,
          size: imageSize,
          currentTotal: totalImageSize,
        });
        break; // Stop processing more images
      }
    }
  }

  if (imageUrls.length > 0) {
    logger.info("Collected image URLs for LLM", {
      count: imageUrls.length,
      totalSize: totalImageSize,
    });
  }

  // Process document attachments (PDF, DOCX, Excel, CSV, TXT)
  const maxTotalChars = parseInt(MAX_TOTAL_DOCUMENT_CHARS.value());
  let totalDocChars = 0;
  for (const attachmentInfo of attachmentsList) {
    // Stop if we've reached the total character limit
    if (totalDocChars >= maxTotalChars) {
      logger.info("Reached total document character limit, skipping remaining documents", {
        totalChars: totalDocChars,
        limit: maxTotalChars,
      });
      break;
    }

    const contentType = attachmentInfo.content_type?.toLowerCase() || "";
    const docType = DOCUMENT_MIME_TYPES[contentType];

    if (docType) {
      try {
        const response = await fetchUrl(attachmentInfo.download_url);
        if (!response.ok) {
          logger.error("Failed to download document attachment", {
            status: response.status,
            attachmentId: attachmentInfo.id,
            filename: attachmentInfo.filename,
          });
          continue;
        }
        const buffer = await response.buffer();
        let content = await parseDocument(buffer, docType);

        // Truncate if adding this would exceed total limit
        const remainingChars = maxTotalChars - totalDocChars;
        if (content.length > remainingChars) {
          content = content.slice(0, remainingChars);
        }

        if (content) {
          documents.push({
            filename: attachmentInfo.filename,
            content,
            mimeType: contentType,
          });
          totalDocChars += content.length;
          logger.info("Parsed document attachment", {
            filename: attachmentInfo.filename,
            type: docType,
            contentLength: content.length,
            totalDocChars,
          });
        }
      } catch (parseError) {
        const errorMessage =
          parseError instanceof Error ? parseError.message : String(parseError);
        logger.error("Failed to parse document attachment", {
          error: errorMessage,
          attachmentId: attachmentInfo.id,
          filename: attachmentInfo.filename,
        });
      }
    }
  }

  if (documents.length > 0) {
    logger.info("Parsed documents for LLM", {
      count: documents.length,
      filenames: documents.map((d) => d.filename),
    });
  }

  return {icsFiles, imageUrls, documents};
}

export {processAttachments};
