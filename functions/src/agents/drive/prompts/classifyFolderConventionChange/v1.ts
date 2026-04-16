/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const ClassifyFolderConventionChangeSchema = z.object({
  is_change: z.boolean().describe("True if the user's reply asks to change the folder naming convention"),
  new_convention: z.string().describe("Terse folder convention token when is_change is true; otherwise repeat the current convention"),
  new_description: z.string().describe("One-sentence description of new_convention, explicitly naming digit width and separator with an example"),
});

type ClassifyFolderConventionChangeResult = z.infer<typeof ClassifyFolderConventionChangeSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  temperature: 0,
  prompt: `Determine whether the user is changing a Google Drive folder naming convention.

Return is_change true when the reply requests a different folder format, prefix width, separator, casing, ordering, or naming rule. Return false when the reply is approval, vague discussion, or an unrelated folder-structure revision.

When is_change is true, new_convention MUST be a TERSE TOKEN PATTERN, not a sentence. Use only this grammar:
- N, NN, NNN, NNNN, ... — zero-padded numeric prefix. Use exactly one N per digit.
- Category — the folder's category name
- ClientName, Project — named components for client/project naming
- YYYY, YYYY-Q# — year or year-quarter for date-based naming
- Separator literals must be preserved exactly between tokens: dash (-), pipe (|), underscore (_), space ( ), or space-dash-space ( - ).

new_description must be one plain-English sentence that explicitly names the digit width and separator character, and includes a concrete example.

Token-vs-sentence rule:
- Correct new_convention: NN|Category
- Incorrect new_convention: Use a 2-digit numerical prefix followed by | then the category.

Examples:
- Current: NN-Category; reply: "use pipe instead of dash" -> is_change true, new_convention "NN|Category", new_description "Two-digit zero-padded prefix, a pipe, then the category name (e.g. 01|Finance)."
- Current: NN-Category; reply: "use underscores" -> is_change true, new_convention "NN_Category", new_description "Two-digit zero-padded prefix, an underscore, then the category name (e.g. 01_Finance)."
- Current: NN-Category; reply: "make it a space separator" -> is_change true, new_convention "NN Category", new_description "Two-digit zero-padded prefix, a space, then the category name (e.g. 01 Finance)."
- Current: NN|Category; reply: "switch back to dash" -> is_change true, new_convention "NN-Category", new_description "Two-digit zero-padded prefix, a dash, then the category name (e.g. 01-Finance)."
- Current: NN|Category; reply: "Only keep Personal, Work, Trading" -> is_change false, new_convention "NN|Category", new_description "Two-digit zero-padded prefix, a pipe, then the category name (e.g. 01|Finance)."

If is_change is false, repeat the current convention token in new_convention and provide a matching description when possible.`,
};

export {prompt, ClassifyFolderConventionChangeSchema, ClassifyFolderConventionChangeResult};
