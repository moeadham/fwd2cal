import {logger} from "firebase-functions/v2";
import {defaultCompletion, DEFAULT_TEMP} from "../../util/openai";
import {prompts} from "./prompts";
import {BatchFilePlacementSchema, BatchFilePlacement, FilePlacementItem} from "./types";
import {ChatMessage} from "../../util/types";

interface FileInfo {
  fileName: string;
  mimeType: string;
  fileSize: number;
  contentSummary: string;
}

/**
 * Ask the LLM to pick the best folder and filename for all files in one call
 */
async function pickFilePlacements(
    folderTreeText: string,
    files: FileInfo[],
    emailSubject: string,
    emailBody: string,
    uid: string | null = null,
): Promise<FilePlacementItem[]> {
  let userContent = `## Folder Tree\n${folderTreeText || "(empty — user has no folders)"}\n\n`;

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
    {
      role: "system",
      content: prompts.pickFilePlacement.prompt,
    },
    {role: "user", content: userContent},
  ];

  logger.debug("Calling LLM for batch file placement", {
    fileCount: files.length,
  });

  const result = await defaultCompletion<BatchFilePlacement>(
      messages,
      prompts.pickFilePlacement.model,
      DEFAULT_TEMP,
      BatchFilePlacementSchema,
      uid,
  );

  return (result as BatchFilePlacement).placements;
}

export {pickFilePlacements, FileInfo};
