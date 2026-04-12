import {logger} from "firebase-functions/v2";
import {Auth} from "googleapis";
import {sendEvent} from "../../../util/analytics";
import {getSupportEmail} from "../../../util/config";
import {getOauthClient} from "../../../auth/authHandler";
import {TransformedEmail} from "../../../util/types";
import {AGENT_EMAIL_ADDRESS, AGENT_NAME} from "../config";
import {applyTemplate, isDriveAuthError} from "../driveUtils";
import {driveMailTemplates} from "../mailTemplates";
import {OrganizeProcessingResult, OrganizeProposalDoc, OrganizeSnapshotAction} from "../types";
import {
  deleteFolder,
  findAgentManagedFolders,
  getFolderChildren,
  getFolderFileCount,
  moveFile,
  renameFile,
} from "../driveHelper";
import {updateOrganizeProposalStatus} from "../../../util/firestoreHandler";
import {emptyResult, sendOrganizeEmailResponse} from "./organizeHelpers";
import {sendOrganizeAuthRequiredEmail} from "./organizeMain";

/** Handles a user request to undo a completed organize proposal. */
export async function handleOrganizeUndo(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
): Promise<OrganizeProcessingResult> {
  const snapshot = proposalDoc.snapshot;

  const supportEmail = getSupportEmail(AGENT_EMAIL_ADDRESS.value());
  const helpLink = `<a href="mailto:${supportEmail}">${supportEmail}</a>`;

  if (!snapshot || snapshot.length === 0) {
    logger.warn("Drive organize undo: No snapshot found", {proposalId});
    const html = `Unable to undo &mdash; no snapshot was saved for this proposal.` +
      `<br><br>You can always ask for help: ${helpLink}<br>`;
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("No snapshot");
  }

  // Check 30-day undo window
  const completedAt = proposalDoc.completedAt;
  if (completedAt) {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (new Date().getTime() - new Date(completedAt).getTime() > thirtyDaysMs) {
      const html = `The 30-day undo window has expired for this proposal.` +
        `<br><br>You can always ask for help: ${helpLink}<br>`;
      await sendOrganizeEmailResponse(sender, email, html);
      return emptyResult("Undo window expired");
    }
  }

  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid, AGENT_NAME);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize undo: OAuth failed", {uid, error: errMsg});
    if (isDriveAuthError(errMsg)) {
      return sendOrganizeAuthRequiredEmail(email, sender, proposalDoc.emailId);
    }
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("OAuth failed");
  }

  logger.info("Drive organize undo: Starting", {proposalId, actions: snapshot.length});
  await undoOrganizeActions(oauth2Client, snapshot);
  await updateOrganizeProposalStatus(proposalId, "undone");

  const html = applyTemplate(driveMailTemplates.organizeUndone.html, {});
  await sendOrganizeEmailResponse(sender, email, html);

  sendEvent(uid, "driveOrganizeUndone", "drive", {
    proposalId,
    filesReverted: String(snapshot.length),
  });

  logger.info("Drive organize undo: Complete", {
    proposalId, uid, filesReverted: snapshot.length,
  });

  return emptyResult();
}

/**
 * Delete any empty agent-managed folders (those with a marker file but no other files).
 */
export async function cleanupEmptyManagedFolders(
    oauth2Client: Auth.OAuth2Client,
): Promise<void> {
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  try {
    const managedFolders = await findAgentManagedFolders(oauth2Client);
    let deleted = 0;
    for (const folder of managedFolders) {
      const children = await getFolderChildren(oauth2Client, folder.id);
      if (children.length === 0) {
        await deleteFolder(oauth2Client, folder.id);
        deleted++;
        continue;
      }

      // Check if all children are empty folders — if so, delete them all
      const allEmptyFolders = children.every((c) => c.mimeType === FOLDER_MIME);
      if (!allEmptyFolders) continue;

      let allEmpty = true;
      for (const child of children) {
        const count = await getFolderFileCount(oauth2Client, child.id);
        if (count > 0) {
          allEmpty = false;
          break;
        }
      }
      if (allEmpty) {
        for (const child of children) {
          await deleteFolder(oauth2Client, child.id);
        }
        await deleteFolder(oauth2Client, folder.id);
        deleted++;
      }
    }
    if (deleted > 0) {
      logger.info("Drive organize: Deleted empty managed folders", {deleted});
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn("Drive organize: Failed to clean up empty folders", {
      error: errMsg,
    });
  }
}

/**
 * Undo organize actions by moving/renaming files back to their original state,
 * then delete any empty agent-managed folders left behind.
 */
export async function undoOrganizeActions(
    oauth2Client: Auth.OAuth2Client,
    snapshot: OrganizeSnapshotAction[],
): Promise<void> {
  // Undo file actions in reverse order
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const entry = snapshot[i];
    try {
      // Undo rename first (restore original name)
      if (entry.newName) {
        await renameFile(oauth2Client, entry.fileId, entry.originalName);
      }

      // Undo move (restore original parent)
      if (entry.newParentId && entry.originalParentId &&
          entry.newParentId !== entry.originalParentId) {
        await moveFile(
            oauth2Client, entry.fileId,
            entry.originalParentId, entry.newParentId,
        );
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Drive organize undo: Failed to revert action", {
        fileId: entry.fileId, error: errMsg,
      });
    }
  }

  logger.info("Drive organize undo: Reverted actions", {
    count: snapshot.length,
  });

  await cleanupEmptyManagedFolders(oauth2Client);
}
