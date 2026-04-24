/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const ScopePlanRevisionSchema = z.object({
  folder_prefixes_in_scope: z.array(z.string()).describe(
      "Exact approved folder paths or exact current_path prefixes visible in the tree that should be considered in-scope",
  ),
  folder_prefixes_to_ignore: z.array(z.string()).describe(
      "Exact approved folder paths or exact current_path prefixes visible in the tree that the user wants left alone",
  ),
  filename_patterns: z.array(z.string()).describe(
      "Case-insensitive filename substrings explicitly implied by the request, like 'tax' or 'receipt'",
  ),
  extensions: z.array(z.string()).describe(
      "Lowercased file extensions without dots, like 'pdf' or 'jpg'",
  ),
  explicit_file_hints: z.array(z.string()).describe(
      "Exact filenames the user explicitly named, preserving the visible filename text",
  ),
  prefers_folder_operation: z.boolean().describe(
      "True when the user is asking to create, rename, merge, or delete folders instead of revising file actions",
  ),
  unclear: z.boolean().describe(
      "True when the request does not bind to any observable folder, file, or extension in the provided context",
  ),
  summary: z.string().describe("Short explanation of the inferred scope or the clarification needed"),
});

type ScopePlanRevisionResult = z.infer<typeof ScopePlanRevisionSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/o4-mini",
  temperature: 0.1,
  prompt: `You scope a Google Drive plan-review revision before any per-file edits happen.

You will receive:
- The approved folder tree with file counts.
- The original current-path tree with file counts.
- A few sample filenames per proposed folder.
- Any folders already marked ignored.
- The user's reply.

Your job:
- Output scope criteria only. Do not revise files or folders.

Rules:
- folder_prefixes_in_scope entries must be exact folder paths that are visible in the provided tree context.
- folder_prefixes_to_ignore entries must be exact folder paths that are visible in the provided tree context.
- A prefix may be either an approved folder path or a current_path prefix shown in the tree.
- Never invent folders or filenames.
- Empty arrays are valid.
- Use filename_patterns for semantic filename constraints like "tax", "receipt", "contract", or "2024".
- Use explicit_file_hints only for filenames the user explicitly names.
- Use extensions as lowercase strings without the leading dot.
- Set prefers_folder_operation=true when the user asks to create, rename, merge, split, move, or delete folders.
- Set unclear=true when the request cannot be tied to any observable folder, file, or extension from the supplied context.
- summary should be concise and user-facing.`,
};

export {
  prompt,
  ScopePlanRevisionSchema,
  ScopePlanRevisionResult,
};
