import {logger} from "firebase-functions/v2";
import {getOauthClient} from "../../../auth/authHandler";
import {sendEvent} from "../../../util/analytics";
import {getUserFromEmail, getUserFromUID, DRIVE_USERS_COLLECTION} from "../../../util/firestoreHandler";
import {collectImageUrls} from "../../../util/imageUtils";
import {ResendClient, TransformedEmail} from "../../../util/types";
import {AGENT_NAME, DRIVE_USER_EMAIL, MAX_DRIVE_UPLOAD_BYTES} from "../config";
import {listAttachments} from "../fileProcessor";
import {driveMailTemplates, driveSignupUrl} from "../mailTemplates";
import {DriveProcessingResult} from "../types";
import {
  applyTemplate,
  buildFileInfos,
  callProposalWithFallback,
  downloadDriveLinkedFiles,
  ensureDatePrefix,
  extractDriveFileIds,
  getExtension,
  getNextFolderPrefix,
  sendDriveEmailResponse,
} from "../driveUtils";
import {processUpload} from "./uploadHandler";

/** Handles the file-upload path for returning and unauthenticated Drive users. */
export async function handleFileUpload(
    email: TransformedEmail,
    resend: ResendClient,
    emailId: string,
    sender: string,
): Promise<DriveProcessingResult> {
  let uid = await getUserFromEmail(sender);
  if (uid) {
    try {
      const userData = await getUserFromUID(uid, DRIVE_USERS_COLLECTION);
      if (userData.access_token) {
        logger.info("Drive: Returning user — organizing immediately", {sender, uid});
        return processUpload(emailId, uid, resend, email);
      }
    } catch {
      uid = null;
    }
  }

  logger.info("Drive: New user — sending auth email", {sender});

  const maxUploadBytes = MAX_DRIVE_UPLOAD_BYTES.value();
  const attachments = await listAttachments(resend, emailId, maxUploadBytes);

  if (attachments.length === 0) {
    const driveFileIds = extractDriveFileIds(email.html || "", email.text || "");
    if (driveFileIds.length > 0) {
      logger.info("Drive: No attachments but Drive links detected, downloading via agent", {
        sender, driveFileIds,
      });
      try {
        const agentUid = await getUserFromEmail(DRIVE_USER_EMAIL.value());
        if (agentUid) {
          const agentOauth = await getOauthClient(agentUid, AGENT_NAME);
          const driveAttachments = await downloadDriveLinkedFiles(
              agentOauth, driveFileIds, maxUploadBytes,
          );
          if (driveAttachments.length > 0) {
            attachments.push(...driveAttachments);
          }
        }
      } catch (error) {
        logger.warn("Drive: Failed to download Drive-linked files via agent", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (attachments.length === 0) {
      if (!uid) {
        logger.info("Drive: New user without attachments — sending signup invitation", {sender});
        const html = applyTemplate(driveMailTemplates.noUserFound.html, {});
        await sendDriveEmailResponse(sender, email, html);
        sendEvent(sender, "driveUserInvited", "drive");
        return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: []};
      }

      logger.info("Drive: No attachments found", {sender});
      const html = applyTemplate(driveMailTemplates.noAttachments.html, {});
      await sendDriveEmailResponse(sender, email, html);
      return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "No attachments"};
    }
  }

  const {fileInfos, documentImageUrls} = await buildFileInfos(attachments);
  const allImageUrls = [...collectImageUrls(attachments), ...documentImageUrls];

  const nextPrefix = getNextFolderPrefix([]);
  const proposal = await callProposalWithFallback(
      fileInfos, email.subject || "", email.text || "",
      [], nextPrefix, uid, attachments, allImageUrls,
  );
  logger.info("Drive: LLM proposal", {
    folder: proposal.folder_name,
    isExisting: proposal.is_existing_folder,
    files: proposal.proposals.map((p) => p.suggested_name),
  });

  const statePayload = JSON.stringify({
    emailId,
    proposal: {
      folder_name: proposal.folder_name,
      is_existing_folder: proposal.is_existing_folder,
      proposals: proposal.proposals.map((p) => ({
        file_index: p.file_index,
        suggested_name: p.suggested_name,
        reason: p.reason,
      })),
    },
  });
  const encodedState = Buffer.from(statePayload).toString("base64url");
  const signupLink = `${driveSignupUrl()}?state=${encodeURIComponent(encodedState)}`;

  const emailDate = email.headers?.date;
  if (proposal.proposals.length === 1) {
    const file = proposal.proposals[0];
    const extension = getExtension(attachments[0].filename);
    const withExt = file.suggested_name.endsWith(extension) ?
      file.suggested_name : `${file.suggested_name}${extension}`;
    const suggestedName = ensureDatePrefix(withExt, emailDate);
    const html = applyTemplate(driveMailTemplates.fileProposal.html, {
      PROPOSED_NAME: suggestedName,
      PROPOSED_FOLDER: proposal.folder_name,
      SIGNUP_LINK: signupLink,
    });
    await sendDriveEmailResponse(sender, email, html);
  } else {
    const fileListHtml = proposal.proposals.map((p) => {
      const att = attachments[p.file_index];
      const extension = att ? getExtension(att.filename) : "";
      const withExt = p.suggested_name.endsWith(extension) ?
        p.suggested_name : `${p.suggested_name}${extension}`;
      const name = ensureDatePrefix(withExt, emailDate);
      return `<b>${name}</b>`;
    }).join("<br>");
    const html = applyTemplate(driveMailTemplates.multipleFileProposal.html, {
      PROPOSED_FOLDER: proposal.folder_name,
      FILE_LIST: fileListHtml,
      SIGNUP_LINK: signupLink,
    });
    await sendDriveEmailResponse(sender, email, html);
  }

  sendEvent(uid || sender, "driveFileProposed", "drive", {
    filesCount: String(attachments.length),
    folder: proposal.folder_name,
  });

  return {
    filesProcessed: attachments.length,
    filesSucceeded: 0,
    filesFailed: 0,
    results: [],
  };
}
