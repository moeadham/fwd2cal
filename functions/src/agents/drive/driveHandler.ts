import {logger} from "firebase-functions/v2";
import {getUserFromEmail, getUserFromUID, DRIVE_USERS_COLLECTION} from "../../util/firestoreHandler";
import {sendEvent} from "../../util/analytics";
import {MAX_DRIVE_UPLOAD_BYTES} from "./config";
import {getSenderFromRawEmail, verifyEmail} from "../../util/emailUtils";
import {TransformedEmail, ResendClient} from "../../util/types";
import {DriveProcessingResult} from "./types";
import {driveMailTemplates, driveSignupUrl} from "./mailTemplates";
import {listAttachments} from "./fileProcessor";
import {collectImageUrls} from "../../util/imageUtils";
import {fastMatchSkill} from "../../util/skills/matcher";
import {getSkills} from "./skills";
import {handleOrganizeDrive, handleOrganizeApproval} from "./organizeHandler";
import {loadFeatureFlags, isOrganizeDriveEnabled} from "../../util/featureFlags";
import {driveDeleteUserAccount, driveRemoveEmailFromUser} from "./accountHandler";
import {
  parseEmbeddedDriveData, parseOrganizeEmbeddedData,
  applyTemplate, sendDriveEmailResponse, getNextFolderPrefix,
  buildFileInfos, callProposalWithFallback, getExtension, ensureDatePrefix,
} from "./driveUtils";
import {processUpload} from "./uploadHandler";
import {handleMoveReply} from "./moveHandler";

/**
 * Main drive handler — processes an inbound email.
 * If the user has OAuth, uploads immediately and tells them they can reply to move.
 * If not, sends an auth-required email with a signup link.
 * Also detects replies for the move-file flow.
 */
async function handleDriveEmail(
    email: TransformedEmail,
    resend: ResendClient,
    emailId: string,
): Promise<DriveProcessingResult> {
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "No sender found"};
  }

  // Verify email sender
  if (!verifyEmail(email)) {
    logger.warn("Drive: Unverified email", {sender});
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "Unverified email"};
  }

  // Load feature flags (no-ops after first call)
  await loadFeatureFlags();

  // Check if this is a REPLY to an organize-drive proposal (approval)
  // Must come before skill match — the quoted thread subject still matches "organize drive"
  if (isOrganizeDriveEnabled()) {
    const organizeData = parseOrganizeEmbeddedData(email.html || "");
    if (organizeData) {
      logger.info("Drive: organize-drive approval detected", {sender, proposalId: organizeData.proposalId});
      await handleOrganizeApproval(email, organizeData.proposalId);
      return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: []};
    }
  }

  // Check if this is a REPLY to an existing upload (move request).
  // Must come before skill match — quoted thread body contains promo text
  // that would otherwise match organize-drive.
  const parsedDriveData = await parseEmbeddedDriveData(email.html || "");
  if (parsedDriveData) {
    return handleMoveReply(
        email, sender, parsedDriveData.files, parsedDriveData.fileDataId,
    );
  }

  // Check for skill match (organize-drive, delete-account, remove-email)
  const skills = getSkills();
  const skillMatch = fastMatchSkill(email.subject || "", email.text || "", skills);
  if (skillMatch?.skillId === "organize-drive" && isOrganizeDriveEnabled()) {
    logger.info("Drive: organize-drive skill matched", {sender, matchedIn: skillMatch.matchedIn});
    await handleOrganizeDrive(email, emailId);
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: []};
  }

  // Account management skills require a known user
  if (skillMatch?.skillId === "delete-account" || skillMatch?.skillId === "remove-email") {
    const uid = await getUserFromEmail(sender);
    if (uid) {
      logger.info("Drive: account skill matched", {sender, skill: skillMatch.skillId});
      if (skillMatch.skillId === "delete-account") {
        await driveDeleteUserAccount(email, sender, uid);
      } else {
        await driveRemoveEmailFromUser(email, sender, uid, skillMatch.extractedValue);
      }
      return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: []};
    }
    // Unknown user — fall through to auth flow below
  }

  // Check if user already has OAuth — if so, organize immediately
  let uid = await getUserFromEmail(sender);
  if (uid) {
    try {
      const userData = await getUserFromUID(uid, DRIVE_USERS_COLLECTION);
      if (userData.access_token) {
        logger.info("Drive: Returning user — organizing immediately", {sender, uid});
        return processUpload(emailId, uid, resend, email);
      }
    } catch {
      // User exists in EmailAddress (e.g. calendar-only) but not in DriveUsers
      uid = null;
    }
  }

  // User doesn't have OAuth — send auth-required email
  logger.info("Drive: New user — sending auth email", {sender});

  // List attachment metadata
  const maxUploadBytes = MAX_DRIVE_UPLOAD_BYTES.value();
  const attachments = await listAttachments(resend, emailId, maxUploadBytes);

  if (attachments.length === 0) {
    if (!uid) {
      // New user with no attachments — send welcome/signup invitation
      logger.info("Drive: New user without attachments — sending signup invitation", {sender});
      const html = applyTemplate(driveMailTemplates.noUserFound.html, {});
      await sendDriveEmailResponse(sender, email, html);
      sendEvent(sender, "driveUserInvited");
      return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: []};
    }
    // Returning user who forgot attachments
    logger.info("Drive: No attachments found", {sender});
    const html = applyTemplate(driveMailTemplates.noAttachments.html, {});
    await sendDriveEmailResponse(sender, email, html);
    return {filesProcessed: 0, filesSucceeded: 0, filesFailed: 0, results: [], error: "No attachments"};
  }

  // Download and extract content summaries + document page images for LLM preview
  const {fileInfos, documentImageUrls} = await buildFileInfos(attachments);
  const allImageUrls = [...collectImageUrls(attachments), ...documentImageUrls];

  // LLM: propose folder + filenames (no agent folders available without OAuth)
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

  // Build signup link with emailId + proposal as state (OAuth callback will reuse proposal)
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
  const signupLink = `${driveSignupUrl}?state=${encodeURIComponent(encodedState)}`;

  // Send auth-required email showing what we'll organize
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

  sendEvent(uid || sender, "driveFileProposed", {
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

export {handleDriveEmail};

// Re-exports for backward compatibility
export {processUpload} from "./uploadHandler";
export {getNextFolderPrefix, parseEmbeddedDriveData, buildEmbeddedDriveData} from "./driveUtils";
