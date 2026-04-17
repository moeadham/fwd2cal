/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig, OrganizeFolderSchema} from "../../types";

const FinalizeDirectoryMapSchema = z.object({
  final_directories: z.array(OrganizeFolderSchema).describe("Complete final directory map, including existing and newly added directories"),
  added_directories: z.array(z.string()).describe("Folder paths newly added in this finalization step"),
  summary: z.string().describe("Brief explanation of the final directory map"),
});

type FinalizeDirectoryMapResult = z.infer<typeof FinalizeDirectoryMapSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.1,
  prompt: `You are finalizing the user's Google Drive directory map.

You will receive the proposed structure, recommended directory moves, a file summary, and optional user feedback. Add only directories needed for completeness, then return the complete final directory list.

Rules:
- Paths must be relative to My Drive.
- Preserve user-approved categories unless the latest feedback changes them.
- Include parent folders required by subfolders.
- Keep added_directories to the folders introduced in this step.`,
};

export {prompt, FinalizeDirectoryMapSchema, FinalizeDirectoryMapResult};
