import {logger} from "firebase-functions/v2";
import {
  DRIVE_USERS_COLLECTION,
  findGeneratingProposal,
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
import {DriveOrganizeProposal, OrganizeIntermediateState, OrganizeProcessingResult} from "../types";
import {AGENT_NAME, ORGANIZE_DRIVE_CHUNK_SIZE} from "../config";
import {driveMailTemplates, driveFullScopeSignupUrl} from "../mailTemplates";
import {listAllDriveFiles, getRootFolderId} from "../driveHelper";
import {reconcileFileActions} from "../llm";
import {dispatchOrganizeChunkTask} from "./dispatchHandler";
import {
  buildDriveStructureSummary,
  buildFileEntries,
  calculateOrganizeCost,
  emptyResult,
  hasFullDriveScope,
  seedFoldersFromDrive,
  sendOrganizeEmailResponse,
  sendOrganizeProposalEmail,
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
  const PARALLEL_CHUNK_LIMIT = 10;
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
  const folderFiles = fileEntries.filter((f) => f.isFolder);
  logger.info("Drive organize: File breakdown", {
    total: fileEntries.length,
    files: nonFolderFiles.length,
    folders: folderFiles.length,
  });

  // Check for empty drive
  if (nonFolderFiles.length === 0) {
    const html = applyTemplate(driveMailTemplates.organizeNoFiles.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult();
  }

  // Build structure summary
  const {treeSummary} = buildDriveStructureSummary(fileEntries);

  // Seed folders from existing Drive structure (rename with NNN prefix)
  const {seedFolders, folderRenameActions} = seedFoldersFromDrive(fileEntries);
  logger.info("Drive organize: Seeded folders from existing structure", {
    seedCount: seedFolders.length,
    folderRenames: folderRenameActions.filter((a) => a.action === "rename").length,
  });

  const chunkSize = ORGANIZE_DRIVE_CHUNK_SIZE.value();
  const totalChunks = nonFolderFiles.length === 0 ?
    0 :
    Math.ceil(nonFolderFiles.length / chunkSize);

  // Call LLM for reorganization proposal (chunked)
  logger.info("Drive organize: Calling LLM", {
    uid, fileCount: nonFolderFiles.length,
    totalChunks,
  });

  if (nonFolderFiles.length === 0) {
    const proposal: DriveOrganizeProposal = {
      proposed_folders: seedFolders,
      file_actions: [...folderRenameActions],
      summary: "No files found to organize.",
    };
    reconcileFileActions(proposal);

    const cost = calculateOrganizeCost(proposal, nonFolderFiles);
    const mimeMap = Object.fromEntries(
        nonFolderFiles.map((file) => [file.id, file.mimeType]),
    );

    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const proposalId = await saveOrganizeProposal({
        uid,
        senderEmail: sender,
        emailId,
        status: "pending",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        proposal,
        cost,
        mimeMap,
      });

      await sendOrganizeProposalEmail(sender, email, proposalId, proposal, cost);

      sendEvent(uid, "driveOrganizeProposed", "drive", {
        totalFiles: String(cost.totalFiles),
        filesToChange: String(cost.totalFiles - cost.filesToKeep),
        totalCost: cost.totalCost.toFixed(2),
      });

      logger.info("Drive organize: Proposal sent", {
        uid, totalFiles: cost.totalFiles,
        filesToChange: cost.totalFiles - cost.filesToKeep,
        totalCost: cost.totalCost,
        proposalId,
      });

      return {
        totalFiles: cost.totalFiles,
        filesToMove: cost.filesToMove,
        filesToRename: cost.filesToRename,
        totalCost: cost.totalCost,
        proposalSent: true,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Drive organize: Failed to save direct proposal", {
        uid, error: errMsg,
      });
      const html = applyTemplate(driveMailTemplates.organizeError.html, {});
      await sendOrganizeEmailResponse(sender, email, html);
      return emptyResult("Save failed", nonFolderFiles.length);
    }
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    const proposalId = await saveOrganizeProposal({
      uid,
      senderEmail: sender,
      emailId,
      status: "generating",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      generationStartedAt: now.toISOString(),
      attemptCount: 1,
      currentChunk: 0,
      completedChunks: 0,
      completedChunkIndices: [],
      totalChunks,
    });

    const intermediateState: OrganizeIntermediateState = {
      driveStructureSummary: treeSummary,
      fileEntries: [...folderFiles, ...nonFolderFiles],
      chunkSize,
      seedFolders,
      folderRenameActions,
      completedChunks: 0,
      totalChunks,
      parallelChunkLimit: PARALLEL_CHUNK_LIMIT,
      senderEmail: sender,
    };
    await saveOrganizeIntermediateState(
        proposalId,
        intermediateState as unknown as Record<string, unknown>,
    );

    const scanStartedHtml = applyTemplate(
        driveMailTemplates.organizeScanStarted.html,
        {},
    );
    await sendOrganizeEmailResponse(sender, email, scanStartedHtml);
    logger.info("Drive organize: Sent scan-started acknowledgment", {
      sender,
      proposalId,
      totalChunks,
    });

    const firstBatchSize = Math.min(totalChunks, PARALLEL_CHUNK_LIMIT);
    for (let nextChunkIndex = 0; nextChunkIndex < firstBatchSize; nextChunkIndex++) {
      await dispatchOrganizeChunkTask({
        proposalId,
        emailId,
        uid,
        chunkIndex: nextChunkIndex,
      });
    }

    return emptyResult(undefined, nonFolderFiles.length);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize: Failed to initialize chunked proposal", {
      uid, error: errMsg,
    });
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Chunk initialization failed", nonFolderFiles.length);
  }
}
