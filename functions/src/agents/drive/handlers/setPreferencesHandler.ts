import {logger} from "firebase-functions/v2";
import {
  getDriveUserPreferences,
  getUserFromEmail,
  saveDriveUserPreferences,
} from "../../../util/firestoreHandler";
import {getSenderFromRawEmail} from "../../../util/emailUtils";
import {TransformedEmail} from "../../../util/types";
import {applyTemplate, sendDriveEmailResponse} from "../driveUtils";
import {
  driveMailTemplates,
  PreferenceChange,
  renderPreferencesUpdatedBlock,
} from "../mailTemplates";
import {DEFAULT_FILENAME_CONVENTION, DEFAULT_FOLDER_CONVENTION, setPreferences} from "../llm";

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Handles emails that update Drive folder and filename conventions. */
export async function handleSetPreferences(
    email: TransformedEmail,
    _emailId: string,
): Promise<void> {
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    logger.warn("Drive preferences: No sender found");
    return;
  }

  const uid = await getUserFromEmail(sender);
  if (!uid) {
    const html = applyTemplate(driveMailTemplates.noUserFound.html, {});
    await sendDriveEmailResponse(sender, email, html);
    return;
  }

  const existingPreferences = await getDriveUserPreferences(uid);
  const currentFolderConvention = getNonEmptyString(existingPreferences.folderConvention) ||
    DEFAULT_FOLDER_CONVENTION;
  const currentFilenameConvention = getNonEmptyString(existingPreferences.filenameConvention) ||
    DEFAULT_FILENAME_CONVENTION;

  const parsed = await setPreferences(
      email.subject || "",
      email.text || email.html || "",
      currentFolderConvention,
      currentFilenameConvention,
      uid,
  );

  const nextFolderConvention = getNonEmptyString(parsed.folderConvention);
  const nextFilenameConvention = getNonEmptyString(parsed.filenameConvention);
  const updates: Record<string, string> = {};
  const changes: PreferenceChange[] = [];

  if (nextFolderConvention && nextFolderConvention !== currentFolderConvention) {
    updates.folderConvention = nextFolderConvention;
    changes.push({
      label: "Folder convention",
      before: currentFolderConvention,
      after: nextFolderConvention,
    });
  }
  if (nextFilenameConvention && nextFilenameConvention !== currentFilenameConvention) {
    updates.filenameConvention = nextFilenameConvention;
    changes.push({
      label: "Filename convention",
      before: currentFilenameConvention,
      after: nextFilenameConvention,
    });
  }

  if (Object.keys(updates).length > 0) {
    await saveDriveUserPreferences(uid, updates);
  }

  const finalFolderConvention = updates.folderConvention || currentFolderConvention;
  const finalFilenameConvention = updates.filenameConvention || currentFilenameConvention;
  const preferencesUpdatedBlock = renderPreferencesUpdatedBlock(
      changes,
      parsed.summary || "Saved your updated preferences.",
  );
  const html = applyTemplate(driveMailTemplates.preferencesUpdated.html, {
    PREFERENCES_UPDATED: preferencesUpdatedBlock,
    CURRENT_FOLDER_CONVENTION: finalFolderConvention,
    CURRENT_FILENAME_CONVENTION: finalFilenameConvention,
  });
  await sendDriveEmailResponse(sender, email, html);
}

export const setPreferencesTestHooks = {
  getNonEmptyString,
};
