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
      "A unique, descriptive filename without extension (e.g., '2024-03-15 Amazon Invoice Laptop')",
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
  driveAuthFailed: DriveMailTemplate;
  noAttachments: DriveMailTemplate;
  notDriveUser: DriveMailTemplate;
  uploadFailed: DriveMailTemplate;
}
