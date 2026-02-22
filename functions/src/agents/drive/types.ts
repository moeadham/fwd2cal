import {z} from "zod";

// ============================================================================
// ZOD SCHEMAS
// ============================================================================

// LLM file placement result for a single file
export const FilePlacementItemSchema = z.object({
  file_index: z.number().describe("The 0-based index of the file from the input list"),
  folder_id: z.string().describe("The Google Drive folder ID where the file should be placed"),
  folder_path: z.string().describe(
      "The human-readable path of the chosen folder (e.g., 'Documents/Work/Projects')",
  ),
  suggested_name: z.string().describe(
      "A unique, descriptive filename without extension, ALWAYS prefixed with " +
      "YYYY.MM.DD date (e.g., '2024.03.15 Amazon Invoice Laptop')",
  ),
  reason: z.string().describe("Brief reasoning for why this folder and name were chosen"),
});

export type FilePlacementItem = z.infer<typeof FilePlacementItemSchema>;

// Batch placement result for all files in one email
export const BatchFilePlacementSchema = z.object({
  placements: z.array(FilePlacementItemSchema).describe("Placement decision for each file"),
});

export type BatchFilePlacement = z.infer<typeof BatchFilePlacementSchema>;

// Keep single-file alias for backward compatibility
export const FilePlacementSchema = FilePlacementItemSchema;
export type FilePlacement = FilePlacementItem;

// File proposal result (Phase 1 — before Drive access)
export const FileProposalItemSchema = z.object({
  file_index: z.number().describe("The 0-based index of the file from the input list"),
  suggested_name: z.string().describe(
      "A descriptive filename with extension, ALWAYS prefixed with " +
      "YYYY.MM.DD date (e.g., '2024.03.15 Amazon Invoice Laptop.pdf')",
  ),
  reason: z.string().describe("Brief reasoning for the suggested name"),
});

export const FileProposalSchema = z.object({
  folder_name: z.string().describe(
      "Folder name with numeric prefix (e.g., '001-Invoices'). Reuse an existing agent folder if the category matches.",
  ),
  is_existing_folder: z.boolean().describe(
      "True if reusing a previously created agent folder, false if suggesting a new one",
  ),
  proposals: z.array(FileProposalItemSchema).describe("Naming proposal for each file"),
});

export type FileProposal = z.infer<typeof FileProposalSchema>;

// Move instruction result (reply handler)
export const MoveInstructionItemSchema = z.object({
  file_index: z.number().describe("The 0-based index of the file to move"),
  folder_id: z.string().describe(
      "The Google Drive folder ID to move to, or 'root' for a new folder",
  ),
  folder_path: z.string().describe(
      "The folder path to move to (new folder name if folder_id is 'root')",
  ),
  reason: z.string().describe("Brief reasoning for the move"),
});

export const MoveInstructionSchema = z.object({
  moves: z.array(MoveInstructionItemSchema).describe("Move instruction for each file"),
});

export type MoveInstruction = z.infer<typeof MoveInstructionSchema>;

// ============================================================================
// DRIVE TYPES
// ============================================================================

// Drive folder for building the tree
export interface DriveFolder {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  children: DriveFolder[];
}

// Attachment downloaded from Resend for Drive upload
export interface DriveAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer | null;
  downloadUrl: string;
}

// Result of processing a single file
export interface ProcessedDriveFile {
  filename: string;
  folderPath: string;
  suggestedName: string;
  driveFileId?: string;
  driveWebLink?: string;
  error?: string;
}

// Overall result from the drive handler
export interface DriveProcessingResult {
  filesProcessed: number;
  filesSucceeded: number;
  filesFailed: number;
  results: ProcessedDriveFile[];
  error?: string;
}

// ============================================================================
// LLM TYPES
// ============================================================================

// Prompt configuration (mirrors calendar pattern)
export interface DrivePromptConfig {
  model: string;
  prompt: string;
}

export interface DrivePrompts {
  pickFilePlacement: DrivePromptConfig;
  proposeFilePlacement: DrivePromptConfig;
  interpretMoveInstructions: DrivePromptConfig;
}

// ============================================================================
// MAIL TEMPLATE TYPES
// ============================================================================

export interface DriveMailTemplate {
  html: string;
  subject?: string;
}

export interface DriveMailTemplates {
  fileUploaded: DriveMailTemplate;
  multipleFilesUploaded: DriveMailTemplate;
  fileProposal: DriveMailTemplate;
  multipleFileProposal: DriveMailTemplate;
  fileMoved: DriveMailTemplate;
  driveAuthFailed: DriveMailTemplate;
  noAttachments: DriveMailTemplate;
  notDriveUser: DriveMailTemplate;
  uploadFailed: DriveMailTemplate;
}

// ============================================================================
// EMBEDDED DATA (carried in email HTML for reply/move detection)
// ============================================================================

export interface DriveEmbeddedFileData {
  id: string;
  folderId: string;
  folderPath: string;
  filename: string;
  webLink: string;
}

export interface DriveEmbeddedData {
  files: DriveEmbeddedFileData[];
}
