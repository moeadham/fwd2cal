import {logger} from "firebase-functions/v2";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const MAX_IMAGE_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50MB

interface ImageCandidate {
  filename: string;
  size: number;
  downloadUrl: string;
}

/**
 * Collect download URLs for image attachments (for LLM vision processing).
 * Enforces a 50MB total payload limit.
 */
function collectImageUrls(attachments: ImageCandidate[]): string[] {
  const imageUrls: string[] = [];
  let totalSize = 0;

  for (const attachment of attachments) {
    const filename = attachment.filename?.toLowerCase() || "";
    const isImage = IMAGE_EXTENSIONS.some((ext) => filename.endsWith(ext));

    if (isImage) {
      if (totalSize + attachment.size <= MAX_IMAGE_PAYLOAD_BYTES) {
        imageUrls.push(attachment.downloadUrl);
        totalSize += attachment.size;
        logger.info("Added image URL for LLM processing", {
          filename: attachment.filename,
          size: attachment.size,
          totalSize,
        });
      } else {
        logger.warn("Skipping image - would exceed 50MB limit", {
          filename: attachment.filename,
          size: attachment.size,
          currentTotal: totalSize,
        });
        break;
      }
    }
  }

  if (imageUrls.length > 0) {
    logger.info("Collected image URLs for LLM", {
      count: imageUrls.length,
      totalSize,
    });
  }

  return imageUrls;
}

export {collectImageUrls, ImageCandidate};
