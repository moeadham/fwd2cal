import {z} from "zod";

// ============================================================================
// ZOD SCHEMAS
// ============================================================================

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
      "Folder name with numeric prefix (e.g., '01-Invoices'). Reuse an existing agent folder if the category matches.",
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
// ORGANIZE-DRIVE TYPES
// ============================================================================

// A single file or folder from Drive (flat list entry for full-drive scan)
export interface DriveFileEntry {
  id: string;
  name: string;
  mimeType: string;
  parentId: string | null;
  parentPath: string;
  createdTime: string;
  size: number;
  webViewLink: string;
  isFolder: boolean;
}

// Proposed folder in the new structure
export const OrganizeFolderSchema = z.object({
  folder_name: z.string().describe(
      "Folder name with NN - Category format (e.g., '01 - Personal', '02 - Work')",
  ),
  description: z.string().describe("Brief description of what this folder contains"),
  subfolders: z.array(z.object({
    subfolder_name: z.string().describe("Subfolder name"),
    description: z.string().describe("Brief description"),
  })).nullable().describe("Optional subfolders within this category, null if none"),
});

// Proposed action for a single file
export const OrganizeFileActionSchema = z.object({
  file_id: z.string().describe("Google Drive file ID"),
  current_name: z.string().describe("Current filename"),
  current_path: z.string().describe("Current folder path"),
  new_name: z.string().describe(
      "Proposed new filename in YYYY.MM.DD - description.ext format",
  ),
  new_folder: z.string().describe(
      "Target folder name (NN - Category or NN - Category/Subfolder)",
  ),
  action: z.enum(["move", "rename", "move_and_rename", "keep"]).describe(
      "What action to take on this file",
  ),
  reason: z.string().describe("Brief reasoning"),
});

// Full reorganization proposal
export const DriveOrganizeProposalSchema = z.object({
  proposed_folders: z.array(OrganizeFolderSchema).describe(
      "The proposed top-level folder structure",
  ),
  file_actions: z.array(OrganizeFileActionSchema).describe(
      "Proposed action for each file in the drive",
  ),
  summary: z.string().describe(
      "Brief natural-language summary of the proposed changes",
  ),
});

export type DriveOrganizeProposal = z.infer<typeof DriveOrganizeProposalSchema>;

// Organize processing result
export interface OrganizeProcessingResult {
  totalFiles: number;
  filesToMove: number;
  filesToRename: number;
  totalCost: number;
  proposalSent: boolean;
  error?: string;
}

// Cost calculation result
export interface OrganizeCostBreakdown {
  totalFiles: number;
  filesToMove: number;
  filesToRename: number;
  filesToKeep: number;
  costPerFile: number;
  totalCost: number;
}

// Organize proposal stored in Firestore
export interface OrganizeProposalDoc {
  uid: string;
  senderEmail: string;
  emailId: string;
  status: "pending" | "approved" | "executing" | "completed" | "undone";
  createdAt: string;
  expiresAt: string;
  proposal: DriveOrganizeProposal;
  cost: OrganizeCostBreakdown;
  snapshot?: OrganizeSnapshotAction[];
  completedAt?: string;
}

// Snapshot for undo (stored in Firestore)
export interface OrganizeSnapshotAction {
  fileId: string;
  originalName: string;
  originalParentId: string;
  originalParentPath: string;
  newName?: string;
  newParentId?: string;
}

export interface OrganizeSnapshot {
  uid: string;
  timestamp: string;
  actions: OrganizeSnapshotAction[];
}

// Embedded data for organize proposal (in email HTML)
export interface OrganizeEmbeddedData {
  proposalId: string;
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
  proposeFilePlacement: DrivePromptConfig;
  interpretMoveInstructions: DrivePromptConfig;
  proposeOrganization: DrivePromptConfig;
  consolidateSummaries: DrivePromptConfig;
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
  multipleFilesMoved: DriveMailTemplate;
  driveAuthFailed: DriveMailTemplate;
  noAttachments: DriveMailTemplate;
  uploadFailed: DriveMailTemplate;
  moveFailed: DriveMailTemplate;
  organizeAuthRequired: DriveMailTemplate;
  organizeProposal: DriveMailTemplate;
  organizeError: DriveMailTemplate;
  organizeNoFiles: DriveMailTemplate;
  organizeComplete: DriveMailTemplate;
  organizeUndone: DriveMailTemplate;
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

// Reference embedded in email HTML (only the Firestore doc ID)
export interface DriveEmbeddedData {
  fileDataId: string;
}

// Full file data stored in Firestore (DriveFileData collection)
export interface DriveFileDataDoc {
  uid: string;
  files: DriveEmbeddedFileData[];
  createdAt: string;
  expiresAt: string;
}

// ============================================================================
// FILE INFO (used by LLM proposal)
// ============================================================================

export interface FileInfo {
  fileName: string;
  mimeType: string;
  fileSize: number;
  contentSummary: string;
}

// ============================================================================
// DISPATCH TYPES (used by routes + dispatchHandler)
// ============================================================================

export interface PostAuthTaskData {
  emailId: string;
  uid: string;
  organize?: boolean;
  proposal?: FileProposal;
}

export interface OrganizeActionTaskData {
  proposalId: string;
  action: string;
  emailId: string;
}
