import {z} from "zod";
import {logger} from "firebase-functions/v2";
import {defaultCompletion, DEFAULT_TEMP} from "../../util/openai";
import {prompts} from "./prompts";
import {
  FileProposalSchema,
  FileProposal,
  MoveInstructionSchema,
  MoveInstruction,
  DriveEmbeddedFileData,
  DriveOrganizeProposalSchema,
  DriveOrganizeProposal,
  DriveFileEntry,
  FileInfo,
} from "./types";
import {ChatMessage, TextContent, ImageURLContent} from "../../util/types";
import {REFINE_ORGANIZATION_MODEL} from "./config";

const RefineOrganizationResultSchema = z.object({
  refined_folders: DriveOrganizeProposalSchema.shape.proposed_folders,
  folder_renames: z.array(z.object({
    old_path: z.string().describe("Original folder path"),
    new_path: z.string().describe("New folder path"),
  })).describe("Folder rename mappings to apply to existing file actions"),
  summary: z.string(),
});

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
): Promise<FileProposal> {
  let userText = `## Existing Agent-Managed Folders\n`;
  if (agentFolderNames.length > 0) {
    userText += agentFolderNames.map((f) => `- ${f}`).join("\n") + "\n";
  } else {
    userText += "(none — this is a new user)\n";
  }
  userText += `\nNext available folder prefix: ${nextPrefix}\n\n`;

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
      DEFAULT_TEMP,
      FileProposalSchema,
      uid,
  );

  return result as FileProposal;
}

/**
 * Interpret a user's reply to move uploaded files to a new location.
 */
async function interpretMoveInstructions(
    replyText: string,
    currentFiles: DriveEmbeddedFileData[],
    agentFolders: {name: string; id: string}[],
    uid: string | null = null,
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

  let userContent = `## User's Instructions\n${replyText}\n\n`;

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
      DEFAULT_TEMP,
      MoveInstructionSchema,
      uid,
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
): Promise<DriveOrganizeProposal> {
  let userText = `## User Requested Changes\n${userInstructions}\n\n`;

  userText += `## Current Proposed Folders\n`;
  if (currentProposal.proposed_folders.length > 0) {
    for (const folder of currentProposal.proposed_folders) {
      userText += `- ${folder.folder_path}: ${folder.description}\n`;
    }
  } else {
    userText += "(none)\n";
  }

  userText += `\n## Current File Actions\n`;
  if (currentProposal.file_actions.length > 0) {
    for (const action of currentProposal.file_actions) {
      userText += `- [${action.file_id}] "${action.current_name}" from "${action.current_path}"` +
        ` -> "${action.new_folder}/${action.new_name}" (${action.action})` +
        ` reason: ${action.reason}\n`;
    }
  } else {
    userText += "(none)\n";
  }

  userText += `\n## Current Summary\n${currentProposal.summary}\n`;

  const messages: ChatMessage[] = [
    {role: "system", content: prompts.reviseOrganization.prompt},
    {role: "user", content: userText},
  ];

  logger.info("Drive organize revision prompt", {
    fileActions: currentProposal.file_actions.length,
    proposedFolders: currentProposal.proposed_folders.length,
    userTextLength: userText.length,
  });

  const result = await defaultCompletion<DriveOrganizeProposal>(
      messages,
      prompts.reviseOrganization.model,
      DEFAULT_TEMP,
      DriveOrganizeProposalSchema,
      uid,
  );

  const revisedProposal = result as DriveOrganizeProposal;
  normalizeFolderPrefixes(revisedProposal);
  return revisedProposal;
}

/**
 * Build user text for a single chunk of files.
 */
function buildChunkUserText(
    driveStructureSummary: string,
    existingFolders: DriveOrganizeProposal["proposed_folders"],
    chunkFiles: DriveFileEntry[],
    chunkIndex: number,
    totalChunks: number,
    totalFiles: number,
): string {
  let userText = `## Current Drive Structure\n`;
  userText += driveStructureSummary + "\n\n";

  if (existingFolders.length > 0) {
    userText += `## Previously Proposed Folders (reuse these)\n`;
    for (const folder of existingFolders) {
      userText += `- ${folder.folder_path}: ${folder.description}\n`;
    }
    userText += "\n";
  }

  const nonFolders = chunkFiles.filter((f) => !f.isFolder);
  userText += `## File Batch ${chunkIndex + 1}/${totalChunks}` +
    ` (${nonFolders.length} files, ${totalFiles} total in drive)\n`;
  for (const file of nonFolders) {
    userText += `- [${file.id}] "${file.name}" in "${file.parentPath}" ` +
      `(${file.mimeType}, created: ${file.createdTime}, ` +
      `${file.size} bytes)\n`;
  }
  userText += `\nYou MUST return exactly ${nonFolders.length} file_actions — one per file above.\n`;

  return userText;
}

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

/**
 * Ensure every top-level proposed folder has an NN-/NNN- prefix and
 * update any file action paths that reference renamed folders.
 */
function normalizeFolderPrefixes(proposal: DriveOrganizeProposal): void {
  let maxPrefix = 0;
  const prefixedFolderPattern = /^(\d{2,3})-/;

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

    const oldName = folder.folder_path;
    maxPrefix += 1;
    const newName = `${String(maxPrefix).padStart(2, "0")}-${oldName}`;
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

function normalizeFolderPath(folderPath: string): string {
  return folderPath
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join("/");
}

function stripFolderPrefix(segment: string): string {
  return segment.replace(/^\d{2,3}-/, "");
}

function getFolderSegments(folderPath: string): string[] {
  return normalizeFolderPath(folderPath)
      .split("/")
      .filter(Boolean);
}

function getFolderSemanticSegments(folderPath: string): string[] {
  return getFolderSegments(folderPath).map((segment) => stripFolderPrefix(segment));
}

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

function getSharedPrefixLength(left: string[], right: string[]): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) {
    count += 1;
  }
  return count;
}

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

async function refineOrganizationProposal(
    proposal: DriveOrganizeProposal,
    uid: string | null = null,
): Promise<DriveOrganizeProposal> {
  const actionCounts = {
    move: 0,
    rename: 0,
    move_and_rename: 0,
    keep: 0,
  };

  for (const action of proposal.file_actions) {
    actionCounts[action.action] += 1;
  }

  const userText = [
    "## Proposed Folder Tree",
    renderFolderTreePlainText(proposal),
    "",
    "## Action Counts",
    `move: ${actionCounts.move}`,
    `rename: ${actionCounts.rename}`,
    `move_and_rename: ${actionCounts.move_and_rename}`,
    `keep: ${actionCounts.keep}`,
    "",
    "## Current Summary",
    proposal.summary,
  ].join("\n");

  const refineModel = REFINE_ORGANIZATION_MODEL.value().trim() || prompts.refineOrganization.model;

  logger.info("Drive organize refinement prompt", {
    model: refineModel,
    proposedFolders: proposal.proposed_folders.length,
    fileActions: proposal.file_actions.length,
    userTextLength: userText.length,
  });

  const messages: ChatMessage[] = [
    {role: "system", content: prompts.refineOrganization.prompt},
    {role: "user", content: userText},
  ];

  const result = await defaultCompletion<z.infer<typeof RefineOrganizationResultSchema>>(
      messages,
      refineModel,
      DEFAULT_TEMP,
      RefineOrganizationResultSchema,
      uid,
  ) as z.infer<typeof RefineOrganizationResultSchema>;

  const refinedProposal: DriveOrganizeProposal = {
    proposed_folders: result.refined_folders.map((folder) => ({...folder})),
    file_actions: proposal.file_actions.map((action) => ({...action})),
    summary: result.summary,
  };

  const renameEntries = result.folder_renames
      .map((r) => [normalizeFolderPath(r.old_path), normalizeFolderPath(r.new_path)] as const)
      .filter(([from, to]) => from && to)
      .sort(([left], [right]) => right.length - left.length);

  for (const action of refinedProposal.file_actions) {
    const normalizedFolder = normalizeFolderPath(action.new_folder);
    let nextFolder = normalizedFolder;

    for (const [from, to] of renameEntries) {
      if (nextFolder === from) {
        nextFolder = to;
        break;
      }
      if (nextFolder.startsWith(`${from}/`)) {
        nextFolder = `${to}${nextFolder.slice(from.length)}`;
        break;
      }
    }

    action.new_folder = nextFolder;
  }

  normalizeFolderPrefixes(refinedProposal);
  reconcileFileActions(refinedProposal);
  return refinedProposal;
}

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

function backfillUncoveredFiles(
    nonFolders: DriveFileEntry[],
    allFileActions: DriveOrganizeProposal["file_actions"],
): DriveOrganizeProposal["file_actions"] {
  const coveredIds = new Set(allFileActions.map((a) => a.file_id));
  const uncoveredFiles = nonFolders.filter((file) => !coveredIds.has(file.id));

  if (uncoveredFiles.length > 0) {
    logger.warn("LLM organize: uncovered files backfilled with keep actions", {
      uncoveredCount: uncoveredFiles.length,
      totalFiles: nonFolders.length,
      coveragePercent: Math.round(((nonFolders.length - uncoveredFiles.length) / Math.max(nonFolders.length, 1)) * 100),
    });
    for (const file of uncoveredFiles) {
      allFileActions.push({
        file_id: file.id,
        current_name: file.name,
        current_path: file.parentPath,
        new_name: file.name,
        new_folder: file.parentPath,
        action: "keep",
        reason: "Safety backfill — not covered by LLM",
      });
    }
  }

  return allFileActions;
}

async function consolidateSummaries(
    summaries: string[],
    uid: string | null = null,
): Promise<string> {
  let finalSummary = summaries[0] ?? "";
  if (summaries.length <= 1) {
    return finalSummary;
  }

  const consolidateMessages: ChatMessage[] = [
    {
      role: "system",
      content: prompts.consolidateSummaries.prompt,
    },
    {
      role: "user",
      content: summaries.map((s, i) =>
        `Batch ${i + 1}: ${s}`).join("\n"),
    },
  ];
  try {
    const result = await defaultCompletion<{summary: string}>(
        consolidateMessages,
        prompts.consolidateSummaries.model,
        DEFAULT_TEMP,
        z.object({summary: z.string()}),
        uid,
    );
    finalSummary = (result as {summary: string}).summary;
  } catch (err) {
    logger.warn("Failed to consolidate summaries, using first", err);
  }
  return finalSummary;
}

/**
 * Propose a full Drive reorganization by processing files in chunks.
 * Each chunk receives the accumulated folder structure from prior chunks.
 */
async function proposeOrganization(
    driveStructureSummary: string,
    fileEntries: DriveFileEntry[],
    chunkSize: number,
    uid: string | null = null,
    seedFolders: DriveOrganizeProposal["proposed_folders"] = [],
): Promise<DriveOrganizeProposal> {
  const nonFolders = fileEntries.filter((f) => !f.isFolder);
  const totalFiles = nonFolders.length;

  // Split non-folder files into chunks
  const chunks: DriveFileEntry[][] = [];
  for (let i = 0; i < nonFolders.length; i += chunkSize) {
    chunks.push(nonFolders.slice(i, i + chunkSize));
  }

  logger.info("LLM organize: starting chunked processing", {
    totalFiles,
    chunkSize,
    totalChunks: chunks.length,
    seedFolders: seedFolders.length,
  });

  // Accumulated state across chunks — start with seed folders from existing Drive structure
  let accumulatedFolders: DriveOrganizeProposal["proposed_folders"] = [...seedFolders];
  let allFileActions: DriveOrganizeProposal["file_actions"] = [];
  const summaries: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const userText = buildChunkUserText(
        driveStructureSummary,
        accumulatedFolders,
        chunk,
        i,
        chunks.length,
        totalFiles,
    );

    const messages: ChatMessage[] = [
      {role: "system", content: prompts.proposeOrganization.prompt},
      {role: "user", content: userText},
    ];

    logger.info(`LLM organize chunk ${i + 1}/${chunks.length}`, {
      chunkFiles: chunk.length,
      existingFolders: accumulatedFolders.length,
      userTextLength: userText.length,
    });

    const result = await defaultCompletion<DriveOrganizeProposal>(
        messages,
        prompts.proposeOrganization.model,
        DEFAULT_TEMP,
        DriveOrganizeProposalSchema,
        uid,
    );

    const chunkProposal = result as DriveOrganizeProposal;
    normalizeFolderPrefixes(chunkProposal);

    logger.info(`LLM organize chunk ${i + 1} result`, {
      proposedFolders: chunkProposal.proposed_folders.length,
      fileActions: chunkProposal.file_actions.length,
      chunkFiles: chunk.length,
    });

    // Update accumulated folders (LLM returns full list each time)
    accumulatedFolders = chunkProposal.proposed_folders;

    // Collect file actions from this chunk
    allFileActions.push(...chunkProposal.file_actions);

    if (chunkProposal.summary) {
      summaries.push(chunkProposal.summary);
    }
  }

  allFileActions = backfillUncoveredFiles(nonFolders, allFileActions);

  const keptCount = allFileActions.filter((a) => a.action === "keep").length;
  logger.info("LLM organize: chunked processing complete", {
    totalFiles,
    filesWithChanges: allFileActions.length - keptCount,
    filesKept: keptCount,
    finalFolders: accumulatedFolders.length,
  });

  const finalSummary = await consolidateSummaries(summaries, uid);

  return {
    proposed_folders: accumulatedFolders,
    file_actions: allFileActions,
    summary: finalSummary,
  };
}

export {
  proposeFilePlacement,
  interpretMoveInstructions,
  proposeOrganization,
  reviseOrganization,
  refineOrganizationProposal,
  buildChunkUserText,
  renderFolderTreePlainText,
  normalizeFolderPrefixes,
  mergeRevisedProposal,
  reconcileFileActions,
  backfillUncoveredFiles,
  consolidateSummaries,
};
