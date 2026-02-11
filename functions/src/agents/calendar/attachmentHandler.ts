import {logger} from "firebase-functions/v2";
import {
  ICSFile,
  ProcessedAttachments,
  AttachmentInfo,
  ParsedDocument,
} from "./types";
import {ResendClient} from "../../util/types";
import * as fs from "fs/promises";
import {
  MAX_CHARS_PER_DOCUMENT,
  MAX_TOTAL_DOCUMENT_CHARS,
  MAX_CHARS_PER_SHEET,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_DOCUMENT_BYTES,
} from "../../util/config";
import {DOCUMENT_MIME_TYPES, parseDocument} from "../../util/documentParser";

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
  const maxTotalBytes = parseInt(MAX_TOTAL_DOCUMENT_BYTES.value());
  let totalDocChars = 0;
  let totalDocBytes = 0;
  for (const attachmentInfo of attachmentsList) {
    // Stop if we've reached the total character limit
    if (totalDocChars >= maxTotalChars) {
      logger.info("Reached total document character limit, skipping remaining documents", {
        totalChars: totalDocChars,
        limit: maxTotalChars,
      });
      break;
    }

    // Stop if we've reached the total download size limit
    if (totalDocBytes >= maxTotalBytes) {
      logger.info("Reached total document byte limit, skipping remaining documents", {
        totalBytes: totalDocBytes,
        limit: maxTotalBytes,
      });
      break;
    }

    const contentType = attachmentInfo.content_type?.toLowerCase() || "";
    const docType = DOCUMENT_MIME_TYPES[contentType];

    if (docType) {
      const maxBytes = parseInt(MAX_ATTACHMENT_BYTES.value());
      if (attachmentInfo.size && attachmentInfo.size > maxBytes) {
        logger.warn("Skipping oversized document attachment", {
          filename: attachmentInfo.filename,
          size: attachmentInfo.size,
          limit: maxBytes,
        });
        continue;
      }

      // Check if downloading this attachment would exceed total byte limit
      const estimatedSize = attachmentInfo.size || 0;
      if (estimatedSize && totalDocBytes + estimatedSize > maxTotalBytes) {
        logger.warn("Skipping document - would exceed total byte limit", {
          filename: attachmentInfo.filename,
          size: estimatedSize,
          currentTotal: totalDocBytes,
          limit: maxTotalBytes,
        });
        continue;
      }

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
        totalDocBytes += buffer.length;
        const maxCharsPerDoc = parseInt(MAX_CHARS_PER_DOCUMENT.value());
        const maxCharsSheet = parseInt(MAX_CHARS_PER_SHEET.value());
        let content = await parseDocument(buffer, docType, maxCharsPerDoc, maxCharsSheet);

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
