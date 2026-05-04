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
- "Entity" here means a company, organization, or institution (e.g. employer, client company, bank, school, government agency, named legal matter tied to such an organization). Individual people, family members, and personal contacts are NOT entities — do not create folders named after individuals. Place documents about individuals into a generic category folder (e.g. a personal/medical/tax/correspondence root) instead.
- Do not nest one named entity inside a different named entity. If the file's primary entity is not yet present in the Approved Directory Tree, extend the closest non-entity ancestor (any entry whose description begins with "(category root" or any path that is itself a generic category rather than a named entity) with a new sibling entity folder. Never use a named entity's folder as a parent for unrelated entities.
- Prefer the most specific approved child whose entity matches the file's subject. Only target a category-root ancestor when you are creating a new entity sibling beneath it; if the file's entity already has its own approved folder, extend that folder instead.
- A "matter-scoped" approved folder is one whose deepest segment names a specific individual, episode, case, incident, or one-off matter (rather than a company, organization, or institution). A matter-scoped folder is NOT a catch-all for unrelated documents that share a person, period, or general category. Only place a file in a matter-scoped folder when the file's subject is clearly that exact matter. If the file is about an individual but not that specific matter, place it in the closest non-matter-scoped category root instead.
- When creating a new_directory for an entity, the deepest segment must be the entity name only — do not append descriptors, document types, statuses, or years to that segment. Use deeper child folders for those sub-categories instead.
- Only create a new_directory when (a) the file's contents or filename clearly identifies a specific named company, organization, or institution, AND (b) no existing entry in the Approved Directory Tree already represents that entity by case-insensitive name match against any folder segment in the tree. Do not create folders from document descriptors such as document type, action, status, or topic (for example "Receipts", "Shipping", "Application Form", "Diploma Request"), and do not create folders named after individual people. If the entity already appears anywhere in the approved tree, reuse that approved folder instead of creating a duplicate. Single one-off documents without a named organization should land in the closest approved parent, not in a folder created for that one document.

Choosing the root:
- The leading segments of current_path are source folder names, not categories. Do not map a generic top-level word ("Business", "Personal", "Documents", etc.) to an approved root with the same name. Pick the root from the file's actual subject (current_name, deeper path segments, file contents).

Preserving vs dropping the deepest source subfolder:
- Preserve it as a new_directory when it names a stable grouping tied to a company, organization, or institution — a client company, project, legal matter, account, season, year, or an opaque code that plausibly groups sibling files. Do not preserve a subfolder solely because it is named after an individual person; treat that as a generic container and drop it.
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

Example 4 (sibling entity under a category root):
- Approved Directory Tree:
  - 02-Business: (category root — extend with new entity sibling)
  - 02-Business/AcmeCo: AcmeCo active business
- File:
  - Current Path: Business/Old/FooHoldings/Banking
  - Name: 2024.06.10 - Wire Instructions.pdf
- Answer:
  - action: "move"
  - target_directory: "02-Business"
  - needs_new_directory: true
  - new_directory.folder_path: "02-Business/FooHoldings"

Reasoning: FooHoldings is a different entity from AcmeCo, so it must NOT be nested under 02-Business/AcmeCo. The category root 02-Business is a legal extension target; create FooHoldings as a sibling of AcmeCo there. The deepest new-folder segment is the entity name only ("FooHoldings"), not "FooHoldings Banking 2024".

Example 5 (do NOT create a folder for a single one-off document):
- Approved Directory Tree:
  - 03-Personal: personal documents
- File:
  - Current Path: OLD
  - Name: shipping-receipt.pdf
- Answer:
  - action: "move"
  - target_directory: "03-Personal"
  - needs_new_directory: false
  - new_directory: null

Reasoning: "shipping-receipt" is a document descriptor, not a named entity. The source path "OLD" provides no grouping signal. Place the file in the closest approved parent, 03-Personal, without creating a folder for a one-off document.

Example 6 (do NOT place an unrelated personal document in a matter-scoped folder):
- Approved Directory Tree:
  - 03-Personal: personal documents
  - 03-Personal/SpringTrip2024: documents from a specific 2024 trip
- File:
  - Current Path: Government Docs/IDs
  - Name: drivers-licence.pdf
- Answer:
  - action: "move"
  - target_directory: "03-Personal"
  - needs_new_directory: false
  - new_directory: null

Reasoning: 03-Personal/SpringTrip2024 is a matter-scoped folder for one specific trip. A driver's license is a general personal ID document, not specific to that trip. Even though both are "personal," the matter-scoped folder is not a catch-all — the file belongs in the broader 03-Personal category root.

Return JSON only.`,
};

export {prompt, ProposePlacementSchema, ProposePlacementResult};
