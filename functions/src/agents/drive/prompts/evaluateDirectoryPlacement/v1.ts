/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const DirectoryMoveSchema = z.object({
  current_path: z.string().describe("Current folder path relative to My Drive"),
  proposed_path: z.string().describe("New folder path relative to My Drive"),
  reason: z.string().describe("Why this directory should move or be renamed"),
});

const EvaluateDirectoryPlacementSchema = z.object({
  directory_moves: z.array(DirectoryMoveSchema).describe("Existing directories that should move or be renamed to match the proposed structure"),
  no_changes_needed: z.boolean().describe("True when no existing directories should be moved or renamed"),
  summary: z.string().describe("Brief explanation of the placement recommendations"),
});

type EvaluateDirectoryPlacementResult = z.infer<typeof EvaluateDirectoryPlacementSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.1,
  prompt: `You are reviewing whether the user's existing Google Drive folders should be moved or renamed to fit an approved directory structure.

You will receive the current folder tree, the proposed directory structure, and optional user feedback. Recommend only directory-level moves or renames that clearly improve consistency. Do not invent file moves.

Rules:
- Use paths relative to My Drive.
- Set no_changes_needed to true only when directory_moves is empty.
- If the user provided revision feedback, apply it directly.
- Prefer fewer, clearer changes over churn.`,
};

export {prompt, EvaluateDirectoryPlacementSchema, EvaluateDirectoryPlacementResult};
