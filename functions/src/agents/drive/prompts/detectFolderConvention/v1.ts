/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const DetectFolderConventionSchema = z.object({
  has_convention: z.boolean().describe("True if the current Drive folder names already follow a consistent naming convention"),
  detected_convention: z.string().describe("Description of the detected convention, or empty string if none exists"),
  suggested_convention: z.string().describe("Convention to use going forward, either the detected convention or the default NN-Category convention"),
  summary: z.string().describe("Brief explanation of the convention recommendation"),
});

type DetectFolderConventionResult = z.infer<typeof DetectFolderConventionSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.2,
  prompt: `You are analyzing a user's Google Drive folder names before proposing any reorganization.

Your job: determine whether the existing top-level folders follow a naming convention.

Common conventions to look for:
- Numbered prefixes like "01-Documents", "02-Finance" (NN-Category)
- Client/project naming like "Acme - Contracts", "BigCo - Invoices"
- Date-based folders like "2024", "2025-Q1"
- Consistent category names like "Work", "Personal", "Finance"

IMPORTANT: If even 2-3 folders share a clear pattern (e.g., they all start with a two-digit number followed by a dash), that IS a convention. Set has_convention to true and describe the pattern in detected_convention.

If no useful convention exists, suggest this default: NN-Category root folders, e.g., 01-Documents, 02-Finance, 03-Work.

Rules:
- Only analyze folder naming style. Do not propose the full directory map yet.
- Keep suggested_convention concise and actionable.
- If has_convention is true, suggested_convention should match the detected convention.
- If has_convention is false, detected_convention must be an empty string.`,
};

export {prompt, DetectFolderConventionSchema, DetectFolderConventionResult};
