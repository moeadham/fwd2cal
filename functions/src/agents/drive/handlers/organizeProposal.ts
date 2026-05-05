import {logger} from "firebase-functions/v2";
import {sendEvent} from "../../../util/analytics";
import {
  DRIVE_PLAN_REVISION_MAX_SCOPED_ACTIONS,
  ENVIRONMENT_NAME,
  getSupportEmail,
} from "../../../util/config";
import {getOauthClient} from "../../../auth/authHandler";
import {getSenderFromRawEmail} from "../../../util/emailUtils";
import {TransformedEmail} from "../../../util/types";
import {AGENT_EMAIL_ADDRESS, AGENT_NAME} from "../config";
import {applyTemplate, isDriveAuthError} from "../driveUtils";
import {driveMailTemplates, driveOrganizeActionUrl} from "../mailTemplates";
import {
  DriveFileEntry,
  DriveOrganizeProposal,
  OrganizeEmbeddedData,
  OrganizeProcessingResult,
  OrganizeProposalDoc,
  PlacementSetupData,
  PlacementRulesData,
} from "../types";
import {buildOrganizeEmbeddedData, renderFolderTree} from "../templates/folderTree";
import {
  computeAffectedActions,
  calculateOrganizeCostEstimate,
  calculateOrganizeCostFromMimeTypesByFileId,
  emptyResult,
  extractReplyBody,
  formatSummaryHtml,
  isApprovalText,
  sendOrganizeCostEstimateEmail,
  sendOrganizeEmailResponse,
  sendOrganizeFolderPreferencesEmail,
  sendOrganizePlacementSetupEmail,
  sendOrganizePlacementRulesEmail,
  sendOrganizePlanReviewEmail,
  sendOrganizePlanReviewScopeTooBroadEmail,
  sendOrganizePhase1aEmail,
  sendOrganizePhase2Email,
  sendOrganizeProposalEmail,
  signActionToken,
} from "./organizeHelpers";
import {
  applyPlanPatches,
  executeOrganizeProposal,
  getPlanCsvStoragePath,
  getPlanStoragePath,
  loadSavedPlan,
  savePlanCsv,
  saveSavedPlan,
  startChunkedMove,
  startChunkedPlanning,
} from "./organizeExecution";
import {cleanupAllEmptyFolders, handleOrganizeUndo, undoOrganizeActions} from "./organizeUndo";
import {verifyOrganizeResults} from "./organizeVerify";
import {sendOrganizeAuthRequiredEmail} from "./organizeMain";
import {createOrUpdateProposalSheet} from "../driveHelper";
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
  classifyFolderConventionChange,
  classifyPlacementSetupChange,
  classifyPlacementRulesChange,
  DEFAULT_FOLDER_CONVENTION,
  evaluateDirectoryPlacement,
  extractNamedEntities,
  finalizeDirectoryMap,
  generateFilenameExamples,
  mergeRevisedProposal,
  normalizeFolderConventionSeparators,
  renumberFoldersContiguously,
  reviseOrganization,
  revisePlanFileActions,
  scopePlanRevision,
  filterFileActionsByScope,
} from "../llm";
const DEFAULT_FILENAME_CONVENTION = "YYYY.MM.DD - Description.ext";

let scopePlanRevisionImpl = scopePlanRevision;
let revisePlanFileActionsImpl = revisePlanFileActions;
let handleOrganizeRevisionImpl = handleOrganizeRevision;
let createOrUpdateProposalSheetImpl = createOrUpdateProposalSheet;

function getProposalSheetRef(
    proposalId: string,
    existingFileId?: string,
): {fileId: string; webViewLink: string} {
  const fileId = existingFileId || `local-proposal-sheet-${proposalId}`;
  return {
    fileId,
    webViewLink: `https://docs.google.com/spreadsheets/d/${fileId}`,
  };
}

async function createOrReuseProposalSheet(
    oauth2Client: ReturnType<typeof getOauthClient> extends Promise<infer T> ? T : never,
    proposalId: string,
    csvBuffer: Buffer,
    existingFileId?: string,
): Promise<{fileId: string; webViewLink: string}> {
  if (ENVIRONMENT_NAME.value() === "local" || ENVIRONMENT_NAME.value() === "test") {
    return getProposalSheetRef(proposalId, existingFileId);
  }
  return createOrUpdateProposalSheetImpl(oauth2Client, proposalId, csvBuffer, existingFileId);
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeFolderPath(folderPath: string): string {
  return folderPath
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join("/");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

const PLACEMENT_GRANULARITIES = new Set<PlacementSetupData["granularity"]>([
  "by_entity",
  "by_document_type",
  "by_date",
  "mixed",
]);

function normalizePlacementSetup(value: unknown): PlacementSetupData {
  const candidate = value as Partial<PlacementSetupData> | undefined;
  const granularity = typeof candidate?.granularity === "string" &&
    PLACEMENT_GRANULARITIES.has(candidate.granularity as PlacementSetupData["granularity"]) ?
    candidate.granularity as PlacementSetupData["granularity"] :
    "by_entity";
  return {
    granularity,
    namedEntities: uniqueStrings(Array.isArray(candidate?.namedEntities) ? candidate.namedEntities : []),
    removedEntities: uniqueStrings(Array.isArray(candidate?.removedEntities) ? candidate.removedEntities : []),
  };
}

function hasCaseInsensitive(values: string[], candidate: string): boolean {
  const key = candidate.trim().toLowerCase();
  return values.some((value) => value.trim().toLowerCase() === key);
}

function mergePlacementSetup(
    current: PlacementSetupData,
    updated: {
      granularity?: string | null;
      namedEntities?: string[] | null;
    },
): PlacementSetupData {
  const granularity = typeof updated.granularity === "string" &&
    PLACEMENT_GRANULARITIES.has(updated.granularity as PlacementSetupData["granularity"]) ?
    updated.granularity as PlacementSetupData["granularity"] :
    current.granularity;
  const previousEntities = uniqueStrings(current.namedEntities);
  const nextEntities = Array.isArray(updated.namedEntities) ?
    uniqueStrings(updated.namedEntities) :
    previousEntities;
  const justRemoved = previousEntities.filter((entity) => !hasCaseInsensitive(nextEntities, entity));
  const currentRemoved = uniqueStrings(current.removedEntities);
  const reAdded = nextEntities.filter((entity) => hasCaseInsensitive(currentRemoved, entity));
  const removedWithNew = uniqueStrings([...currentRemoved, ...justRemoved]);
  const nextRemoved = removedWithNew.filter((entity) => !hasCaseInsensitive(reAdded, entity));
  return {
    granularity,
    namedEntities: nextEntities,
    removedEntities: nextRemoved,
  };
}

function mergePlacementRules(
    current: PlacementRulesData,
    updated: {
      edgeCaseRules?: string[] | null;
      examples?: string[] | null;
    },
): PlacementRulesData {
  return {
    edgeCaseRules: Array.isArray(updated.edgeCaseRules) ?
      uniqueStrings(updated.edgeCaseRules) :
      uniqueStrings(current.edgeCaseRules),
    examples: Array.isArray(updated.examples) ?
      uniqueStrings(updated.examples) :
      uniqueStrings(current.examples),
  };
}

export function normalizeIgnoredFolderPaths(folderPaths: string[]): string[] {
  return [...new Set(
      folderPaths
          .map((folderPath) => normalizeFolderPath(folderPath))
          .filter((folderPath) => Boolean(folderPath) && folderPath !== "My Drive"),
  )].sort((left, right) => left.localeCompare(right));
}

export function findIgnoredRoot(path: string, ignoredFolders: Iterable<string>): string | null {
  const normalizedPath = normalizeFolderPath(path);
  if (!normalizedPath || normalizedPath === "My Drive") {
    return null;
  }
  for (const ignoredFolder of ignoredFolders) {
    if (normalizedPath === ignoredFolder || normalizedPath.startsWith(`${ignoredFolder}/`)) {
      return ignoredFolder;
    }
  }
  return null;
}

function dropIgnoredFolderEntries<T>(
    entries: T[],
    ignoredFolders: Iterable<string>,
    getPath: (entry: T) => string | null | undefined,
    proposalId: string,
): T[] {
  return entries.filter((entry) => {
    const path = getPath(entry);
    if (!path) {
      return true;
    }
    const ignoredRoot = findIgnoredRoot(path, ignoredFolders);
    if (ignoredRoot) {
      logger.warn("Drive organize: dropping directory entry inside ignored folder", {
        proposalId,
        path,
        ignoredRoot,
      });
    }
    return !ignoredRoot;
  });
}

function renumberDirectoryStructure(
    folders: DriveOrganizeProposal["proposed_folders"],
    summary: string,
    folderConvention?: string,
): DriveOrganizeProposal["proposed_folders"] {
  const proposal: DriveOrganizeProposal = {
    proposed_folders: folders,
    file_actions: [],
    summary,
  };
  renumberFoldersContiguously(proposal, undefined, folderConvention);
  return proposal.proposed_folders;
}

async function finalizeProposedDirectoryTree({
  proposedStructure,
  treeSummary,
  folderConvention,
  userFeedback,
  uid,
}: {
  proposedStructure: DriveOrganizeProposal["proposed_folders"];
  treeSummary: string;
  folderConvention?: string;
  userFeedback?: string;
  uid: string;
}): Promise<{
    finalStructure: DriveOrganizeProposal["proposed_folders"];
    directoryMoves: Awaited<ReturnType<typeof evaluateDirectoryPlacement>>["directory_moves"];
    addedDirectories: string[];
    summary: string;
  }> {
  const placement = await evaluateDirectoryPlacement(
      treeSummary,
      proposedStructure,
      uid,
  );
  const finalized = await finalizeDirectoryMap(
      proposedStructure,
      placement.directory_moves,
      treeSummary,
      uid,
      userFeedback || "",
  );
  const finalStructure = renumberDirectoryStructure(
      finalized.final_directories,
      finalized.summary,
      folderConvention,
  );
  return {
    finalStructure,
    directoryMoves: placement.directory_moves,
    addedDirectories: finalized.added_directories,
    summary: finalized.summary,
  };
}

/** Loads the Drive tree summary from GCS intermediate state. */
async function loadTreeSummary(proposalId: string): Promise<string> {
  const state = await getOrganizeIntermediateState(proposalId);
  return String(state.driveStructureSummary || "");
}

/** Advances a phased organize proposal to filename convention selection. */
async function advanceToFilenameConvention(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    approvedStructure = proposalDoc.phaseData?.directoryLayout?.approvedStructure ||
      proposalDoc.phaseData?.directoryLayout?.proposedStructure ||
      [],
): Promise<OrganizeProcessingResult> {
  const layout = proposalDoc.phaseData?.directoryLayout;
  if (!layout) {
    return emptyResult("Directory layout state missing");
  }
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
  let resolvedConventionDescription = folderPreferences.conventionDescription || "";
  let shouldSaveConvention = isApproval;
  if (!isApproval) {
    const parsed = await classifyFolderConventionChange(
        folderPreferences.suggestedConvention,
        confirmedConvention,
        uid,
    );
    if (parsed.is_change && parsed.new_convention) {
      resolvedConvention = parsed.new_convention;
      resolvedConventionDescription = parsed.new_description || resolvedConventionDescription;
      shouldSaveConvention = true;
    }
  }
  let namedEntities: string[] = [];
  try {
    const extracted = await extractNamedEntities(treeSummary, uid);
    namedEntities = uniqueStrings(Array.isArray(extracted.namedEntities) ? extracted.namedEntities : []);
  } catch (error) {
    logger.warn("Drive organize: extractNamedEntities failed; continuing without entity anchors", {
      proposalId,
      uid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (shouldSaveConvention) {
    await saveDriveUserPreferences(uid, {
      folderConvention: resolvedConvention,
      folderConventionDescription: resolvedConventionDescription,
    });
  }
  const placementSetup: PlacementSetupData = {
    granularity: "by_entity",
    namedEntities,
    removedEntities: [],
  };
  const nextPhaseData = {
    ...proposalDoc.phaseData,
    folderPreferences: {
      ...folderPreferences,
      confirmedConvention: resolvedConvention,
    },
    placementSetup,
    directoryLayout: {
      currentTreeSummary: treeSummary,
      userPrompt: email.text || email.html || "",
      folderConvention: resolvedConvention,
      conventionDescription: resolvedConventionDescription,
    },
  };

  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "placement_setup",
    phaseData: nextPhaseData,
  });
  await sendOrganizePlacementSetupEmail(sender, email, proposalId, placementSetup);
  return emptyResult();
}

/** Handles replies during placement setup before directory analysis. */
async function handlePlacementSetupReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  const layout = proposalDoc.phaseData?.directoryLayout;
  const folderPreferences = proposalDoc.phaseData?.folderPreferences;
  if (!layout || !folderPreferences) {
    return emptyResult("Placement setup state missing");
  }
  const currentSetup = normalizePlacementSetup(proposalDoc.phaseData?.placementSetup);

  if (!isApproval) {
    const change = await classifyPlacementSetupChange(currentSetup, replyBody, uid);
    if (!change.is_change) {
      await sendOrganizePlacementSetupEmail(sender, email, proposalId, currentSetup);
      return emptyResult("Placement setup change unclear");
    }
    const nextSetup = mergePlacementSetup(currentSetup, change.updated);
    await updateOrganizeProposalStatus(proposalId, "pending", {
      phase: "placement_setup",
      phaseData: {
        ...proposalDoc.phaseData,
        placementSetup: nextSetup,
      },
    });
    await sendOrganizePlacementSetupEmail(sender, email, proposalId, nextSetup);
    return emptyResult();
  }

  try {
    const treeSummary = await loadTreeSummary(proposalId);
    const folderConvention = layout.folderConvention || folderPreferences.confirmedConvention ||
      folderPreferences.suggestedConvention || DEFAULT_FOLDER_CONVENTION;
    let conventionDescription = layout.conventionDescription || folderPreferences.conventionDescription || "";
    await saveDriveUserPreferences(uid, {
      placementGranularity: currentSetup.granularity,
      placementNamedEntities: currentSetup.namedEntities,
    });
    const analysis = await analyzeDirectoryStructure(
        treeSummary,
        folderConvention,
        layout.userPrompt || email.text || email.html || "",
        uid,
        conventionDescription,
        [],
        currentSetup.granularity,
        currentSetup.namedEntities,
        currentSetup.removedEntities,
    );
    if (!conventionDescription) {
      conventionDescription = analysis.convention_description || "";
    }
    const proposedStructure = normalizeFolderConventionSeparators(
        analysis.proposed_structure,
        folderConvention,
    ).map((folder) => ({
      folder_path: folder.folder_path,
      description: folder.description,
    }));
    const finalizedLayout = await finalizeProposedDirectoryTree({
      proposedStructure,
      treeSummary,
      folderConvention,
      uid,
    });
    const nextPhaseData = {
      ...proposalDoc.phaseData,
      placementSetup: currentSetup,
      directoryLayout: {
        ...layout,
        currentTreeSummary: treeSummary,
        folderConvention,
        conventionDescription,
        proposedStructure: finalizedLayout.finalStructure,
        directoryMoves: finalizedLayout.directoryMoves,
        addedDirectories: finalizedLayout.addedDirectories,
        summary: finalizedLayout.summary,
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
        conventionDescription,
        finalizedLayout.summary,
        finalizedLayout.finalStructure,
    );
    return emptyResult();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize: Failed to finalize placement setup approval", {
      proposalId,
      uid,
      error: errMsg,
    });
    const html = applyTemplate(driveMailTemplates.organizeError.html, {});
    await sendOrganizeEmailResponse(sender, email, html);
    return emptyResult("Placement setup approval failed");
  }
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
    try {
      const approvedStructure = layout.proposedStructure || [];
      const preferences = await getDriveUserPreferences(uid);
      const convention =
        getNonEmptyString(proposalDoc.phaseData?.filenameConvention?.convention) ||
        getNonEmptyString(preferences.filenameConvention) ||
        DEFAULT_FILENAME_CONVENTION;
      if (layout.returnToCostEstimate === true) {
        const state = await getOrganizeIntermediateState(proposalId);
        const fileEntries = (Array.isArray(state.fileEntries) ? state.fileEntries : []) as DriveFileEntry[];
        const cost = calculateOrganizeCostEstimate(fileEntries);
        const directoryLayout = {
          ...layout,
          approvedStructure,
        };
        delete directoryLayout.returnToCostEstimate;
        const nextPhaseData = {
          ...proposalDoc.phaseData,
          directoryLayout,
          filenameConvention: {
            convention,
          },
          costEstimate: {
            totalFiles: cost.totalFiles,
            textFiles: cost.textFiles,
            imageFiles: cost.imageFiles,
            totalCost: cost.totalCost,
          },
        };
        await updateOrganizeProposalStatus(proposalId, "pending", {
          phase: "cost_estimate",
          cost,
          phaseData: nextPhaseData,
        });
        const examples = await generateFilenameExamples(convention, uid);
        await sendOrganizeCostEstimateEmail(
            sender, email, proposalId, approvedStructure, convention, cost, examples,
            new Set(normalizeIgnoredFolderPaths(proposalDoc.ignoredFolders ?? [])),
        );
        return {
          totalFiles: cost.totalFiles,
          filesToMove: cost.filesToMove,
          filesToRename: cost.filesToRename,
          totalCost: cost.totalCost,
          proposalSent: true,
        };
      }
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
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Drive organize: Failed to finalize directory analysis approval", {
        proposalId,
        uid,
        error: errMsg,
      });
      const html = applyTemplate(driveMailTemplates.organizeError.html, {});
      await sendOrganizeEmailResponse(sender, email, html);
      return emptyResult("Directory analysis approval failed");
    }
  }

  const currentProposedTree = (layout.proposedStructure || [])
      .map((f: {folder_path: string; description: string}) =>
        `${f.folder_path}/ - ${f.description}`)
      .join("\n");
  const revisionPrompt =
      `${layout.userPrompt || ""}\n\n` +
      `## Current Proposed Structure (revise this)\n${currentProposedTree}\n\n` +
      `## User Revision Request\n${replyBody}`;
  const existingIgnoredFolders = normalizeIgnoredFolderPaths(proposalDoc.ignoredFolders || []);
  const placementSetup = normalizePlacementSetup(proposalDoc.phaseData?.placementSetup);
  const result = await analyzeDirectoryStructure(
      treeSummary,
      layout.folderConvention || proposalDoc.phaseData?.folderPreferences?.confirmedConvention || "",
      revisionPrompt,
      uid,
      layout.conventionDescription || "",
      existingIgnoredFolders,
      placementSetup.granularity,
      placementSetup.namedEntities,
      placementSetup.removedEntities,
  );
  const folderConvention =
    layout.folderConvention ||
    proposalDoc.phaseData?.folderPreferences?.confirmedConvention ||
    "";
  const conventionDescription = layout.conventionDescription || result.convention_description || "";
  const normalizedStructure = normalizeFolderConventionSeparators(
      result.proposed_structure,
      folderConvention,
  ).map((folder) => ({
    folder_path: folder.folder_path,
    description: folder.description,
  }));
  const nextIgnoredFolders = new Set(existingIgnoredFolders);
  for (const folderPath of result.folder_ignores || []) {
    const normalizedPath = normalizeFolderPath(folderPath);
    if (normalizedPath && normalizedPath !== "My Drive") {
      nextIgnoredFolders.add(normalizedPath);
    }
  }
  for (const folder of normalizedStructure) {
    for (const ignoredFolder of [...nextIgnoredFolders]) {
      if (folder.folder_path === ignoredFolder || folder.folder_path.startsWith(`${ignoredFolder}/`)) {
        nextIgnoredFolders.delete(ignoredFolder);
      }
    }
  }
  const filteredNormalizedStructure = dropIgnoredFolderEntries(
      normalizedStructure,
      nextIgnoredFolders,
      (folder) => folder.folder_path,
      proposalId,
  );
  const proposedStructure = renumberDirectoryStructure(
      filteredNormalizedStructure,
      result.summary,
      folderConvention,
  );
  const finalizedLayout = await finalizeProposedDirectoryTree({
    proposedStructure,
    treeSummary,
    folderConvention,
    userFeedback: replyBody,
    uid,
  });
  const filteredFinalStructure = dropIgnoredFolderEntries(
      finalizedLayout.finalStructure,
      nextIgnoredFolders,
      (folder) => folder.folder_path,
      proposalId,
  );
  const filteredDirectoryMoves = finalizedLayout.directoryMoves.filter((move) => {
    const ignoredRoot = findIgnoredRoot(move.current_path, nextIgnoredFolders) ||
      findIgnoredRoot(move.proposed_path, nextIgnoredFolders);
    if (ignoredRoot) {
      logger.warn("Drive organize: dropping directory entry inside ignored folder", {
        proposalId,
        path: `${move.current_path} -> ${move.proposed_path}`,
        ignoredRoot,
      });
      return false;
    }
    return true;
  });
  const filteredAddedDirectories = dropIgnoredFolderEntries(
      finalizedLayout.addedDirectories,
      nextIgnoredFolders,
      (folderPath) => folderPath,
      proposalId,
  );
  const sortedIgnoredFolders = normalizeIgnoredFolderPaths([...nextIgnoredFolders]);
  const preservedFolderPaths = new Set(sortedIgnoredFolders);
  const nextPhaseData = {
    ...proposalDoc.phaseData,
    directoryLayout: {
      ...layout,
      conventionDescription,
      proposedStructure: filteredFinalStructure,
      directoryMoves: filteredDirectoryMoves,
      addedDirectories: filteredAddedDirectories,
      summary: finalizedLayout.summary,
    },
  };
  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "directory_analysis",
    ignoredFolders: sortedIgnoredFolders,
    phaseData: nextPhaseData,
  });
  await sendOrganizePhase1aEmail(
      sender,
      email,
      proposalId,
      conventionDescription,
      finalizedLayout.summary,
      filteredFinalStructure,
      true,
      preservedFolderPaths,
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
    _replyBody: string,
    _isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  const layout = proposalDoc.phaseData?.directoryLayout;
  if (!layout) {
    return emptyResult("Directory placement state missing");
  }
  const approvedStructure = layout.approvedStructure || layout.proposedStructure || [];
  return advanceToFilenameConvention(email, sender, uid, proposalId, proposalDoc, approvedStructure);
}

/** Handles replies during Phase 1c final directory additions. */
async function handleDirectoryAdditionsReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    _replyBody: string,
    _isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  const layout = proposalDoc.phaseData?.directoryLayout;
  if (!layout) {
    return emptyResult("Directory additions state missing");
  }

  const approvedStructure = layout.approvedStructure || layout.proposedStructure || [];
  return advanceToFilenameConvention(email, sender, uid, proposalId, proposalDoc, approvedStructure);
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
    const placementRules = proposalDoc.phaseData?.placementRules ||
      {edgeCaseRules: [], examples: []};
    await updateOrganizeProposalStatus(proposalId, "pending", {
      phase: "placement_rules",
      phaseData: {
        ...proposalDoc.phaseData,
        filenameConvention: {convention},
        placementRules,
      },
    });
    await sendOrganizePlacementRulesEmail(sender, email, proposalId, placementRules);
    return emptyResult();
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

/** Handles replies during Phase 2b placement rules selection. */
async function handlePlacementRulesReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
): Promise<OrganizeProcessingResult> {
  const currentRules = proposalDoc.phaseData?.placementRules ||
    {edgeCaseRules: [], examples: []};

  if (isApproval) {
    const resolvedRules = mergePlacementRules(currentRules, {});
    await saveDriveUserPreferences(uid, {
      placementEdgeCaseRules: resolvedRules.edgeCaseRules,
      placementExamples: resolvedRules.examples,
    });
    const convention =
      proposalDoc.phaseData?.filenameConvention?.convention ||
      DEFAULT_FILENAME_CONVENTION;
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
        placementRules: resolvedRules,
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
        new Set(normalizeIgnoredFolderPaths(proposalDoc.ignoredFolders ?? [])),
    );
    return {
      totalFiles: cost.totalFiles,
      filesToMove: cost.filesToMove,
      filesToRename: cost.filesToRename,
      totalCost: cost.totalCost,
      proposalSent: true,
    };
  }

  const change = await classifyPlacementRulesChange(currentRules, replyBody, uid);
  if (!change.is_change) {
    await sendOrganizePlacementRulesEmail(sender, email, proposalId, currentRules);
    return emptyResult("Placement rules change unclear");
  }
  const nextRules = mergePlacementRules(currentRules, change.updated);
  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "placement_rules",
    phaseData: {
      ...proposalDoc.phaseData,
      placementRules: nextRules,
    },
  });
  await sendOrganizePlacementRulesEmail(sender, email, proposalId, nextRules);
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
    fromActionTask = false,
): Promise<OrganizeProcessingResult> {
  if (isApproval) {
    if (fromActionTask) {
      return startChunkedPlanning(email, sender, uid, proposalId, proposalDoc);
    }

    const approvedStructure =
      proposalDoc.phaseData?.directoryLayout?.approvedStructure ||
      proposalDoc.phaseData?.directoryLayout?.proposedStructure ||
      [];
    if (approvedStructure.length === 0) {
      await sendOrganizeEmailResponse(
          sender,
          email,
          "No problem. Reply with the folder structure changes you'd like, or reply &quot;approve&quot; to keep it.",
      );
      return emptyResult("Directory analysis state missing");
    }

    const convention =
      proposalDoc.phaseData?.filenameConvention?.convention ||
      DEFAULT_FILENAME_CONVENTION;
    const cost = proposalDoc.cost;
    if (!cost) {
      logger.warn("Drive organize: Cost estimate missing for reply approval", {proposalId});
      return emptyResult("Cost estimate missing");
    }

    let examples: string[] = [];
    try {
      examples = await generateFilenameExamples(convention, uid);
    } catch (error) {
      logger.warn("Drive organize: Filename examples unavailable for cost estimate resend", {
        proposalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sendOrganizeCostEstimateEmail(
        sender, email, proposalId, approvedStructure, convention, cost, examples,
        new Set(normalizeIgnoredFolderPaths(proposalDoc.ignoredFolders ?? [])),
    );
    return emptyResult("Awaiting button click");
  }

  const layout = proposalDoc.phaseData?.directoryLayout;
  if (!layout?.proposedStructure) {
    await sendOrganizeEmailResponse(
        sender,
        email,
        "No problem. Reply with the folder structure changes you'd like, or reply &quot;approve&quot; to keep it.",
    );
    return emptyResult("Directory analysis state missing");
  }

  const nextPhaseData = {
    ...proposalDoc.phaseData,
    directoryLayout: {
      ...layout,
      returnToCostEstimate: true,
    },
  };
  const updatedProposalDoc = {
    ...proposalDoc,
    phase: "directory_analysis" as const,
    phaseData: nextPhaseData,
  };
  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "directory_analysis",
    phaseData: nextPhaseData,
  });
  return handleDirectoryAnalysisReply(
      email,
      sender,
      uid,
      proposalId,
      updatedProposalDoc,
      replyBody,
      false,
  );
}

/** Handles replies during plan review after the CSV has been generated. */
async function handlePlanReviewReply(
    email: TransformedEmail,
    sender: string,
    uid: string,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    replyBody: string,
    isApproval: boolean,
    fromActionTask = false,
): Promise<OrganizeProcessingResult> {
  const proposal = await loadSavedPlan(proposalId);
  const counts = {
    totalFiles: proposal.file_actions.length,
    filesToMove: proposal.file_actions.filter((a) => a.action === "move" || a.action === "move_and_rename").length,
    filesToRename: proposal.file_actions.filter((a) => a.action === "rename" || a.action === "move_and_rename").length,
    filesToKeep: proposal.file_actions.filter((a) => a.action === "keep").length,
  };

  if (isApproval) {
    if (fromActionTask) {
      return startChunkedMove(email, sender, uid, proposalId, proposalDoc);
    }
    const csvBuffer = await savePlanCsv(proposalId, proposal.file_actions);
    const oauth2Client = await getOauthClient(uid, AGENT_NAME);
    const existingSheetId = proposalDoc.phaseData?.planReview?.sheetFileId;
    const sheet = await createOrReuseProposalSheet(oauth2Client, proposalId, csvBuffer, existingSheetId);
    await sendOrganizePlanReviewEmail(
        sender,
        email,
        proposalId,
        proposal,
        sheet.webViewLink,
        counts,
        "Use the Move Files button when you're ready.",
    );
    return emptyResult("Awaiting Move Files button click", proposal.file_actions.length);
  }

  const approvedFolders =
    proposalDoc.phaseData?.directoryLayout?.approvedStructure ||
    proposalDoc.phaseData?.directoryLayout?.proposedStructure ||
    proposal.proposed_folders;
  const existingIgnoredFolders = normalizeIgnoredFolderPaths([
    ...(proposal.ignoredFolders || []),
    ...(proposalDoc.ignoredFolders || []),
  ]);
  const scope = await scopePlanRevisionImpl(
      proposal,
      replyBody,
      existingIgnoredFolders,
      uid,
  );
  logger.info("Drive organize: Plan revision scope", {
    proposalId,
    uid,
    inScope: scope.folder_prefixes_in_scope,
    ignored: scope.folder_prefixes_to_ignore,
    filenamePatterns: scope.filename_patterns,
    extensions: scope.extensions,
    explicitFileHints: scope.explicit_file_hints,
    prefersFolderOperation: scope.prefers_folder_operation,
    unclear: scope.unclear,
    summary: scope.summary,
  });

  if (scope.prefers_folder_operation) {
    return handleOrganizeRevisionImpl(email, sender, uid, proposalId, proposalDoc, replyBody);
  }

  if (scope.unclear) {
    const csvBuffer = await savePlanCsv(proposalId, proposal.file_actions);
    const oauth2Client = await getOauthClient(uid, AGENT_NAME);
    const existingSheetId = proposalDoc.phaseData?.planReview?.sheetFileId;
    const sheet = await createOrReuseProposalSheet(oauth2Client, proposalId, csvBuffer, existingSheetId);
    await sendOrganizePlanReviewEmail(
        sender,
        email,
        proposalId,
        proposal,
        sheet.webViewLink,
        counts,
        scope.summary || "Please name the exact file and the new filename or approved folder path.",
    );
    return emptyResult("Plan revision scope unclear", proposal.file_actions.length);
  }

  const scopedActions = filterFileActionsByScope(proposal.file_actions, scope);
  if (scopedActions.length === 0 && (scope.folder_prefixes_to_ignore?.length ?? 0) === 0) {
    const csvBuffer = await savePlanCsv(proposalId, proposal.file_actions);
    const oauth2Client = await getOauthClient(uid, AGENT_NAME);
    const existingSheetId = proposalDoc.phaseData?.planReview?.sheetFileId;
    const sheet = await createOrReuseProposalSheet(oauth2Client, proposalId, csvBuffer, existingSheetId);
    await sendOrganizePlanReviewEmail(
        sender,
        email,
        proposalId,
        proposal,
        sheet.webViewLink,
        counts,
        scope.summary || "Please name the exact file and the new filename or approved folder path.",
    );
    return emptyResult("Plan revision scope unclear", proposal.file_actions.length);
  }
  const maxScopedActions = DRIVE_PLAN_REVISION_MAX_SCOPED_ACTIONS.value();
  if (scopedActions.length > maxScopedActions) {
    const csvBuffer = await savePlanCsv(proposalId, proposal.file_actions);
    const oauth2Client = await getOauthClient(uid, AGENT_NAME);
    const existingSheetId = proposalDoc.phaseData?.planReview?.sheetFileId;
    const sheet = await createOrReuseProposalSheet(oauth2Client, proposalId, csvBuffer, existingSheetId);
    await sendOrganizePlanReviewScopeTooBroadEmail(
        sender,
        email,
        proposalId,
        proposal,
        sheet.webViewLink,
        counts,
        scope.summary ||
          "That change still touches too many files. Please narrow it to a folder, filename, or extension.",
    );
    return emptyResult("Plan revision scope too broad", proposal.file_actions.length);
  }

  sendEvent(uid, "drivePlanRevisionScoped", "drive", {
    proposalId,
    total: String(proposal.file_actions.length),
    scoped: String(scopedActions.length),
    inScope: String(scope.folder_prefixes_in_scope.length),
    ignored: String(scope.folder_prefixes_to_ignore.length),
    unclear: String(scope.unclear),
    rerouted: String(scope.prefers_folder_operation),
  });

  const revision = await revisePlanFileActionsImpl(
      scopedActions,
      approvedFolders,
      replyBody,
      existingIgnoredFolders,
      uid,
  );
  if (revision.unclear) {
    const csvBuffer = await savePlanCsv(proposalId, proposal.file_actions);
    const oauth2Client = await getOauthClient(uid, AGENT_NAME);
    const existingSheetId = proposalDoc.phaseData?.planReview?.sheetFileId;
    const sheet = await createOrReuseProposalSheet(oauth2Client, proposalId, csvBuffer, existingSheetId);
    await sendOrganizePlanReviewEmail(
        sender,
        email,
        proposalId,
        proposal,
        sheet.webViewLink,
        counts,
        revision.summary || "Please name the exact file and the new filename or approved folder path.",
    );
    return emptyResult("Plan revision unclear", proposal.file_actions.length);
  }

  const nextIgnoredFolders = new Set(existingIgnoredFolders);
  for (const folderPath of scope.folder_prefixes_to_ignore || []) {
    const normalizedPath = normalizeFolderPath(folderPath);
    if (normalizedPath) {
      nextIgnoredFolders.add(normalizedPath);
    }
  }
  for (const folderPath of revision.folder_ignores || []) {
    const normalizedPath = normalizeFolderPath(folderPath);
    if (normalizedPath) {
      nextIgnoredFolders.add(normalizedPath);
    }
  }
  const actionsByFileId = new Map(proposal.file_actions.map((action) => [action.file_id, action]));
  for (const patch of revision.patches) {
    if (!patch.new_folder) {
      continue;
    }
    const originalAction = actionsByFileId.get(patch.file_id);
    if (!originalAction) {
      continue;
    }
    const currentPath = normalizeFolderPath(originalAction.current_path || "My Drive") || "My Drive";
    const newFolder = normalizeFolderPath(patch.new_folder);
    if (!newFolder || newFolder === currentPath) {
      continue;
    }
    for (const ignoredFolder of [...nextIgnoredFolders]) {
      if (currentPath === ignoredFolder || currentPath.startsWith(`${ignoredFolder}/`)) {
        nextIgnoredFolders.delete(ignoredFolder);
      }
    }
  }
  const filteredActions = proposal.file_actions.filter((action) =>
    findIgnoredRoot(action.current_path || "My Drive", nextIgnoredFolders) === null);
  const revisedActions = applyPlanPatches(
      filteredActions,
      revision.patches,
      approvedFolders,
  );
  const sortedIgnoredFolders = normalizeIgnoredFolderPaths([...nextIgnoredFolders]);
  const revisedProposal: DriveOrganizeProposal = {
    ...proposal,
    file_actions: revisedActions,
    ignoredFolders: sortedIgnoredFolders,
    summary: revision.summary || proposal.summary,
  };
  await saveSavedPlan(proposalId, revisedProposal);
  const csvBuffer = await savePlanCsv(proposalId, revisedProposal.file_actions);
  const oauth2Client = await getOauthClient(uid, AGENT_NAME);
  const existingSheetId = proposalDoc.phaseData?.planReview?.sheetFileId;
  const sheet = await createOrReuseProposalSheet(oauth2Client, proposalId, csvBuffer, existingSheetId);
  const nextVersion = (proposalDoc.phaseData?.planReview?.fileActionsVersion || 1) + 1;
  await updateOrganizeProposalStatus(proposalId, "pending", {
    phase: "plan_review",
    ignoredFolders: sortedIgnoredFolders,
    phaseData: {
      ...proposalDoc.phaseData,
      planReview: {
        totalFiles: revisedProposal.file_actions.length,
        csvStoragePath: proposalDoc.phaseData?.planReview?.csvStoragePath || getPlanCsvStoragePath(proposalId),
        planStoragePath: proposalDoc.phaseData?.planReview?.planStoragePath || getPlanStoragePath(proposalId),
        fileActionsVersion: nextVersion,
        planEmailSentAt: new Date().toISOString(),
        sheetFileId: sheet.fileId,
        sheetWebViewLink: sheet.webViewLink,
      },
    },
  });
  const revisedCounts = {
    totalFiles: revisedProposal.file_actions.length,
    filesToMove: revisedProposal.file_actions
        .filter((a) => a.action === "move" || a.action === "move_and_rename").length,
    filesToRename: revisedProposal.file_actions
        .filter((a) => a.action === "rename" || a.action === "move_and_rename").length,
    filesToKeep: revisedProposal.file_actions.filter((a) => a.action === "keep").length,
  };
  const affectedActions = computeAffectedActions(
      proposal.file_actions,
      revisedProposal.file_actions,
  );
  await sendOrganizePlanReviewEmail(
      sender,
      email,
      proposalId,
      revisedProposal,
      sheet.webViewLink,
      revisedCounts,
      revision.summary || "Updated the plan.",
      affectedActions,
  );
  return emptyResult(undefined, revisedProposal.file_actions.length);
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
    fromActionTask = false,
): Promise<OrganizeProcessingResult | null> {
  switch (proposalDoc.phase) {
    case "folder_preferences":
      return handleFolderPreferencesReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "placement_setup":
      return handlePlacementSetupReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "directory_analysis":
      return handleDirectoryAnalysisReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "directory_placement":
      return handleDirectoryPlacementReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "directory_additions":
      return handleDirectoryAdditionsReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "filename_convention":
      return handleFilenameConventionReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "placement_rules":
      return handlePlacementRulesReply(email, sender, uid, proposalId, proposalDoc, replyBody, isApproval);
    case "cost_estimate":
      return handleCostEstimateReply(
          email, sender, uid, proposalId, proposalDoc, replyBody, isApproval, fromActionTask,
      );
    case "plan_review":
      return handlePlanReviewReply(
          email, sender, uid, proposalId, proposalDoc, replyBody, isApproval, fromActionTask,
      );
    default:
      return null;
  }
}

export const organizeProposalTestHooks = {
  handleOrganizePhaseReply,
  handleFolderPreferencesReply,
  handlePlacementSetupReply,
  handleDirectoryAnalysisReply,
  handleDirectoryPlacementReply,
  handleDirectoryAdditionsReply,
  handleFilenameConventionReply,
  handlePlacementRulesReply,
  handleCostEstimateReply,
  handlePlanReviewReply,
  setScopePlanRevisionForTest(fn: typeof scopePlanRevisionImpl | null): void {
    scopePlanRevisionImpl = fn || scopePlanRevision;
  },
  setRevisePlanFileActionsForTest(fn: typeof revisePlanFileActionsImpl | null): void {
    revisePlanFileActionsImpl = fn || revisePlanFileActions;
  },
  setHandleOrganizeRevisionForTest(fn: typeof handleOrganizeRevisionImpl | null): void {
    handleOrganizeRevisionImpl = fn || handleOrganizeRevision;
  },
  setCreateOrUpdateProposalSheetForTest(fn: typeof createOrUpdateProposalSheetImpl | null): void {
    createOrUpdateProposalSheetImpl = fn || createOrUpdateProposalSheet;
  },
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
    fromActionTask = false,
): Promise<OrganizeProcessingResult> {
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    return emptyResult("No sender found");
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

  // Look up user. Action tasks are already authorized by a signed/admin endpoint,
  // and admin reruns may use a synthetic sender that is not an EmailAddress record.
  const uid = fromActionTask ? proposalDoc.uid : await getUserFromEmail(sender);
  if (!uid) {
    logger.warn("Drive organize approval: Unknown user", {sender});
    return emptyResult("User not found");
  }

  // Validate proposal ownership
  if (!fromActionTask && proposalDoc.uid !== uid) {
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
  if (isUndo && proposalDoc.phase === "plan_review") {
    await sendOrganizeEmailResponse(
        sender,
        email,
        "Nothing has moved yet, so there is nothing to undo. Use the Move Files button when you're ready.",
    );
    return emptyResult("Undo requested before move");
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
      fromActionTask,
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

  // Clean up empty folders left behind after reorganization
  await cleanupAllEmptyFolders(oauth2Client);

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
