import {logger} from "firebase-functions/v2";
import {getFunctions} from "firebase-admin/functions";
import {Resend} from "resend";
import type {Request, Response} from "express";
import {renderActionPage} from "../templates/actionPage.html";

import {handleDriveEmail} from "./driveHandler";
import {processUpload} from "./uploadHandler";
import {handleOrganizeDrive} from "./organizeMain";
import {handleOrganizeProposalReply} from "./organizeProposal";
import {processMoveChunk, processPlanningChunk, startChunkedMove} from "./organizeExecution";
import {signActionToken} from "./organizeHelpers";
import {driveSignupUrl} from "../mailTemplates";
import {ENVIRONMENT_NAME, RESEND_API_KEY} from "../../../util/config";
import {AGENT_EMAIL_ADDRESS} from "../config";
import {sendEvent} from "../../../util/analytics";
import {
  TaskRequest,
  DispatchResult,
  TransformedEmail,
  ResendClient,
} from "../../../util/types";
import {getLastSentEmail, getMockResendClient, setMockData} from "../../../util/resendMock";
import {
  getUserFromEmail,
  getUserFromUID,
  DRIVE_USERS_COLLECTION,
  getOrganizeProposal,
  updateOrganizeProposalStatus,
} from "../../../util/firestoreHandler";
import {
  fetchAndTransformEmail,
  EmailFetchError,
} from "../../../resend/emailFetcher";
import {
  FileProposal,
  MoveChunkTaskData,
  OrganizeProposalDoc,
  PostAuthTaskData,
  OrganizeActionTaskData,
  PlanningChunkTaskData,
} from "../types";

// ============================================================================
// UTILITIES
// ============================================================================

type FunctionsClient = {
  taskQueue: (path: string) => {
    enqueue: (data: unknown, opts?: {dispatchDeadlineSeconds?: number; id?: string}) => Promise<unknown>;
  };
};

let getFunctionsClient = (): FunctionsClient => getFunctions() as unknown as FunctionsClient;
let functionsClientStubbed = false;

function isLocalDispatch(): boolean {
  if (functionsClientStubbed) return false;
  return ENVIRONMENT_NAME.value() === "local" || ENVIRONMENT_NAME.value() === "test";
}

/**
 * Parse the OAuth state parameter (base64url-encoded JSON with emailId + proposal).
 */
export function parseOAuthState(
    state: string,
): {emailId: string; proposal?: FileProposal; organize?: boolean} {
  const json = Buffer.from(state, "base64url").toString();
  const parsed = JSON.parse(json);
  return {emailId: parsed.emailId, proposal: parsed.proposal, organize: parsed.organize};
}

/** Detects synthetic email IDs created by the admin organize endpoint. */
function isAdminEmailId(emailId: string): boolean {
  return emailId.startsWith("admin-organize-");
}

/** Builds a synthetic email object for admin-triggered organize work. */
function buildAdminSyntheticEmail(senderEmail: string): TransformedEmail {
  return {
    subject: "Admin: Organize Drive",
    text: "",
    html: "",
    from: senderEmail,
    to: [AGENT_EMAIL_ADDRESS.value()],
    headers: {},
    SPF: "pass",
    dkim: "pass",
  };
}

function sanitizeProposalIdForTaskId(proposalId: string): string {
  return proposalId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 500);
}

function isTaskAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    code?: number | string;
    status?: number | string;
    details?: string;
    message?: string;
  };
  const code = String(candidate.code || candidate.status || "");
  const details = candidate.details || "";
  const message = candidate.message || "";
  return code === "409" ||
    code.toUpperCase() === "ALREADY_EXISTS" ||
    details.includes("ALREADY_EXISTS") ||
    message.includes("ALREADY_EXISTS") ||
    details.includes("already exists") ||
    message.includes("already exists") ||
    details.includes("Requested entity already exists") ||
    message.includes("Requested entity already exists");
}

async function enqueueChunkTask(
    queuePath: string,
    data: PlanningChunkTaskData | MoveChunkTaskData,
    taskId: string,
    logContext: Record<string, unknown>,
): Promise<void> {
  const queue = getFunctionsClient().taskQueue(queuePath);
  try {
    await queue.enqueue(data, {
      dispatchDeadlineSeconds: 60 * 30,
      id: taskId,
    });
  } catch (error) {
    if (isTaskAlreadyExistsError(error)) {
      logger.info("Drive chunk dispatch: Duplicate task enqueue suppressed", {
        ...logContext,
        taskId,
      });
      return;
    }
    throw error;
  }
}

/**
 * Fetch an email by ID from Resend and transform it.
 * Used by confirm endpoint and OAuth callback to re-fetch the original email.
 */
export async function fetchEmailById(
    emailId: string,
): Promise<{resend: ResendClient; transformedEmail: TransformedEmail}> {
  const isTestMode =
    ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
  const resend: ResendClient = isTestMode ?
    getMockResendClient() :
    (new Resend(RESEND_API_KEY.value()) as unknown as ResendClient);

  const {data, error} = await resend.emails.receiving.get(emailId);
  if (error) {
    throw new Error(`Failed to fetch email: ${error.message}`);
  }

  const authResults = data.headers?.["authentication-results"] || "";
  const spfResult = authResults.includes("spf=pass") ? "pass" : "fail";
  const dkimResult = authResults.includes("dkim=pass") ?
    (authResults.match(/dkim=pass header\.i=(@[^\s;]+)/) || [
      null,
      "@unknown",
    ])[1] + " : pass" :
    "fail";

  const transformedEmail: TransformedEmail = {
    subject: data.subject,
    text: data.text || "",
    html: data.html || "",
    from: data.from,
    to: Array.isArray(data.to) ? data.to : [data.to],
    headers: data.headers || {},
    SPF: spfResult as "pass" | "fail",
    dkim: `{${dkimResult}}`,
  };

  return {resend, transformedEmail};
}

// ============================================================================
// DISPATCH HANDLERS
// ============================================================================

/** Handles queued inbound Drive webhook processing. */
export async function handleDriveInboundDispatch(
    req: TaskRequest,
): Promise<DispatchResult> {
  const webhookData = req.data;

  let transformedEmail;
  let resend;
  try {
    const result = await fetchAndTransformEmail(webhookData);
    transformedEmail = result.transformedEmail;
    resend = result.resend;
  } catch (error) {
    if (error instanceof EmailFetchError) {
      return {message: "error", error: error.message};
    }
    throw error;
  }

  if (ENVIRONMENT_NAME.value() !== "production") {
    logger.log("DRIVE WEBHOOK DATA", webhookData);
    logger.log("DRIVE TRANSFORMED EMAIL", transformedEmail);
  }

  // Process with the drive handler
  // eslint-disable-next-line camelcase
  const {email_id} = webhookData.data;
  const outcome = await handleDriveEmail(transformedEmail, resend, email_id);

  let sentEmail = null;
  if (ENVIRONMENT_NAME.value() !== "production") {
    sentEmail = getLastSentEmail(transformedEmail.from);
  }

  return {
    message: "thanks",
    data: outcome,
    sentEmail: sentEmail,
  };
}

/** Enqueues post-auth upload processing for a Drive OAuth callback. */
export async function dispatchPostAuthTask(data: PostAuthTaskData): Promise<void> {
  if (!data.organize) {
    sendEvent(data.uid, "driveFileConfirmed", "drive");
  }
  const isLocal = ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
  if (isLocal) {
    // In local/test mode, run synchronously (task queues not available)
    if (data.organize) {
      let transformedEmail: TransformedEmail;
      if (isAdminEmailId(data.emailId)) {
        const user = await getUserFromUID(data.uid, DRIVE_USERS_COLLECTION);
        transformedEmail = buildAdminSyntheticEmail(user.email);
      } else {
        ({transformedEmail} = await fetchEmailById(data.emailId));
      }
      await handleOrganizeDrive(transformedEmail, data.emailId);
    } else {
      const {resend, transformedEmail} = await fetchEmailById(data.emailId);
      await processUpload(
          data.emailId, data.uid, resend, transformedEmail, data.proposal,
      );
    }
    return;
  }
  const queue = getFunctions().taskQueue(
      "locations/us-central1/functions/v2driveProcessAfterAuth",
  );
  await queue.enqueue(data, {
    dispatchDeadlineSeconds: 60 * 30,
  });
  logger.info("Drive: Dispatched post-auth task", {
    emailId: data.emailId, organize: !!data.organize,
  });
}

/** Enqueues asynchronous processing for an organize action link. */
export async function dispatchOrganizeActionTask(
    data: OrganizeActionTaskData,
): Promise<void> {
  const isLocal = ENVIRONMENT_NAME.value() === "local" ||
    ENVIRONMENT_NAME.value() === "test";
  if (isLocal) {
    await handleOrganizeActionTask(data);
    return;
  }
  const queue = getFunctions().taskQueue(
      "locations/us-central1/functions/v2driveOrganizeActionTask",
  );
  await queue.enqueue(data, {
    dispatchDeadlineSeconds: 60 * 30,
  });
  logger.info("Drive organize action: Dispatched task", {
    proposalId: data.proposalId, action: data.action,
  });
}

/** Enqueues LLM-only planning chunk processing. */
export async function dispatchPlanningChunkTask(
    data: PlanningChunkTaskData,
): Promise<void> {
  if (isLocalDispatch()) {
    let transformedEmail: TransformedEmail;
    if (isAdminEmailId(data.emailId)) {
      const proposal = await getOrganizeProposal(data.proposalId);
      const senderEmail = (proposal as unknown as OrganizeProposalDoc)?.senderEmail || "";
      transformedEmail = buildAdminSyntheticEmail(senderEmail);
    } else {
      ({transformedEmail} = await fetchEmailById(data.emailId));
    }
    await processPlanningChunk(transformedEmail, data);
    return;
  }

  await enqueueChunkTask(
      "locations/us-central1/functions/v2drivePlanningChunkTask",
      data,
      `${sanitizeProposalIdForTaskId(data.proposalId)}-plan-${data.chunkIndex}`,
      {proposalId: data.proposalId, chunkIndex: data.chunkIndex, phase: "planning"},
  );
  logger.info("Drive planning chunk: Dispatched task", {
    proposalId: data.proposalId,
    chunkIndex: data.chunkIndex,
  });
}

/** Enqueues reviewed-plan Drive mutation chunk processing. */
export async function dispatchMoveChunkTask(
    data: MoveChunkTaskData,
): Promise<void> {
  if (isLocalDispatch()) {
    let transformedEmail: TransformedEmail;
    if (isAdminEmailId(data.emailId)) {
      const proposal = await getOrganizeProposal(data.proposalId);
      const senderEmail = (proposal as unknown as OrganizeProposalDoc)?.senderEmail || "";
      transformedEmail = buildAdminSyntheticEmail(senderEmail);
    } else {
      ({transformedEmail} = await fetchEmailById(data.emailId));
    }
    await processMoveChunk(transformedEmail, data);
    return;
  }

  await enqueueChunkTask(
      "locations/us-central1/functions/v2driveMoveChunkTask",
      data,
      `${sanitizeProposalIdForTaskId(data.proposalId)}-move-${data.chunkIndex}`,
      {proposalId: data.proposalId, chunkIndex: data.chunkIndex, phase: "move"},
  );
  logger.info("Drive move chunk: Dispatched task", {
    proposalId: data.proposalId,
    chunkIndex: data.chunkIndex,
  });
}

// ============================================================================
// HTTP ROUTE HANDLERS
// ============================================================================

/** Handles browser confirmation after a user authorizes Drive access. */
export async function handleDriveConfirm(
    req: Request,
    res: Response,
): Promise<void> {
  const emailId = req.query.emailId as string;
  if (!emailId) {
    res.status(400).send("Missing emailId");
    return;
  }

  // Fetch the original email to identify the sender
  let resend: ResendClient;
  let transformedEmail: TransformedEmail;
  try {
    const result = await fetchEmailById(emailId);
    resend = result.resend;
    transformedEmail = result.transformedEmail;
  } catch (err) {
    logger.error("Drive: Failed to fetch email for confirm", {
      emailId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).send("Failed to fetch email");
    return;
  }

  const sender = transformedEmail.from?.toLowerCase();
  if (!sender) {
    res.status(400).send("Could not determine sender");
    return;
  }

  // Check if user has OAuth already
  const uid = await getUserFromEmail(sender);
  if (uid) {
    try {
      const userData = await getUserFromUID(uid, DRIVE_USERS_COLLECTION);
      if (userData.access_token) {
        // User has OAuth — process upload directly
        sendEvent(uid, "driveFileConfirmed", "drive");
        await processUpload(emailId, uid, resend, transformedEmail);
        res.redirect(302, "https://www.fwd2drive.com/upload-success");
        return;
      }
    } catch (err) {
      logger.warn("Drive: Error checking user for confirm", {
        uid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // No OAuth — redirect to signup with emailId as state
  const encodedState = Buffer.from(JSON.stringify({emailId})).toString("base64url");
  res.redirect(302, `${driveSignupUrl()}?state=${encodeURIComponent(encodedState)}`);
}

/** Validates an organize action link and dispatches the requested work. */
export async function handleOrganizeAction(
    req: Request,
    res: Response,
): Promise<void> {
  const proposalId = req.query.proposalId as string;
  const action = req.query.action as OrganizeActionTaskData["action"];

  if (!proposalId || !action || !["approve", "undo", "move"].includes(action)) {
    res.status(400).send(renderActionPage("error", "Invalid request."));
    return;
  }

  // Verify HMAC token
  const token = req.query.token as string;
  const expectedToken = signActionToken(proposalId, action);
  if (!token || token !== expectedToken) {
    res.status(403).send(renderActionPage("error", "Invalid or expired link."));
    return;
  }

  // Fetch proposal from Firestore for quick validation
  let proposalDoc: OrganizeProposalDoc;
  try {
    const raw = await getOrganizeProposal(proposalId);
    if (!raw) {
      res.status(404).send(renderActionPage("error",
          "This proposal was not found or has expired."));
      return;
    }
    proposalDoc = raw as unknown as OrganizeProposalDoc;
  } catch (err) {
    logger.error("Drive organize action: Failed to fetch proposal", {
      proposalId, error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).send(renderActionPage("error",
        "Something went wrong. Please try again."));
    return;
  }

  // Validate status before dispatching
  if (action === "approve" && proposalDoc.status !== "pending") {
    res.send(renderActionPage("error",
        `This proposal has already been ${proposalDoc.status}.`));
    return;
  }
  if (action === "undo" && proposalDoc.status !== "completed") {
    res.send(renderActionPage("error",
        "This proposal cannot be undone at this time."));
    return;
  }
  if (action === "move" && (proposalDoc.status !== "pending" || proposalDoc.phase !== "plan_review")) {
    res.send(renderActionPage("error",
        `This proposal has already been ${proposalDoc.status}.`));
    return;
  }
  if (action !== "undo" && new Date(proposalDoc.expiresAt) < new Date()) {
    res.send(renderActionPage("error",
        "This proposal has expired. Send a new organize request to start over."));
    return;
  }

  // Mark as executing to prevent double-clicks
  if (action === "approve" || action === "move") {
    await updateOrganizeProposalStatus(proposalId, "executing");
  }

  // Dispatch background task and return immediately
  try {
    await dispatchOrganizeActionTask({
      proposalId,
      action,
      emailId: proposalDoc.emailId,
    });
  } catch (err) {
    logger.error("Drive organize action: Failed to dispatch task", {
      proposalId, action,
      error: err instanceof Error ? err.message : String(err),
    });
    // Revert status on dispatch failure
    if (action === "approve" || action === "move") {
      await updateOrganizeProposalStatus(proposalId, "pending");
    }
    res.status(500).send(renderActionPage("error",
        "Something went wrong. Please try again."));
    return;
  }

  const message = action === "undo" ?
    "We're restoring your Drive to its previous state. You'll receive a confirmation email when it's done." :
    action === "move" ?
      "We're moving your files now. You'll receive a confirmation email when it's done." :
      "We're preparing your Drive organization plan now. You'll receive a review email when it's ready.";
  res.send(renderActionPage("processing", message));
}

/** Runs upload processing from the local test endpoint. */
export async function handleTestProcessUpload(
    req: Request,
    res: Response,
): Promise<void> {
  try {
    const {emailId, mockData} = req.body;
    if (!emailId) {
      res.status(400).json({error: "Missing emailId"});
      return;
    }

    // Set up mock data if provided (test mode)
    if (mockData && ENVIRONMENT_NAME.value() !== "production") {
      setMockData(emailId, mockData.emailContent, mockData.attachmentsList || []);
    }

    const {resend, transformedEmail} = await fetchEmailById(emailId);
    const sender = transformedEmail.from?.toLowerCase();
    if (!sender) {
      res.status(400).json({error: "Could not determine sender"});
      return;
    }

    const uid = await getUserFromEmail(sender);
    if (!uid) {
      res.status(400).json({error: "User not found"});
      return;
    }

    const result = await processUpload(emailId, uid, resend, transformedEmail);

    let sentEmail = null;
    if (ENVIRONMENT_NAME.value() !== "production") {
      sentEmail = getLastSentEmail(sender);
    }

    res.status(200).json({message: "thanks", data: result, sentEmail});
  } catch (err) {
    const error = err as Error;
    logger.error("Error in testDriveProcessUpload", err);
    res.status(500).json({error: error.message});
  }
}

// ============================================================================
// TASK QUEUE HANDLERS
// ============================================================================

/** Processes a queued post-auth upload task. */
export async function handlePostAuthTask(
    data: PostAuthTaskData,
): Promise<void> {
  const {emailId, uid, organize, proposal} = data;
  if (organize) {
    logger.info("Drive post-auth: Starting organize", {emailId});
    let transformedEmail: TransformedEmail;
    if (isAdminEmailId(emailId)) {
      const user = await getUserFromUID(uid, DRIVE_USERS_COLLECTION);
      transformedEmail = buildAdminSyntheticEmail(user.email);
    } else {
      ({transformedEmail} = await fetchEmailById(emailId));
    }
    await handleOrganizeDrive(transformedEmail, emailId);
  } else {
    logger.info("Drive post-auth: Starting upload", {emailId, uid});
    const {resend, transformedEmail} = await fetchEmailById(emailId);
    await processUpload(emailId, uid, resend, transformedEmail, proposal);
  }
}

/** Processes a queued approve or undo organize action. */
export async function handleOrganizeActionTask(
    data: OrganizeActionTaskData,
): Promise<void> {
  const {proposalId, action, emailId} = data;
  logger.info("Drive organize action task: Starting", {proposalId, action});

  let transformedEmail: TransformedEmail;
  if (isAdminEmailId(emailId)) {
    const proposal = await getOrganizeProposal(proposalId);
    const senderEmail = (proposal as unknown as OrganizeProposalDoc)?.senderEmail || "";
    transformedEmail = buildAdminSyntheticEmail(senderEmail);
  } else {
    ({transformedEmail} = await fetchEmailById(emailId));
  }
  if (action === "move") {
    const rawProposal = await getOrganizeProposal(proposalId);
    if (!rawProposal) {
      throw new Error("Organize proposal not found");
    }
    const proposalDoc = rawProposal as unknown as OrganizeProposalDoc;
    await startChunkedMove(transformedEmail, proposalDoc.senderEmail, proposalDoc.uid, proposalId, proposalDoc);
    logger.info("Drive organize action task: Complete", {proposalId, action});
    return;
  }
  transformedEmail.text = action;
  await handleOrganizeProposalReply(transformedEmail, proposalId, true);

  logger.info("Drive organize action task: Complete", {proposalId, action});
}

/** Processes a queued LLM-only planning chunk task. */
export async function handlePlanningChunkTask(
    data: PlanningChunkTaskData,
): Promise<void> {
  const {proposalId, emailId, chunkIndex} = data;
  logger.info("Drive planning chunk task: Starting", {proposalId, chunkIndex});

  let transformedEmail: TransformedEmail;
  if (isAdminEmailId(emailId)) {
    const proposal = await getOrganizeProposal(proposalId);
    const senderEmail = (proposal as unknown as OrganizeProposalDoc)?.senderEmail || "";
    transformedEmail = buildAdminSyntheticEmail(senderEmail);
  } else {
    ({transformedEmail} = await fetchEmailById(emailId));
  }
  await processPlanningChunk(transformedEmail, data);

  logger.info("Drive planning chunk task: Complete", {proposalId, chunkIndex});
}

/** Processes a queued reviewed-plan Drive mutation chunk task. */
export async function handleMoveChunkTask(
    data: MoveChunkTaskData,
): Promise<void> {
  const {proposalId, emailId, chunkIndex} = data;
  logger.info("Drive move chunk task: Starting", {proposalId, chunkIndex});

  let transformedEmail: TransformedEmail;
  if (isAdminEmailId(emailId)) {
    const proposal = await getOrganizeProposal(proposalId);
    const senderEmail = (proposal as unknown as OrganizeProposalDoc)?.senderEmail || "";
    transformedEmail = buildAdminSyntheticEmail(senderEmail);
  } else {
    ({transformedEmail} = await fetchEmailById(emailId));
  }
  await processMoveChunk(transformedEmail, data);

  logger.info("Drive move chunk task: Complete", {proposalId, chunkIndex});
}

export const dispatchHandlerTestHooks = {
  setGetFunctionsClientForTest(clientFactory: (() => FunctionsClient) | null): void {
    if (clientFactory) {
      functionsClientStubbed = true;
      getFunctionsClient = clientFactory;
    } else {
      functionsClientStubbed = false;
      getFunctionsClient = () => getFunctions() as unknown as FunctionsClient;
    }
  },
};
