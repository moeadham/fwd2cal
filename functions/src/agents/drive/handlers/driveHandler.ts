import {logger} from "firebase-functions/v2";
import {getUserFromEmail} from "../../../util/firestoreHandler";
import {sendEvent} from "../../../util/analytics";
import {getSenderFromRawEmail, verifyEmail} from "../../../util/emailUtils";
import {TransformedEmail, ResendClient} from "../../../util/types";
import {DriveProcessingResult} from "../types";
import {fastMatchSkill} from "../../../util/skills/matcher";
import {getSkills} from "../skills";
import {handleOrganizeDrive} from "./organizeMain";
import {handleOrganizeProposalReply} from "./organizeProposal";
import {loadFeatureFlags, isOrganizeDriveEnabled} from "../../../util/featureFlags";
import {driveDeleteUserAccount, driveRemoveEmailFromUser} from "./accountHandler";
import {
  parseEmbeddedDriveData, parseOrganizeEmbeddedData,
} from "../driveUtils";
import {handleMoveReply} from "./moveHandler";
import {handleFileUpload} from "./fileUploadHandler";

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

  // Track all inbound drive emails
  sendEvent(sender, "driveEmailReceived", "drive");

  // Check if this is a REPLY to an organize-drive proposal (approval)
  // Must come before skill match — the quoted thread subject still matches "organize drive"
  if (isOrganizeDriveEnabled()) {
    const organizeData = parseOrganizeEmbeddedData(email.html || "");
    if (organizeData) {
      logger.info("Drive: organize-drive approval detected", {sender, proposalId: organizeData.proposalId});
      await handleOrganizeProposalReply(email, organizeData.proposalId);
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

  return handleFileUpload(email, resend, emailId, sender);
}

export {handleDriveEmail};

// Re-exports for backward compatibility
export {processUpload} from "./uploadHandler";
export {getNextFolderPrefix, parseEmbeddedDriveData, buildEmbeddedDriveData} from "../driveUtils";
