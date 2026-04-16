/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const DetectFolderConventionSchema = z.object({
  has_convention: z.boolean().describe("True if the current Drive folder names already follow a consistent naming convention"),
  detected_convention: z.string().describe("Description of the detected convention, or empty string if none exists"),
  suggested_convention: z.string().describe("Convention to use going forward, either the detected convention or the provided fallback"),
  summary: z.string().describe("Brief explanation of the convention recommendation"),
});

type DetectFolderConventionResult = z.infer<typeof DetectFolderConventionSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.2,
  prompt: `You analyze a flat list of the user's top-level Google Drive folder names and decide whether they share a naming convention.

You will receive a "## Top-Level Folders" list. That list is the ONLY source of truth. A "## Fallback Convention" block may also appear — use it only for suggested_convention when the folders show no detectable pattern, and never let it override what the folders actually show.

## Output tokens
Express detected_convention and suggested_convention as TERSE token patterns (not sentences) using these tokens:
- N, NN, NNN, NNNN, ... — zero-padded numeric prefix. Use exactly one N per digit in the observed zero-padded width.
- Category — the folder's category name
- ClientName, Project — named components for client/project naming
- YYYY, YYYY-Q# — year or year-quarter for date-based naming

## Detection rules
- If 2 or more folders share the same visible pattern, that IS a convention. Set has_convention to true.
- Count the digits in the numeric prefix literally. Examples:
  - "1-Work", "2-Finance" → single digit → "N-Category"
  - "01-Finance", "02-Work", "03-Personal" → 2-digit → "NN-Category"
  - "001-Personal", "002-Work" → 3-digit → "NNN-Category"
  - "0001-Archive", "0002-Active" → 4-digit → "NNNN-Category"
- Separator matters. Preserve the actual separator between prefix and category: "01-Finance" → "NN-Category"; "01 Finance" → "NN Category"; "01_Finance" → "NN_Category".
- Other shapes:
  - "Acme - Contracts", "BigCo - Invoices" → "ClientName - Category"
  - "2024", "2025" → "YYYY"
  - "2025-Q1", "2025-Q2" → "YYYY-Q#"
- Ignore a single outlier folder that doesn't fit, as long as the majority share the pattern.
- If folders show no shared pattern, set has_convention to false and detected_convention to "".

## Rules
- Keep suggested_convention concise, actionable, and expressed with the tokens above.
- If has_convention is true, suggested_convention MUST equal detected_convention.
- If has_convention is false, detected_convention must be an empty string, and suggested_convention should come from the fallback block or "NN-Category".`,
};

export {prompt, DetectFolderConventionSchema, DetectFolderConventionResult};
