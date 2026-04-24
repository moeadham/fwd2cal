import {z} from "zod";

// ============================================================================
// ZOD SCHEMAS
// ============================================================================

// File proposal result (Phase 1 — before Drive access)
export const FileProposalItemSchema = z.object({
  file_index: z.number().describe("The 0-based index of the file from the input list"),
  suggested_name: z.string().describe(
      "A descriptive filename with extension that follows the provided filename convention, " +
      "or the YYYY.MM.DD fallback when no convention is provided.",
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

export const GenerateFilenameExamplesSchema = z.object({
  examples: z.array(z.string()).length(3).describe(
      "Exactly three example filenames matching the convention, one per requested description, in order.",
  ),
});

export type GenerateFilenameExamplesResult = z.infer<typeof GenerateFilenameExamplesSchema>;

// Move instruction result (reply handler)
export const MoveInstructionItemSchema = z.object({
  file_index: z.number().describe("The 0-based index of the file to move"),
  action: z.enum(["move", "trash"]).describe(
      "Whether to move the file to a folder or trash it",
  ),
  folder_id: z.string().describe(
      "The Google Drive folder ID to move to, or 'root' for a new folder (ignored when action is 'trash')",
  ),
  folder_path: z.string().describe(
      "The folder path to move to (new folder name if folder_id is 'root') (ignored when action is 'trash')",
  ),
  reason: z.string().describe("Brief reasoning for the move"),
  new_filename: z.string().nullable().optional().describe(
      "New filename to rename the file to (including extension). Omit to keep current name.",
  ),
});

export const MoveInstructionSchema = z.object({
  moves: z.array(MoveInstructionItemSchema).describe("Move instruction for each file"),
  folder_convention_update: z.string().nullable().optional().describe(
      "New global folder naming convention requested by the user. Null/omit when there is no convention change.",
  ),
  filename_convention_update: z.string().nullable().optional().describe(
      "New global filename convention requested by the user. Null/omit when there is no convention change.",
  ),
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
  folder_path: z.string().describe(
      "Full folder path, e.g. '01-Personal' or '01-Personal/Medical/2024'",
  ),
  description: z.string().describe("Brief description of what this folder contains"),
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
      "Target folder path (e.g. '01-Work' or '01-Work/Clients/Acme')",
  ),
  action: z.enum(["move", "rename", "move_and_rename", "keep"]).describe(
      "What action to take on this file",
  ),
  reason: z.string().describe("Brief reasoning"),
});

// Full reorganization proposal
export const DriveOrganizeProposalSchema = z.object({
  proposed_folders: z.array(OrganizeFolderSchema).describe(
      "Flat list of all folder paths in the proposed structure",
  ),
  file_actions: z.array(OrganizeFileActionSchema).describe(
      "Proposed action for each file in the drive",
  ),
  ignoredFolders: z.array(z.string()).optional().describe(
      "Folder paths the user has marked as ignored; files under these stay put",
  ),
  summary: z.string().describe(
      "Brief natural-language summary of the proposed changes",
  ),
});

export type DriveOrganizeProposal = z.infer<typeof DriveOrganizeProposalSchema>;

export type OrganizePhase =
  "folder_preferences" |
  "directory_analysis" |
  "directory_placement" |
  "directory_additions" |
  "filename_convention" |
  "cost_estimate" |
  "plan_review" |
  "executing" |
  "completed";

export interface DirectoryMoveData {
  current_path: string;
  proposed_path: string;
  reason: string;
}

export interface DirectoryLayoutData {
  currentTreeSummary: string;
  userPrompt: string;
  folderConvention?: string;
  conventionDescription?: string;
  proposedStructure?: z.infer<typeof OrganizeFolderSchema>[];
  directoryMoves?: DirectoryMoveData[];
  approvedStructure?: z.infer<typeof OrganizeFolderSchema>[];
  addedDirectories?: string[];
  summary?: string;
  returnToCostEstimate?: boolean;
}

export interface FolderPreferencesData {
  detectedConvention?: string;
  suggestedConvention: string;
  confirmedConvention?: string;
  conventionDescription?: string;
  summary?: string;
  topLevelFolderNames?: string[];
}

export interface FilenameConventionData {
  convention: string;
  examples?: string[];
}

export interface CostEstimateData {
  totalFiles: number;
  textFiles: number;
  imageFiles: number;
  totalCost: number;
}

export interface ExecutionData {
  chunkSize: number;
  totalChunks: number;
  completedChunks: number;
}

export interface PlanReviewData {
  totalFiles: number;
  csvStoragePath: string;
  planStoragePath: string;
  fileActionsVersion: number;
  planEmailSentAt?: string;
}

export interface OrganizePhaseData {
  folderPreferences?: FolderPreferencesData;
  directoryLayout?: DirectoryLayoutData;
  filenameConvention?: FilenameConventionData;
  costEstimate?: CostEstimateData;
  execution?: ExecutionData;
  planReview?: PlanReviewData;
}

export interface DriveUserPreferences {
  folderConvention?: string;
  folderConventionDescription?: string;
  filenameConvention?: string;
  filenameConventionDescription?: string;
}

export const FolderOperationSchema = z.object({
  action: z.enum(["create", "rename", "merge", "delete", "preserve_source"]).describe(
      "Folder operation type",
  ),
  path: z.string().nullable().describe("Folder path used by create/delete; otherwise null"),
  description: z.string().nullable().describe("Folder description used by create/rename; otherwise null"),
  from: z.string().nullable().describe("Source folder path used by rename/merge; otherwise null"),
  to: z.string().nullable().describe("Destination folder path used by rename; otherwise null"),
  into: z.string().nullable().describe("Destination folder path used by merge; otherwise null"),
  source_path: z.string().nullable().describe("Original Drive folder path used by preserve_source; otherwise null"),
});

export const DriveOrganizeRevisionSchema = z.object({
  folder_operations: z.array(FolderOperationSchema).describe(
      "Ordered folder operations to apply to the current proposal",
  ),
  summary: z.string().describe("Brief natural-language summary of the revised changes"),
});

export type FolderOperation = z.infer<typeof FolderOperationSchema>;
export type DriveOrganizeRevision = z.infer<typeof DriveOrganizeRevisionSchema>;

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
  textFiles: number;
  imageFiles: number;
  costPerTextFile: number;
  costPerImageFile: number;
  totalCost: number;
}

// Organize proposal stored in Firestore (bulk data in GCS)
export interface OrganizeProposalDoc {
  uid: string;
  senderEmail: string;
  emailId: string;
  status: "generating" | "planning" | "pending" | "approved" | "executing" |
    "completed" | "failed" | "undone" | "cancelled";
  phase?: OrganizePhase;
  phaseData?: OrganizePhaseData;
  createdAt: string;
  expiresAt: string;
  storagePath: string;
  ignoredFolders?: string[];
  proposal?: DriveOrganizeProposal;
  cost?: OrganizeCostBreakdown;
  snapshot?: OrganizeSnapshotAction[];
  completedAt?: string;
  generationStartedAt?: string;
  attemptCount?: number;
  lastError?: string;
  proposalEmailSentAt?: string;
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
  temperature?: number;
}

export interface DrivePrompts {
  proposeFilePlacement: DrivePromptConfig;
  interpretMoveInstructions: DrivePromptConfig;
  reviseOrganization: DrivePromptConfig;
  setPreferences: DrivePromptConfig;
  detectFolderConvention: DrivePromptConfig;
  analyzeDirectoryStructure: DrivePromptConfig;
  evaluateDirectoryPlacement: DrivePromptConfig;
  finalizeDirectoryMap: DrivePromptConfig;
  classifyConventionChange: DrivePromptConfig;
  classifyFolderConventionChange: DrivePromptConfig;
  proposeFileAction: DrivePromptConfig;
  generateFilenameExamples: DrivePromptConfig;
  revisePlanFileActions: DrivePromptConfig;
  scopePlanRevision: DrivePromptConfig;
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
  fileTrashed: DriveMailTemplate;
  multipleFilesTrashed: DriveMailTemplate;
  driveAuthFailed: DriveMailTemplate;
  noAttachments: DriveMailTemplate;
  noUserFound: DriveMailTemplate;
  uploadFailed: DriveMailTemplate;
  moveFailed: DriveMailTemplate;
  organizeAuthRequired: DriveMailTemplate;
  organizeScanStarted: DriveMailTemplate;
  organizeExecutionStarted: DriveMailTemplate;
  organizeProposal: DriveMailTemplate;
  organizeFolderPreferences: DriveMailTemplate;
  organizePhase1aProposal: DriveMailTemplate;
  organizePhase2Proposal: DriveMailTemplate;
  organizeCostEstimate: DriveMailTemplate;
  organizePlanReview: DriveMailTemplate;
  organizePlanReviewScopeTooBroad: DriveMailTemplate;
  organizeError: DriveMailTemplate;
  organizeNoFiles: DriveMailTemplate;
  organizeComplete: DriveMailTemplate;
  organizeUndone: DriveMailTemplate;
  preferencesUpdated: DriveMailTemplate;
  userDeleted: DriveMailTemplate;
  emailRemoved: DriveMailTemplate;
  emailNotOwned: DriveMailTemplate;
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
  action: "approve" | "undo" | "move";
  emailId: string;
}

export interface PlanningChunkTaskData {
  proposalId: string;
  emailId: string;
  uid: string;
  chunkIndex: number;
}

export interface MoveChunkTaskData {
  proposalId: string;
  emailId: string;
  uid: string;
  chunkIndex: number;
}

export interface OrganizeIntermediateState {
  driveStructureSummary: string;
  fileEntries: DriveFileEntry[];
  senderEmail: string;
}
