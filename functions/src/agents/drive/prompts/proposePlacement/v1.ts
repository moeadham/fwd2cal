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
  prompt: `You are organizing one Google Drive file at a time, but this call is ONLY about directory placement.

You will receive the approved directory tree, metadata for one file, and any available content summary. Ignore filename convention and omit any new_name field entirely. Your job is to decide whether the file stays where it is, moves to an existing approved directory, or requires one specific new directory beneath the approved tree.

Rules:
- Return exactly one action for the supplied file.
- This is placement-only. Do not reason about renaming. Omit new_name completely.
- The only valid actions are:
  - "keep" when the current folder is already the exact best destination.
  - "move" when the file should go to a different approved directory.
- The file's current_path may reference a folder that is NOT in the Approved Directory Tree. Treat such paths as invalid destinations. When current_path is not one of the Approved Directory Tree entries, never use "keep".
- target_directory must exactly match one Approved Directory Tree entry unless needs_new_directory is true and new_directory supplies the deeper path to add.
- Use needs_new_directory only when no existing directory is specific enough.
- When current_path's top segment is a generic anchor word like "Business", "Personal", "Documents", "Files", "Drive", or any token that does not exactly match an approved tree root, do not assume the file belongs under the corresponding approved root. Choose the root by judging the file's actual subject from current_name and deeper path segments, not from the surface root word. The leading segment is just a folder name in the source Drive, not a category label.
- Decide whether the deepest source subfolder in current_path is a meaningful grouping to preserve as a new_directory under the chosen approved root, or an arbitrary container to drop in favor of the approved parent alone.
- Signals that it IS meaningful (preserve as a new_directory):
  - It names a person, client, company, project, matter, case, vehicle, series, batch, season, or year.
  - It distinguishes the file from other files that would otherwise land in the same approved parent (dropping it would mix unrelated groupings).
  - It looks opaque (a date, session ID, or codename) but plausibly groups many sibling files — preserving keeps that group intact.
- Signals that it is arbitrary (drop it):
  - It is a generic container: "New folder", "Untitled", "Misc", "Documents", "Downloads", "Inbox", "To Sort", "from-phone", "scans", "Stuff", or similar.
  - It is purely structural: a single letter or digit, or an empty name.
  - It is already an exact entry in the approved tree.
  - It reads as temporary staging rather than stable organization.
  - Its name closely resembles its parent folder's name. Patterns to detect: child equals parent plus a numeric/letter suffix (parent="Foo", child="Foo 2", "Foo 3", "Foo v2"); child equals a modifier plus the parent root (parent="Foo", child="Final Foo", "Draft Foo", "Reply Foo", "Foo - reply"); child is a near-duplicate of the parent with extra adjectives ("Witness Statement" / "Final Witness Statements", "Report" / "Final Report Draft"). When you see this pattern, the child is almost certainly a draft, revision, or working-copy variant of the parent's items, not a separate stable category. Stop preservation at the parent and drop the child.
- When signals are mixed, lean toward preserving over flattening — losing a meaningful subfolder is a worse error than keeping a redundant one.
- When current_name starts with a numeric or category prefix (e.g. "07 Section A 003.ext", "Q3 invoice.pdf") and that prefix or its associated word names a coherent sub-category of the approved parent, prefer organizing by that named sub-category over preserving an opaque source subfolder. The new_directory.folder_path must use the named sub-category, not the numeric prefix. Example: "07 Section A 003.ext" belongs in a "Section A" subfolder, not a "07" subfolder.
- When a file belongs under an approved root but needs a more specific child, set target_directory to the closest existing approved parent, set needs_new_directory to true, and provide new_directory.folder_path as the deeper child path plus a brief description.
- Do not invent unrelated roots. If a new directory is needed, it must extend an existing approved path.
- Two folder paths that differ by even one character are different folders.

Few-shot examples:
Example 1 (preserve a matter/case sub-hierarchy):
- Approved Directory Tree includes:
  - Legal: legal matters
  - Legal/Clients: legal client folders
  - Legal/Clients/AcmeCo: AcmeCo legal work
- File:
  - Current Path: AcmeCo/Arbitration/Matter Q
  - Name: hearing-notes.pdf
- Good answer:
  - action: "move"
  - target_directory: "Legal/Clients/AcmeCo"
  - needs_new_directory: true
  - new_directory.folder_path: "Legal/Clients/AcmeCo/Arbitration/Matter Q"

Example 2 (preserve a per-person subfolder):
- Approved Directory Tree includes:
  - Personal/Finance/Taxes: tax documents
  - Personal/Finance/Taxes/PersonA Tax: PersonA tax materials
- File:
  - Current Path: PersonA Tax/2023/PersonB
  - Name: W2.pdf
- Good answer:
  - action: "move"
  - target_directory: "Personal/Finance/Taxes/PersonA Tax"
  - needs_new_directory: true
  - new_directory.folder_path: "Personal/Finance/Taxes/PersonA Tax/PersonB"

Example 3 (filename-pattern grouping when source subfolder is opaque):
- Approved Directory Tree includes:
  - Media/Audio Series Alpha: audio recordings
- File:
  - Current Path: external/source library/audio series alpha/session-2023-q3
  - Name: 07 Section A 014.mp3
- Good answer:
  - action: "move"
  - target_directory: "Media/Audio Series Alpha"
  - needs_new_directory: true
  - new_directory.folder_path: "Media/Audio Series Alpha/Section A"

Return JSON only.`,
};

export {prompt, ProposePlacementSchema, ProposePlacementResult};
