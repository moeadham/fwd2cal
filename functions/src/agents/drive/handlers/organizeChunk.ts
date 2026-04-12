import {LengthFinishReasonError} from "openai/core/error";
import {logger} from "firebase-functions/v2";
import {getStorage} from "firebase-admin/storage";
import {sendEvent} from "../../../util/analytics";
import {getSenderFromRawEmail} from "../../../util/emailUtils";
import {ChatMessage, TransformedEmail} from "../../../util/types";
import {
  DriveFileEntry,
  DriveOrganizeProposal,
  DriveOrganizeProposalSchema,
  OrganizeChunkResult,
  OrganizeChunkTaskData,
  OrganizeIntermediateState,
  OrganizeProposalDoc,
} from "../types";
import {
  backfillUncoveredFiles,
  buildChunkUserText,
  consolidateSummaries,
  reconcileFileActions,
  refineOrganizationProposal,
} from "../llm";
import {defaultCompletion, DEFAULT_TEMP} from "../../../util/openai";
import {getPrompts} from "../prompts/index";
import {dispatchOrganizeChunkTask, fetchEmailById} from "./dispatchHandler";
import {
  calculateOrganizeCost,
  failOrganizeGeneration,
  getParallelBatchChunkIndexes,
  mergeChunkProposalFolders,
  sendOrganizeProposalEmail,
} from "./organizeHelpers";
import {
  claimChunkProcessing,
  claimOrganizeProposalFinalization,
  finalizeOrganizeProposal,
  getChunkResultPath,
  getOrganizeChunkResults,
  getOrganizeIntermediateState,
  getOrganizeProposal,
  getStuckOrganizeProposals,
  incrementOrganizeCompletedChunks,
  releaseChunkProcessing,
  saveOrganizeChunkResult,
  updateOrganizeProposalStatus,
} from "../../../util/firestoreHandler";

/** Combines completed chunk outputs into the final organize proposal. */
export async function finalizeChunkedProposal(
    email: TransformedEmail,
    proposalId: string,
    proposalDoc: OrganizeProposalDoc,
    state: OrganizeIntermediateState,
): Promise<void> {
  const claimedFinalization = await claimOrganizeProposalFinalization(proposalId);
  if (!claimedFinalization) {
    logger.info("Drive organize: Finalization already claimed, skipping", {
      proposalId,
      uid: proposalDoc.uid,
    });
    return;
  }

  const chunkResults = (await getOrganizeChunkResults(
      proposalId,
      state.totalChunks,
  ) as unknown as OrganizeChunkResult[]).sort((a, b) => a.chunkIndex - b.chunkIndex);
  const nonFolders = state.fileEntries.filter((f) => !f.isFolder);

  let accumulatedFolders = [...state.seedFolders];
  const allFileActions: DriveOrganizeProposal["file_actions"] = [];
  const summaries: string[] = [];

  for (const chunkResult of chunkResults) {
    accumulatedFolders = mergeChunkProposalFolders(accumulatedFolders, {
      proposed_folders: chunkResult.proposed_folders,
      file_actions: chunkResult.file_actions,
      summary: chunkResult.summary,
    });
    allFileActions.push(...chunkResult.file_actions);
    if (chunkResult.summary) {
      summaries.push(chunkResult.summary);
    }
  }

  const backfilledFileActions = backfillUncoveredFiles(nonFolders, allFileActions);
  const finalSummary = await consolidateSummaries(summaries, proposalDoc.uid);
  let finalProposal: DriveOrganizeProposal = {
    proposed_folders: accumulatedFolders,
    file_actions: [
      ...backfilledFileActions,
      ...state.folderRenameActions,
    ],
    summary: finalSummary,
  };
  reconcileFileActions(finalProposal);

  try {
    finalProposal = await refineOrganizationProposal(finalProposal, proposalDoc.uid);
    logger.info("Drive organize: proposal refinement applied", {
      proposalId,
      uid: proposalDoc.uid,
      proposedFolders: finalProposal.proposed_folders.length,
      fileActions: finalProposal.file_actions.length,
    });
  } catch (error) {
    const refinementErr = error as Error & { status?: number; error?: unknown };
    logger.warn("Drive organize: proposal refinement failed, using original proposal", {
      proposalId,
      uid: proposalDoc.uid,
      error: refinementErr.message || String(error),
      status: refinementErr.status,
      errorBody: refinementErr.error,
    });
  }

  const cost = calculateOrganizeCost(finalProposal, nonFolders);
  const mimeMap = Object.fromEntries(
      nonFolders.map((file) => [file.id, file.mimeType]),
  );

  await sendOrganizeProposalEmail(
      state.senderEmail || proposalDoc.senderEmail || getSenderFromRawEmail(email) || "",
      email,
      proposalId,
      finalProposal,
      cost,
  );
  await finalizeOrganizeProposal(
      proposalId,
      finalProposal as unknown as Record<string, unknown>,
      cost as unknown as Record<string, unknown>,
      mimeMap as Record<string, unknown>,
  );

  sendEvent(proposalDoc.uid, "driveOrganizeProposed", "drive", {
    totalFiles: String(cost.totalFiles),
    filesToChange: String(cost.totalFiles - cost.filesToKeep),
    totalCost: cost.totalCost.toFixed(2),
  });

  logger.info("Drive organize: Chunked proposal finalized", {
    proposalId,
    uid: proposalDoc.uid,
    totalFiles: cost.totalFiles,
    filesToChange: cost.totalFiles - cost.filesToKeep,
    totalCost: cost.totalCost,
  });
}
/** Processes one chunk of files for a generating organize proposal. */
export async function processOrganizeChunk(
    email: TransformedEmail,
    data: OrganizeChunkTaskData,
): Promise<void> {
  const {proposalId, uid, chunkIndex} = data;

  let proposalDoc: OrganizeProposalDoc | null = null;
  try {
    const rawProposal = await getOrganizeProposal(proposalId);
    if (!rawProposal) {
      logger.warn("Drive organize chunk: Proposal not found (likely deleted or expired)", {
        proposalId,
        chunkIndex,
      });
      return;
    }
    proposalDoc = rawProposal as unknown as OrganizeProposalDoc;
    if (proposalDoc.status !== "generating") {
      logger.info("Drive organize chunk: Proposal no longer generating", {
        proposalId,
        status: proposalDoc.status,
      });
      return;
    }

    const claimedChunk = await claimChunkProcessing(proposalId, chunkIndex, 15);
    if (!claimedChunk) {
      logger.info("Drive organize chunk: Already being processed, skipping duplicate dispatch", {
        proposalId,
        chunkIndex,
      });
      return;
    }

    try {
      const state = await getOrganizeIntermediateState(proposalId) as
        unknown as OrganizeIntermediateState;

      if (!state.fileEntries) {
        logger.warn("Drive organize chunk: Intermediate state missing fileEntries (proposal likely finalized)", {
          proposalId,
          chunkIndex,
        });
        return;
      }

      const nonFolders = state.fileEntries.filter((f) => !f.isFolder);
      const chunks: DriveFileEntry[][] = [];
      for (let i = 0; i < nonFolders.length; i += state.chunkSize) {
        chunks.push(nonFolders.slice(i, i + state.chunkSize));
      }

      const chunk = chunks[chunkIndex];
      if (!chunk) {
        logger.warn("Drive organize chunk: Missing chunk", {
          proposalId,
          chunkIndex,
          totalChunks: chunks.length,
        });
        return;
      }

      const chunkResultFile = getStorage()
          .bucket()
          .file(getChunkResultPath(proposalId, chunkIndex));
      const [chunkResultExists] = await chunkResultFile.exists();

      if (!chunkResultExists) {
        const {prompts, versions} = getPrompts();
        const userText = buildChunkUserText(
            state.driveStructureSummary,
            state.seedFolders,
            chunk,
            chunkIndex,
            chunks.length,
            nonFolders.length,
        );
        const messages: ChatMessage[] = [
          {role: "system", content: prompts.proposeOrganization.prompt},
          {role: "user", content: userText},
        ];

        logger.info(`LLM organize chunk ${chunkIndex + 1}/${chunks.length}`, {
          proposalId,
          chunkFiles: chunk.length,
          existingFolders: state.seedFolders.length,
          userTextLength: userText.length,
        });

        const result = await defaultCompletion<DriveOrganizeProposal>(
            messages,
            prompts.proposeOrganization.model,
            prompts.proposeOrganization.temperature ?? DEFAULT_TEMP,
            DriveOrganizeProposalSchema,
            uid,
            {
              maxTokens: 32768,
              promptVersion: versions.PROMPT_PROPOSE_ORGANIZATION_VERSION,
            },
        );
        const chunkProposal = result as DriveOrganizeProposal;
        await saveOrganizeChunkResult(proposalId, chunkIndex, {
          chunkIndex,
          proposed_folders: chunkProposal.proposed_folders,
          file_actions: chunkProposal.file_actions,
          summary: chunkProposal.summary,
        } as unknown as Record<string, unknown>);
      } else {
        logger.info("Drive organize chunk: Reusing existing chunk result", {
          proposalId,
          chunkIndex,
        });
      }

      const {count: newCompletedCount, wasNew} = await incrementOrganizeCompletedChunks(proposalId, chunkIndex);
      if (newCompletedCount > state.totalChunks) {
        logger.warn("Drive organize chunk: Completed chunk count exceeded total", {
          proposalId,
          chunkIndex,
          newCompletedCount,
          totalChunks: state.totalChunks,
        });
        return;
      }

      const latestProposal = await getOrganizeProposal(proposalId);
      if (!latestProposal || latestProposal.status !== "generating") {
        logger.info("Drive organize chunk: Proposal finalized while chunk was running", {
          proposalId,
          chunkIndex,
          status: latestProposal?.status,
        });
        return;
      }

      const heartbeat = new Date().toISOString();

      await updateOrganizeProposalStatus(proposalId, "generating", {
        currentChunk: newCompletedCount,
        totalChunks: state.totalChunks,
        generationStartedAt: heartbeat,
        lastError: null,
      });

      if (wasNew) {
        const nextBatchChunkIndexes = getParallelBatchChunkIndexes(
            newCompletedCount,
            state.totalChunks,
            state.parallelChunkLimit,
        );
        if (nextBatchChunkIndexes.length > 0) {
          for (const nextChunkIndex of nextBatchChunkIndexes) {
            await dispatchOrganizeChunkTask({
              proposalId,
              emailId: proposalDoc.emailId,
              uid,
              chunkIndex: nextChunkIndex,
            });
          }
        }
      }

      if (wasNew && newCompletedCount === state.totalChunks) {
        await finalizeChunkedProposal(email, proposalId, proposalDoc, state);
        return;
      }
      return;
    } finally {
      await releaseChunkProcessing(proposalId, chunkIndex).catch((err) => {
        logger.warn("Drive organize chunk: Failed to release lock", {
          proposalId,
          chunkIndex,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Drive organize chunk: Failed", {
      proposalId,
      chunkIndex,
      error: errMsg,
    });
    if (proposalDoc?.status === "generating") {
      const isFatal = error instanceof LengthFinishReasonError;
      await updateOrganizeProposalStatus(
          proposalId,
          isFatal ? "failed" : "generating",
          {
            currentChunk: chunkIndex,
            lastError: errMsg,
          },
      ).catch((updateError) => {
        logger.error("Drive organize chunk: Failed to persist error", {
          proposalId,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });
      });
    }
    throw error;
  }
}

/** Retries or fails organize proposals whose generation appears stuck. */
export async function cleanupStuckOrganizeProposals(): Promise<{
  checked: number;
  retried: number;
  failed: number;
}> {
  const stuckProposals = await getStuckOrganizeProposals(45);
  let retried = 0;
  let failed = 0;
  logger.info("Drive organize cleanup: Found stuck proposals", {
    count: stuckProposals.length,
  });

  for (const rawProposal of stuckProposals) {
    const proposal = rawProposal as {id: string} & Partial<OrganizeProposalDoc>;
    const proposalId = proposal.id;
    const attemptCount = proposal.attemptCount || 1;
    const currentChunk = proposal.currentChunk || 0;

    try {
      if (attemptCount >= 3) {
        try {
          const {transformedEmail} = await fetchEmailById(proposal.emailId!);
          await failOrganizeGeneration(
              proposalId,
              proposal.senderEmail || getSenderFromRawEmail(transformedEmail) || "",
              transformedEmail,
              proposal.lastError || "Max retries exhausted",
          );
        } catch (error) {
          const lastError = error instanceof Error ? error.message : String(error);
          await updateOrganizeProposalStatus(proposalId, "failed", {
            generationStartedAt: null,
            lastError: lastError.includes("Failed to fetch email") ?
              "Original email expired" :
              lastError,
          });
        }
        failed++;
        continue;
      }

      await updateOrganizeProposalStatus(proposalId, "generating", {
        attemptCount: attemptCount + 1,
        generationStartedAt: new Date().toISOString(),
      });
      await dispatchOrganizeChunkTask({
        proposalId,
        emailId: proposal.emailId!,
        uid: proposal.uid!,
        chunkIndex: currentChunk,
      });

      logger.info("Drive organize cleanup: Redispatched stuck proposal", {
        proposalId,
        attemptCount: attemptCount + 1,
        chunkIndex: currentChunk,
      });
      retried++;
    } catch (error) {
      logger.error("Drive organize cleanup: Failed", {
        proposalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    checked: stuckProposals.length,
    retried,
    failed,
  };
}
