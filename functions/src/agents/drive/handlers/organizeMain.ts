import {logger} from "firebase-functions/v2";
import {
  DRIVE_USERS_COLLECTION,
  findGeneratingProposal,
  getDriveUserPreferences,
  getUserFromEmail,
  getUserFromUID,
  saveOrganizeIntermediateState,
  saveOrganizeProposal,
} from "../../../util/firestoreHandler";
import {getOauthClient} from "../../../auth/authHandler";
import {sendEvent} from "../../../util/analytics";
import {getSenderFromRawEmail, verifyEmail} from "../../../util/emailUtils";
import {TransformedEmail} from "../../../util/types";
import {applyTemplate, isDriveAuthError} from "../driveUtils";
import {OrganizeIntermediateState, OrganizeProcessingResult} from "../types";
import {AGENT_NAME} from "../config";
import {driveMailTemplates, driveFullScopeSignupUrl} from "../mailTemplates";
import {listAllDriveFiles, getRootFolderId} from "../driveHelper";
import {DEFAULT_FOLDER_CONVENTION, detectFolderConvention} from "../llm";
import {
  buildDriveStructureSummary,
  buildFileEntries,
  emptyResult,
  hasFullDriveScope,
  sendOrganizeEmailResponse,
  sendOrganizeFolderPreferencesEmail,
} from "./organizeHelpers";
export {findGeneratingProposal} from "../../../util/firestoreHandler";

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Entry point for the organize-drive flow.
 * Called from handleDriveEmail() when the "organize-drive" skill is matched.
 */
export async function handleOrganizeDrive(
    email: TransformedEmail,
    emailId: string,
): Promise<OrganizeProcessingResult> {
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    return emptyResult("No sender found");
  }

  // Verify email sender
  if (!verifyEmail(email)) {
    logger.warn("Drive organize: Unverified email", {sender});
    return emptyResult("Unverified email");
  }

  // Check if user has OAuth
  const uid = await getUserFromEmail(sender);
  if (!uid) {
    return sendOrganizeAuthRequiredEmail(email, sender, emailId);
  }

  let userData;
  try {
    userData = await getUserFromUID(uid, DRIVE_USERS_COLLECTION);
  } catch (err) {
    logger.debug("Drive organize: User lookup failed", {
      uid, error: err instanceof Error ? err.message : String(err),
    });
    return sendOrganizeAuthRequiredEmail(email, sender, emailId);
  }

  if (!userData.access_token) {
    return sendOrganizeAuthRequiredEmail(email, sender, emailId);
  }

  // Check for full drive scope
  if (!hasFullDriveScope(userData.token_scope)) {
    return sendOrganizeScopeUpgradeEmail(email, sender, emailId);
  }

  const generatingProposal = await findGeneratingProposal(uid, emailId);
  if (generatingProposal) {
    const html = "We're still working on your Drive organization proposal. " +
      "You'll receive an email when it's ready.";
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult();
  }

  // User has full scope — proceed with organization
  return scanAndPropose(email, sender, emailId, uid);
}

/**
 * Send auth-required email with link to full-scope OAuth.
 */
export async function sendOrganizeAuthRequiredEmail(
    email: TransformedEmail,
    sender: string,
    emailId: string,
): Promise<OrganizeProcessingResult> {
  const statePayload = JSON.stringify({emailId, organize: true});
  const encodedState = Buffer.from(statePayload).toString("base64url");
  const signupLink = `${driveFullScopeSignupUrl()}?state=${encodeURIComponent(encodedState)}`;

  const html = applyTemplate(driveMailTemplates.organizeAuthRequired.html, {
    FULL_SCOPE_SIGNUP_LINK: signupLink,
  });
  await sendOrganizeEmailResponse(sender, email, html);

  logger.info("Drive organize: Sent auth-required email", {sender});
  return emptyResult();
}

/**
 * Send scope-upgrade email for users with limited scope.
 */
export async function sendOrganizeScopeUpgradeEmail(
    email: TransformedEmail,
    sender: string,
    emailId: string,
): Promise<OrganizeProcessingResult> {
  const statePayload = JSON.stringify({emailId, organize: true});
  const encodedState = Buffer.from(statePayload).toString("base64url");
  const signupLink = `${driveFullScopeSignupUrl()}?state=${encodeURIComponent(encodedState)}`;

  const html = applyTemplate(driveMailTemplates.organizeAuthRequired.html, {
    FULL_SCOPE_SIGNUP_LINK: signupLink,
  });
  await sendOrganizeEmailResponse(sender, email, html);

  logger.info("Drive organize: Sent scope-upgrade email", {sender});
  return emptyResult();
}

/**
 * Scan the entire Drive and send a reorganization proposal.
 */
export async function scanAndPropose(
    email: TransformedEmail,
    sender: string,
    emailId: string,
    uid: string,
): Promise<OrganizeProcessingResult> {
  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid, AGENT_NAME);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize: OAuth failed", {uid, error: errMsg});
    if (isDriveAuthError(errMsg)) {
      return sendOrganizeAuthRequiredEmail(email, sender, emailId);
    }
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("OAuth failed");
  }

  // Scan entire Drive
  logger.info("Drive organize: Scanning drive", {uid, sender});
  let rawFiles;
  try {
    rawFiles = await listAllDriveFiles(oauth2Client);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize: Failed to list files", {
      uid, error: errMsg,
    });
    if (isDriveAuthError(errMsg)) {
      return sendOrganizeAuthRequiredEmail(email, sender, emailId);
    }
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Drive scan failed");
  }

  // Build file entries with computed paths
  logger.info("Drive organize: Raw files from API", {
    rawCount: rawFiles.length,
  });
  const rootFolderId = await getRootFolderId(oauth2Client);
  const {entries: allFileEntries, isDrivePath} = buildFileEntries(
      rawFiles, rootFolderId,
  );
  const fileEntries = allFileEntries.filter((f) => isDrivePath(f.id));
  logger.info("Drive organize: Excluded non-Drive files", {
    excludedCount: allFileEntries.length - fileEntries.length,
    remainingCount: fileEntries.length,
  });
  const nonFolderFiles = fileEntries.filter((f) => !f.isFolder);
  const topLevelFolderNames = fileEntries
      .filter((f) => f.isFolder && f.parentPath === "My Drive")
      .map((f) => f.name)
      .sort((a, b) => a.localeCompare(b));
  logger.info("Drive organize: File breakdown", {
    total: fileEntries.length,
    files: nonFolderFiles.length,
    folders: fileEntries.filter((f) => f.isFolder).length,
  });

  // Build structure summary
  const {treeSummary} = buildDriveStructureSummary(fileEntries, rootFolderId);

  logger.info("Drive organize: Calling folder convention LLM", {
    uid, fileCount: nonFolderFiles.length,
  });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    const preferences = await getDriveUserPreferences(uid);
    const folderConvention = typeof preferences.folderConvention === "string" && preferences.folderConvention.trim() ?
      preferences.folderConvention.trim() : DEFAULT_FOLDER_CONVENTION;
    const convention = await detectFolderConvention(treeSummary, uid, folderConvention);
    const phaseData = {
      folderPreferences: {
        detectedConvention: convention.detected_convention,
        suggestedConvention: convention.suggested_convention,
        summary: convention.summary,
        topLevelFolderNames,
      },
    };
    const proposalId = await saveOrganizeProposal({
      uid,
      senderEmail: sender,
      emailId,
      status: "pending",
      phase: "folder_preferences",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      attemptCount: 1,
    });

    const intermediateState: OrganizeIntermediateState = {
      driveStructureSummary: treeSummary,
      fileEntries,
      senderEmail: sender,
    };
    await saveOrganizeIntermediateState(
        proposalId,
        {...intermediateState, phaseData} as unknown as Record<string, unknown>,
    );

    await sendOrganizeFolderPreferencesEmail(
        sender,
        email,
        proposalId,
        topLevelFolderNames,
        convention.detected_convention,
        convention.suggested_convention,
    );

    sendEvent(uid, "driveOrganizeFolderPreferencesProposed", "drive", {
      totalFiles: String(nonFolderFiles.length),
    });

    logger.info("Drive organize: Folder preferences sent", {
      uid,
      sender,
      proposalId,
      totalFiles: nonFolderFiles.length,
    });

    return emptyResult(undefined, nonFolderFiles.length);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize: Failed to initialize phased proposal", {
      uid, error: errMsg,
    });
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Phased proposal initialization failed", nonFolderFiles.length);
  }
}
