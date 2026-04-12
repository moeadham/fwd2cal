import {Auth} from "googleapis";
import {DriveOrganizeProposal, OrganizeSnapshotAction} from "../types";
import {getDriveClient} from "../driveHelper";

/** Verifies moved or renamed files after proposal execution. */
export async function verifyOrganizeResults(
    oauth2Client: Auth.OAuth2Client,
    _proposal: DriveOrganizeProposal,
    _folderMap: Map<string, string>,
    snapshot: OrganizeSnapshotAction[],
): Promise<Array<{fileId: string; expected: string; actual: string}>> {
  const drive = getDriveClient(oauth2Client);
  const mismatches: Array<{fileId: string; expected: string; actual: string}> = [];

  // Only verify actions that actually succeeded (present in snapshot).
  // Failed actions are already counted in stats.failed and should not trigger
  // a full rollback of successful actions.
  const actionsToVerify = snapshot.filter((s) => s.newParentId || s.newName);

  // Verify in batches of 50
  for (let i = 0; i < actionsToVerify.length; i += 50) {
    const batch = actionsToVerify.slice(i, i + 50);
    const checks = batch.map(async (entry) => {
      try {
        const resp = await drive.files.get({
          fileId: entry.fileId,
          fields: "id, name, parents",
        });

        const actualName = resp.data.name || "";
        const actualParentId = resp.data.parents?.[0] || "";

        // Check name — compare base names without extension because
        // Google Drive auto-corrects extensions on Workspace files
        // (e.g. renaming a Google Doc to .doc will become .docx)
        if (entry.newName && actualName !== entry.newName) {
          const expectedBase = entry.newName.replace(/\.[^.]+$/, "");
          const actualBase = actualName.replace(/\.[^.]+$/, "");
          if (expectedBase !== actualBase) {
            mismatches.push({
              fileId: entry.fileId,
              expected: `name="${entry.newName}"`,
              actual: `name="${actualName}"`,
            });
          }
        }

        // Check parent
        if (entry.newParentId && actualParentId !== entry.newParentId) {
          mismatches.push({
            fileId: entry.fileId,
            expected: `parent="${entry.newParentId}"`,
            actual: `parent="${actualParentId}"`,
          });
        }
      } catch {
        mismatches.push({
          fileId: entry.fileId,
          expected: "accessible",
          actual: "not found or inaccessible",
        });
      }
    });
    await Promise.all(checks);
  }

  return mismatches;
}

// ============================================================================
