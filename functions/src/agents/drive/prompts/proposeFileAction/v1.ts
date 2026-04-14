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
- Use "keep" only when both the folder and filename already match the approved system.`,
};

export {prompt, ProposeFileActionSchema, ProposeFileActionResult};
