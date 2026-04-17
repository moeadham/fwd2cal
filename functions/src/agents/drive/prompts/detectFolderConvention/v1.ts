/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const DetectFolderConventionSchema = z.object({
  has_convention: z.boolean().describe("True if the current Drive folder names already follow a consistent naming convention"),
  detected_convention: z.string().describe("Terse token pattern for the detected convention (e.g. 'NNN-Category'), or empty string if none"),
  suggested_convention: z.string().describe("Terse token pattern to use going forward. Equals detected_convention when has_convention is true; otherwise comes from fallback or 'NN-Category'"),
  convention_description: z.string().describe(
      "One-sentence plain-English description of suggested_convention that downstream prompts can reuse verbatim. " +
      "Must be stable, explicit about digit width and separator, and avoid vague terms. " +
      "Example: 'Three-digit zero-padded prefix, a dash, then the category name (e.g. 001-Personal).'",
  ),
  summary: z.string().describe("Brief explanation of the convention recommendation shown to the user"),
});

type DetectFolderConventionResult = z.infer<typeof DetectFolderConventionSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.1,
  prompt: `You analyze a flat list of the user's top-level Google Drive folder names and decide whether they share a naming convention.

You will receive a "## Top-Level Folders" list. That list is the ONLY source of truth. A "## Fallback Convention" block may also appear — use it only for suggested_convention when the folders show no detectable pattern, and never let it override what the folders actually show.

## Output tokens
Express detected_convention and suggested_convention as TERSE token patterns (not sentences) using these tokens:
- N, NN, NNN, NNNN, ... — zero-padded numeric prefix. Use exactly one N per digit in the observed zero-padded width.
- Category — the folder's category name
- ClientName, Project — named components for client/project naming
- YYYY, YYYY-Q# — year or year-quarter for date-based naming

## Detection rules
- If 2 or more folders share a pattern, that counts as a convention. Set has_convention to true even when many other folders don't follow it — organizing a Drive tends to be incremental and you will often see a mix of organized and unorganized folders.
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

## Handling mixed patterns
- Unprefixed folders (e.g. "BDC", "Important", "Personal") almost always exist alongside organized folders. They are UNORGANIZED items, not evidence of "no convention". Ignore them when deciding if a convention exists.
- If you see a mix of digit widths (e.g. some "001-..." and some "01-..."), report the DOMINANT width — the one that appears in more folders. Tie: prefer the wider width. Call out the mix in convention_description.
- If you see numeric-prefixed folders alongside unprefixed folders, the convention IS the numeric-prefix pattern. Do NOT default to "no convention".
- Only set has_convention to false when fewer than 2 folders share any pattern at all.

## Rules
- Keep suggested_convention concise, actionable, and expressed with the tokens above.
- If has_convention is true, suggested_convention MUST equal detected_convention.
- If has_convention is false, detected_convention must be an empty string, and suggested_convention should come from the fallback block or "NN-Category".

## convention_description
- Always produce a single-sentence plain-English description of suggested_convention.
- Be explicit about digit width and separator so downstream prompts (which only see the description and the pattern) have no ambiguity.
- Include at least one concrete example derived from the actual folders when possible.
- Examples:
  - For "NN-Category": "Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Finance)."
  - For "NNN-Category": "Three-digit zero-padded prefix, a dash, then the category name (e.g. 001-Personal)."
  - For "ClientName - Category": "The client or project name, a space-dash-space separator, then the category name (e.g. Acme - Contracts)."`,
};

export {prompt, DetectFolderConventionSchema, DetectFolderConventionResult};
