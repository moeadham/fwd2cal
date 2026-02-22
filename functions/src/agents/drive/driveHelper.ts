import {google, drive_v3 as driveV3, Auth} from "googleapis";
import {logger} from "firebase-functions/v2";
import {DriveFolder} from "./types";
import {Readable} from "stream";

/**
 * Get a Google Drive API client
 */
function getDriveClient(oauth2Client: Auth.OAuth2Client): driveV3.Drive {
  return google.drive({version: "v3", auth: oauth2Client});
}

/**
 * List all folders in the user's Drive and build a tree structure
 */
async function getDriveFolderTree(
    oauth2Client: Auth.OAuth2Client,
): Promise<DriveFolder[]> {
  const drive = getDriveClient(oauth2Client);
  const folders: Array<{id: string; name: string; parents?: string[]}> = [];

  let pageToken: string | undefined;
  do {
    const response = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'me' in owners",
      fields: "nextPageToken, files(id, name, parents)",
      pageSize: 1000,
      pageToken: pageToken,
    });

    const files = response.data.files || [];
    for (const file of files) {
      if (file.id && file.name) {
        folders.push({
          id: file.id,
          name: file.name,
          parents: file.parents || undefined,
        });
      }
    }
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  logger.info("Retrieved Drive folders", {count: folders.length});

  // Build tree from flat list
  const folderMap = new Map<string, DriveFolder>();
  for (const folder of folders) {
    folderMap.set(folder.id, {
      id: folder.id,
      name: folder.name,
      path: folder.name,
      parentId: folder.parents?.[0] || null,
      children: [],
    });
  }

  // Build parent-child relationships and compute paths
  const roots: DriveFolder[] = [];
  for (const folder of folderMap.values()) {
    if (folder.parentId && folderMap.has(folder.parentId)) {
      folderMap.get(folder.parentId)!.children.push(folder);
    } else {
      // Root-level folder (parent is the Drive root or not in our list)
      roots.push(folder);
    }
  }

  // Compute full paths recursively
  function computePaths(node: DriveFolder, parentPath: string): void {
    node.path = parentPath ? `${parentPath}/${node.name}` : node.name;
    for (const child of node.children) {
      computePaths(child, node.path);
    }
  }
  for (const root of roots) {
    computePaths(root, "");
  }

  return roots;
}

/**
 * Format the folder tree as indented text for the LLM prompt
 */
function formatFolderTreeForLLM(roots: DriveFolder[]): string {
  const lines: string[] = [];

  function walk(node: DriveFolder, depth: number): void {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${node.name}/ [id: ${node.id}]`);
    // Sort children alphabetically for consistency
    const sorted = [...node.children].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of sorted) {
      walk(child, depth + 1);
    }
  }

  // Sort roots alphabetically
  const sorted = [...roots].sort((a, b) => a.name.localeCompare(b.name));
  for (const root of sorted) {
    walk(root, 0);
  }

  return lines.join("\n");
}

/**
 * Upload a file to Google Drive
 */
async function uploadFile(
    oauth2Client: Auth.OAuth2Client,
    folderId: string,
    fileName: string,
    mimeType: string,
    content: Readable,
): Promise<{id: string; webViewLink: string}> {
  const drive = getDriveClient(oauth2Client);

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType: mimeType,
      body: content,
    },
    fields: "id, webViewLink",
  });

  if (!response.data.id) {
    throw new Error("Drive upload failed: no file ID returned");
  }

  return {
    id: response.data.id,
    webViewLink: response.data.webViewLink || "",
  };
}

/**
 * Create a folder in Google Drive
 */
async function createFolder(
    oauth2Client: Auth.OAuth2Client,
    name: string,
    parentId: string,
): Promise<string> {
  const drive = getDriveClient(oauth2Client);

  const response = await drive.files.create({
    requestBody: {
      name: name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });

  if (!response.data.id) {
    throw new Error(`Failed to create folder: ${name}`);
  }

  logger.info("Created Drive folder", {name, parentId, id: response.data.id});
  return response.data.id;
}

/**
 * Find a folder by ID in the tree, or return null
 */
function findFolderInTree(
    roots: DriveFolder[],
    folderId: string,
): DriveFolder | null {
  for (const root of roots) {
    if (root.id === folderId) return root;
    const found = findFolderInTree(root.children, folderId);
    if (found) return found;
  }
  return null;
}

/**
 * Get the Drive root folder ID (for uploading to root)
 */
async function getRootFolderId(
    oauth2Client: Auth.OAuth2Client,
): Promise<string> {
  const drive = getDriveClient(oauth2Client);
  const response = await drive.files.get({
    fileId: "root",
    fields: "id",
  });
  return response.data.id || "root";
}

/**
 * Move a file to a new folder in Google Drive
 */
async function moveFile(
    oauth2Client: Auth.OAuth2Client,
    fileId: string,
    newParentId: string,
    oldParentId: string,
): Promise<{id: string; webViewLink: string}> {
  const drive = getDriveClient(oauth2Client);
  const response = await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: oldParentId,
    fields: "id, webViewLink, parents",
  });

  if (!response.data.id) {
    throw new Error("Drive move failed: no file ID returned");
  }

  logger.info("Drive: File moved", {fileId, newParentId, oldParentId});
  return {
    id: response.data.id,
    webViewLink: response.data.webViewLink || "",
  };
}

/**
 * Place a hidden marker file `.sorted.by.fwd2drive.com` in a folder.
 * Skips if marker already exists in that folder.
 */
async function placeMarkerFile(
    oauth2Client: Auth.OAuth2Client,
    folderId: string,
): Promise<void> {
  const drive = getDriveClient(oauth2Client);
  const existing = await drive.files.list({
    q: `name = '.sorted.by.fwd2drive.com' and '${folderId}' in parents and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });
  if (existing.data.files?.length) return;

  await drive.files.create({
    requestBody: {
      name: ".sorted.by.fwd2drive.com",
      parents: [folderId],
      mimeType: "text/plain",
    },
    media: {mimeType: "text/plain", body: ""},
  });
  logger.info("Drive: Marker file placed", {folderId});
}

/**
 * Find all agent-managed folders by searching for the marker file.
 * Returns folder names (e.g. ["001-Invoices", "002-Receipts"]).
 */
async function findAgentManagedFolders(
    oauth2Client: Auth.OAuth2Client,
): Promise<Array<{id: string; name: string}>> {
  const drive = getDriveClient(oauth2Client);
  const results: Array<{id: string; name: string}> = [];

  let pageToken: string | undefined;
  do {
    const response = await drive.files.list({
      q: "name = '.sorted.by.fwd2drive.com' and trashed = false",
      fields: "nextPageToken, files(id, parents)",
      pageSize: 100,
      pageToken,
    });

    const markerFiles = response.data.files || [];
    for (const marker of markerFiles) {
      const parentId = marker.parents?.[0];
      if (!parentId) continue;

      // Fetch the parent folder name
      try {
        const folder = await drive.files.get({
          fileId: parentId,
          fields: "id, name",
        });
        if (folder.data.id && folder.data.name) {
          results.push({id: folder.data.id, name: folder.data.name});
        }
      } catch (_err) {
        logger.warn("Drive: Could not fetch marker parent folder", {parentId});
      }
    }
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  logger.info("Drive: Found agent-managed folders", {
    count: results.length,
    folders: results.map((f) => f.name),
  });
  return results;
}

/**
 * Rename a folder in Google Drive.
 */
async function renameFolder(
    oauth2Client: Auth.OAuth2Client,
    folderId: string,
    newName: string,
): Promise<void> {
  const drive = getDriveClient(oauth2Client);
  await drive.files.update({
    fileId: folderId,
    requestBody: {name: newName},
  });
  logger.info("Drive: Folder renamed", {folderId, newName});
}

/**
 * Count non-marker files in a folder.
 */
async function getFolderFileCount(
    oauth2Client: Auth.OAuth2Client,
    folderId: string,
): Promise<number> {
  const drive = getDriveClient(oauth2Client);
  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false` +
      ` and name != '.sorted.by.fwd2drive.com'`,
    fields: "files(id)",
    pageSize: 100,
  });
  return response.data.files?.length || 0;
}

/**
 * Get a folder's parent ID.
 */
async function getDriveFolderParent(
    oauth2Client: Auth.OAuth2Client,
    folderId: string,
): Promise<{parentId: string | null}> {
  const drive = getDriveClient(oauth2Client);
  const response = await drive.files.get({
    fileId: folderId,
    fields: "parents",
  });
  return {parentId: response.data.parents?.[0] || null};
}

export {
  getDriveClient,
  getDriveFolderTree,
  formatFolderTreeForLLM,
  uploadFile,
  createFolder,
  findFolderInTree,
  getRootFolderId,
  moveFile,
  placeMarkerFile,
  findAgentManagedFolders,
  renameFolder,
  getFolderFileCount,
  getDriveFolderParent,
};
