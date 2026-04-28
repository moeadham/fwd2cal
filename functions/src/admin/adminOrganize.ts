import type {Request, Response} from "express";
import * as authHandler from "../auth/authHandler";
import {AGENT_EMAIL_ADDRESS, AGENT_NAME, DRIVE_ADMIN_API_KEY} from "../agents/drive/config";
import * as driveHelper from "../agents/drive/driveHelper";
import {dispatchOrganizeActionTask} from "../agents/drive/handlers/dispatchHandler";
import {loadSavedPlan} from "../agents/drive/handlers/organizeExecution";
import {buildDriveStructureSummary, buildFileEntries} from "../agents/drive/handlers/organizeHelpers";
import {findGeneratingProposal, hasFullDriveScope, scanAndPropose} from "../agents/drive/organizeHandler";
import {isDriveAuthError} from "../agents/drive/driveUtils";
import {
  DriveOrganizeProposal,
  OrganizeIntermediateState,
  OrganizeProposalDoc,
} from "../agents/drive/types";
import {ENVIRONMENT_NAME} from "../util/config";
import {
  DRIVE_USERS_COLLECTION,
  getOrganizeProposal,
  getResumableOrganizeProposals,
  getUserFromEmail,
  getUserFromUID,
  saveOrganizeIntermediateState,
  updateOrganizeProposalStatus,
} from "../util/firestoreHandler";
import {TransformedEmail} from "../util/types";

type AdminTestDriveScan = {
  rawFiles?: Array<{
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    createdTime: string;
    size: string;
    webViewLink: string;
  }>;
  rootFolderId?: string;
  oauthError?: string;
  scanError?: string;
};

/** Handles POST actions for the admin organize endpoint. */
export async function handleAdminOrganizeRequest(req: Request, res: Response): Promise<void> {
  if (req.method !== "POST") {
    res.set("Allow", "GET, POST");
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  const adminKey = req.get("x-admin-key");
  if (!adminKey || adminKey !== DRIVE_ADMIN_API_KEY.value()) {
    res.status(401).json({error: "Unauthorized"});
    return;
  }

  const body = req.body as {
    action?: string;
    proposalId?: string;
    email?: string;
    uid?: string;
    limit?: number;
  } | undefined;

  if (body?.action === "list") {
    const proposals = await getResumableOrganizeProposals();
    res.status(200).json(proposals);
    return;
  }

  if (body?.action === "rerunPlanning") {
    const proposalId = body.proposalId?.trim();
    if (!proposalId) {
      res.status(400).json({error: "proposalId is required"});
      return;
    }

    const DEFAULT_RERUN_FILE_LIMIT = 300;
    let fileLimit = DEFAULT_RERUN_FILE_LIMIT;
    if (body.limit !== undefined) {
      const isPositiveInteger = typeof body.limit === "number" &&
        Number.isFinite(body.limit) &&
        Number.isInteger(body.limit) &&
        body.limit > 0;
      if (!isPositiveInteger) {
        res.status(400).json({error: "limit must be a positive integer"});
        return;
      }
      fileLimit = body.limit;
    }

    const rawProposal = await getOrganizeProposal(proposalId);
    if (!rawProposal) {
      res.status(404).json({error: "Proposal not found"});
      return;
    }

    const proposal = rawProposal as unknown as OrganizeProposalDoc;
    if (proposal.status !== "pending" || proposal.phase !== "plan_review") {
      res.status(409).json({
        error: "Proposal is not ready for review",
        status: proposal.status,
        phase: proposal.phase,
      });
      return;
    }

    const expiresAt = new Date(proposal.expiresAt);
    if (!(expiresAt.getTime() > Date.now())) {
      res.status(410).json({error: "Proposal has expired"});
      return;
    }

    const ignoredFolders = proposal.ignoredFolders || [];
    const previousEmailId = proposal.emailId;
    const testDriveScan =
      ENVIRONMENT_NAME.value() === "local" || ENVIRONMENT_NAME.value() === "test" ?
        (proposal as OrganizeProposalDoc & {testDriveScan?: AdminTestDriveScan}).testDriveScan :
        undefined;

    let userData;
    try {
      userData = await getUserFromUID(proposal.uid, DRIVE_USERS_COLLECTION);
    } catch (_error) {
      res.status(404).json({error: "User not found"});
      return;
    }

    if (!userData.access_token || !hasFullDriveScope(userData.token_scope)) {
      res.status(403).json({error: "User does not have full drive scope"});
      return;
    }

    if (testDriveScan?.oauthError) {
      if (isDriveAuthError(testDriveScan.oauthError)) {
        res.status(403).json({error: "Drive authorization required"});
        return;
      }
      res.status(500).json({error: "OAuth failed"});
      return;
    }

    let savedPlan: DriveOrganizeProposal | null = null;
    try {
      savedPlan = await loadSavedPlan(proposalId);
    } catch (_error) {
      // Saved plan blob is at getPlanStoragePath, separate from storagePath.
      // Missing blob means planning never finalized; treat as no plan to preserve.
    }
    const userRevisedFolders: DriveOrganizeProposal["proposed_folders"] =
      savedPlan?.proposed_folders ?? [];
    if (userRevisedFolders.length === 0) {
      res.status(422).json({error: "Proposal has no folder plan to preserve"});
      return;
    }

    let fileEntries: OrganizeIntermediateState["fileEntries"];
    let treeSummary: OrganizeIntermediateState["driveStructureSummary"];
    try {
      let rawFiles;
      let rootFolderId;
      if (testDriveScan?.scanError) {
        throw new Error(testDriveScan.scanError);
      }
      if (testDriveScan?.rawFiles && testDriveScan.rootFolderId) {
        rawFiles = testDriveScan.rawFiles;
        rootFolderId = testDriveScan.rootFolderId;
      } else {
        let oauth2Client;
        try {
          oauth2Client = await authHandler.getOauthClient(proposal.uid, AGENT_NAME);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          if (isDriveAuthError(errMsg)) {
            res.status(403).json({error: "Drive authorization required"});
            return;
          }
          res.status(500).json({error: "OAuth failed"});
          return;
        }
        rawFiles = await driveHelper.listAllDriveFiles(oauth2Client);
        rootFolderId = await driveHelper.getRootFolderId(oauth2Client);
      }
      const {entries: allFileEntries, isDrivePath} = buildFileEntries(rawFiles, rootFolderId);
      fileEntries = allFileEntries.filter((file) => isDrivePath(file.id));
      ({treeSummary} = buildDriveStructureSummary(fileEntries, rootFolderId));
    } catch (_error) {
      res.status(502).json({error: "Drive scan failed"});
      return;
    }

    const nonFolderEntries = fileEntries.filter((entry) => !entry.isFolder);
    const totalNonFolderFiles = nonFolderEntries.length;
    let sampledNonFolderEntries = nonFolderEntries;
    if (totalNonFolderFiles > fileLimit) {
      const shuffled = [...nonFolderEntries];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      sampledNonFolderEntries = shuffled.slice(0, fileLimit);
      const folderEntries = fileEntries.filter((entry) => entry.isFolder);
      fileEntries = [...folderEntries, ...sampledNonFolderEntries];
    }

    const intermediateState: OrganizeIntermediateState = {
      driveStructureSummary: treeSummary,
      fileEntries,
      senderEmail: proposal.senderEmail,
    };
    await saveOrganizeIntermediateState(
        proposalId,
        intermediateState as unknown as Record<string, unknown>,
    );

    const emailId = `admin-organize-rerun-${Date.now()}`;
    const sampled = totalNonFolderFiles > fileLimit;
    await updateOrganizeProposalStatus(proposalId, "pending", {
      phase: "cost_estimate",
      emailId,
      ignoredFolders,
      phaseData: {
        ...proposal.phaseData,
        directoryLayout: {
          ...proposal.phaseData?.directoryLayout,
          approvedStructure: userRevisedFolders,
        },
        execution: {
          ...proposal.phaseData?.execution,
          completedChunks: 0,
          sampled,
        },
        planReview: {
          ...proposal.phaseData?.planReview,
          fileActionsVersion: 0,
        },
      },
    });

    try {
      await dispatchOrganizeActionTask({proposalId, action: "approve", emailId});
    } catch (_error) {
      await updateOrganizeProposalStatus(proposalId, "pending", {
        phase: "plan_review",
        emailId: previousEmailId,
      });
      res.status(500).json({error: "Dispatch failed"});
      return;
    }

    res.status(200).json({
      proposalId,
      action: "rerunPlanning",
      emailId,
      scannedFiles: fileEntries.length,
      fileLimit,
      totalFiles: totalNonFolderFiles,
      sampledFiles: sampledNonFolderEntries.length,
    });
    return;
  }

  const requestedEmail = body?.email?.trim();
  let uid = body?.uid?.trim();

  if (!requestedEmail && !uid) {
    res.status(400).json({error: "Either email or uid is required"});
    return;
  }

  if (requestedEmail && !uid) {
    uid = await getUserFromEmail(requestedEmail) ?? undefined;
    if (!uid) {
      res.status(404).json({error: "User not found"});
      return;
    }
  }

  let userData;
  try {
    userData = await getUserFromUID(uid!, DRIVE_USERS_COLLECTION);
  } catch (_error) {
    res.status(404).json({error: "User not found"});
    return;
  }

  if (!userData.access_token || !hasFullDriveScope(userData.token_scope)) {
    res.status(403).json({error: "User does not have full drive scope"});
    return;
  }

  const emailId = `admin-organize-${Date.now()}`;
  const generatingProposal = await findGeneratingProposal(uid!, emailId);
  if (generatingProposal) {
    res.status(409).json({error: "Proposal already generating"});
    return;
  }

  const syntheticEmail: TransformedEmail = {
    subject: "Admin: Organize Drive",
    text: "",
    html: "",
    from: userData.email,
    to: [AGENT_EMAIL_ADDRESS.value()],
    headers: {},
    SPF: "pass",
    dkim: "pass",
  };

  const result = await scanAndPropose(
      syntheticEmail,
      userData.email,
      emailId,
      uid!,
  );
  res.status(200).json(result);
}
