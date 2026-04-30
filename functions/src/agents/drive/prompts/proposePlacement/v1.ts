/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig, OrganizeFolderSchema} from "../../types";

const ProposePlacementSchema = z.object({
  file_id: z.string().describe("Google Drive file ID"),
  current_path: z.string().describe("Current folder path"),
  current_name: z.string().describe("Current filename"),
  target_directory: z.string().describe("Target folder path relative to My Drive"),
  action: z.enum(["move", "keep"]).describe("Placement action to take on this file"),
  needs_new_directory: z.boolean().describe("True if target_directory is not already sufficient"),
  new_directory: OrganizeFolderSchema.nullable().describe("Directory to add when needs_new_directory is true"),
  reason: z.string().describe("Brief reasoning for the placement"),
});

type ProposePlacementResult = z.infer<typeof ProposePlacementSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  temperature: 0.1,
  prompt: `You decide the placement for ONE Google Drive file. You receive the approved directory tree, the file's metadata, and the file's contents (extracted text from the document — not a summary; may be truncated for long files).

Rules:
- Return exactly one action.
  - "keep" only when current_path is already an exact entry in the Approved Directory Tree AND is the best destination.
  - "move" otherwise.
- target_directory must exactly match an Approved Directory Tree entry. If a more specific child is needed, set needs_new_directory to true and put the deeper path in new_directory.folder_path. new_directory must extend an existing approved entry.

Choosing the root:
- The leading segments of current_path are source folder names, not categories. Do not map a generic top-level word ("Business", "Personal", "Documents", etc.) to an approved root with the same name. Pick the root from the file's actual subject (current_name, deeper path segments, file contents).

Preserving vs dropping the deepest source subfolder:
- Preserve it as a new_directory when it names a stable grouping — a person, client, project, matter, vehicle, season, year, or an opaque code that plausibly groups sibling files.
- Drop it when it is a generic container ("New folder", "Misc", "Inbox", "scans"), purely structural (single letter or digit), already an approved entry, or reads as a draft/revision variant of its parent (child = parent plus a suffix or a modifier like "Final", "Draft", "Reply").
- Drop it when its meaning is already conveyed by the chosen target_directory — i.e., the segment expresses a status, era, or scope that the new root or its named child already implies (a legacy/inactive segment under an archive root, a year segment under a folder already scoped to that year, an active/current segment under a live-work root).
- When signals are mixed, lean toward preserving — losing a real grouping is worse than keeping a redundant one.

Filenames:
- A category-like prefix in the filename can justify a named sub-category, but new_directory must use the named category, never a bare numeric prefix.
- A date token in the filename alone is not a grouping signal. Only use a date-based subfolder when current_path already segments by date or an approved entry distinguishes a date-bounded period.

Few-shot examples:

Example 1 (preserve a meaningful subfolder):
- Approved Directory Tree:
  - Legal/Clients/AcmeCo: AcmeCo legal work
- File:
  - Current Path: AcmeCo/Matter Q
  - Name: hearing-notes.pdf
- Answer:
  - action: "move"
  - target_directory: "Legal/Clients/AcmeCo"
  - needs_new_directory: true
  - new_directory.folder_path: "Legal/Clients/AcmeCo/Matter Q"

Example 2 (drop an arbitrary container):
- Approved Directory Tree:
  - Personal/Receipts: receipts
- File:
  - Current Path: scans/from-phone
  - Name: 2026-04-10 coffee receipt.pdf
- Answer:
  - action: "move"
  - target_directory: "Personal/Receipts"
  - needs_new_directory: false
  - new_directory: null

Example 3 (drop a segment redundant with the target_directory):
- Approved Directory Tree:
  - 07-Archive/AcmeCo: legacy AcmeCo materials
- File:
  - Current Path: Business/Old/AcmeCo/Banking
  - Name: account-form.pdf
- Answer:
  - action: "move"
  - target_directory: "07-Archive/AcmeCo"
  - needs_new_directory: true
  - new_directory.folder_path: "07-Archive/AcmeCo/Banking"

Return JSON only.`,
};

export {prompt, ProposePlacementSchema, ProposePlacementResult};
