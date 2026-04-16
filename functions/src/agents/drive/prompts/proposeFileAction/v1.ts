/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig, OrganizeFolderSchema} from "../../types";

const ProposeFileActionSchema = z.object({
  file_id: z.string().describe("Google Drive file ID"),
  current_name: z.string().describe("Current filename"),
  current_path: z.string().describe("Current folder path"),
  new_name: z.string().describe("Proposed filename using the approved convention"),
  target_directory: z.string().describe("Target folder path relative to My Drive"),
  action: z.enum(["move", "rename", "move_and_rename", "keep"]).describe("Action to take on this file"),
  needs_new_directory: z.boolean().describe("True if target_directory is not already in the supplied directory tree"),
  new_directory: OrganizeFolderSchema.nullable().describe("Directory to add when needs_new_directory is true"),
  reason: z.string().describe("Brief reasoning for the placement and name"),
});

type ProposeFileActionResult = z.infer<typeof ProposeFileActionSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.2,
  prompt: `You are organizing one Google Drive file at a time.

You will receive the current evolving directory tree, the approved filename convention, metadata for one file, and any available content summary. Pick the best target directory and filename.

Rules:
- Return exactly one action for the supplied file.
- Use the approved filename convention and preserve the file extension when possible.
- Use needs_new_directory only when no existing directory fits.
- If adding a directory, include new_directory with folder_path and description.
- The file's current_path may reference a folder that is NOT in the Approved Directory Tree (for example, leftover from a prior organize run). Treat such paths as invalid destinations. When current_path is not one of the Approved Directory Tree entries, you MUST emit "move" or "move_and_rename" — never "keep" or "rename".
- target_directory must exactly match one of the Approved Directory Tree entries, unless supplied via new_directory with needs_new_directory: true. Do not invent paths. Two folder paths that differ by even one character (hyphens vs. spaces vs. pipes) are DIFFERENT folders.
- Choosing the action:
  - "keep" — ONLY when BOTH the folder and filename already match the approved system exactly. Never use "keep" when current_path is not in the Approved Directory Tree. If in doubt, do not use "keep".
  - "rename" — when the file is already in the correct target folder but the filename does not match the approved convention.
  - "move" — only when the file needs a folder change AND the current filename already matches the approved convention exactly.
  - "move_and_rename" — when the file needs both a folder change and a filename update. This is the DEFAULT action for most files — assume the filename needs to match the convention unless it already does.
- Whenever the current filename does not already match the approved filename convention, the action MUST be "rename" or "move_and_rename". Never return "move" or "keep" when the filename needs updating.`,
};

export {prompt, ProposeFileActionSchema, ProposeFileActionResult};
