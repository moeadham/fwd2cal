/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig, OrganizeFolderSchema} from "../../types";

const AnalyzeDirectoryStructureSchema = z.object({
  has_existing_convention: z.boolean().describe("True if the current tree already follows a clear folder naming convention"),
  convention_description: z.string().describe("Echo the confirmed convention description provided in input verbatim. Only derive a fresh description if no input description was provided"),
  proposed_structure: z.array(OrganizeFolderSchema.extend({
    source: z.enum(["existing", "proposed"]).describe("Whether this folder already exists or is newly proposed"),
  })).describe("Initial directory structure proposal"),
  folder_ignores: z.array(z.string()).describe(
      "Folder paths the user wants left as-is; use the exact existing folder path from the current tree",
  ),
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
5. A confirmed granularity preference
6. A list of named entities the user has folders for
7. A list of removed entities — names the user explicitly excluded

All root-level folders MUST follow the confirmed naming convention. Do not re-detect or override it. If both a convention token and description are provided, honor both literally.

Rules:
- Follow the confirmed folder naming convention exactly.
- Echo the confirmed convention description verbatim in convention_description. Only derive a fresh description if no input description was provided.
- The separator character in the convention between digit prefix and category name must appear verbatim in every proposed root folder name. If the token is NN|Category, every proposed root folder starts with two digits followed by a pipe.
- When the convention includes a numeric prefix token such as NN-Category, assign root prefixes contiguously from 01 in proposed_structure order. Do not preserve existing prefix numbers from the current tree; the system will renumber deterministically as a safety net.
- Shape the proposed structure to match the granularity preference. For by_entity, prefer per-entity folders under category roots. For by_document_type, prefer per-type folders. For by_date, prefer per-period folders. For mixed, blend per-entity and per-type as warranted.
- When a named entity has folders in the current tree, ensure the proposed structure preserves a dedicated folder for that entity. Do not collapse named entities into generic categories.
- Even when Known Named Entities is empty, preserve dedicated folders for organizations, companies, projects, or matters that already have dedicated folders in the current tree. Do not collapse them into generic categories.
- No segment of any folder path in proposed_structure may match (case-insensitive) a name in the removed-entities list. Files under such folders in the current tree should land in the closest non-entity broader category root. The removed-entities list takes precedence over the named-entities list when a name appears in both.
- Prefer stable, broad root categories over one-off folders.
- Include subfolders if applicable.
- Do not nest a sub-folder whose name expresses the same status, era, or scope as its parent (e.g., an "Old", "Legacy", or "Inactive" sub-folder under an Archive root). Collapse it into the parent and keep the sub-folder's children directly under the parent.
- Mark folders that already exist as source "existing" and new folders as source "proposed".
- Keep paths relative to My Drive. Do not include "My Drive/" in folder_path.
- Include descriptions that explain what belongs in each folder.
- If user instructions include revisions, apply them while preserving the convention.
- If the user says "ignore", "skip", "leave alone", "don't touch", or similar for a folder, add that exact folder path to folder_ignores. Do NOT propose a renamed/merged replacement for it in proposed_structure.
- Do not include any folder in proposed_structure whose path equals or descends into a folder in folder_ignores.
- If the user explicitly asks to reorganize a folder previously marked ignored, omit it from folder_ignores and include it in proposed_structure.`,
};

export {prompt, AnalyzeDirectoryStructureSchema, AnalyzeDirectoryStructureResult};
