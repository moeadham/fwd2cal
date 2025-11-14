/* eslint-disable require-jsdoc */
const {logger} = require("firebase-functions");

/**
 * Process attachments from a Resend email
 * - Downloads ICS files for calendar parsing
 * - Collects image URLs (png, jpg, jpeg, webp) for LLM vision processing
 *
 * @param {Object} resend - Resend client instance
 * @param {string} emailId - Email ID from Resend
 * @return {Promise<Object>} {icsFiles: Array, imageUrls: Array}
 */
async function processAttachments(resend, emailId) {
  const icsFiles = [];
  const imageUrls = [];

  // Get detailed attachment info from list endpoint
  let attachmentsList = [];
  try {
    const {data, error} = await resend.emails.receiving.attachments.list({
      emailId: emailId,
    });
    if (error) {
      logger.error("Failed to list attachments", {error: error.message});
    } else {
      // The response has nested data: {data: {object: 'list', data: [...]}}
      attachmentsList = data?.data || [];
    }
  } catch (listError) {
    logger.error("Failed to list attachments", {error: listError.message});
  }

  // Process ICS attachments (download them from download_url)
  for (const attachmentInfo of attachmentsList) {
    const filename = attachmentInfo.filename?.toLowerCase() || "";
    const isICS = filename.endsWith(".ics");

    if (isICS) {
      try {
        // Fetch the ICS file content from the download URL
        const response = await fetch(attachmentInfo.download_url);
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
        logger.error("Failed to download ICS attachment", {
          error: fetchError.message,
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

  return {icsFiles, imageUrls};
}

module.exports = {
  processAttachments,
};
