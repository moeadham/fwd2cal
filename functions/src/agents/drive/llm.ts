import {logger} from "firebase-functions/v2";
import {defaultCompletion, DEFAULT_TEMP} from "../../util/openai";
import {getPrompts} from "./prompts/index";
import {
  FileProposalSchema,
  FileProposal,
  MoveInstructionSchema,
  MoveInstruction,
  DriveEmbeddedFileData,
  DriveOrganizeProposal,
  DriveOrganizeRevisionSchema,
  DriveOrganizeRevision,
  DriveFileEntry,
  FolderOperation,
  FileInfo,
  GenerateFilenameExamplesSchema,
  GenerateFilenameExamplesResult,
  PlacementSetupData,
  PlacementRulesData,
} from "./types";
import {ChatMessage, TextContent, ImageURLContent} from "../../util/types";
import {
  DetectFolderConventionSchema,
  DetectFolderConventionResult,
} from "./prompts/detectFolderConvention/v1";
import {
  AnalyzeDirectoryStructureSchema,
  AnalyzeDirectoryStructureResult,
} from "./prompts/analyzeDirectoryStructure/v1";
import {
  EvaluateDirectoryPlacementSchema,
  EvaluateDirectoryPlacementResult,
} from "./prompts/evaluateDirectoryPlacement/v1";
import {
  FinalizeDirectoryMapSchema,
  FinalizeDirectoryMapResult,
} from "./prompts/finalizeDirectoryMap/v1";
import {
  ClassifyConventionChangeSchema,
  ClassifyConventionChangeResult,
} from "./prompts/classifyConventionChange/v1";
import {
  ClassifyFolderConventionChangeSchema,
  ClassifyFolderConventionChangeResult,
} from "./prompts/classifyFolderConventionChange/v1";
import {
  ClassifyPlacementSetupChangeSchema,
  ClassifyPlacementSetupChangeResult,
} from "./prompts/classifyPlacementSetupChange/v1";
import {
  ClassifyPlacementRulesChangeSchema,
  ClassifyPlacementRulesChangeResult,
} from "./prompts/classifyPlacementRulesChange/v1";
import {
  ExtractNamedEntitiesSchema,
  ExtractNamedEntitiesResult,
} from "./prompts/extractNamedEntities/v1";
import {
  ProposeFileNameSchema,
  ProposeFileNameResult,
} from "./prompts/proposeFileName/v1";
import {
  ProposePlacementSchema,
  ProposePlacementResult,
} from "./prompts/proposePlacement/v1";
import {
  SetPreferencesSchema,
  SetPreferencesResult,
} from "./prompts/setPreferences/v1";
import {
  RevisePlanFileActionsSchema,
  RevisePlanFileActionsResult,
} from "./prompts/revisePlanFileActions/v1";
import {
  ScopePlanRevisionSchema,
  ScopePlanRevisionResult,
} from "./prompts/scopePlanRevision/v1";
const DEFAULT_FOLDER_CONVENTION = "NN-Category";
const DEFAULT_FILENAME_CONVENTION = "YYYY.MM.DD - Description.ext";

/** Builds the user preference block for folder-producing prompts. */
function renderFolderConventionBlock(folderConvention?: string, folderConventionDescription?: string): string {
  const convention = typeof folderConvention === "string" ? folderConvention.trim() : "";
  if (!convention) {
    return "";
  }
  const description = typeof folderConventionDescription === "string" ? folderConventionDescription.trim() : "";
  const descriptionLine = description ? `\nDescription: ${description}` : "";
  return "\n## Folder Convention\n" +
    `Use this exact pattern for folder_name and folder paths: ${convention}${descriptionLine}\n`;
}

/** Builds the optional user preference block for filename-producing prompts. */
function renderFilenameConventionBlock(filenameConvention?: string): string {
  const convention = typeof filenameConvention === "string" ? filenameConvention.trim() : "";
  if (!convention) {
    return "";
  }
  return `\n## Filename Convention\nUse this exact pattern for suggested_name: ${convention}\n`;
}

const FILENAME_EXAMPLE_INPUTS = [
  {description: "Tax Receipt", extension: ".pdf"},
  {description: "Client Agreement", extension: ".docx"},
  {description: "Travel Itinerary", extension: ".pdf"},
];

function formatDateParts(date: Date): {yyyy: string; mm: string; dd: string} {
  return {
    yyyy: String(date.getFullYear()),
    mm: String(date.getMonth() + 1).padStart(2, "0"),
    dd: String(date.getDate()).padStart(2, "0"),
  };
}

function fallbackFilenameExample(convention: string, description: string, extension: string, date: Date): string {
  const {yyyy, mm, dd} = formatDateParts(date);
  let example = convention.trim() || `${yyyy}.${mm}.${dd} - Description.ext`;
  example = example
      .replace(/YYYY/g, yyyy)
      .replace(/YY/g, yyyy.slice(-2))
      .replace(/MM/g, mm)
      .replace(/DD/g, dd)
      .replace(/\bDescription\b/g, description)
      .replace(/\bdescription\b/g, description.toLowerCase())
      .replace(/\bdesc\b/g, description)
      .replace(/\bname\b/g, description)
      .replace(/\.ext\b/g, extension)
      .replace(/\bext\b/g, extension.replace(/^\./, ""));
  if (!example.includes(".")) {
    example += extension;
  }
  return example;
}

function fallbackFilenameExamples(convention: string): string[] {
  const today = new Date();
  const fallbackConvention = convention.trim() || "YYYY.MM.DD - Description.ext";
  return FILENAME_EXAMPLE_INPUTS.map((input) =>
    fallbackFilenameExample(fallbackConvention, input.description, input.extension, today),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Formats one folder path segment for display. */
function titleCaseFolderSegment(segment: string): string {
  const trimmed = segment.trim().replace(/^["']|["']$/g, "");
  const prefixMatch = trimmed.match(/^(\d{2,3}-)(.*)$/);
  const category = prefixMatch ? prefixMatch[2] : trimmed;
  const titled = category
      .split(/[\s-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  return prefixMatch ? `${prefixMatch[1]}${titled}` : titled;
}

/** Attempts a cheap parse of simple move instructions before using the LLM. */
function tryFastParseMoveInstructions(
    replyText: string,
    currentFiles: DriveEmbeddedFileData[],
    agentFolders: {name: string; id: string}[],
): MoveInstruction | null {
  const normalizedReply = replyText.trim();
  if (!normalizedReply) {
    return null;
  }

  if (/\b(trash|delete|remove)\b/i.test(normalizedReply)) {
    return {
      moves: currentFiles.map((_file, index) => ({
        file_index: index,
        action: "trash" as const,
        folder_id: "",
        folder_path: "",
        reason: "Fast-path parser detected a trash request",
      })),
    };
  }

  const movePatterns = [
    /\bmove\b[\s\S]*?\bto\b\s+(?:a\s+)?(?:folder\s+)?(?:called|named)\s+["']?([^"'.!?<\n]+(?:\/[^"'.!?<\n]+)*)["']?/i,
    /\bmove\b[\s\S]*?\bto\b\s+["']?([^"'.!?<\n]+(?:\/[^"'.!?<\n]+)*)["']?/i,
  ];

  let targetPath = "";
  for (const pattern of movePatterns) {
    const match = normalizedReply.match(pattern);
    if (match?.[1]) {
      targetPath = match[1].trim();
      break;
    }
  }

  if (!targetPath) {
    return null;
  }

  const normalizedTargetPath = targetPath
      .split("/")
      .map((segment) => titleCaseFolderSegment(segment))
      .filter(Boolean)
      .join("/");
  if (!normalizedTargetPath) {
    return null;
  }

  const existingAgentFolder = agentFolders.find((folder) =>
    folder.name.toLowerCase() === normalizedTargetPath.toLowerCase(),
  );

  return {
    moves: currentFiles.map((_file, index) => ({
      file_index: index,
      action: "move" as const,
      folder_id: existingAgentFolder?.id || "root",
      folder_path: existingAgentFolder?.name || normalizedTargetPath,
      reason: "Fast-path parser detected an explicit move destination",
    })),
  };
}

/**
 * Propose a folder name (NNN-Category) and filenames before Drive access.
 * Uses existing agent-managed folder names to reuse categories.
 */
async function proposeFilePlacement(
    files: FileInfo[],
    emailSubject: string,
    emailBody: string,
    agentFolderNames: string[],
    nextPrefix: string,
    uid: string | null = null,
    imageUrls: string[] = [],
    filenameConvention?: string,
    folderConvention?: string,
    folderConventionDescription?: string,
): Promise<FileProposal> {
  const {prompts, versions} = getPrompts();
  let userText = `## Existing Agent-Managed Folders\n`;
  if (agentFolderNames.length > 0) {
    userText += agentFolderNames.map((f) => `- ${f}`).join("\n") + "\n";
  } else {
    userText += "(none — this is a new user)\n";
  }
  userText += `\nNext available folder prefix: ${nextPrefix}\n\n`;
  userText += renderFolderConventionBlock(folderConvention, folderConventionDescription);

  userText += `## Files (${files.length} total)\n`;
  for (let i = 0; i < files.length; i++) {
    userText += `\n### File ${i}\n`;
    userText += `Filename: ${files[i].fileName}\n`;
    userText += `MIME Type: ${files[i].mimeType}\n`;
    userText += `Size: ${files[i].fileSize} bytes\n`;
    if (files[i].contentSummary) {
      userText += `Content Summary: ${files[i].contentSummary}\n`;
    }
  }

  if (emailSubject || emailBody) {
    userText += `\n## Email Context\n`;
    if (emailSubject) userText += `Subject: ${emailSubject}\n`;
    if (emailBody) userText += `Body: ${emailBody.slice(0, 500)}\n`;
  }
  userText += renderFilenameConventionBlock(filenameConvention);

  // Build user message content - text + images (mirrors calendar agent pattern)
  let userContent: string | Array<TextContent | ImageURLContent>;
  if (imageUrls.length > 0) {
    const contentArray: Array<TextContent | ImageURLContent> = [
      {type: "text", text: userText},
    ];
    imageUrls.forEach((url) => {
      contentArray.push({type: "image_url", image_url: {url}});
    });
    userContent = contentArray;
    logger.info("Including images in Drive proposal LLM request", {
      imageCount: imageUrls.length,
    });
  } else {
    userContent = userText;
  }

  const messages: ChatMessage[] = [
    {role: "system", content: prompts.proposeFilePlacement.prompt},
    {role: "user", content: userContent},
  ];

  logger.info("File placement proposal prompt", {
    system: prompts.proposeFilePlacement.prompt,
    user: userText,
    imageCount: imageUrls.length,
  });

  const result = await defaultCompletion<FileProposal>(
      messages,
      prompts.proposeFilePlacement.model,
      prompts.proposeFilePlacement.temperature ?? DEFAULT_TEMP,
      FileProposalSchema,
      uid,
      {promptVersion: versions.PROMPT_PROPOSE_FILE_PLACEMENT_VERSION},
  );

  return result as FileProposal;
}

/**
 * Placement pass run during organize-drive execution against the APPROVED folder tree.
 * Strict: top-level folder must come from the approved tree; new subfolders allowed.
 * Accepts current proposal (target folder + proposed name) as context so the LLM can
 * refine placement with file content while respecting the approved structure.
 */
/**
 * Interpret a user's reply to move uploaded files to a new location.
 */
async function interpretMoveInstructions(
    replyText: string,
    currentFiles: DriveEmbeddedFileData[],
    agentFolders: {name: string; id: string}[],
    uid: string | null = null,
    filenameConvention?: string,
): Promise<MoveInstruction> {
  const fastPath = tryFastParseMoveInstructions(replyText, currentFiles, agentFolders);
  if (fastPath) {
    logger.info("Drive move instructions resolved via fast-path parser", {
      fileCount: currentFiles.length,
      moves: fastPath.moves.map((move) => ({
        file_index: move.file_index,
        action: move.action,
        folder_id: move.folder_id,
        folder_path: move.folder_path,
      })),
    });
    return fastPath;
  }
  const {prompts, versions} = getPrompts();

  let userContent = `## User's Instructions\n${replyText}\n\n`;
  userContent += renderFilenameConventionBlock(filenameConvention);

  userContent += `## Current Files\n`;
  for (let i = 0; i < currentFiles.length; i++) {
    const f = currentFiles[i];
    userContent += `\n### File ${i}\n`;
    userContent += `Filename: ${f.filename}\n`;
    userContent += `Current Folder: ${f.folderPath}\n`;
    userContent += `Drive File ID: ${f.id}\n`;
  }

  if (agentFolders.length > 0) {
    userContent += `\n## Agent-Managed Folders\n`;
    userContent += agentFolders
        .map((f) => `- ${f.name} [id: ${f.id}]`)
        .join("\n") + "\n";
  } else {
    userContent += `\n## Agent-Managed Folders\n(none)\n`;
  }

  const messages: ChatMessage[] = [
    {role: "system", content: prompts.interpretMoveInstructions.prompt},
    {role: "user", content: userContent},
  ];

  logger.debug("Calling LLM for move instructions", {
    fileCount: currentFiles.length,
  });

  const result = await defaultCompletion<MoveInstruction>(
      messages,
      prompts.interpretMoveInstructions.model,
      prompts.interpretMoveInstructions.temperature ?? DEFAULT_TEMP,
      MoveInstructionSchema,
      uid,
      {promptVersion: versions.PROMPT_INTERPRET_MOVE_INSTRUCTIONS_VERSION},
  );

  return result as MoveInstruction;
}

/**
 * Revise an existing organize-drive proposal based on a user's reply.
 */
async function reviseOrganization(
    currentProposal: DriveOrganizeProposal,
    userInstructions: string,
    uid: string | null = null,
    filenameConvention?: string,
    folderConvention?: string,
    folderConventionDescription?: string,
): Promise<{ proposal: DriveOrganizeProposal; preservedRootPaths: Set<string> }> {
  const {prompts, versions} = getPrompts();
  const proposedTree = renderFolderTreePlainText(currentProposal);
  const originalTree = renderOriginalFolderTree(currentProposal);
  const userText = `## User Requested Changes\n${userInstructions}\n\n` +
    renderFolderConventionBlock(folderConvention, folderConventionDescription) +
    `## Current Proposed Folder Tree\n${proposedTree}\n\n` +
    `## Original Drive Folder Tree\n${originalTree}\n` +
    renderFilenameConventionBlock(filenameConvention);

  const messages: ChatMessage[] = [
    {role: "system", content: prompts.reviseOrganization.prompt},
    {role: "user", content: userText},
  ];

  logger.info("Drive organize revision prompt", {
    fileActions: currentProposal.file_actions.length,
    proposedFolders: currentProposal.proposed_folders.length,
    userTextLength: userText.length,
  });

  const result = await defaultCompletion<DriveOrganizeRevision>(
      messages,
      prompts.reviseOrganization.model,
      prompts.reviseOrganization.temperature ?? DEFAULT_TEMP,
      DriveOrganizeRevisionSchema,
      uid,
      {promptVersion: versions.PROMPT_REVISE_ORGANIZATION_VERSION},
  ) as DriveOrganizeRevision;

  logger.info("Drive organize revision result", {
    fileActions: currentProposal.file_actions.length,
    proposedFolders: currentProposal.proposed_folders.length,
    userTextLength: userText.length,
    operationsCount: result.folder_operations.length,
    operations: result.folder_operations,
    summary: result.summary,
  });

  const {proposal: revisedProposal, preservedRootPaths} = applyFolderOperations(
      currentProposal,
      result.folder_operations,
      result.summary,
  );
  normalizeFolderPrefixes(revisedProposal, preservedRootPaths, folderConvention);
  return {proposal: revisedProposal, preservedRootPaths};
}

/** Refine the in-progress directory tree during chunked planning. */
async function refineDirectoryTree(
    runningTree: DriveOrganizeProposal["proposed_folders"],
    fileActions: DriveOrganizeProposal["file_actions"],
    uid: string | null = null,
): Promise<DriveOrganizeRevision> {
  const {prompts, versions} = getPrompts();
  const treeText = renderFolderTreePlainText({
    proposed_folders: runningTree,
    file_actions: fileActions,
    summary: "",
  });
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.refineDirectoryTree.prompt},
    {role: "user", content: treeText},
  ];

  const result = await defaultCompletion<DriveOrganizeRevision>(
      messages,
      prompts.refineDirectoryTree.model,
      prompts.refineDirectoryTree.temperature ?? DEFAULT_TEMP,
      DriveOrganizeRevisionSchema,
      uid,
      {promptVersion: versions.PROMPT_REFINE_DIRECTORY_TREE_VERSION},
  ) as DriveOrganizeRevision;

  logger.info("Drive organize tree refinement result", {
    proposedFolders: runningTree.length,
    operationsCount: result.folder_operations.length,
    operations: result.folder_operations,
    summary: result.summary,
  });

  return result;
}

/** Generates user-facing filename examples for a confirmed convention. */
async function generateFilenameExamples(
    convention: string,
    uid: string | null = null,
): Promise<string[]> {
  const safeConvention = convention.trim() || "YYYY.MM.DD - Description.ext";
  const {prompts, versions} = getPrompts();
  const {yyyy, mm, dd} = formatDateParts(new Date());
  const userText = `## Filename Convention\n${safeConvention}\n\n` +
    `## Today's Date\n${yyyy}-${mm}-${dd}\n\n` +
    `## Required Examples\n` +
    FILENAME_EXAMPLE_INPUTS
        .map((input, index) => `${index + 1}. ${input.description}${input.extension}`)
        .join("\n") +
    "\n";

  try {
    const messages: ChatMessage[] = [
      {role: "system", content: prompts.generateFilenameExamples.prompt},
      {role: "user", content: userText},
    ];
    const result = await defaultCompletion<GenerateFilenameExamplesResult>(
        messages,
        prompts.generateFilenameExamples.model,
        prompts.generateFilenameExamples.temperature ?? DEFAULT_TEMP,
        GenerateFilenameExamplesSchema,
        uid,
        {
          promptVersion: versions.PROMPT_GENERATE_FILENAME_EXAMPLES_VERSION,
          retry: false,
        },
    ) as GenerateFilenameExamplesResult;
    return result.examples.map((example) => String(example));
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn("Drive organize: Filename example generation failed, using fallback examples", {
      error: errMsg,
      convention: safeConvention,
    });
    return fallbackFilenameExamples(safeConvention);
  }
}

/** Revise saved plan-review file actions from a user reply. */
async function revisePlanFileActions(
    fileActions: DriveOrganizeProposal["file_actions"],
    approvedFolders: DriveOrganizeProposal["proposed_folders"],
    userInstructions: string,
    existingIgnoredFolders: string[] = [],
    uid: string | null = null,
): Promise<RevisePlanFileActionsResult> {
  const {prompts, versions} = getPrompts();
  const folders = approvedFolders
      .map((folder) => `- ${folder.folder_path}: ${folder.description}`)
      .join("\n");
  const actions = fileActions
      .map((action) =>
        `- file_id: ${action.file_id}\n` +
        `  current_path: ${action.current_path}\n` +
        `  current_name: ${action.current_name}\n` +
        `  new_folder: ${action.new_folder}\n` +
        `  new_name: ${action.new_name}\n` +
        `  action: ${action.action}\n` +
        `  reason: ${action.reason}`,
      )
      .join("\n");
  const ignoredFolders = existingIgnoredFolders.length > 0 ?
    `## Previously Ignored Folders\n` +
    `These folder paths were marked as ignored in an earlier revision. Unless the user's current ` +
    `instructions explicitly ask to reorganize one of them, keep them in folder_ignores and do ` +
    `not emit patches for files under them.\n` +
    existingIgnoredFolders.map((folderPath) => `- ${folderPath}`).join("\n") +
    "\n\n" :
    "";
  const userText = `## User Requested Changes\n${userInstructions}\n\n` +
    `## Approved Folder Structure\n${folders || "(none)"}\n\n` +
    ignoredFolders +
    `## Current File Actions\n${actions || "(none)"}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.revisePlanFileActions.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<RevisePlanFileActionsResult>(
      messages,
      prompts.revisePlanFileActions.model,
      prompts.revisePlanFileActions.temperature ?? DEFAULT_TEMP,
      RevisePlanFileActionsSchema,
      uid,
      {promptVersion: versions.PROMPT_REVISE_PLAN_FILE_ACTIONS_VERSION},
  ) as RevisePlanFileActionsResult;
}

/** Scope a plan-review revision before passing file actions to the patching LLM. */
async function scopePlanRevision(
    proposal: DriveOrganizeProposal,
    userInstructions: string,
    existingIgnoredFolders: string[] = [],
    uid: string | null = null,
): Promise<ScopePlanRevisionResult> {
  const {prompts, versions} = getPrompts();
  const approvedTree = renderFolderTreePlainText(proposal);
  const originalTree = renderOriginalFolderTree(proposal);
  const filenameSamples = sampleFilenamesPerFolder(proposal);
  const sampleBlock = proposal.proposed_folders
      .map((folder) => {
        const folderPath = normalizeFolderPath(folder.folder_path);
        const filenames = filenameSamples.get(folderPath) || [];
        const sampleText = filenames.length > 0 ? filenames.join(", ") : "(none)";
        return `- ${folderPath || folder.folder_path}: ${sampleText}`;
      })
      .join("\n");
  const ignoredFolders = existingIgnoredFolders.length > 0 ?
    existingIgnoredFolders.map((folderPath) => `- ${folderPath}`).join("\n") :
    "(none)";
  const userText = `## User Requested Changes\n${userInstructions || "(none)"}\n\n` +
    `## Approved Folder Tree\n${approvedTree}\n\n` +
    `## Original Current-Path Tree\n${originalTree}\n\n` +
    `## Sample Filenames Per Proposed Folder\n${sampleBlock || "(none)"}\n\n` +
    `## Previously Ignored Folders\n${ignoredFolders}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.scopePlanRevision.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<ScopePlanRevisionResult>(
      messages,
      prompts.scopePlanRevision.model,
      prompts.scopePlanRevision.temperature ?? DEFAULT_TEMP,
      ScopePlanRevisionSchema,
      uid,
      {promptVersion: versions.PROMPT_SCOPE_PLAN_REVISION_VERSION},
  ) as ScopePlanRevisionResult;
}

/** Extract top-level folder names from the tree summary produced by buildDriveStructureSummary. */
function extractTopLevelFolderNames(treeSummary: string): string[] {
  const names: string[] = [];
  for (const line of treeSummary.split("\n")) {
    const m = line.match(/^ {2}([^\s/][^/]*)\//);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Detect the existing or preferred folder naming convention from the current Drive tree. */
async function detectFolderConvention(
    treeSummary: string,
    uid: string | null = null,
    folderConvention?: string,
): Promise<DetectFolderConventionResult> {
  const {prompts, versions} = getPrompts();
  const topLevelFolderNames = extractTopLevelFolderNames(treeSummary);
  const fallbackBlock = folderConvention && folderConvention.trim() ?
    `\n## Fallback Convention\nUse this only if no pattern is detectable: ${folderConvention.trim()}\n` :
    "";
  const folderList = topLevelFolderNames.length > 0 ?
    topLevelFolderNames.map((n) => `- ${n}`).join("\n") :
    "(none)";
  const userContent = `## Top-Level Folders\n${folderList}\n${fallbackBlock}`;
  logger.info("detectFolderConvention LLM input", {
    topLevelFolderCount: topLevelFolderNames.length,
    userContentPreview: userContent.slice(0, 500),
  });
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.detectFolderConvention.prompt},
    {role: "user", content: userContent},
  ];
  const result = await defaultCompletion<DetectFolderConventionResult>(
      messages,
      prompts.detectFolderConvention.model,
      prompts.detectFolderConvention.temperature ?? DEFAULT_TEMP,
      DetectFolderConventionSchema,
      uid,
      {promptVersion: versions.PROMPT_DETECT_FOLDER_CONVENTION_VERSION},
  ) as DetectFolderConventionResult;

  logger.info("detectFolderConvention LLM result", {
    has_convention: result.has_convention,
    detected_convention: result.detected_convention,
    suggested_convention: result.suggested_convention,
    summary: result.summary,
  });
  return result;
}

/** Parse an email into Drive preference updates. */
async function setPreferences(
    subject: string,
    body: string,
    currentFolderConvention: string,
    currentFilenameConvention: string,
    uid: string | null = null,
): Promise<SetPreferencesResult> {
  const {prompts, versions} = getPrompts();
  const userText = `## Current Folder Convention\n${currentFolderConvention || "(none)"}\n\n` +
    `## Current Filename Convention\n${currentFilenameConvention || "(none)"}\n\n` +
    `## Email Subject\n${subject || "(none)"}\n\n` +
    `## Email Body\n${body || "(none)"}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.setPreferences.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<SetPreferencesResult>(
      messages,
      prompts.setPreferences.model,
      prompts.setPreferences.temperature ?? DEFAULT_TEMP,
      SetPreferencesSchema,
      uid,
      {promptVersion: versions.PROMPT_SET_PREFERENCES_VERSION},
  ) as SetPreferencesResult;
}

/** Analyze the current Drive tree and propose an initial directory structure. */
async function analyzeDirectoryStructure(
    treeSummary: string,
    folderConvention: string,
    userPrompt: string,
    uid: string | null = null,
    conventionDescription = "",
    existingIgnoredFolders: string[] = [],
    granularity = "by_entity",
    namedEntities: string[] = [],
    removedEntities: string[] = [],
): Promise<AnalyzeDirectoryStructureResult> {
  const {prompts, versions} = getPrompts();
  const namedEntitiesBlock = namedEntities.length ?
    namedEntities.map((entity) => `- ${entity}`).join("\n") :
    "(none)";
  const removedEntitiesBlock = removedEntities.length ?
    removedEntities.map((entity) => `- ${entity}`).join("\n") :
    "(none)";
  const ignoredFolders = existingIgnoredFolders.length > 0 ?
    `## Previously Ignored Folders\n` +
    `These folder paths were marked as ignored in an earlier revision. Unless the user's current ` +
    `instructions explicitly ask to reorganize one of them, keep them in folder_ignores and do ` +
    `not include them (or their descendants) in proposed_structure.\n` +
    existingIgnoredFolders.map((folderPath) => `- ${folderPath}`).join("\n") +
    "\n\n" :
    "";
  const userText = `## Current Drive Tree\n${treeSummary}\n\n` +
    `## Confirmed Folder Naming Convention\n${folderConvention || "(none)"}\n\n` +
    `## Confirmed Convention Description\n${conventionDescription || "(none)"}\n\n` +
    `## Granularity\n${granularity || "by_entity"}\n\n` +
    `## Known Named Entities\n${namedEntitiesBlock}\n\n` +
    `## Removed Entities\n${removedEntitiesBlock}\n\n` +
    ignoredFolders +
    `## User Instructions\n${userPrompt || "(none)"}\n`;
  logger.info("analyzeDirectoryStructure LLM input", {
    folderConvention: folderConvention || "(empty)",
    conventionDescription: conventionDescription || "(empty)",
    granularity: granularity || "by_entity",
    userPromptPreview: userPrompt.slice(0, 200),
    treeSummaryLength: treeSummary.length,
  });
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.analyzeDirectoryStructure.prompt},
    {role: "user", content: userText},
  ];
  const result = await defaultCompletion<AnalyzeDirectoryStructureResult>(
      messages,
      prompts.analyzeDirectoryStructure.model,
      prompts.analyzeDirectoryStructure.temperature ?? DEFAULT_TEMP,
      AnalyzeDirectoryStructureSchema,
      uid,
      {promptVersion: versions.PROMPT_ANALYZE_DIRECTORY_STRUCTURE_VERSION},
  ) as AnalyzeDirectoryStructureResult;
  if (removedEntities.length > 0) {
    const removed = new Set(removedEntities.map((entity) => entity.trim().toLowerCase()).filter(Boolean));
    const kept = result.proposed_structure.filter((folder) => {
      const hasRemovedSegment = folder.folder_path
          .split("/")
          .map((segment) => segment.trim().toLowerCase())
          .some((segment) => removed.has(segment));
      if (hasRemovedSegment) {
        logger.warn("Drive organize: dropping proposed folder for removed entity", {
          folderPath: folder.folder_path,
          removedEntities,
        });
      }
      return !hasRemovedSegment;
    });
    return {
      ...result,
      proposed_structure: kept,
    };
  }
  return result;
}

/** Evaluate whether existing directories should move into the proposed structure. */
async function evaluateDirectoryPlacement(
    currentTree: string,
    proposedStructure: DriveOrganizeProposal["proposed_folders"],
    uid: string | null = null,
    userFeedback = "",
): Promise<EvaluateDirectoryPlacementResult> {
  const {prompts, versions} = getPrompts();
  const proposed = proposedStructure
      .map((folder) => `- ${folder.folder_path}: ${folder.description}`)
      .join("\n");
  const userText = `## Current Drive Tree\n${currentTree}\n\n` +
    `## Proposed Structure\n${proposed || "(none)"}\n\n` +
    `## User Feedback\n${userFeedback || "(none)"}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.evaluateDirectoryPlacement.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<EvaluateDirectoryPlacementResult>(
      messages,
      prompts.evaluateDirectoryPlacement.model,
      prompts.evaluateDirectoryPlacement.temperature ?? DEFAULT_TEMP,
      EvaluateDirectoryPlacementSchema,
      uid,
      {promptVersion: versions.PROMPT_EVALUATE_DIRECTORY_PLACEMENT_VERSION},
  ) as EvaluateDirectoryPlacementResult;
}

/** Finalize the approved directory map before filename convention selection. */
async function finalizeDirectoryMap(
    proposedStructure: DriveOrganizeProposal["proposed_folders"],
    directoryMoves: Array<{current_path: string; proposed_path: string; reason: string}>,
    fileSummary: string,
    uid: string | null = null,
    userFeedback = "",
): Promise<FinalizeDirectoryMapResult> {
  const {prompts, versions} = getPrompts();
  const proposed = proposedStructure
      .map((folder) => `- ${folder.folder_path}: ${folder.description}`)
      .join("\n");
  const moves = directoryMoves
      .map((move) => `- ${move.current_path} -> ${move.proposed_path}: ${move.reason}`)
      .join("\n");
  const userText = `## Proposed Structure\n${proposed || "(none)"}\n\n` +
    `## Directory Moves\n${moves || "(none)"}\n\n` +
    `## File Summary\n${fileSummary || "(none)"}\n\n` +
    `## User Feedback\n${userFeedback || "(none)"}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.finalizeDirectoryMap.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<FinalizeDirectoryMapResult>(
      messages,
      prompts.finalizeDirectoryMap.model,
      prompts.finalizeDirectoryMap.temperature ?? DEFAULT_TEMP,
      FinalizeDirectoryMapSchema,
      uid,
      {promptVersion: versions.PROMPT_FINALIZE_DIRECTORY_MAP_VERSION},
  ) as FinalizeDirectoryMapResult;
}

/** Classify whether a reply updates the filename convention. */
async function classifyConventionChange(
    convention: string,
    userReply: string,
    uid: string | null = null,
): Promise<ClassifyConventionChangeResult> {
  const {prompts, versions} = getPrompts();
  const userText = `## Current Convention\n${convention}\n\n` +
    `## User Reply\n${userReply}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.classifyConventionChange.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<ClassifyConventionChangeResult>(
      messages,
      prompts.classifyConventionChange.model,
      prompts.classifyConventionChange.temperature ?? DEFAULT_TEMP,
      ClassifyConventionChangeSchema,
      uid,
      {promptVersion: versions.PROMPT_CLASSIFY_CONVENTION_CHANGE_VERSION},
  ) as ClassifyConventionChangeResult;
}

/** Classify whether a reply updates the folder convention. */
async function classifyFolderConventionChange(
    convention: string,
    userReply: string,
    uid: string | null = null,
): Promise<ClassifyFolderConventionChangeResult> {
  const {prompts, versions} = getPrompts();
  const userText = `## Current Convention\n${convention}\n\n` +
    `## User Reply\n${userReply}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.classifyFolderConventionChange.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<ClassifyFolderConventionChangeResult>(
      messages,
      prompts.classifyFolderConventionChange.model,
      prompts.classifyFolderConventionChange.temperature ?? DEFAULT_TEMP,
      ClassifyFolderConventionChangeSchema,
      uid,
      {promptVersion: versions.PROMPT_CLASSIFY_FOLDER_CONVENTION_CHANGE_VERSION},
  ) as ClassifyFolderConventionChangeResult;
}

function renderPlacementSetupBlock(setup: PlacementSetupData): string {
  const namedEntities = setup.namedEntities.length ?
    setup.namedEntities.map((entity) => `- ${entity}`).join("\n") :
    "(none)";
  return `Granularity: ${setup.granularity || "by_entity"}\n\n` +
    `Named entities:\n${namedEntities}\n`;
}

/** Classify whether a reply updates placement setup. */
async function classifyPlacementSetupChange(
    currentSetup: PlacementSetupData,
    userReply: string,
    uid: string | null = null,
): Promise<ClassifyPlacementSetupChangeResult> {
  const {prompts, versions} = getPrompts();
  const userText = `## Current Placement Setup\n${renderPlacementSetupBlock(currentSetup)}\n\n` +
    `## User Reply\n${userReply}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.classifyPlacementSetupChange.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<ClassifyPlacementSetupChangeResult>(
      messages,
      prompts.classifyPlacementSetupChange.model,
      prompts.classifyPlacementSetupChange.temperature ?? DEFAULT_TEMP,
      ClassifyPlacementSetupChangeSchema,
      uid,
      {promptVersion: versions.PROMPT_CLASSIFY_PLACEMENT_SETUP_CHANGE_VERSION},
  ) as ClassifyPlacementSetupChangeResult;
}

/** Classify whether a reply updates placement rules. */
async function classifyPlacementRulesChange(
    currentRules: PlacementRulesData,
    userReply: string,
    uid: string | null = null,
): Promise<ClassifyPlacementRulesChangeResult> {
  const {prompts, versions} = getPrompts();
  const userText = `## Current Placement Rules\n${renderPlacementRulesBlock(currentRules)}\n\n` +
    `## User Reply\n${userReply}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.classifyPlacementRulesChange.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<ClassifyPlacementRulesChangeResult>(
      messages,
      prompts.classifyPlacementRulesChange.model,
      prompts.classifyPlacementRulesChange.temperature ?? DEFAULT_TEMP,
      ClassifyPlacementRulesChangeSchema,
      uid,
      {promptVersion: versions.PROMPT_CLASSIFY_PLACEMENT_RULES_CHANGE_VERSION},
  ) as ClassifyPlacementRulesChangeResult;
}

/** Extract named entities from a folder tree. */
async function extractNamedEntities(
    treeText: string,
    uid: string | null = null,
): Promise<ExtractNamedEntitiesResult> {
  const {prompts, versions} = getPrompts();
  const userText = `## Folder Tree\n${treeText || "(empty tree)"}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.extractNamedEntities.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<ExtractNamedEntitiesResult>(
      messages,
      prompts.extractNamedEntities.model,
      prompts.extractNamedEntities.temperature ?? DEFAULT_TEMP,
      ExtractNamedEntitiesSchema,
      uid,
      {promptVersion: versions.PROMPT_EXTRACT_NAMED_ENTITIES_VERSION},
  ) as ExtractNamedEntitiesResult;
}

function renderFileMetadataBlock(fileInfo: DriveFileEntry): string {
  return `## File\n` +
    `ID: ${fileInfo.id}\n` +
    `Name: ${fileInfo.name}\n` +
    `Current Path: ${fileInfo.parentPath}\n` +
    `MIME Type: ${fileInfo.mimeType}\n` +
    `Created: ${fileInfo.createdTime}\n` +
    `Size: ${fileInfo.size} bytes\n`;
}

function renderPlacementRulesBlock(placementRules: PlacementRulesData | null): string {
  if (!placementRules) {
    return "(none)\n";
  }
  const edgeCaseRules = placementRules.edgeCaseRules.length ?
    placementRules.edgeCaseRules.map((rule) => `- ${rule}`).join("\n") :
    "(none)";
  const examples = placementRules.examples.length ?
    placementRules.examples.map((example) => `- ${example}`).join("\n") :
    "(none)";
  if (!placementRules.edgeCaseRules.length && !placementRules.examples.length) {
    return "(none)\n";
  }
  return `Edge-case rules:\n${edgeCaseRules}\n\n` +
    `Examples:\n${examples}\n`;
}

/** Propose the filename for one file using content and optional images. */
async function proposeFileName(
    fileInfo: DriveFileEntry,
    convention: string,
    contentSummary: string,
    uid: string | null = null,
    imageUrls: string[] = [],
    placementRules: PlacementRulesData | null = null,
): Promise<ProposeFileNameResult> {
  const {prompts, versions} = getPrompts();
  const userText = `## Filename Convention\n${convention}\n\n` +
    `## Placement Rules\n${renderPlacementRulesBlock(placementRules)}\n` +
    renderFileMetadataBlock(fileInfo) +
    `\n` +
    `## File Contents\n${contentSummary || "(none)"}\n`;
  let userContent: string | Array<TextContent | ImageURLContent>;
  if (imageUrls.length > 0) {
    const contentArray: Array<TextContent | ImageURLContent> = [
      {type: "text", text: userText},
    ];
    imageUrls.forEach((url) => {
      contentArray.push({type: "image_url", image_url: {url}});
    });
    userContent = contentArray;
  } else {
    userContent = userText;
  }
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.proposeFileName.prompt},
    {role: "user", content: userContent},
  ];
  return await defaultCompletion<ProposeFileNameResult>(
      messages,
      prompts.proposeFileName.model,
      prompts.proposeFileName.temperature ?? DEFAULT_TEMP,
      ProposeFileNameSchema,
      uid,
      {promptVersion: versions.PROMPT_PROPOSE_FILE_NAME_VERSION},
  ) as ProposeFileNameResult;
}

/** Propose the placement for one file using the evolving directory tree. */
async function proposePlacement(
    fileInfo: DriveFileEntry,
    directoryTree: DriveOrganizeProposal["proposed_folders"],
    contentSummary: string,
    uid: string | null = null,
    placementRules: PlacementRulesData | null = null,
): Promise<ProposePlacementResult> {
  const {prompts, versions} = getPrompts();
  const tree = expandApprovedTreeWithAncestors(directoryTree)
      .map((folder) => `- ${folder.folder_path}: ${folder.description}`)
      .join("\n");
  const userText = `## Placement Rules\n${renderPlacementRulesBlock(placementRules)}\n` +
    `## Approved Directory Tree\n${tree || "(none)"}\n\n` +
    renderFileMetadataBlock(fileInfo) +
    `\n` +
    `## File Contents\n${contentSummary || "(none)"}\n`;
  const messages: ChatMessage[] = [
    {role: "system", content: prompts.proposePlacement.prompt},
    {role: "user", content: userText},
  ];
  return await defaultCompletion<ProposePlacementResult>(
      messages,
      prompts.proposePlacement.model,
      prompts.proposePlacement.temperature ?? DEFAULT_TEMP,
      ProposePlacementSchema,
      uid,
      {promptVersion: versions.PROMPT_PROPOSE_PLACEMENT_VERSION},
  ) as ProposePlacementResult;
}

/** Renders a proposal folder tree as plain text for prompt context. */
function renderFolderTreePlainText(proposal: DriveOrganizeProposal): string {
  type TreeNode = {
    children: Map<string, TreeNode>;
    fullPath: string;
  };

  let tree = "My Drive\n";
  if (proposal.proposed_folders.length === 0) {
    return tree;
  }

  const root: TreeNode = {
    children: new Map<string, TreeNode>(),
    fullPath: "",
  };
  const uniquePaths = new Set<string>();

  for (const folder of proposal.proposed_folders) {
    const normalizedPath = normalizeFolderPath(folder.folder_path);
    if (!normalizedPath) {
      continue;
    }
    uniquePaths.add(normalizedPath);
  }

  for (const folderPath of [...uniquePaths].sort((a, b) => a.localeCompare(b))) {
    let current = root;
    let currentPath = "";
    for (const segment of folderPath.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let child = current.children.get(segment);
      if (!child) {
        child = {children: new Map<string, TreeNode>(), fullPath: currentPath};
        current.children.set(segment, child);
      }
      current = child;
    }
  }

  const fileCounts = new Map<string, number>();
  for (const action of proposal.file_actions) {
    const normalizedFolder = normalizeFolderPath(action.new_folder);
    fileCounts.set(normalizedFolder, (fileCounts.get(normalizedFolder) || 0) + 1);
  }

  /** Renders child tree nodes into the surrounding tree output. */
  function renderChildren(node: TreeNode, prefix: string): void {
    const children = [...node.children.entries()]
        .sort(([left], [right]) => left.localeCompare(right));
    for (let i = 0; i < children.length; i++) {
      const [segment, child] = children[i];
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const count = fileCounts.get(child.fullPath) || 0;
      tree += `${prefix}${branch}${segment}/  (${count} files)\n`;
      renderChildren(child, `${prefix}${isLast ? "    " : "│   "}`);
    }
  }

  renderChildren(root, "");
  return tree.trimEnd();
}

/** Renders the original proposal folder tree for revision prompts. */
function renderOriginalFolderTree(proposal: DriveOrganizeProposal): string {
  type TreeNode = {
    children: Map<string, TreeNode>;
    fullPath: string;
  };

  let tree = "My Drive\n";
  const root: TreeNode = {
    children: new Map<string, TreeNode>(),
    fullPath: "",
  };
  const fileCounts = new Map<string, number>();

  for (const action of proposal.file_actions) {
    const normalizedFolder = normalizeFolderPath(action.current_path || "My Drive") || "My Drive";
    fileCounts.set(normalizedFolder, (fileCounts.get(normalizedFolder) || 0) + 1);
  }

  const uniquePaths = [...fileCounts.keys()]
      .filter((folderPath) => folderPath && folderPath !== "My Drive")
      .sort((a, b) => a.localeCompare(b));
  if (uniquePaths.length === 0) {
    return tree.trimEnd();
  }

  for (const folderPath of uniquePaths) {
    let current = root;
    let currentPath = "";
    for (const segment of folderPath.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let child = current.children.get(segment);
      if (!child) {
        child = {children: new Map<string, TreeNode>(), fullPath: currentPath};
        current.children.set(segment, child);
      }
      current = child;
    }
  }

  /** Renders child tree nodes into the surrounding tree output. */
  function renderChildren(node: TreeNode, prefix: string): void {
    const children = [...node.children.entries()]
        .sort(([left], [right]) => left.localeCompare(right));
    for (let i = 0; i < children.length; i++) {
      const [segment, child] = children[i];
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const count = fileCounts.get(child.fullPath) || 0;
      tree += `${prefix}${branch}${segment}/  (${count} files)\n`;
      renderChildren(child, `${prefix}${isLast ? "    " : "│   "}`);
    }
  }

  renderChildren(root, "");
  return tree.trimEnd();
}

/** Collects a few example filenames for each proposed destination folder. */
function sampleFilenamesPerFolder(
    proposal: DriveOrganizeProposal,
    limit = 3,
): Map<string, string[]> {
  const samples = new Map<string, string[]>();
  for (const action of proposal.file_actions) {
    const folderPath = normalizeFolderPath(action.new_folder);
    if (!folderPath) {
      continue;
    }
    const folderSamples = samples.get(folderPath) || [];
    if (folderSamples.length >= limit) {
      continue;
    }
    if (!folderSamples.includes(action.current_name)) {
      folderSamples.push(action.current_name);
      samples.set(folderPath, folderSamples);
    }
  }
  return samples;
}

/** Matches a folder path against a normalized segment-aware prefix. */
function matchesFolderPrefix(folderPath: string, prefix: string): boolean {
  const normalizedFolderPath = normalizeFolderPath(folderPath);
  const normalizedPrefix = normalizeFolderPath(prefix);
  if (!normalizedFolderPath || !normalizedPrefix) {
    return false;
  }
  return normalizedFolderPath === normalizedPrefix || normalizedFolderPath.startsWith(`${normalizedPrefix}/`);
}

/** Returns the lowercased extension without the leading dot. */
function getLowercaseExtension(filename: string): string {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return "";
  }
  return trimmed.slice(lastDot + 1).toLowerCase();
}

/** Filters plan-review file actions to only the scope inferred from the user reply. */
function filterFileActionsByScope(
    fileActions: DriveOrganizeProposal["file_actions"],
    scope: ScopePlanRevisionResult,
): DriveOrganizeProposal["file_actions"] {
  const ignoredPrefixes = new Set(
      scope.folder_prefixes_to_ignore
          .map((folderPath) => normalizeFolderPath(folderPath))
          .filter(Boolean),
  );
  const inScopePrefixes = scope.folder_prefixes_in_scope
      .map((folderPath) => normalizeFolderPath(folderPath))
      .filter(Boolean);
  const filenamePatterns = scope.filename_patterns
      .map((pattern) => pattern.trim().toLowerCase())
      .filter(Boolean);
  const extensions = new Set(
      scope.extensions
          .map((extension) => extension.trim().replace(/^\./, "").toLowerCase())
          .filter(Boolean),
  );
  const explicitHints = new Set(
      scope.explicit_file_hints
          .map((hint) => hint.trim().toLowerCase())
          .filter(Boolean),
  );
  const hasNameFilters = filenamePatterns.length > 0 || extensions.size > 0;

  return fileActions.filter((action) => {
    const currentPath = normalizeFolderPath(action.current_path || "My Drive") || "My Drive";
    const newFolder = normalizeFolderPath(action.new_folder);
    if ([...ignoredPrefixes].some((prefix) =>
      matchesFolderPrefix(currentPath, prefix) || matchesFolderPrefix(newFolder, prefix),
    )) {
      return false;
    }

    const currentNameLower = action.current_name.toLowerCase();
    const newNameLower = action.new_name.toLowerCase();
    if (explicitHints.has(currentNameLower) || explicitHints.has(newNameLower)) {
      return true;
    }

    const matchesPattern = filenamePatterns.length === 0 || filenamePatterns.some((pattern) =>
      currentNameLower.includes(pattern) || newNameLower.includes(pattern),
    );
    const extensionMatches = extensions.size === 0 ||
      extensions.has(getLowercaseExtension(action.current_name)) ||
      extensions.has(getLowercaseExtension(action.new_name));

    if (inScopePrefixes.length > 0) {
      const prefixMatches = inScopePrefixes.some((prefix) =>
        matchesFolderPrefix(currentPath, prefix) || matchesFolderPrefix(newFolder, prefix),
      );
      return prefixMatches && matchesPattern && extensionMatches;
    }

    if (hasNameFilters) {
      return matchesPattern && extensionMatches;
    }

    return false;
  });
}

/**
 * Ensure every top-level proposed folder has an NN-/NNN- prefix and
 * update any file action paths that reference renamed folders.
 */
function normalizeFolderPrefixes(
    proposal: DriveOrganizeProposal,
    skipPaths?: Set<string>,
    folderConvention?: string,
): void {
  const convention = parseNumericCategoryConvention(folderConvention);
  if (!convention) return;
  const paddingWidth = convention.width;
  let maxPrefix = 0;
  const prefixedFolderPattern = new RegExp(`^(\\d+)${escapeRegExp(convention.separator)}`);

  for (const folder of proposal.proposed_folders) {
    const rootSegment = folder.folder_path.split("/")[0];
    const match = rootSegment.match(prefixedFolderPattern);
    if (!match) {
      continue;
    }

    maxPrefix = Math.max(maxPrefix, Number.parseInt(match[1], 10));
  }

  const renameMap = new Map<string, string>();
  for (const folder of proposal.proposed_folders) {
    if (folder.folder_path.includes("/")) {
      continue;
    }

    if (prefixedFolderPattern.test(folder.folder_path)) {
      continue;
    }

    if (skipPaths?.has(folder.folder_path)) {
      continue;
    }

    const oldName = folder.folder_path;
    maxPrefix += 1;
    const newName = `${String(maxPrefix).padStart(paddingWidth, "0")}${convention.separator}${oldName}`;
    renameMap.set(oldName, newName);
    folder.folder_path = newName;
  }

  if (renameMap.size === 0) {
    return;
  }

  const renameEntries = [...renameMap.entries()]
      .sort(([left], [right]) => right.length - left.length);

  for (const folder of proposal.proposed_folders) {
    if (!folder.folder_path.includes("/")) {
      continue;
    }

    const [rootSegment, ...rest] = folder.folder_path.split("/");
    const renamedRoot = renameMap.get(rootSegment);
    if (renamedRoot) {
      folder.folder_path = [renamedRoot, ...rest].join("/");
    }
  }

  for (const action of proposal.file_actions) {
    const exactMatch = renameMap.get(action.new_folder);
    if (exactMatch) {
      action.new_folder = exactMatch;
      continue;
    }

    for (const [oldName, newName] of renameEntries) {
      if (action.new_folder.startsWith(`${oldName}/`)) {
        action.new_folder = `${newName}${action.new_folder.slice(oldName.length)}`;
        break;
      }
    }
  }
}

/** Normalizes folder paths for comparison. */
function normalizeFolderPath(folderPath: string): string {
  return folderPath
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join("/");
}

type FolderCanonicalRegistry = Map<string, string>;

/** Builds a case-folded folder path registry whose first casing wins. */
function buildFolderCanonicalRegistry(paths: Iterable<string>): FolderCanonicalRegistry {
  const registry: FolderCanonicalRegistry = new Map();
  for (const folderPath of paths) {
    canonicalizeFolderPath(folderPath, registry);
  }
  return registry;
}

/** Canonicalizes a folder path segment-by-segment against an existing registry. */
function canonicalizeFolderPath(folderPath: string, registry: FolderCanonicalRegistry): string {
  const segments = normalizeFolderPath(folderPath).split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }

  let canonicalPath = "";
  for (const segment of segments) {
    const candidatePath = canonicalPath ? `${canonicalPath}/${segment}` : segment;
    const key = candidatePath.toLowerCase();
    const registeredPath = registry.get(key);
    if (registeredPath) {
      canonicalPath = registeredPath;
      continue;
    }
    registry.set(key, candidatePath);
    canonicalPath = candidatePath;
  }

  return canonicalPath;
}

/** Removes a numeric prefix from a folder path segment. */
function stripFolderPrefix(segment: string): string {
  return segment.replace(/^\d{1,4}[^A-Za-z0-9]+/, "");
}

/** Splits a normalized folder path into path segments. */
function getFolderSegments(folderPath: string): string[] {
  return normalizeFolderPath(folderPath)
      .split("/")
      .filter(Boolean);
}

const SYNTHESIZED_ANCESTOR_DESCRIPTION =
  "(category root — extend with new entity sibling)";

/**
 * Expands an approved folder list with synthesized ancestor entries so the
 * placement LLM can extend a category root with a new sibling entity folder.
 * Existing approved entries are preserved verbatim; only missing ancestors
 * are added, marked with a constant description.
 */
function expandApprovedTreeWithAncestors(
    folders: DriveOrganizeProposal["proposed_folders"],
): DriveOrganizeProposal["proposed_folders"] {
  const byPath = new Map<string, DriveOrganizeProposal["proposed_folders"][number]>();
  for (const folder of folders) {
    const normalized = normalizeFolderPath(folder.folder_path);
    if (!normalized || byPath.has(normalized)) {
      continue;
    }
    byPath.set(normalized, {...folder, folder_path: normalized});
  }

  for (const folderPath of [...byPath.keys()]) {
    const segments = folderPath.split("/");
    let ancestor = "";
    for (let i = 0; i < segments.length - 1; i++) {
      ancestor = ancestor ? `${ancestor}/${segments[i]}` : segments[i];
      if (byPath.has(ancestor)) continue;
      byPath.set(ancestor, {
        folder_path: ancestor,
        description: SYNTHESIZED_ANCESTOR_DESCRIPTION,
      });
    }
  }

  return [...byPath.values()].sort((left, right) => {
    const leftDepth = left.folder_path.split("/").length;
    const rightDepth = right.folder_path.split("/").length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return left.folder_path.localeCompare(right.folder_path);
  });
}

/** Promotes folder-level changes into file-action entries. */
function promoteFolderChangeAction(
    action: DriveOrganizeProposal["file_actions"][number]["action"],
): DriveOrganizeProposal["file_actions"][number]["action"] {
  if (action === "keep") {
    return "move";
  }
  if (action === "rename") {
    return "move_and_rename";
  }
  return action;
}

/** Applies folder-level operations to a proposal before reconciliation. */
function applyFolderOperations(
    original: DriveOrganizeProposal,
    operations: FolderOperation[],
    summary: string,
): { proposal: DriveOrganizeProposal; preservedRootPaths: Set<string> } {
  const canonicalRegistry = buildFolderCanonicalRegistry(
      original.proposed_folders.map((folder) => normalizeFolderPath(folder.folder_path)),
  );
  let proposedFolders = original.proposed_folders.map((folder) => ({
    ...folder,
    folder_path: canonicalizeFolderPath(folder.folder_path, canonicalRegistry),
  })).filter((folder) => Boolean(folder.folder_path));
  const pinnedFolders = new Set<string>();
  const preservedRootPaths = new Set<string>();
  const fileActions = original.file_actions.map((action) => ({
    ...action,
    current_path: normalizeFolderPath(action.current_path || "My Drive") || "My Drive",
    new_folder: canonicalizeFolderPath(action.new_folder, canonicalRegistry),
  }));

  const folderIndex = new Map<string, DriveOrganizeProposal["proposed_folders"][number]>();
  for (const folder of proposedFolders) {
    if (!folderIndex.has(folder.folder_path)) {
      folderIndex.set(folder.folder_path, folder);
    }
  }
  proposedFolders = [...folderIndex.values()];

  const rebuildFolderIndex = (): void => {
    folderIndex.clear();
    for (const folder of proposedFolders) {
      folderIndex.set(folder.folder_path, folder);
    }
  };

  const replaceFolderPaths = (
      matcher: (folderPath: string) => string | null,
  ): void => {
    const nextFolders: typeof proposedFolders = [];
    const seen = new Set<string>();
    for (const folder of proposedFolders) {
      const nextPath = matcher(folder.folder_path);
      if (!nextPath) {
        continue;
      }
      const normalizedPath = canonicalizeFolderPath(nextPath, canonicalRegistry);
      if (!normalizedPath || seen.has(normalizedPath)) {
        continue;
      }
      const nextFolder = {
        ...folder,
        folder_path: normalizedPath,
      };
      nextFolders.push(nextFolder);
      seen.add(normalizedPath);
    }
    proposedFolders = nextFolders;
    rebuildFolderIndex();
  };

  const ensureFolder = (folderPath: string, description: string): void => {
    const normalizedPath = canonicalizeFolderPath(folderPath, canonicalRegistry);
    if (!normalizedPath || folderIndex.has(normalizedPath)) {
      return;
    }
    const folder = {
      folder_path: normalizedPath,
      description,
    };
    proposedFolders.push(folder);
    folderIndex.set(normalizedPath, folder);
  };

  for (const operation of operations) {
    if (operation.action === "create") {
      const createdPath = canonicalizeFolderPath(operation.path || "", canonicalRegistry);
      ensureFolder(createdPath, operation.description || "");
      if (createdPath) {
        let currentPath = "";
        for (const segment of getFolderSegments(createdPath)) {
          currentPath = currentPath ? `${currentPath}/${segment}` : segment;
          pinnedFolders.add(currentPath);
        }
      }
      continue;
    }

    if (operation.action === "rename") {
      const from = canonicalizeFolderPath(operation.from || "", canonicalRegistry);
      const to = canonicalizeFolderPath(operation.to || "", canonicalRegistry);
      if (!from || !to || from === to) {
        continue;
      }
      if (!folderIndex.has(from)) {
        logger.warn("Drive organize revision: rename source folder missing", {from, to});
        continue;
      }

      replaceFolderPaths((folderPath) => {
        if (folderPath === from) {
          return to;
        }
        if (folderPath.startsWith(`${from}/`)) {
          return `${to}${folderPath.slice(from.length)}`;
        }
        return folderPath;
      });

      for (const action of fileActions) {
        if (action.new_folder === from) {
          action.new_folder = to;
        } else if (action.new_folder.startsWith(`${from}/`)) {
          action.new_folder = `${to}${action.new_folder.slice(from.length)}`;
        } else {
          continue;
        }
        action.action = promoteFolderChangeAction(action.action);
        const renameNote = `Folder renamed: ${from} → ${to}`;
        action.reason = action.reason ? `${action.reason}\n${renameNote}` : renameNote;
      }
      if (operation.description) {
        const renamedFolder = folderIndex.get(to);
        if (renamedFolder) {
          renamedFolder.description = operation.description;
        }
      }
      continue;
    }

    if (operation.action === "merge") {
      const from = canonicalizeFolderPath(operation.from || "", canonicalRegistry);
      const into = canonicalizeFolderPath(operation.into || "", canonicalRegistry);
      if (!from || !into || from === into) {
        logger.warn("Drive organize revision: merge skipped", {from, into});
        continue;
      }

      ensureFolder(into, folderIndex.get(into)?.description || `Merged folder ${into}`);
      replaceFolderPaths((folderPath) => {
        if (folderPath === from) {
          return into;
        }
        if (folderPath.startsWith(`${from}/`)) {
          return `${into}${folderPath.slice(from.length)}`;
        }
        return folderPath;
      });

      for (const action of fileActions) {
        if (action.new_folder === from) {
          action.new_folder = into;
        } else if (action.new_folder.startsWith(`${from}/`)) {
          action.new_folder = `${into}${action.new_folder.slice(from.length)}`;
        } else {
          continue;
        }
        action.action = promoteFolderChangeAction(action.action);
        const mergeNote = `Merged: ${from} → ${into}`;
        action.reason = action.reason ? `${action.reason}\n${mergeNote}` : mergeNote;
      }
      continue;
    }

    if (operation.action === "delete") {
      const folderPath = canonicalizeFolderPath(operation.path || "", canonicalRegistry);
      if (!folderPath) {
        continue;
      }
      for (const action of fileActions) {
        if (action.new_folder !== folderPath && !action.new_folder.startsWith(`${folderPath}/`)) {
          continue;
        }
        action.new_folder = action.current_path;
        action.new_name = action.current_name;
        action.action = "keep";
        action.reason = `Reverted: folder "${folderPath}" deleted by user revision`;

        const segments = getFolderSegments(action.current_path);
        let currentFolder = "";
        for (const segment of segments) {
          currentFolder = currentFolder ? `${currentFolder}/${segment}` : segment;
          ensureFolder(currentFolder, "Reverted source folder");
        }

        const preservedRoot = segments[0];
        if (preservedRoot && preservedRoot !== "My Drive") {
          preservedRootPaths.add(preservedRoot);
        }
      }
      proposedFolders = proposedFolders.filter((folder) =>
        folder.folder_path !== folderPath && !folder.folder_path.startsWith(`${folderPath}/`),
      );
      rebuildFolderIndex();
      continue;
    }

    if (operation.action === "preserve_source") {
      const sourcePath = canonicalizeFolderPath(operation.source_path || "My Drive", canonicalRegistry) || "My Drive";
      const preservedFolders = new Set<string>();
      for (const action of fileActions) {
        const currentPath = canonicalizeFolderPath(action.current_path || "My Drive", canonicalRegistry) || "My Drive";
        if (currentPath !== sourcePath && !currentPath.startsWith(`${sourcePath}/`)) {
          continue;
        }
        action.new_folder = currentPath;
        action.new_name = action.current_name;
        action.action = "keep";
        action.reason = `Preserved by user: "${sourcePath}" left as-is`;
        preservedFolders.add(currentPath);
      }

      for (const folderPath of preservedFolders) {
        const segments = getFolderSegments(folderPath);
        let currentFolder = "";
        for (const segment of segments) {
          currentFolder = currentFolder ? `${currentFolder}/${segment}` : segment;
          ensureFolder(currentFolder, "Preserved source folder");
        }
      }

      for (const folderPath of preservedFolders) {
        const preservedRoot = getFolderSegments(folderPath)[0];
        if (preservedRoot && preservedRoot !== "My Drive") {
          preservedRootPaths.add(preservedRoot);
        }
      }
    }
  }

  // Auto-detect previously preserved folders from file_actions so that
  // subsequent revisions inherit preservation even when the LLM does not
  // re-emit preserve_source or delete operations for them.
  for (const action of fileActions) {
    if (action.action === "keep" &&
        (action.reason?.startsWith("Preserved by user:") ||
         action.reason?.startsWith("Reverted:"))) {
      const root = getFolderSegments(action.new_folder)[0];
      if (root && root !== "My Drive") {
        preservedRootPaths.add(root);
      }
    }
  }

  const referencedFolders = new Set<string>();
  for (const action of fileActions) {
    const folderPath = canonicalizeFolderPath(action.new_folder, canonicalRegistry);
    if (!folderPath) {
      continue;
    }
    referencedFolders.add(folderPath);
    let currentPath = "";
    for (const segment of getFolderSegments(folderPath)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      referencedFolders.add(currentPath);
    }
  }

  proposedFolders = proposedFolders.filter((folder) =>
    referencedFolders.has(normalizeFolderPath(folder.folder_path)) ||
    pinnedFolders.has(normalizeFolderPath(folder.folder_path)),
  );
  rebuildFolderIndex();

  return {
    proposal: {
      proposed_folders: proposedFolders,
      file_actions: fileActions,
      summary,
    },
    preservedRootPaths,
  };
}

/** Renumbers proposal folders while preserving requested roots. */
interface NumericCategoryConvention {
  width: number;
  separator: string;
}

/**
 * Parse numeric category folder convention tokens (e.g. "NN-Category" or
 * "NN|Category"). Returns null for non-numeric conventions.
 */
function parseNumericCategoryConvention(folderConvention?: string): NumericCategoryConvention | null {
  if (!folderConvention) return null;
  const m = folderConvention.trim().match(/^(N+)(.+?)Category\b/);
  if (!m || !m[2]) return null;
  return {
    width: m[1].length,
    separator: m[2],
  };
}

function rewriteRootSeparator(root: string, convention: NumericCategoryConvention): string {
  const prefixMatch = root.match(new RegExp(`^(\\d{${convention.width}})(.*)$`));
  if (!prefixMatch) return root;
  const [, prefix, rest] = prefixMatch;
  if (rest.startsWith(convention.separator)) return root;
  if (!/^[^A-Za-z0-9]+/.test(rest)) return root;
  const category = rest.replace(/^[^A-Za-z0-9]+/, "");
  return category ? `${prefix}${convention.separator}${category}` : root;
}

function normalizeFolderConventionSeparators<T extends {folder_path: string}>(
    folders: T[],
    folderConvention?: string,
): T[] {
  const convention = parseNumericCategoryConvention(folderConvention);
  if (!convention) return folders;

  return folders.map((folder) => {
    const segments = getFolderSegments(folder.folder_path);
    if (segments.length === 0) return folder;
    const rewrittenRoot = rewriteRootSeparator(segments[0], convention);
    if (rewrittenRoot === segments[0]) return folder;
    return {
      ...folder,
      folder_path: [rewrittenRoot, ...segments.slice(1)].join("/"),
    };
  });
}

function renumberFoldersContiguously(
    proposal: DriveOrganizeProposal,
    skipPaths?: Set<string>,
    folderConvention?: string,
): void {
  const convention = parseNumericCategoryConvention(folderConvention);
  if (!convention) return;
  const paddingWidth = convention.width;
  const escapedSeparator = escapeRegExp(convention.separator);
  const prefixedFolderPattern = new RegExp(`^(\\d+)${escapedSeparator}`);
  const compareFolderPaths = (left: string, right: string): number => {
    const leftSegments = getFolderSegments(left);
    const rightSegments = getFolderSegments(right);
    const leftRoot = leftSegments[0] || "";
    const rightRoot = rightSegments[0] || "";
    const leftPrefix = leftRoot.match(prefixedFolderPattern);
    const rightPrefix = rightRoot.match(prefixedFolderPattern);

    if (leftPrefix && rightPrefix) {
      const leftValue = Number.parseInt(leftPrefix[1], 10);
      const rightValue = Number.parseInt(rightPrefix[1], 10);
      if (leftValue !== rightValue) {
        return leftValue - rightValue;
      }
    } else if (leftPrefix || rightPrefix) {
      return leftPrefix ? -1 : 1;
    }

    return left.localeCompare(right, undefined, {sensitivity: "base"});
  };
  const renameMap = new Map<string, string>();
  const rootSegments = [...new Set(
      proposal.proposed_folders
          .map((folder) => getFolderSegments(folder.folder_path)[0])
          .filter((segment): segment is string => Boolean(segment) && !skipPaths?.has(segment)),
  )];
  const prefixed = rootSegments
      .filter((segment) => prefixedFolderPattern.test(segment))
      .sort((left, right) => {
        const leftPrefix = Number.parseInt(left.match(prefixedFolderPattern)![1], 10);
        const rightPrefix = Number.parseInt(right.match(prefixedFolderPattern)![1], 10);
        if (leftPrefix !== rightPrefix) {
          return leftPrefix - rightPrefix;
        }
        return left.localeCompare(right);
      });
  const unprefixed = rootSegments
      .filter((segment) => !prefixedFolderPattern.test(segment))
      .sort((left, right) =>
        left.localeCompare(right, undefined, {sensitivity: "base"}),
      );
  const orderedSegments = [...prefixed, ...unprefixed];

  for (let index = 0; index < orderedSegments.length; index++) {
    const segment = orderedSegments[index];
    const newPrefix = String(index + 1).padStart(paddingWidth, "0");
    const renamed = `${newPrefix}${convention.separator}${segment.replace(prefixedFolderPattern, "")}`;
    if (renamed !== segment) {
      renameMap.set(segment, renamed);
    }
  }

  if (renameMap.size === 0) {
    const seenFolderPaths = new Set<string>();
    proposal.proposed_folders = proposal.proposed_folders.filter((folder) => {
      const normalizedPath = normalizeFolderPath(folder.folder_path);
      if (!normalizedPath || seenFolderPaths.has(normalizedPath)) {
        return false;
      }
      folder.folder_path = normalizedPath;
      seenFolderPaths.add(normalizedPath);
      return true;
    });
    return;
  }

  for (const folder of proposal.proposed_folders) {
    const segments = getFolderSegments(folder.folder_path);
    if (segments.length === 0) {
      continue;
    }

    const renamedRoot = renameMap.get(segments[0]);
    if (renamedRoot) {
      segments[0] = renamedRoot;
    }
    folder.folder_path = segments.join("/");
  }

  for (const action of proposal.file_actions) {
    const segments = getFolderSegments(action.new_folder);
    if (segments.length === 0) {
      continue;
    }

    const renamedRoot = renameMap.get(segments[0]);
    if (renamedRoot) {
      segments[0] = renamedRoot;
      action.new_folder = segments.join("/");
    }
  }

  const seenFolderPaths = new Set<string>();
  proposal.proposed_folders = proposal.proposed_folders.filter((folder) => {
    const normalizedPath = normalizeFolderPath(folder.folder_path);
    if (!normalizedPath || seenFolderPaths.has(normalizedPath)) {
      return false;
    }
    folder.folder_path = normalizedPath;
    seenFolderPaths.add(normalizedPath);
    return true;
  });
  proposal.proposed_folders.sort((left, right) =>
    compareFolderPaths(left.folder_path, right.folder_path),
  );
}

/** Returns folder segments without numeric prefixes for semantic matching. */
function getFolderSemanticSegments(folderPath: string): string[] {
  return getFolderSegments(folderPath).map((segment) => stripFolderPrefix(segment));
}

/** Counts matching path segments from the end of two paths. */
function getSharedSuffixLength(left: string[], right: string[]): number {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

/** Counts matching path segments from the start of two paths. */
function getSharedPrefixLength(left: string[], right: string[]): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) {
    count += 1;
  }
  return count;
}

/** Finds the revised folder path that best matches an original path. */
function findClosestRevisedFolder(
    originalFolder: string,
    revisedFolders: string[],
): string | null {
  if (revisedFolders.length === 0) {
    return null;
  }

  const originalSegments = getFolderSemanticSegments(originalFolder);
  let bestMatch: string | null = null;
  let bestScore = -1;
  let bestSuffix = -1;

  for (const candidate of revisedFolders) {
    const candidateSegments = getFolderSemanticSegments(candidate);
    const suffixScore = getSharedSuffixLength(originalSegments, candidateSegments);
    const prefixScore = getSharedPrefixLength(originalSegments, candidateSegments);
    const totalScore = suffixScore * 10 + prefixScore;
    if (totalScore > bestScore || (totalScore === bestScore && suffixScore > bestSuffix)) {
      bestMatch = candidate;
      bestScore = totalScore;
      bestSuffix = suffixScore;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

/**
 * Normalizes file action folder paths against the proposal folder set.
 * Remaps mismatched folders by base name, numeric prefix, or closest semantic match, and auto-adds folders for keep
 * actions that reference unknown existing folders.
 *
 * @example
 * ```ts
 * const proposal = {
 *   proposed_folders: [{folder_path: "01-Documents", description: "Documents"}],
 *   file_actions: [
 *     {new_folder: "Documents", action: "move"},
 *     {new_folder: "Client Uploads", action: "keep"},
 *   ],
 *   summary: "",
 * };
 *
 * reconcileFileActions(proposal);
 * // proposal.file_actions[0].new_folder === "01-Documents"
 * // proposal.proposed_folders includes "Client Uploads"
 * ```
 */
function reconcileFileActions(proposal: DriveOrganizeProposal): void {
  const normalizedFolders = new Set<string>();
  const folderDescriptions = new Map<string, string>();
  for (const folder of proposal.proposed_folders) {
    const normalizedPath = normalizeFolderPath(folder.folder_path);
    if (!normalizedPath || normalizedFolders.has(normalizedPath)) {
      continue;
    }
    normalizedFolders.add(normalizedPath);
    folderDescriptions.set(normalizedPath, folder.description);
    folder.folder_path = normalizedPath;
  }

  const proposedFolderPaths = [...normalizedFolders].sort((a, b) => a.localeCompare(b));
  const proposedRoots = [...new Set(
      proposedFolderPaths
          .map((folderPath) => getFolderSegments(folderPath)[0])
          .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
  const prefixedFolderPattern = /^(\d{2,3})-/;

  const baseNameRootMap = new Map<string, string>();
  const prefixRootMap = new Map<string, string>();
  for (const root of proposedRoots) {
    const baseName = stripFolderPrefix(root).toLowerCase();
    if (!baseNameRootMap.has(baseName)) {
      baseNameRootMap.set(baseName, root);
    } else {
      const current = baseNameRootMap.get(baseName)!;
      const currentDepth = getFolderSegments(current).length;
      const candidateDepth = getFolderSegments(root).length;
      if (candidateDepth < currentDepth || (candidateDepth === currentDepth && root.localeCompare(current) < 0)) {
        baseNameRootMap.set(baseName, root);
      }
    }

    const prefixMatch = root.match(prefixedFolderPattern);
    if (prefixMatch && !prefixRootMap.has(prefixMatch[1])) {
      prefixRootMap.set(prefixMatch[1], root);
    }
  }

  let reconciled = 0;
  let keepFoldersAdded = 0;
  let unmapped = 0;

  for (const action of proposal.file_actions) {
    const normalizedNewFolder = normalizeFolderPath(action.new_folder);
    action.new_folder = normalizedNewFolder;

    if (!normalizedNewFolder || normalizedFolders.has(normalizedNewFolder)) {
      continue;
    }

    let mappedFolder: string | null = null;
    const segments = getFolderSegments(normalizedNewFolder);
    if (segments.length > 0) {
      const [rootSegment, ...rest] = segments;
      let mappedRoot = baseNameRootMap.get(stripFolderPrefix(rootSegment).toLowerCase());
      if (!mappedRoot) {
        const prefixMatch = rootSegment.match(prefixedFolderPattern);
        if (prefixMatch) {
          mappedRoot = prefixRootMap.get(prefixMatch[1]);
        }
      }
      if (mappedRoot) {
        const candidate = [mappedRoot, ...rest].join("/");
        if (normalizedFolders.has(candidate)) {
          mappedFolder = candidate;
        } else if (rest.length === 0) {
          mappedFolder = mappedRoot;
        }
      }
    }

    if (!mappedFolder) {
      mappedFolder = findClosestRevisedFolder(normalizedNewFolder, proposedFolderPaths);
    }

    if (!mappedFolder && segments.length === 1) {
      mappedFolder = baseNameRootMap.get(stripFolderPrefix(segments[0]).toLowerCase()) || null;
    }

    if (mappedFolder) {
      action.new_folder = mappedFolder;
      reconciled += 1;
      continue;
    }

    if (action.action === "keep" && normalizedNewFolder &&
        normalizedNewFolder !== "My Drive") {
      const pathSegments = getFolderSegments(normalizedNewFolder);
      let currentPath = "";
      for (const segment of pathSegments) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        if (normalizedFolders.has(currentPath)) {
          continue;
        }
        normalizedFolders.add(currentPath);
        folderDescriptions.set(currentPath, "Existing folder");
        proposal.proposed_folders.push({
          folder_path: currentPath,
          description: "Existing folder",
        });
        keepFoldersAdded += 1;
      }
      continue;
    }

    unmapped += 1;
  }

  proposal.proposed_folders = [...normalizedFolders]
      .sort((a, b) => a.localeCompare(b))
      .map((folderPath) => ({
        folder_path: folderPath,
        description: folderDescriptions.get(folderPath) || "",
      }));

  logger.info("Drive organize: reconciled file actions", {
    reconciled,
    keepFoldersAdded,
    unmapped,
  });
}

/** Merges a revision proposal into the original proposal. */
function mergeRevisedProposal(
    original: DriveOrganizeProposal,
    revised: DriveOrganizeProposal,
): DriveOrganizeProposal {
  const revisedFileIds = new Set(revised.file_actions.map((action) => action.file_id));
  const merged: DriveOrganizeProposal = {
    proposed_folders: revised.proposed_folders.map((folder) => ({...folder})),
    file_actions: [...revised.file_actions],
    summary: revised.summary,
  };

  let carriedOverCount = 0;
  for (const action of original.file_actions) {
    if (revisedFileIds.has(action.file_id)) {
      continue;
    }

    merged.file_actions.push({
      ...action,
      new_folder: normalizeFolderPath(action.new_folder),
    });
    carriedOverCount += 1;
  }

  reconcileFileActions(merged);

  // Prune folders with no file actions pointing to them (directly or as parent).
  // After a revision, the LLM or carry-over reconciliation may leave stale
  // folders (e.g. "13-Pavonis") that had all their files moved elsewhere.
  const referencedFolders = new Set<string>();
  for (const action of merged.file_actions) {
    const folder = normalizeFolderPath(action.new_folder);
    if (!folder) continue;
    referencedFolders.add(folder);
    const segments = getFolderSegments(folder);
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      referencedFolders.add(path);
    }
  }
  const beforeCount = merged.proposed_folders.length;
  merged.proposed_folders = merged.proposed_folders.filter((f) =>
    referencedFolders.has(normalizeFolderPath(f.folder_path)),
  );

  logger.info("Drive organize revision: merged revised proposal", {
    originalCount: original.file_actions.length,
    revisedCount: revised.file_actions.length,
    mergedCount: merged.file_actions.length,
    carriedOverCount,
    prunedFolders: beforeCount - merged.proposed_folders.length,
  });

  return merged;
}


export {
  proposeFilePlacement,
  DEFAULT_FOLDER_CONVENTION,
  DEFAULT_FILENAME_CONVENTION,
  renderFolderConventionBlock,
  interpretMoveInstructions,
  reviseOrganization,
  refineDirectoryTree,
  renderFolderTreePlainText,
  normalizeFolderPrefixes,
  normalizeFolderConventionSeparators,
  renumberFoldersContiguously,
  mergeRevisedProposal,
  applyFolderOperations,
  buildFolderCanonicalRegistry,
  canonicalizeFolderPath,
  expandApprovedTreeWithAncestors,
  detectFolderConvention,
  setPreferences,
  analyzeDirectoryStructure,
  evaluateDirectoryPlacement,
  finalizeDirectoryMap,
  classifyConventionChange,
  classifyFolderConventionChange,
  classifyPlacementSetupChange,
  classifyPlacementRulesChange,
  extractNamedEntities,
  proposeFileName,
  proposePlacement,
  generateFilenameExamples,
  revisePlanFileActions,
  scopePlanRevision,
  sampleFilenamesPerFolder,
  filterFileActionsByScope,
};
export type {FolderCanonicalRegistry};
