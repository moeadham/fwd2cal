import {z} from "zod";
import {logger} from "firebase-functions/v2";
import {defaultCompletion, DEFAULT_TEMP} from "../../util/openai";
import {prompts} from "./prompts";
import {
  FileProposalSchema,
  FileProposal,
  MoveInstructionSchema,
  MoveInstruction,
  DriveEmbeddedFileData,
  DriveOrganizeProposalSchema,
  DriveOrganizeProposal,
  DriveFileEntry,
  FileInfo,
} from "./types";
import {ChatMessage, TextContent, ImageURLContent} from "../../util/types";

/**
 * Propose a folder name (NNN-Category) and filenames before Drive access.
 * Uses existing agent-managed folder names to reuse categories.
 */
async function proposeFilePlacement(
    files: FileInfo[],
    emailSubject: string,
    emailBody: string,
    agentFolderNames: string[],
    nextPrefix: string,
    uid: string | null = null,
    imageUrls: string[] = [],
): Promise<FileProposal> {
  let userText = `## Existing Agent-Managed Folders\n`;
  if (agentFolderNames.length > 0) {
    userText += agentFolderNames.map((f) => `- ${f}`).join("\n") + "\n";
  } else {
    userText += "(none — this is a new user)\n";
  }
  userText += `\nNext available folder prefix: ${nextPrefix}\n\n`;

  userText += `## Files (${files.length} total)\n`;
  for (let i = 0; i < files.length; i++) {
    userText += `\n### File ${i}\n`;
    userText += `Filename: ${files[i].fileName}\n`;
    userText += `MIME Type: ${files[i].mimeType}\n`;
    userText += `Size: ${files[i].fileSize} bytes\n`;
    if (files[i].contentSummary) {
      userText += `Content Summary: ${files[i].contentSummary}\n`;
    }
  }

  if (emailSubject || emailBody) {
    userText += `\n## Email Context\n`;
    if (emailSubject) userText += `Subject: ${emailSubject}\n`;
    if (emailBody) userText += `Body: ${emailBody.slice(0, 500)}\n`;
  }

  // Build user message content - text + images (mirrors calendar agent pattern)
  let userContent: string | Array<TextContent | ImageURLContent>;
  if (imageUrls.length > 0) {
    const contentArray: Array<TextContent | ImageURLContent> = [
      {type: "text", text: userText},
    ];
    imageUrls.forEach((url) => {
      contentArray.push({type: "image_url", image_url: {url}});
    });
    userContent = contentArray;
    logger.info("Including images in Drive proposal LLM request", {
      imageCount: imageUrls.length,
    });
  } else {
    userContent = userText;
  }

  const messages: ChatMessage[] = [
    {role: "system", content: prompts.proposeFilePlacement.prompt},
    {role: "user", content: userContent},
  ];

  logger.debug("Calling LLM for file placement proposal", {
    fileCount: files.length,
    agentFolderCount: agentFolderNames.length,
  });

  const result = await defaultCompletion<FileProposal>(
      messages,
      prompts.proposeFilePlacement.model,
      DEFAULT_TEMP,
      FileProposalSchema,
      uid,
  );

  return result as FileProposal;
}

/**
 * Interpret a user's reply to move uploaded files to a new location.
 */
async function interpretMoveInstructions(
    replyText: string,
    currentFiles: DriveEmbeddedFileData[],
    agentFolders: {name: string; id: string}[],
    uid: string | null = null,
): Promise<MoveInstruction> {
  let userContent = `## User's Instructions\n${replyText}\n\n`;

  userContent += `## Current Files\n`;
  for (let i = 0; i < currentFiles.length; i++) {
    const f = currentFiles[i];
    userContent += `\n### File ${i}\n`;
    userContent += `Filename: ${f.filename}\n`;
    userContent += `Current Folder: ${f.folderPath}\n`;
    userContent += `Drive File ID: ${f.id}\n`;
  }

  if (agentFolders.length > 0) {
    userContent += `\n## Agent-Managed Folders\n`;
    userContent += agentFolders
        .map((f) => `- ${f.name} [id: ${f.id}]`)
        .join("\n") + "\n";
  } else {
    userContent += `\n## Agent-Managed Folders\n(none)\n`;
  }

  const messages: ChatMessage[] = [
    {role: "system", content: prompts.interpretMoveInstructions.prompt},
    {role: "user", content: userContent},
  ];

  logger.debug("Calling LLM for move instructions", {
    fileCount: currentFiles.length,
  });

  const result = await defaultCompletion<MoveInstruction>(
      messages,
      prompts.interpretMoveInstructions.model,
      DEFAULT_TEMP,
      MoveInstructionSchema,
      uid,
  );

  return result as MoveInstruction;
}

/**
 * Build user text for a single chunk of files.
 */
function buildChunkUserText(
    driveStructureSummary: string,
    existingFolders: DriveOrganizeProposal["proposed_folders"],
    chunkFiles: DriveFileEntry[],
    chunkIndex: number,
    totalChunks: number,
    totalFiles: number,
): string {
  let userText = `## Current Drive Structure\n`;
  userText += driveStructureSummary + "\n\n";

  if (existingFolders.length > 0) {
    userText += `## Previously Proposed Folders (reuse these)\n`;
    for (const folder of existingFolders) {
      userText += `- ${folder.folder_name}: ${folder.description}`;
      if (folder.subfolders) {
        const subs = folder.subfolders
            .map((s) => s.subfolder_name).join(", ");
        userText += ` [subfolders: ${subs}]`;
      }
      userText += "\n";
    }
    userText += "\n";
  }

  const nonFolders = chunkFiles.filter((f) => !f.isFolder);
  userText += `## File Batch ${chunkIndex + 1}/${totalChunks}` +
    ` (${nonFolders.length} files, ${totalFiles} total in drive)\n`;
  for (const file of nonFolders) {
    userText += `- [${file.id}] "${file.name}" in "${file.parentPath}" ` +
      `(${file.mimeType}, created: ${file.createdTime}, ` +
      `${file.size} bytes)\n`;
  }

  return userText;
}

/**
 * Propose a full Drive reorganization by processing files in chunks.
 * Each chunk receives the accumulated folder structure from prior chunks.
 */
async function proposeOrganization(
    driveStructureSummary: string,
    fileEntries: DriveFileEntry[],
    chunkSize: number,
    uid: string | null = null,
    seedFolders: DriveOrganizeProposal["proposed_folders"] = [],
): Promise<DriveOrganizeProposal> {
  const nonFolders = fileEntries.filter((f) => !f.isFolder);
  const totalFiles = nonFolders.length;

  // Split non-folder files into chunks
  const chunks: DriveFileEntry[][] = [];
  for (let i = 0; i < nonFolders.length; i += chunkSize) {
    chunks.push(nonFolders.slice(i, i + chunkSize));
  }

  logger.info("LLM organize: starting chunked processing", {
    totalFiles,
    chunkSize,
    totalChunks: chunks.length,
    seedFolders: seedFolders.length,
  });

  // Accumulated state across chunks — start with seed folders from existing Drive structure
  let accumulatedFolders: DriveOrganizeProposal["proposed_folders"] = [...seedFolders];
  const allFileActions: DriveOrganizeProposal["file_actions"] = [];
  const summaries: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const userText = buildChunkUserText(
        driveStructureSummary,
        accumulatedFolders,
        chunk,
        i,
        chunks.length,
        totalFiles,
    );

    const messages: ChatMessage[] = [
      {role: "system", content: prompts.proposeOrganization.prompt},
      {role: "user", content: userText},
    ];

    logger.info(`LLM organize chunk ${i + 1}/${chunks.length}`, {
      chunkFiles: chunk.length,
      existingFolders: accumulatedFolders.length,
      userTextLength: userText.length,
    });

    const result = await defaultCompletion<DriveOrganizeProposal>(
        messages,
        prompts.proposeOrganization.model,
        DEFAULT_TEMP,
        DriveOrganizeProposalSchema,
        uid,
    );

    const chunkProposal = result as DriveOrganizeProposal;

    logger.info(`LLM organize chunk ${i + 1} result`, {
      proposedFolders: chunkProposal.proposed_folders.length,
      fileActions: chunkProposal.file_actions.length,
      chunkFiles: chunk.length,
    });

    // Update accumulated folders (LLM returns full list each time)
    accumulatedFolders = chunkProposal.proposed_folders;

    // Collect file actions from this chunk
    allFileActions.push(...chunkProposal.file_actions);

    if (chunkProposal.summary) {
      summaries.push(chunkProposal.summary);
    }
  }

  // Back-fill files not addressed by any chunk as "keep"
  const coveredIds = new Set(allFileActions.map((a) => a.file_id));
  let backfilled = 0;
  for (const file of nonFolders) {
    if (!coveredIds.has(file.id)) {
      allFileActions.push({
        file_id: file.id,
        current_name: file.name,
        current_path: file.parentPath,
        new_name: file.name,
        new_folder: file.parentPath,
        action: "keep",
        reason: "Kept in place",
      });
      backfilled++;
    }
  }

  logger.info("LLM organize: chunked processing complete", {
    totalFiles,
    filesWithChanges: allFileActions.length - backfilled,
    filesKept: backfilled,
    finalFolders: accumulatedFolders.length,
  });

  // Consolidate per-batch summaries into one concise summary
  let finalSummary = summaries[0] ?? "";
  if (summaries.length > 1) {
    const consolidateMessages: ChatMessage[] = [
      {
        role: "system",
        content: prompts.consolidateSummaries.prompt,
      },
      {
        role: "user",
        content: summaries.map((s, i) =>
          `Batch ${i + 1}: ${s}`).join("\n"),
      },
    ];
    try {
      const result = await defaultCompletion<{summary: string}>(
          consolidateMessages,
          prompts.consolidateSummaries.model,
          DEFAULT_TEMP,
          z.object({summary: z.string()}),
          uid,
      );
      finalSummary = (result as {summary: string}).summary;
    } catch (err) {
      logger.warn("Failed to consolidate summaries, using first", err);
    }
  }

  return {
    proposed_folders: accumulatedFolders,
    file_actions: allFileActions,
    summary: finalSummary,
  };
}

export {
  proposeFilePlacement,
  interpretMoveInstructions,
  proposeOrganization,
};
