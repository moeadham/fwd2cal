/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig, OrganizeFolderSchema} from "../../types";

const AnalyzeDirectoryStructureSchema = z.object({
  has_existing_convention: z.boolean().describe("True if the current tree already follows a clear folder naming convention"),
  convention_description: z.string().describe("Echo the confirmed convention description provided in input verbatim. Only derive a fresh description if no input description was provided"),
  proposed_structure: z.array(OrganizeFolderSchema.extend({
    source: z.enum(["existing", "proposed"]).describe("Whether this folder already exists or is newly proposed"),
  })).describe("Initial directory structure proposal"),
  summary: z.string().describe("Brief explanation of the structure and why it fits the drive"),
});

type AnalyzeDirectoryStructureResult = z.infer<typeof AnalyzeDirectoryStructureSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.1,
  prompt: `You are designing a clean Google Drive directory map before any file moves happen.

You will receive:
1. The user's current folder tree
2. A confirmed folder naming convention (already approved by the user)
3. A confirmed convention description when one is available
4. User instructions (may include revision requests)

All root-level folders MUST follow the confirmed naming convention. Do not re-detect or override it. If both a convention token and description are provided, honor both literally.

Rules:
- Follow the confirmed folder naming convention exactly.
- Echo the confirmed convention description verbatim in convention_description. Only derive a fresh description if no input description was provided.
- The separator character in the convention between digit prefix and category name must appear verbatim in every proposed root folder name. If the token is NN|Category, every proposed root folder starts with two digits followed by a pipe.
- When the convention includes a numeric prefix token such as NN-Category, assign root prefixes contiguously from 01 in proposed_structure order. Do not preserve existing prefix numbers from the current tree; the system will renumber deterministically as a safety net.
- Prefer stable, broad root categories over one-off folders.
- Include subfolders if applicable.
- Mark folders that already exist as source "existing" and new folders as source "proposed".
- Keep paths relative to My Drive. Do not include "My Drive/" in folder_path.
- Include descriptions that explain what belongs in each folder.
- If user instructions include revisions, apply them while preserving the convention.`,
};

export {prompt, AnalyzeDirectoryStructureSchema, AnalyzeDirectoryStructureResult};
