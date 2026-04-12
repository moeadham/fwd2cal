import type {Request, Response} from "express";
import {AGENT_EMAIL_ADDRESS, DRIVE_ADMIN_API_KEY} from "../agents/drive/config";
import {dispatchOrganizeChunkTask} from "../agents/drive/dispatchHandler";
import {findGeneratingProposal, hasFullDriveScope, scanAndPropose} from "../agents/drive/organizeHandler";
import {OrganizeProposalDoc} from "../agents/drive/types";
import {
  DRIVE_USERS_COLLECTION,
  getOrganizeProposal,
  getResumableOrganizeProposals,
  getUserFromEmail,
  getUserFromUID,
  updateOrganizeProposalStatus,
} from "../util/firestoreHandler";
import {TransformedEmail} from "../util/types";

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
  } | undefined;

  if (body?.action === "list") {
    const proposals = await getResumableOrganizeProposals();
    res.status(200).json(proposals);
    return;
  }

  if (body?.action === "retry") {
    const proposalId = body.proposalId?.trim();
    if (!proposalId) {
      res.status(400).json({error: "Missing proposalId"});
      return;
    }

    const rawProposal = await getOrganizeProposal(proposalId);
    if (!rawProposal) {
      res.status(404).json({error: "Proposal not found"});
      return;
    }

    const proposal = rawProposal as unknown as OrganizeProposalDoc;
    if (proposal.status !== "generating" && proposal.status !== "failed") {
      res.status(400).json({
        error: `Proposal status is ${proposal.status}`,
      });
      return;
    }

    if (!proposal.emailId || !proposal.uid) {
      res.status(500).json({error: "missing retry metadata"});
      return;
    }

    const chunkIndex = proposal.currentChunk || 0;
    if (proposal.status === "failed") {
      await updateOrganizeProposalStatus(proposalId, "generating", {
        attemptCount: 1,
        generationStartedAt: new Date().toISOString(),
        lastError: null,
      });
    }

    await dispatchOrganizeChunkTask({
      proposalId,
      emailId: proposal.emailId,
      uid: proposal.uid,
      chunkIndex,
    });

    res.status(200).json({
      proposalId,
      chunkIndex,
      message: "Retry dispatched",
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
