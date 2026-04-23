import {DriveOrganizeProposal, OrganizeEmbeddedData} from "../types";

/**
 * Render proposed folder tree as monospace HTML.
 */
export function renderFolderTree(
    proposal: DriveOrganizeProposal,
    preservedRootPaths?: Set<string>,
    preservedFolderPaths?: Set<string>,
): string {
  type TreeNode = {
    children: Map<string, TreeNode>;
    fullPath: string;
  };

  let tree = "My Drive/<br>";
  if (proposal.proposed_folders.length === 0) {
    return tree;
  }

  const root: TreeNode = {
    children: new Map<string, TreeNode>(),
    fullPath: "",
  };
  const uniquePaths = new Set<string>();

  for (const folder of proposal.proposed_folders) {
    const normalizedPath = folder.folder_path
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join("/");
    if (!normalizedPath) {
      continue;
    }
    uniquePaths.add(normalizedPath);
  }

  for (const folderPath of preservedFolderPaths || []) {
    const normalizedPath = folderPath
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join("/");
    if (!normalizedPath) {
      continue;
    }
    let currentPath = "";
    for (const segment of normalizedPath.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      uniquePaths.add(currentPath);
    }
  }

  for (const action of proposal.file_actions) {
    if (action.action !== "keep" ||
        (!action.reason?.startsWith("Preserved by user:") &&
         !action.reason?.startsWith("Reverted:"))) {
      continue;
    }
    let currentPath = "";
    for (const segment of action.new_folder
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      uniquePaths.add(currentPath);
    }
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
    fileCounts.set(action.new_folder, (fileCounts.get(action.new_folder) || 0) + 1);
  }

  /** Renders child folders in the proposed folder tree. */
  function renderChildren(node: TreeNode, prefix: string, depth = 0): void {
    const children = [...node.children.entries()]
        .sort(([left], [right]) => left.localeCompare(right));
    for (let i = 0; i < children.length; i++) {
      const [segment, child] = children[i];
      const isLast = i === children.length - 1;
      const branch = isLast ? "└── " : "├── ";

      if (preservedFolderPaths?.has(child.fullPath)) {
        let totalCount = 0;
        for (const [folderPath, count] of fileCounts.entries()) {
          if (folderPath === child.fullPath || folderPath.startsWith(`${child.fullPath}/`)) {
            totalCount += count;
          }
        }
        tree += `${prefix}${branch}${segment}/&nbsp;&nbsp;(${totalCount} files, preserved)<br>`;
        continue;
      }

      if (depth === 0 && preservedRootPaths?.has(segment)) {
        let totalCount = 0;
        for (const [folderPath, count] of fileCounts.entries()) {
          if (folderPath === child.fullPath || folderPath.startsWith(`${child.fullPath}/`)) {
            totalCount += count;
          }
        }
        tree += `${prefix}${branch}${segment}/&nbsp;&nbsp;(${totalCount} files, preserved)<br>`;
        continue;
      }

      const count = fileCounts.get(child.fullPath) || 0;
      tree += `${prefix}${branch}${segment}/&nbsp;&nbsp;(${count} files)<br>`;
      renderChildren(
          child,
          `${prefix}${isLast ? "&nbsp;&nbsp;&nbsp;&nbsp;" : "│&nbsp;&nbsp;&nbsp;"}`,
          depth + 1,
      );
    }
  }

  renderChildren(root, "");
  return tree;
}

/**
 * Build embedded organize data for proposal tracking.
 */
export function buildOrganizeEmbeddedData(data: OrganizeEmbeddedData): string {
  const json = JSON.stringify(data);
  const encoded = Buffer.from(json).toString("base64url");
  const link = `<br><a href="https://www.fwd2drive.com/d?o=${encoded}"` +
    ` style="color:#999;font-size:11px;">View proposal</a>`;
  return link;
}
