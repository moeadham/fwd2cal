/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig, OrganizeFolderSchema} from "../../types";

const AnalyzeDirectoryStructureSchema = z.object({
  has_existing_convention: z.boolean().describe("True if the current tree already follows a clear folder naming convention"),
  convention_description: z.string().describe("Short description of the detected convention, or the proposed convention if none exists"),
  proposed_structure: z.array(OrganizeFolderSchema.extend({
    source: z.enum(["existing", "proposed"]).describe("Whether this folder already exists or is newly proposed"),
  })).describe("Initial directory structure proposal"),
  summary: z.string().describe("Brief explanation of the structure and why it fits the drive"),
});

type AnalyzeDirectoryStructureResult = z.infer<typeof AnalyzeDirectoryStructureSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.2,
  prompt: `You are designing a clean Google Drive directory map before any file moves happen.

You will receive:
1. The user's current folder tree
2. A confirmed folder naming convention (already approved by the user)
3. User instructions (may include revision requests)

All root-level folders MUST follow the confirmed naming convention. Do not re-detect or override it.

Rules:
- Follow the confirmed folder naming convention exactly.
- Prefer stable, broad root categories over one-off folders.
- Mark folders that already exist as source "existing" and new folders as source "proposed".
- Keep paths relative to My Drive. Do not include "My Drive/" in folder_path.
- Include descriptions that explain what belongs in each folder.
- If user instructions include revisions, apply them while preserving the convention.`,
};

export {prompt, AnalyzeDirectoryStructureSchema, AnalyzeDirectoryStructureResult};
