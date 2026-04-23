/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const RevisePlanFileActionPatchSchema = z.object({
  file_id: z.string().describe("Google Drive file ID for the existing file action to update"),
  new_name: z.string().nullable().describe("Replacement filename, or null to leave unchanged"),
  new_folder: z.string().nullable().describe("Replacement folder path from the approved structure, or null to leave unchanged"),
  action: z.enum(["move", "rename", "move_and_rename", "keep"]).nullable().describe("Replacement action, or null to let the system recompute it"),
  reason: z.string().describe("Brief reason for this per-file change"),
});

const RevisePlanFileActionsSchema = z.object({
  patches: z.array(RevisePlanFileActionPatchSchema).describe("Per-file patches for only the files explicitly named by the user"),
  folder_ignores: z.array(z.string()).describe(
      "Folder paths to leave in place, using an exact approved folder path or an exact current_path prefix visible in the file actions",
  ),
  unclear: z.boolean().describe("True when the user's requested file or edit cannot be identified confidently"),
  summary: z.string().describe("Short user-facing summary of the revision result or clarification needed"),
});

type RevisePlanFileActionsResult = z.infer<typeof RevisePlanFileActionsSchema>;
type RevisePlanFileActionPatch = z.infer<typeof RevisePlanFileActionPatchSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.1,
  prompt: `You revise a saved Google Drive organization plan.

You will receive:
- The approved folder structure.
- The current per-file action plan.
- The user's reply requesting changes.

Rules:
- Return patches only for files the user explicitly identifies by name, path, or unmistakable description.
- Do not create, rename, merge, or delete folders.
- If the user says "ignore", "skip", "leave alone", "don't touch", or similar for a folder, add that exact folder path to folder_ignores instead of emitting per-file patches.
- A folder_ignores path may be either an exact approved folder path or any exact current_path prefix visible in the current file actions.
- If the user explicitly asks to reorganize a folder that was previously ignored, omit it from folder_ignores and emit the needed per-file patches instead.
- new_folder must exactly match one approved folder path. If the requested folder is not in the approved structure, mark unclear=true unless another exact approved folder is clearly intended.
- Do not invent files.
- Do not rewrite the whole plan.
- Use null for any field the user did not ask to change.
- Use action=null unless the user explicitly requests keep/move/rename and that label is consistent with the changed name/folder.
- Set unclear=true when the requested file, destination, or rename is ambiguous.`,
};

export {
  prompt,
  RevisePlanFileActionsSchema,
  RevisePlanFileActionsResult,
  RevisePlanFileActionPatch,
};
