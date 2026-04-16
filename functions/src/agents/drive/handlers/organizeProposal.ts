import {logger} from "firebase-functions/v2";
import {sendEvent} from "../../../util/analytics";
import {getSupportEmail} from "../../../util/config";
import {getOauthClient} from "../../../auth/authHandler";
import {getSenderFromRawEmail} from "../../../util/emailUtils";
import {TransformedEmail} from "../../../util/types";
import {AGENT_EMAIL_ADDRESS, AGENT_NAME} from "../config";
import {applyTemplate, isDriveAuthError} from "../driveUtils";
import {driveMailTemplates, driveOrganizeActionUrl} from "../mailTemplates";
import {
  DriveFileEntry,
  OrganizeEmbeddedData,
  OrganizeProcessingResult,
  OrganizeProposalDoc,
} from "../types";
import {buildOrganizeEmbeddedData, renderFolderTree} from "../templates/folderTree";
import {
  calculateOrganizeCostEstimate,
  calculateOrganizeCostFromMimeTypesByFileId,
  emptyResult,
  extractReplyBody,
  formatSummaryHtml,
  isApprovalText,
  sendOrganizeCostEstimateEmail,
  sendOrganizeEmailResponse,
  sendOrganizeFolderPreferencesEmail,
  sendOrganizePhase1aEmail,
  sendOrganizePhase1bEmail,
  sendOrganizePhase1cEmail,
  sendOrganizePhase2Email,
  sendOrganizeProposalEmail,
  signActionToken,
} from "./organizeHelpers";
import {executeOrganizeProposal, startChunkedExecution} from "./organizeExecution";
import {cleanupEmptyManagedFolders, handleOrganizeUndo, undoOrganizeActions} from "./organizeUndo";
import {verifyOrganizeResults} from "./organizeVerify";
import {sendOrganizeAuthRequiredEmail} from "./organizeMain";
import {
  finalizeOrganizeProposal,
  getDriveUserPreferences,
  getOrganizeIntermediateState,
  getOrganizePhaseData,
  getOrganizeProposal,
  getUserFromEmail,
  saveDriveUserPreferences,
  updateOrganizeProposalStatus,
} from "../../../util/firestoreHandler";
import {
  analyzeDirectoryStructure,
  classifyConventionChange,
  DEFAULT_FOLDER_CONVENTION,
  evaluateDirectoryPlacement,
  finalizeDirectoryMap,
  generateFilenameExamples,
  mergeRevisedProposal,
  renumberFoldersContiguously,
  reviseOrganization,
} from "../llm";
const DEFAULT_FILENAME_CONVENTION = "YYYY.MM.DD - Description.ext";

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Loads the Drive tree summary from GCS intermediate state. */
async function loadTreeSummary(proposalId: string): Promise<string> {
  const state = await getOrganizeIntermediateState(proposalId);
  return String(state.driveStructureSummary || "");
}

/** Handles replies during Phase 0 folder naming preference confirmation. */
async function handleFolderPreferencesReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  const folderPreferences = proposalDoc.phaseData?.folderPreferences;
  if (!folderPreferences?.suggestedConvention) {
    return emptyResult("Folder preferences state missing");
  }

  const treeSummary = await loadTreeSummary(proposalId);
  const topLevelFolderNames = folderPreferences.topLevelFolderNames || [];
  const confirmedConvention = isApproval ?
    folderPreferences.suggestedConvention :
    replyBody.trim();
  if (!confirmedConvention) {
    await sendOrganizeFolderPreferencesEmail(
        sender,
        email,
        proposalId,
        topLevelFolderNames,
        folderPreferences.detectedConvention || "",
        folderPreferences.suggestedConvention,
        folderPreferences.conventionDescription || "",
    );
    return emptyResult("Empty folder convention");
  }

  // Determine the convention to use for downstream analysis.
  // Only treat the reply as a convention change when classify says so; otherwise reuse
  // the previously-suggested convention and leave the user's stored preference alone.
  let resolvedConvention = folderPreferences.suggestedConvention;
  let conventionChanged = isApproval;
  if (!isApproval) {
    const parsed = await classifyConventionChange(
        folderPreferences.suggestedConvention,
        confirmedConvention,
        uid,
    );
    if (parsed.is_change && parsed.new_convention) {
      resolvedConvention = parsed.new_convention;
      conventionChanged = true;
    }
  }
  const analysis = await analyzeDirectoryStructure(
      treeSummary,
      resolvedConvention,
      email.text || email.html || "",
      uid,
  );
  if (conventionChanged) {
    await saveDriveUserPreferences(uid, {
      folderConvention: resolvedConvention,
      folderConventionDescription: analysis.convention_description ||
        folderPreferences.conventionDescription ||
        "",
    });
  }
  const proposedStructure = analysis.proposed_structure.map((folder) => ({
    folder_path: folder.folder_path,
    description: folder.description,
  }));
  const nextPhaseData = {
    ...proposalDoc.phaseData,
    folderPreferences: {
      ...folderPreferences,
      confirmedConvention: resolvedConvention,
    },
    directoryLayout: {
      userPrompt: email.text || email.html || "",
      folderConvention: resolvedConvention,
      conventionDescription: analysis.convention_description,
      proposedStructure,
      summary: analysis.summary,
    },
  };

  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "directory_analysis",
    phaseData: nextPhaseData,
  });
  await sendOrganizePhase1aEmail(
      sender,
      email,
      proposalId,
      analysis.convention_description,
      analysis.summary,
      proposedStructure,
  );
  return emptyResult();
}

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
    const preferences = await getDriveUserPreferences(uid);
    const folderConvention =
      getNonEmptyString(proposalDoc.phaseData?.directoryLayout?.folderConvention) ||
      getNonEmptyString(preferences.folderConvention) ||
      DEFAULT_FOLDER_CONVENTION;
    const folderConventionDescription =
      getNonEmptyString(proposalDoc.phaseData?.directoryLayout?.conventionDescription) ||
      getNonEmptyString(proposalDoc.phaseData?.folderPreferences?.conventionDescription) ||
      getNonEmptyString(preferences.folderConventionDescription);
    const filenameConvention =
      getNonEmptyString(proposalDoc.phaseData?.filenameConvention?.convention) ||
      getNonEmptyString(preferences.filenameConvention) ||
      DEFAULT_FILENAME_CONVENTION;
    const {proposal: revisedProposal, preservedRootPaths} = await reviseOrganization(
        proposalDoc.proposal!,
        userInstructions,
        uid,
        filenameConvention,
        folderConvention,
        folderConventionDescription,
    );
    const mergedProposal = mergeRevisedProposal(
        proposalDoc.proposal!,
        revisedProposal,
    );
    renumberFoldersContiguously(mergedProposal, preservedRootPaths, folderConvention);
    const state = await getOrganizeIntermediateState(proposalId);
    const fileEntries = (Array.isArray(state.fileEntries) ? state.fileEntries : []) as DriveFileEntry[];
    const mimeTypesByFileId = Object.fromEntries(
        fileEntries.filter((file) => !file.isFolder)
            .map((file) => [file.id, file.mimeType]),
    );
    const newCost = calculateOrganizeCostFromMimeTypesByFileId(
        mergedProposal,
        mimeTypesByFileId,
    );

    await finalizeOrganizeProposal(
        proposalId,
        mergedProposal as unknown as Record<string, unknown>,
        newCost as unknown as Record<string, unknown>,
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

/** Handles replies during Phase 1a directory analysis. */
async function handleDirectoryAnalysisReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  const layout = proposalDoc.phaseData?.directoryLayout;
  if (!layout) {
    return emptyResult("Directory analysis state missing");
  }
  const treeSummary = await loadTreeSummary(proposalId);

  if (isApproval) {
    const result = await evaluateDirectoryPlacement(
        treeSummary,
        layout.proposedStructure || [],
        uid,
    );
    const nextPhaseData = {
      ...proposalDoc.phaseData,
      directoryLayout: {
        ...layout,
        directoryMoves: result.directory_moves,
        summary: result.summary,
      },
    };
    await updateOrganizeProposalStatus(proposalId, "pending", {
      phase: "directory_placement",
      phaseData: nextPhaseData,
    });
    await sendOrganizePhase1bEmail(sender, email, proposalId, result.summary, result.directory_moves);
    return emptyResult();
  }

  const currentProposedTree = (layout.proposedStructure || [])
      .map((f: {folder_path: string; description: string}) =>
        `${f.folder_path}/ - ${f.description}`)
      .join("\n");
  const revisionPrompt =
      `${layout.userPrompt || ""}\n\n` +
      `## Current Proposed Structure (revise this)\n${currentProposedTree}\n\n` +
      `## User Revision Request\n${replyBody}`;
  const result = await analyzeDirectoryStructure(
      treeSummary,
      layout.folderConvention || proposalDoc.phaseData?.folderPreferences?.confirmedConvention || "",
      revisionPrompt,
      uid,
  );
  const proposedStructure = result.proposed_structure.map((folder) => ({
    folder_path: folder.folder_path,
    description: folder.description,
  }));
  const nextPhaseData = {
    ...proposalDoc.phaseData,
    directoryLayout: {
      ...layout,
      conventionDescription: result.convention_description,
      proposedStructure,
      summary: result.summary,
    },
  };
  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "directory_analysis",
    phaseData: nextPhaseData,
  });
  await sendOrganizePhase1aEmail(
      sender,
      email,
      proposalId,
      result.convention_description,
      result.summary,
      proposedStructure,
      true,
  );
  return emptyResult();
}

/** Handles replies during Phase 1b directory placement. */
async function handleDirectoryPlacementReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  const layout = proposalDoc.phaseData?.directoryLayout;
  if (!layout) {
    return emptyResult("Directory placement state missing");
  }
  const treeSummary = await loadTreeSummary(proposalId);

  if (isApproval) {
    const result = await finalizeDirectoryMap(
        layout.proposedStructure || [],
        layout.directoryMoves || [],
        treeSummary,
        uid,
    );
    const nextPhaseData = {
      ...proposalDoc.phaseData,
      directoryLayout: {
        ...layout,
        approvedStructure: result.final_directories,
        addedDirectories: result.added_directories,
        summary: result.summary,
      },
    };
    await updateOrganizeProposalStatus(proposalId, "pending", {
      phase: "directory_additions",
      phaseData: nextPhaseData,
    });
    await sendOrganizePhase1cEmail(
        sender,
        email,
        proposalId,
        result.summary,
        result.final_directories,
        result.added_directories,
    );
    return emptyResult();
  }

  const result = await evaluateDirectoryPlacement(
      treeSummary,
      layout.proposedStructure || [],
      uid,
      replyBody,
  );
  const nextPhaseData = {
    ...proposalDoc.phaseData,
    directoryLayout: {
      ...layout,
      directoryMoves: result.directory_moves,
      summary: result.summary,
    },
  };
  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "directory_placement",
    phaseData: nextPhaseData,
  });
  await sendOrganizePhase1bEmail(sender, email, proposalId, result.summary, result.directory_moves);
  return emptyResult();
}

/** Handles replies during Phase 1c final directory additions. */
async function handleDirectoryAdditionsReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  const layout = proposalDoc.phaseData?.directoryLayout;
  if (!layout) {
    return emptyResult("Directory additions state missing");
  }

  if (isApproval) {
    const approvedStructure = layout.approvedStructure || layout.proposedStructure || [];
    const preferences = await getDriveUserPreferences(uid);
    const convention =
      getNonEmptyString(proposalDoc.phaseData?.filenameConvention?.convention) ||
      getNonEmptyString(preferences.filenameConvention) ||
      DEFAULT_FILENAME_CONVENTION;
    const nextPhaseData = {
      ...proposalDoc.phaseData,
      directoryLayout: {
        ...layout,
        approvedStructure,
      },
      filenameConvention: {
        convention,
      },
    };
    await updateOrganizeProposalStatus(proposalId, "pending", {
      phase: "filename_convention",
      phaseData: nextPhaseData,
    });
    const examples = await generateFilenameExamples(convention, uid);
    await sendOrganizePhase2Email(sender, email, proposalId, convention, examples);
    return emptyResult();
  }

  const treeSummary = await loadTreeSummary(proposalId);
  const result = await finalizeDirectoryMap(
      layout.proposedStructure || [],
      layout.directoryMoves || [],
      treeSummary,
      uid,
      replyBody,
  );
  const nextPhaseData = {
    ...proposalDoc.phaseData,
    directoryLayout: {
      ...layout,
      approvedStructure: result.final_directories,
      addedDirectories: result.added_directories,
      summary: result.summary,
    },
  };
  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "directory_additions",
    phaseData: nextPhaseData,
  });
  await sendOrganizePhase1cEmail(
      sender,
      email,
      proposalId,
      result.summary,
      result.final_directories,
      result.added_directories,
  );
  return emptyResult();
}

/** Handles replies during Phase 2 filename convention selection. */
async function handleFilenameConventionReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  const convention =
    proposalDoc.phaseData?.filenameConvention?.convention ||
    DEFAULT_FILENAME_CONVENTION;

  if (isApproval) {
    await saveDriveUserPreferences(uid, {filenameConvention: convention});
    const state = await getOrganizeIntermediateState(proposalId);
    const fileEntries = (Array.isArray(state.fileEntries) ? state.fileEntries : []) as DriveFileEntry[];
    const cost = calculateOrganizeCostEstimate(fileEntries);
    const approvedStructure =
      proposalDoc.phaseData?.directoryLayout?.approvedStructure ||
      proposalDoc.phaseData?.directoryLayout?.proposedStructure ||
      [];
    await updateOrganizeProposalStatus(proposalId, "pending", {
      phase: "cost_estimate",
      cost,
      phaseData: {
        ...proposalDoc.phaseData,
        filenameConvention: {convention},
        costEstimate: {
          totalFiles: cost.totalFiles,
          textFiles: cost.textFiles,
          imageFiles: cost.imageFiles,
          totalCost: cost.totalCost,
        },
      },
    });
    const examples = await generateFilenameExamples(convention, uid);
    await sendOrganizeCostEstimateEmail(
        sender, email, proposalId, approvedStructure, convention, cost, examples,
    );
    return {
      totalFiles: cost.totalFiles,
      filesToMove: cost.filesToMove,
      filesToRename: cost.filesToRename,
      totalCost: cost.totalCost,
      proposalSent: true,
    };
  }

  const change = await classifyConventionChange(convention, replyBody, uid);
  if (!change.is_change) {
    const examples = await generateFilenameExamples(convention, uid);
    await sendOrganizePhase2Email(sender, email, proposalId, convention, examples);
    return emptyResult("Filename convention change unclear");
  }

  const nextPhaseData = {
    ...proposalDoc.phaseData,
    filenameConvention: {
      convention: change.new_convention,
    },
  };
  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "filename_convention",
    phaseData: nextPhaseData,
  });
  const examples = await generateFilenameExamples(change.new_convention, uid);
  await sendOrganizePhase2Email(sender, email, proposalId, change.new_convention, examples);
  return emptyResult();
}

/** Handles replies during the final cost-estimate phase. */
async function handleCostEstimateReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  if (isApproval) {
    return startChunkedExecution(email, sender, uid, proposalId, proposalDoc);
  }

  const lowered = replyBody.toLowerCase();
  if (lowered.includes("folder") || lowered.includes("director")) {
    await updateOrganizeProposalStatus(proposalId, "pending", {
      phase: "directory_additions",
    });
    await sendOrganizeEmailResponse(
        sender,
        email,
        "No problem. Reply with the folder structure changes you'd like, or reply &quot;approve&quot; to keep it.",
    );
    return emptyResult("Returned to directory additions");
  }

  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "filename_convention",
  });
  const convention =
    proposalDoc.phaseData?.filenameConvention?.convention ||
    DEFAULT_FILENAME_CONVENTION;
  const examples = await generateFilenameExamples(convention, uid);
  await sendOrganizePhase2Email(sender, email, proposalId, convention, examples);
  return emptyResult("Returned to filename convention");
}

/** Routes replies to the active organize-drive phase. */
async function handleOrganizePhaseReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
): Promise<OrganizeProcessingResult | null> {
  switch (proposalDoc.phase) {
    case "folder_preferences":
      return handleFolderPreferencesReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "directory_analysis":
      return handleDirectoryAnalysisReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "directory_placement":
      return handleDirectoryPlacementReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "directory_additions":
      return handleDirectoryAdditionsReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "filename_convention":
      return handleFilenameConventionReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "cost_estimate":
      return handleCostEstimateReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    default:
      return null;
  }
}

export const organizeProposalTestHooks = {
  handleOrganizePhaseReply,
  handleFolderPreferencesReply,
  handleDirectoryAnalysisReply,
  handleDirectoryPlacementReply,
  handleDirectoryAdditionsReply,
  handleFilenameConventionReply,
  handleCostEstimateReply,
};
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

  // Load phaseData from GCS (not stored in Firestore for scalability)
  if (!proposalDoc.phaseData) {
    const gcsPhaseData = await getOrganizePhaseData(proposalId);
    if (gcsPhaseData) {
      proposalDoc.phaseData = gcsPhaseData as OrganizeProposalDoc["phaseData"];
    }
  }

  const replyBody = extractReplyBody(email.text || "");
  const isApproval = isApprovalText(email.text || "");

  if (replyBody.length === 0 && !isApproval) {
    const html = "We received your reply but couldn't find any instructions. " +
      "Reply with changes you'd like to make, or reply &quot;approve&quot; to proceed.";
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Empty reply");
  }

  const phaseResult = await handleOrganizePhaseReply(
      email,
      sender,
      uid,
      proposalId,
      proposalDoc,
      replyBody,
      isApproval,
  );
  if (phaseResult) {
    return phaseResult;
  }

  if (!proposalDoc.proposal || !proposalDoc.cost) {
    logger.error("Drive organize: Proposal payload missing", {proposalId});
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Proposal missing");
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
  const preferences = await getDriveUserPreferences(uid);
  const executionFolderConvention =
    getNonEmptyString(proposalDoc.phaseData?.directoryLayout?.folderConvention) ||
    getNonEmptyString(preferences.folderConvention) ||
    DEFAULT_FOLDER_CONVENTION;
  const executionFolderConventionDescription =
    getNonEmptyString(proposalDoc.phaseData?.directoryLayout?.conventionDescription) ||
    getNonEmptyString(proposalDoc.phaseData?.folderPreferences?.conventionDescription) ||
    getNonEmptyString(preferences.folderConventionDescription);
  const executionFilenameConvention =
    getNonEmptyString(proposalDoc.phaseData?.filenameConvention?.convention) ||
    getNonEmptyString(preferences.filenameConvention) ||
    DEFAULT_FILENAME_CONVENTION;
  let execResult;
  try {
    execResult = await executeOrganizeProposal(
        oauth2Client,
        proposal,
        uid,
        executionFilenameConvention,
        executionFolderConvention,
        executionFolderConventionDescription,
    );
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
