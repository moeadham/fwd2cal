import fs from "fs";
import os from "os";
import path from "path";
import {finished} from "stream/promises";
import {z} from "zod";
import {defaultCompletion} from "../src/util/openai";
import {ChatMessage} from "../src/util/types";
import {OrganizeFolderSchema} from "../src/agents/drive/types";
import {ProposeFileActionSchema} from "../src/agents/drive/prompts/proposeFileAction/v1";

const DEFAULT_CSV_PATH = "~/Downloads/proposal-dgUu19HrsDWgeIctGKYc - proposal-dgUu19HrsDWgeIctGKYc.csv";
const OUTPUT_DIR = path.join(__dirname, ".experiment-out");
const SAMPLE_SEED = 1;

const BUCKET_ORDER = [
  "audio_bible",
  "bitaccess_arbitration",
  "lisa_tax",
  "family_kids",
  "per_client_invoice",
  "visa",
  "new_top_level",
  "misc_bad",
  "good_regression",
] as const;

const SAMPLE_TARGETS: Record<BucketName, number> = {
  audio_bible: 15,
  bitaccess_arbitration: 10,
  lisa_tax: 5,
  family_kids: 10,
  per_client_invoice: 5,
  visa: 3,
  new_top_level: 5,
  misc_bad: 5,
  good_regression: 5,
};

const V1_BASELINE = `You are organizing one Google Drive file at a time.

You will receive the current evolving directory tree, the approved filename convention, metadata for one file, and any available content summary. Some requests may also include attached images: either rendered document pages or the file itself when the file is an image. Use both the text summary and any attached images for content-aware placement and filename decisions. Pick the best target directory and filename.

Rules:
- Return exactly one action for the supplied file.
- Use the approved filename convention and preserve the file extension when possible.
- When images are attached, inspect them for text and visible content, and use that evidence to improve both folder placement and new_name.
- Use needs_new_directory only when no existing directory fits.
- If adding a directory, include new_directory with folder_path and description.
- The file's current_path may reference a folder that is NOT in the Approved Directory Tree (for example, leftover from a prior organize run). Treat such paths as invalid destinations. When current_path is not one of the Approved Directory Tree entries, you MUST emit "move" or "move_and_rename" — never "keep" or "rename".
- target_directory must exactly match one of the Approved Directory Tree entries, unless supplied via new_directory with needs_new_directory: true. Do not invent paths. Two folder paths that differ by even one character (hyphens vs. spaces vs. pipes) are DIFFERENT folders.
- Choosing the action:
  - "keep" — ONLY when BOTH the folder and filename already match the approved system exactly. Never use "keep" when current_path is not in the Approved Directory Tree. If in doubt, do not use "keep".
  - "rename" — when the file is already in the correct target folder but the filename does not match the approved convention.
  - "move" — only when the file needs a folder change AND the current filename already matches the approved convention exactly.
  - "move_and_rename" — when the file needs both a folder change and a filename update. This is the DEFAULT action for most files — assume the filename needs to match the convention unless it already does.
- Whenever the current filename does not already match the approved filename convention, the action MUST be "rename" or "move_and_rename". Never return "move" or "keep" when the filename needs updating.`;

const V2_PLACEMENT = `You are organizing one Google Drive file at a time, but this experiment is ONLY about directory placement.

You will receive the approved directory tree and metadata for one file. Ignore filename convention and omit any new_name field entirely. Your job is to decide whether the file stays where it is, moves to an existing approved directory, or requires one specific new directory beneath the approved tree.

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

Return JSON only.`;

const PlacementOnlySchema = z.object({
  file_id: z.string().describe("Google Drive file ID"),
  current_path: z.string().describe("Current folder path"),
  current_name: z.string().describe("Current filename"),
  target_directory: z.string().describe("Target folder path relative to My Drive"),
  action: z.enum(["move", "keep"]).describe("Placement action to take on this file"),
  needs_new_directory: z.boolean().describe("True if target_directory is not already sufficient"),
  new_directory: OrganizeFolderSchema.nullable().describe("Directory to add when needs_new_directory is true"),
  reason: z.string().describe("Brief reasoning for the placement"),
});

type BucketName = typeof BUCKET_ORDER[number];
type PlacementOnlyResult = z.infer<typeof PlacementOnlySchema>;
type BaselineResult = z.infer<typeof ProposeFileActionSchema>;
type PromptLabel = "v1_baseline" | "v2_placement";

interface CsvRow {
  file_id: string;
  current_path: string;
  current_name: string;
  new_folder: string;
  result: string;
  whereItShouldBe: string;
  reason: string;
  created: string;
  size: string;
  mimeType: string;
}

interface ApprovedFolder {
  folder_path: string;
  description: string;
}

interface SampleRow {
  bucket: BucketName;
  row: CsvRow;
}

interface VariantCapture {
  prompt_label: PromptLabel;
  target_directory: string | null;
  action: string | null;
  needs_new_directory: boolean | null;
  new_directory: ApprovedFolder | null;
  reason: string | null;
  error: string | null;
}

function expandHomePath(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        i++;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\r") {
      if (next === "\n") {
        i++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error("CSV parse error: unmatched quote");
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function getCell(record: Record<string, string>, ...headers: string[]): string {
  for (const header of headers) {
    const value = record[normalizeHeader(header)];
    if (value !== undefined) {
      return value.trim();
    }
  }
  return "";
}

function loadCsvRows(csvPath: string): CsvRow[] {
  const raw = fs.readFileSync(csvPath, "utf8");
  const matrix = parseCsv(raw);
  if (matrix.length === 0) {
    return [];
  }

  const headers = matrix[0].map(normalizeHeader);
  const rows: CsvRow[] = [];

  for (const values of matrix.slice(1)) {
    if (values.every((value) => value.trim() === "")) {
      continue;
    }

    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? "";
    });

    const result = getCell(record, "Result");
    if (!result) {
      continue;
    }

    rows.push({
      file_id: getCell(record, "file_id", "File ID"),
      current_path: getCell(record, "current_path", "Current Path"),
      current_name: getCell(record, "current_name", "Current Name", "Name"),
      new_folder: getCell(record, "new_folder", "New Folder"),
      result,
      whereItShouldBe: getCell(record, "Where it Should be"),
      reason: getCell(record, "reason", "Reason"),
      created: getCell(record, "Created", "created", "Created Time"),
      size: getCell(record, "Size", "size"),
      mimeType: getCell(record, "MIME Type", "mime_type", "Mime Type"),
    });
  }

  return rows;
}

function extractApprovedFoldersFromUnknown(data: unknown): ApprovedFolder[] | null {
  const candidates: unknown[] = [];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    candidates.push(obj.proposed_folders);
    candidates.push(obj.approved_folders);
    candidates.push(obj.proposal);
    candidates.push(obj.proposal && typeof obj.proposal === "object" ? (obj.proposal as Record<string, unknown>).proposed_folders : null);
    candidates.push(obj.phaseData);
    const phaseData = obj.phaseData && typeof obj.phaseData === "object" ? obj.phaseData as Record<string, unknown> : null;
    const directoryLayout = phaseData?.directoryLayout && typeof phaseData.directoryLayout === "object" ?
      phaseData.directoryLayout as Record<string, unknown> :
      null;
    candidates.push(directoryLayout?.approvedStructure);
    candidates.push(directoryLayout?.proposedStructure);
  }

  for (const candidate of candidates) {
    const parsed = z.array(OrganizeFolderSchema).safeParse(candidate);
    if (parsed.success) {
      return parsed.data;
    }
  }

  return null;
}

function loadApprovedFolders(proposalJsonPath: string): ApprovedFolder[] {
  const raw = fs.readFileSync(proposalJsonPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const approved = extractApprovedFoldersFromUnknown(parsed);
  if (approved) {
    return approved;
  }

  const keys = parsed && typeof parsed === "object" ? Object.keys(parsed as Record<string, unknown>) : [];
  console.error(
      "Proposal JSON is missing an approved folders field. Top-level keys: " +
      `${keys.length > 0 ? keys.join(", ") : "(none)"}`,
  );
  process.exit(1);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function bucketRow(row: CsvRow): BucketName {
  const currentPath = row.current_path.toLowerCase();
  const where = row.whereItShouldBe.toLowerCase();
  const result = row.result.toLowerCase();

  if (currentPath.includes("bible king james")) {
    return "audio_bible";
  }
  if (currentPath.includes("bitaccess") && (currentPath.includes("arbitration") || currentPath.includes("buyout dispute"))) {
    return "bitaccess_arbitration";
  }
  if (currentPath.includes("lisa tax")) {
    return "lisa_tax";
  }
  if (where === "family") {
    return "family_kids";
  }
  if (where.includes("what company") || where.includes("wrong company")) {
    return "per_client_invoice";
  }
  if (where.includes("visa") || currentPath.includes("visa")) {
    return "visa";
  }
  if (/(^|[^a-z])(vehicles|watches|projects|travel|cypherpunk)([^a-z]|$)/i.test(row.whereItShouldBe)) {
    return "new_top_level";
  }
  if (result === "good") {
    return "good_regression";
  }
  return "misc_bad";
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const output = [...items];
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  for (let i = output.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }

  return output;
}

function sampleRows(rows: CsvRow[]): SampleRow[] {
  const byBucket = new Map<BucketName, CsvRow[]>();
  const seenFileIds = new Set<string>();

  for (const row of rows) {
    if (!row.file_id || seenFileIds.has(row.file_id)) {
      continue;
    }
    seenFileIds.add(row.file_id);
    const bucket = bucketRow(row);
    const bucketRows = byBucket.get(bucket) || [];
    bucketRows.push(row);
    byBucket.set(bucket, bucketRows);
  }

  const samples: SampleRow[] = [];
  BUCKET_ORDER.forEach((bucket, index) => {
    const bucketRows = byBucket.get(bucket) || [];
    const shuffled = seededShuffle(bucketRows, SAMPLE_SEED + index);
    const picked = shuffled.slice(0, SAMPLE_TARGETS[bucket]);
    picked.forEach((row) => samples.push({bucket, row}));
  });
  return samples;
}

function formatApprovedTree(folders: ApprovedFolder[]): string {
  if (folders.length === 0) {
    return "(none)";
  }
  return folders
      .map((folder) => `- ${folder.folder_path}: ${folder.description}`)
      .join("\n");
}

function formatFileBlock(row: CsvRow): string {
  const created = row.created || "(none)";
  const size = row.size ? `${row.size} bytes` : "(none)";
  const mimeType = row.mimeType || "(none)";
  return `## File
ID: ${row.file_id}
Name: ${row.current_name}
Current Path: ${row.current_path}
MIME Type: ${mimeType}
Created: ${created}
Size: ${size}
`;
}

function renderUserMessage(approvedFolders: ApprovedFolder[], row: CsvRow): string {
  return `## Approved Directory Tree
${formatApprovedTree(approvedFolders)}

## Filename Convention
YYYY.MM.DD - Description.ext

${formatFileBlock(row)}`;
}

function normalizeCaptureResult(result: BaselineResult | PlacementOnlyResult, promptLabel: PromptLabel): VariantCapture {
  return {
    prompt_label: promptLabel,
    target_directory: result.target_directory,
    action: result.action,
    needs_new_directory: result.needs_new_directory,
    new_directory: result.new_directory ?
      {
        folder_path: result.new_directory.folder_path,
        description: result.new_directory.description,
      } :
      null,
    reason: result.reason,
    error: null,
  };
}

async function runVariant(
    promptLabel: PromptLabel,
    promptText: string,
    schema: z.ZodTypeAny,
    userText: string,
): Promise<VariantCapture> {
  try {
    const messages: ChatMessage[] = [
      {role: "system", content: promptText},
      {role: "user", content: userText},
    ];
    const completion = await defaultCompletion(messages, "openai/gpt-4.1-mini", 0.1, schema, null);
    return normalizeCaptureResult(
        completion as BaselineResult | PlacementOnlyResult,
        promptLabel,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      prompt_label: promptLabel,
      target_directory: null,
      action: null,
      needs_new_directory: null,
      new_directory: null,
      reason: null,
      error: message,
    };
  }
}

function formatDirectoryChoice(result: VariantCapture): string {
  const target = result.target_directory || "(none)";
  const newDirectory = result.new_directory?.folder_path || "(none)";
  return `${target} | new: ${newDirectory}`;
}

function printBucketSection(
    bucket: BucketName,
    rows: SampleRow[],
    results: Map<string, Record<PromptLabel, VariantCapture>>,
): void {
  console.log(`\n=== ${bucket} (${rows.length}) ===`);
  rows.forEach(({row}) => {
    const variants = results.get(row.file_id);
    const v1 = variants?.v1_baseline;
    const v2 = variants?.v2_placement;
    console.log(`file_id: ${row.file_id}`);
    console.log(`current_path: ${row.current_path || "(empty)"}`);
    console.log(`current_name: ${row.current_name || "(empty)"}`);
    console.log(`where_it_should_be: ${row.whereItShouldBe || "(empty)"}`);
    console.log(`csv_new_folder: ${row.new_folder || "(empty)"}`);
    console.log(`v1: ${v1 ? formatDirectoryChoice(v1) : "(missing)"}`);
    if (v1?.error) {
      console.log(`v1_error: ${v1.error}`);
    }
    console.log(`v2: ${v2 ? formatDirectoryChoice(v2) : "(missing)"}`);
    if (v2?.error) {
      console.log(`v2_error: ${v2.error}`);
    }
    console.log("");
  });
}

function writeJsonlRecord(stream: fs.WriteStream, row: CsvRow, bucket: BucketName, variant: VariantCapture): void {
  const record = {
    file_id: row.file_id,
    current_path: row.current_path,
    current_name: row.current_name,
    bucket,
    where_it_should_be: row.whereItShouldBe,
    csv_new_folder: row.new_folder,
    csv_result: row.result,
    prompt_label: variant.prompt_label,
    target_directory: variant.target_directory,
    action: variant.action,
    needs_new_directory: variant.needs_new_directory,
    new_directory_folder_path: variant.new_directory?.folder_path || null,
    new_directory_description: variant.new_directory?.description || null,
    reason: variant.reason,
    error: variant.error,
  };
  stream.write(`${JSON.stringify(record)}\n`);
}

function isStrictlyDeeper(parentPath: string | null, childPath: string | null): boolean {
  if (!parentPath || !childPath) {
    return false;
  }
  const parent = normalizePath(parentPath);
  const child = normalizePath(childPath);
  return child.startsWith(`${parent}/`);
}

function printSummary(rows: SampleRow[], results: Map<string, Record<PromptLabel, VariantCapture>>): void {
  console.log("\n=== summary ===");
  BUCKET_ORDER.forEach((bucket) => {
    const bucketRows = rows.filter((entry) => entry.bucket === bucket);
    let deeperCount = 0;
    bucketRows.forEach(({row}) => {
      const variants = results.get(row.file_id);
      const v1 = variants?.v1_baseline;
      const v2 = variants?.v2_placement;
      if (
        v2?.needs_new_directory === true &&
        isStrictlyDeeper(v1?.target_directory || null, v2.new_directory?.folder_path || null)
      ) {
        deeperCount++;
      }
    });
    console.log(`${bucket}: ${deeperCount}/${bucketRows.length}`);
  });
}

async function main(): Promise<void> {
  requireEnv("OPENROUTER_API_KEY");
  const proposalJsonPath = expandHomePath(requireEnv("EXPERIMENT_PROPOSAL_JSON"));
  const csvPath = expandHomePath(process.argv[2] || DEFAULT_CSV_PATH);

  const approvedFolders = loadApprovedFolders(proposalJsonPath);
  const csvRows = loadCsvRows(csvPath);
  const samples = sampleRows(csvRows);

  fs.mkdirSync(OUTPUT_DIR, {recursive: true});
  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  const outputPath = path.join(OUTPUT_DIR, `${timestamp}.jsonl`);
  const stream = fs.createWriteStream(outputPath, {flags: "a"});

  const results = new Map<string, Record<PromptLabel, VariantCapture>>();

  // Shared running tree (option 2): both variants see the same tree on each iteration.
  // Only v2_placement's new_directory proposals get pushed back. Mirrors production
  // sequential update at handlers/organizeExecution.ts:265-294.
  const runningTree: ApprovedFolder[] = approvedFolders.map((f) => ({...f}));
  const treePathSet = new Set(runningTree.map((f) => f.folder_path));
  const initialTreeSize = runningTree.length;

  for (const sample of samples) {
    const userText = renderUserMessage(runningTree, sample.row);
    const variants: Record<PromptLabel, VariantCapture> = {
      v1_baseline: await runVariant("v1_baseline", V1_BASELINE, ProposeFileActionSchema, userText),
      v2_placement: await runVariant("v2_placement", V2_PLACEMENT, PlacementOnlySchema, userText),
    };
    results.set(sample.row.file_id, variants);

    if (variants.v1_baseline.error) {
      console.error(`[${sample.row.file_id}] v1_baseline error: ${variants.v1_baseline.error}`);
    }
    if (variants.v2_placement.error) {
      console.error(`[${sample.row.file_id}] v2_placement error: ${variants.v2_placement.error}`);
    }

    const v2 = variants.v2_placement;
    if (
      !v2.error &&
      v2.needs_new_directory &&
      v2.new_directory &&
      v2.new_directory.folder_path &&
      !treePathSet.has(v2.new_directory.folder_path)
    ) {
      runningTree.push({
        folder_path: v2.new_directory.folder_path,
        description: v2.new_directory.description || "",
      });
      treePathSet.add(v2.new_directory.folder_path);
    }

    writeJsonlRecord(stream, sample.row, sample.bucket, variants.v1_baseline);
    writeJsonlRecord(stream, sample.row, sample.bucket, variants.v2_placement);
  }

  console.log(`Running tree grew from ${initialTreeSize} to ${runningTree.length} folders (${runningTree.length - initialTreeSize} added by v2).`);

  stream.end();
  await finished(stream);

  BUCKET_ORDER.forEach((bucket) => {
    const bucketRows = samples.filter((sample) => sample.bucket === bucket);
    printBucketSection(bucket, bucketRows, results);
  });

  printSummary(samples, results);
  console.log(`\nJSONL written to ${outputPath}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
