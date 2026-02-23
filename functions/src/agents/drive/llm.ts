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

export {
  proposeFilePlacement,
  interpretMoveInstructions,
};
