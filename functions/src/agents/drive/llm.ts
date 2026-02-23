import {logger} from "firebase-functions/v2";
import {defaultCompletion, DEFAULT_TEMP} from "../../util/openai";
import {prompts} from "./prompts";
import {
  FileProposalSchema,
  FileProposal,
  MoveInstructionSchema,
  MoveInstruction,
  DriveEmbeddedFileData,
  FileInfo,
} from "./types";
import {ChatMessage} from "../../util/types";

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
): Promise<FileProposal> {
  let userContent = `## Existing Agent-Managed Folders\n`;
  if (agentFolderNames.length > 0) {
    userContent += agentFolderNames.map((f) => `- ${f}`).join("\n") + "\n";
  } else {
    userContent += "(none — this is a new user)\n";
  }
  userContent += `\nNext available folder prefix: ${nextPrefix}\n\n`;

  userContent += `## Files (${files.length} total)\n`;
  for (let i = 0; i < files.length; i++) {
    userContent += `\n### File ${i}\n`;
    userContent += `Filename: ${files[i].fileName}\n`;
    userContent += `MIME Type: ${files[i].mimeType}\n`;
    userContent += `Size: ${files[i].fileSize} bytes\n`;
    if (files[i].contentSummary) {
      userContent += `Content Summary: ${files[i].contentSummary}\n`;
    }
  }

  if (emailSubject || emailBody) {
    userContent += `\n## Email Context\n`;
    if (emailSubject) userContent += `Subject: ${emailSubject}\n`;
    if (emailBody) userContent += `Body: ${emailBody.slice(0, 500)}\n`;
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

export {
  proposeFilePlacement,
  interpretMoveInstructions,
};
