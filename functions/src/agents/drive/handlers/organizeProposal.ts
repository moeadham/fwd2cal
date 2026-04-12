import {logger} from "firebase-functions/v2";
import {sendEvent} from "../../../util/analytics";
import {getSupportEmail} from "../../../util/config";
import {getOauthClient} from "../../../auth/authHandler";
import {getSenderFromRawEmail} from "../../../util/emailUtils";
import {TransformedEmail} from "../../../util/types";
import {AGENT_EMAIL_ADDRESS, AGENT_NAME} from "../config";
import {applyTemplate, isDriveAuthError} from "../driveUtils";
import {driveMailTemplates, driveOrganizeActionUrl} from "../mailTemplates";
import {OrganizeEmbeddedData, OrganizeProcessingResult, OrganizeProposalDoc} from "../types";
import {buildOrganizeEmbeddedData, renderFolderTree} from "../templates/folderTree";
import {
  calculateOrganizeCostFromMimeMap,
  emptyResult,
  extractReplyBody,
  formatSummaryHtml,
  isApprovalText,
  sendOrganizeEmailResponse,
  sendOrganizeProposalEmail,
  signActionToken,
} from "./organizeHelpers";
import {executeOrganizeProposal} from "./organizeExecution";
import {cleanupEmptyManagedFolders, handleOrganizeUndo, undoOrganizeActions} from "./organizeUndo";
import {verifyOrganizeResults} from "./organizeVerify";
import {sendOrganizeAuthRequiredEmail} from "./organizeMain";
import {
  finalizeOrganizeProposal,
  getOrganizeProposal,
  getUserFromEmail,
  updateOrganizeProposalStatus,
} from "../../../util/firestoreHandler";
import {mergeRevisedProposal, renumberFoldersContiguously, reviseOrganization} from "../llm";

/** Handles a user reply that requests changes to a pending organize proposal. */
export async function handleOrganizeRevision(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    userInstructions: string,
): Promise<OrganizeProcessingResult> {
  try {
    const {proposal: revisedProposal, preservedRootPaths} = await reviseOrganization(
        proposalDoc.proposal!,
        userInstructions,
        uid,
    );
    const mergedProposal = mergeRevisedProposal(
        proposalDoc.proposal!,
        revisedProposal,
    );
    renumberFoldersContiguously(mergedProposal, preservedRootPaths);
    const newCost = calculateOrganizeCostFromMimeMap(
        mergedProposal,
        proposalDoc.mimeMap || {},
    );

    await finalizeOrganizeProposal(
        proposalId,
        mergedProposal as unknown as Record<string, unknown>,
        newCost as unknown as Record<string, unknown>,
        proposalDoc.mimeMap as unknown as Record<string, unknown> | undefined,
    );
    await sendOrganizeProposalEmail(
        sender,
        email,
        proposalId,
        mergedProposal,
        newCost,
        preservedRootPaths,
    );

    sendEvent(uid, "driveOrganizeRevised", "drive", {
      proposalId,
      totalFiles: String(newCost.totalFiles),
      filesToChange: String(newCost.totalFiles - newCost.filesToKeep),
      totalCost: newCost.totalCost.toFixed(2),
    });

    logger.info("Drive organize: Proposal revised", {
      proposalId,
      uid,
      totalFiles: newCost.totalFiles,
      filesToChange: newCost.totalFiles - newCost.filesToKeep,
      totalCost: newCost.totalCost,
    });

    return {
      totalFiles: newCost.totalFiles,
      filesToMove: newCost.filesToMove,
      filesToRename: newCost.filesToRename,
      totalCost: newCost.totalCost,
      proposalSent: true,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize revision: Failed", {
      proposalId,
      uid,
      error: errMsg,
    });
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Revision failed");
  }
}
// ============================================================================
// APPROVAL HANDLER
// ============================================================================

/**
 * Handle a user's approval reply to an organize-drive proposal.
 * Called from driveHandler when ?o= embedded data is detected.
 */
export async function handleOrganizeProposalReply(
    email: TransformedEmail,
    proposalId: string,
): Promise<OrganizeProcessingResult> {
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    return emptyResult("No sender found");
  }

  // Look up user
  const uid = await getUserFromEmail(sender);
  if (!uid) {
    logger.warn("Drive organize approval: Unknown user", {sender});
    return emptyResult("User not found");
  }

  // Fetch proposal from Firestore
  let proposalDoc: OrganizeProposalDoc;
  try {
    const raw = await getOrganizeProposal(proposalId);
    if (!raw) {
      logger.warn("Drive organize approval: Proposal not found", {proposalId});
      const html = applyTemplate(driveMailTemplates.organizeError.html, {});
      await sendOrganizeEmailResponse(sender, email, html);
      return emptyResult("Proposal not found");
    }
    proposalDoc = raw as unknown as OrganizeProposalDoc;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize approval: Failed to fetch proposal", {
      proposalId, error: errMsg,
    });
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Proposal fetch failed");
  }

  // Validate proposal ownership
  if (proposalDoc.uid !== uid) {
    logger.warn("Drive organize: UID mismatch", {
      proposalUid: proposalDoc.uid, senderUid: uid,
    });
    return emptyResult("Unauthorized");
  }

  // Check if this is an undo request
  const replyText = (email.text || "").toLowerCase().trim();
  const isUndo = /\bundo\b/.test(replyText);

  if (isUndo && proposalDoc.status === "completed") {
    return handleOrganizeUndo(email, sender, uid, proposalId, proposalDoc);
  }

  const supportEmail = getSupportEmail(AGENT_EMAIL_ADDRESS.value());
  const helpLink = `<a href="mailto:${supportEmail}">${supportEmail}</a>`;

  if (proposalDoc.status !== "pending" && proposalDoc.status !== "executing") {
    logger.warn("Drive organize: Proposal not pending", {
      proposalId, status: proposalDoc.status,
    });
    const html = `This proposal has already been ${proposalDoc.status}. ` +
      `Send a new &quot;organize my drive&quot; email to create a fresh proposal.` +
      `<br><br>You can always ask for help: ${helpLink}<br>`;
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult(`Proposal already ${proposalDoc.status}`);
  }

  const now = new Date();
  if (new Date(proposalDoc.expiresAt) < now) {
    logger.warn("Drive organize: Proposal expired", {proposalId});
    const html = `This proposal has expired. ` +
      `Send a new &quot;organize my drive&quot; email to create a fresh proposal.` +
      `<br><br>You can always ask for help: ${helpLink}<br>`;
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Proposal expired");
  }

  if (!proposalDoc.proposal || !proposalDoc.cost) {
    logger.error("Drive organize: Proposal payload missing", {proposalId});
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Proposal missing");
  }

  const replyBody = extractReplyBody(email.text || "");
  const isApproval = isApprovalText(email.text || "");

  if (replyBody.length === 0 && !isApproval) {
    const html = "We received your reply but couldn't find any instructions. " +
      "Reply with changes you'd like to make, or reply &quot;approve&quot; to proceed.";
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Empty reply");
  }

  if (!isApproval && proposalDoc.status === "pending") {
    return handleOrganizeRevision(
        email,
        sender,
        uid,
        proposalId,
        proposalDoc,
        replyBody,
    );
  }

  // Mark as executing
  await updateOrganizeProposalStatus(proposalId, "executing");

  // Get OAuth client
  let oauth2Client;
  try {
    oauth2Client = await getOauthClient(uid, AGENT_NAME);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize approval: OAuth failed", {uid, error: errMsg});
    await updateOrganizeProposalStatus(proposalId, "pending");
    if (isDriveAuthError(errMsg)) {
      return sendOrganizeAuthRequiredEmail(email, sender, proposalDoc.emailId);
    }
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("OAuth failed");
  }

  const execStartedHtml = applyTemplate(driveMailTemplates.organizeExecutionStarted.html, {});
  await sendOrganizeEmailResponse(sender, email, execStartedHtml);
  logger.info("Drive organize: Sent execution-started acknowledgment", {
    sender,
    proposalId,
  });

  // Execute the proposal
  const proposal = proposalDoc.proposal!;
  let execResult;
  try {
    execResult = await executeOrganizeProposal(oauth2Client, proposal, uid);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize approval: Execution failed", {
      proposalId, error: errMsg,
    });
    await updateOrganizeProposalStatus(proposalId, "pending");
    if (isDriveAuthError(errMsg)) {
      return sendOrganizeAuthRequiredEmail(email, sender, proposalDoc.emailId);
    }
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Execution failed");
  }

  // Integrity check — undo everything if mismatches found
  const mismatches = await verifyOrganizeResults(
      oauth2Client, proposal, execResult.folderMap, execResult.snapshot,
  );

  if (mismatches.length > 0) {
    logger.warn("Drive organize approval: Integrity check failed, undoing", {
      proposalId, mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 10),
    });

    await undoOrganizeActions(oauth2Client, execResult.snapshot);
    await updateOrganizeProposalStatus(proposalId, "pending");

    const html = `We ran into some issues while organizing your Drive and ` +
      `have reverted all changes. Your files are back where they were.` +
      `<br><br>Please try again by sending a new &quot;organize my drive&quot; email.` +
      `<br><br>You can always ask for help: ${helpLink}<br>`;
    await sendOrganizeEmailResponse(sender, email, html);

    sendEvent(uid, "driveOrganizeFailed", "drive", {
      proposalId,
      mismatches: String(mismatches.length),
    });

    return emptyResult("Integrity check failed — changes reverted");
  }

  // All good — save snapshot and mark completed
  await updateOrganizeProposalStatus(proposalId, "completed", {
    snapshot: execResult.snapshot,
    completedAt: now.toISOString(),
  });

  // Clean up empty managed folders left behind after reorganization
  await cleanupEmptyManagedFolders(oauth2Client);

  // Send completion email
  const folderTreeHtml = renderFolderTree(proposal);
  const filesChanged = execResult.stats.moved + execResult.stats.renamed;
  const embeddedData: OrganizeEmbeddedData = {proposalId};
  const embeddedHtml = buildOrganizeEmbeddedData(embeddedData);

  const undoToken = signActionToken(proposalId, "undo");
  const undoLink = `${driveOrganizeActionUrl()}?proposalId=${proposalId}&action=undo&token=${undoToken}`;

  const html = applyTemplate(driveMailTemplates.organizeComplete.html, {
    SUMMARY: formatSummaryHtml(proposal.summary),
    FILES_CHANGED: String(filesChanged),
    FOLDER_TREE: folderTreeHtml,
    EMBEDDED_DATA: embeddedHtml,
    UNDO_LINK: undoLink,
  });
  await sendOrganizeEmailResponse(sender, email, html);

  sendEvent(uid, "driveOrganizeCompleted", "drive", {
    filesChanged: String(filesChanged),
    failed: String(execResult.stats.failed),
  });

  logger.info("Drive organize approval: Complete", {
    proposalId, uid,
    moved: execResult.stats.moved,
    renamed: execResult.stats.renamed,
    failed: execResult.stats.failed,
  });

  return {
    totalFiles: proposal.file_actions.length,
    filesToMove: execResult.stats.moved,
    filesToRename: execResult.stats.renamed,
    totalCost: proposalDoc.cost.totalCost,
    proposalSent: false,
  };
}
