/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const SetPreferencesSchema = z.object({
  folderConvention: z.string().nullable().optional().describe(
      "The requested folder naming convention, or null/omitted if the user did not specify one",
  ),
  folderConventionDescription: z.string().nullable().optional().describe(
      "One-sentence plain-English description of folderConvention. Required when folderConvention is set; " +
      "must be explicit about digit width and separator. Example: " +
      "'Three-digit zero-padded prefix, a dash, then the category name (e.g. 001-Personal).'",
  ),
  filenameConvention: z.string().nullable().optional().describe(
      "The requested filename convention, or null/omitted if the user did not specify one",
  ),
  filenameConventionDescription: z.string().nullable().optional().describe(
      "One-sentence plain-English description of filenameConvention. Required when filenameConvention is set.",
  ),
  summary: z.string().describe("Brief user-facing summary of the preferences found"),
});

type SetPreferencesResult = z.infer<typeof SetPreferencesSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  temperature: 0.2,
  prompt: `You are updating fwd2drive preferences from an email.

The user may ask to set folder naming conventions, filename conventions, or both.

Return only conventions that the user explicitly requested.

Rules:
- folderConvention and filenameConvention must be TERSE token patterns using the tokens below — NEVER sentences, natural-language descriptions, or instructions.
- Whenever you set folderConvention, also set folderConventionDescription to a single plain-English sentence that unambiguously describes the pattern (digit width, separator, what each part means). Do the same for filenameConventionDescription whenever you set filenameConvention.
- Descriptions should be stable enough to reuse verbatim in downstream prompts between revisions.
- Do NOT include words like "use", "should", "prefix", "followed by", "e.g." in the convention strings. Just the pattern itself.
- folderConvention is a single folder-name template (e.g. "N-Category", "NN-Category", "ClientName-Project").
- filenameConvention is a single filename template including the extension placeholder (e.g. "YYYYMMDD_Description.ext", "YYYY.MM.DD - Description.ext").
- Preserve the user's requested structure and separators literally, substituting tokens for the variable parts.
- Do not invent missing preferences.
- If the user asks a question or sends an ambiguous message without a new convention, omit both convention fields and summarize the current request.
- Empty strings are not useful. Omit a field instead of returning an empty string.

## Token semantics
Use these token forms when encoding the user's requested pattern:

Date tokens (filenames):
- YYYYMMDD — compact 8-digit date, e.g. "20260415"
- YYYY.MM.DD — dot-separated date, e.g. "2026.04.15"
- YYYY-MM-DD — dash-separated date, e.g. "2026-04-15"
- YYYY / MM / DD — individual year / month / day segments

Descriptive tokens:
- Description — the file's descriptive text (subject, vendor, topic)
- Category — the folder's category name (e.g. "Work", "Finance", "Invoices")
- ext — the file extension (e.g. "pdf", "png")

Numeric prefix tokens (folders) — use one N per digit of the requested width (at least 1):
- N — 1-digit prefix, e.g. "1"
- NN — 2-digit zero-padded prefix, e.g. "01"
- NNN — 3-digit zero-padded prefix, e.g. "001"
- Extend with more N's for wider padding (e.g. NNNN for 4-digit).

## Examples

Filename conventions:
- User says "use YYYYMMDD underscore description" → filenameConvention: "YYYYMMDD_Description.ext" (e.g. "20260415_Invoice.pdf")
- User says "date then title, separated by pipe" → filenameConvention: "YYYY-MM-DD | Description.ext" (e.g. "2026-04-15 | Invoice.pdf")
- User says "dot-separated date then space then the description" → filenameConvention: "YYYY.MM.DD Description.ext" (e.g. "2026.04.15 Invoice.pdf")

Folder conventions:
- User says "use 3-digit prefix for folders" → folderConvention: "NNN-Category" (e.g. "001-Work")
- User says "two-digit prefix with dash" → folderConvention: "NN-Category" (e.g. "01-Finance")
- User says "client-project naming" → folderConvention: "ClientName-Project" (e.g. "Acme-Contracts")`,
};

export {prompt, SetPreferencesSchema, SetPreferencesResult};
