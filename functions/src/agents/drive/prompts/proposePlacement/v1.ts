/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig, OrganizeFolderSchema} from "../../types";

const ProposePlacementSchema = z.object({
  file_id: z.string().describe("Google Drive file ID"),
  current_path: z.string().describe("Current folder path"),
  current_name: z.string().describe("Current filename"),
  target_directory: z.string().describe("Target folder path relative to My Drive"),
  action: z.enum(["move", "keep"]).describe("Placement action to take on this file"),
  needs_new_directory: z.boolean().describe("True if target_directory is not already sufficient"),
  new_directory: OrganizeFolderSchema.nullable().describe("Directory to add when needs_new_directory is true"),
  reason: z.string().describe("Brief reasoning for the placement"),
});

type ProposePlacementResult = z.infer<typeof ProposePlacementSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  temperature: 0.1,
  prompt: `You decide the placement for ONE Google Drive file. You receive placement rules, the approved directory tree, the file's metadata, and the file's contents (extracted text from the document, not a summary; may be truncated for long files).

Rules:
- Follow the Placement Rules block from the user message verbatim where applicable. When those rules do not cover a case, use the structural rules below.
- Return exactly one action.
  - "keep" only when current_path is already an exact entry in the Approved Directory Tree AND is the best destination.
  - "move" otherwise.
- target_directory must exactly match an Approved Directory Tree entry. If a more specific child is needed, set needs_new_directory to true and put the deeper path in new_directory.folder_path. new_directory must extend an existing approved entry.
- Reuse existing approved folders before creating new directories. If an approved entry already represents the file's subject, use that entry instead of creating a duplicate.
- Only create a new_directory when the approved tree lacks a sufficiently specific destination and the new folder would extend an approved entry.
- The leading segments of current_path are source folder names, not categories. Do not map a generic top-level word ("Business", "Personal", "Documents", etc.) to an approved root with the same name. Pick the root from the file's actual subject (current_name, deeper path segments, file contents).

Filenames:
- A category-like prefix in the filename can justify a named sub-category, but new_directory must use the named category, never a bare numeric prefix.
- A date token in the filename alone is not a grouping signal. Only use a date-based subfolder when current_path already segments by date or an approved entry distinguishes a date-bounded period.

Return JSON only.`,
};

export {prompt, ProposePlacementSchema, ProposePlacementResult};
