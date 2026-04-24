/* eslint-disable max-len */
import {DriveMailTemplates} from "./types";
import {AGENT_HOSTING_URL} from "./config";

export const driveFullScopeSignupUrl = () => `${AGENT_HOSTING_URL.value()}/drive/v2/fullScopeSignup`;
export const driveSignupUrl = () => `${AGENT_HOSTING_URL.value()}/drive/v2/signup`;
export const driveOrganizeActionUrl = () => `${AGENT_HOSTING_URL.value()}/drive/v2/organizeAction`;

export const PREFERENCES_UPDATED_HTML = `<br><br>
<hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
<b>Preferences updated:</b>
<br><br>
%PREFERENCES_CHANGES%
<br>
<span style="color:#666;font-size:13px;">%PREFERENCES_SUMMARY%</span>`;

export interface PreferenceChange {
  label: string;
  before: string;
  after: string;
}

function escapeHtml(value: string): string {
  return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

export function renderPreferencesUpdatedBlock(
    changes: PreferenceChange[],
    summary: string,
): string {
  if (changes.length === 0) {
    return "";
  }
  const changeHtml = changes.map((change) =>
    `<b>${escapeHtml(change.label)}:</b> ` +
    `${escapeHtml(change.before || "(none)")} &rarr; ${escapeHtml(change.after)}`,
  ).join("<br>");
  return PREFERENCES_UPDATED_HTML
      .replace(/%PREFERENCES_CHANGES%/g, changeHtml)
      .replace(/%PREFERENCES_SUMMARY%/g, escapeHtml(summary || "Saved your updated preferences."));
}

const driveMailTemplates: DriveMailTemplates = {
  fileProposal: {
    html: `We'd like to organize your file in Google Drive:
<br><br>File: <b>%PROPOSED_NAME%</b>
<br>Folder: <b>%PROPOSED_FOLDER%</b>
<br><br>To get started, please grant access to your Google Drive:
<br><br><a href="%SIGNUP_LINK%"><img src="%HOSTING_URL%/signup-with-google.png" alt="Sign Up with Google" width="182" height="42" style="display: block;"></a>
<br><br>Once authorized, your file will be organized automatically.
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  multipleFileProposal: {
    html: `We'd like to organize your files in Google Drive:
<br><br>Folder: <b>%PROPOSED_FOLDER%</b>
<br><br>%FILE_LIST%
<br><br>To get started, please grant access to your Google Drive:
<br><br><a href="%SIGNUP_LINK%"><img src="%HOSTING_URL%/signup-with-google.png" alt="Sign Up with Google" width="182" height="42" style="display: block;"></a>
<br><br>Once authorized, your files will be organized automatically.
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  fileUploaded: {
    html: `Your file has been saved to Google Drive.
<br><br>File: <b>%FILE_NAME%</b>
<br>Location: <b>%FOLDER_PATH%</b>
<br><a href="%FILE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View in Drive</a>
<br><br>If you'd prefer it somewhere else, just reply to this email with instructions and we'll move it for you.
%EMBEDDED_DATA%
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  multipleFilesUploaded: {
    html: `Your files have been saved to Google Drive.
<br><br>%FILE_LIST%
<br><br>If you'd prefer them somewhere else, just reply to this email with instructions and we'll move them for you.
%EMBEDDED_DATA%
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  fileMoved: {
    html: `Done! Your file has been moved.
<br><br>File: <b>%FILE_NAME%</b>
<br>New location: <b>%NEW_PATH%</b>
<br><a href="%FILE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View in Drive</a>
%PREFERENCES_UPDATED%
%EMBEDDED_DATA%
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  multipleFilesMoved: {
    html: `Done! Your files have been moved.
<br><br>%FILE_LIST%
<br><br>Want them somewhere else? Just reply again and we'll move them.
%PREFERENCES_UPDATED%
%EMBEDDED_DATA%
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  fileTrashed: {
    html: `Done! Your file has been moved to trash.
<br><br>File: <b>%FILE_NAME%</b>
<br><br>You can restore it from your Google Drive trash if needed.
%PREFERENCES_UPDATED%
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  multipleFilesTrashed: {
    html: `Done! Your files have been moved to trash.
<br><br>%FILE_LIST%
<br><br>You can restore them from your Google Drive trash if needed.
%PREFERENCES_UPDATED%
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  driveAuthFailed: {
    html: `Sorry - there was an issue authenticating with Google Drive. Please click to authorize Google Drive again, and then forward your file another time.
<br><br><a href="%HOSTING_URL%/drive/v2/signup"><img src="%HOSTING_URL%/signup-with-google.png" alt="Sign Up with Google" width="182" height="42" style="display: block;"></a>

<br>Make sure you complete the checkbox to allow fwd2drive to access your Google Drive.
<img src="%HOSTING_URL%/fwd2drivePermissions.png" alt="Google Permissions" width="394" style="display: block;">
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  noAttachments: {
    html: `Sorry - your email didn't have any attachments. Forward an email with files attached and they'll be saved to your Google Drive.
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  noUserFound: {
    html: `Welcome to fwd2drive!<br><br>
To get started, please grant access to your Google Drive:<br><br>
<a href="%HOSTING_URL%/drive/v2/signup"><img src="%HOSTING_URL%/signup-with-google.png" alt="Sign Up with Google" width="182" height="42" style="display: block;"></a><br><br>
Once authorized, you can forward emails with attachments to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a> and they'll be organized in your Google Drive automatically.<br><br>
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  uploadFailed: {
    html: `Sorry - there was an error uploading your file to Google Drive. Please try forwarding it again.
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  moveFailed: {
    html: `Sorry - there was an error moving your file in Google Drive. Please try replying again with your move instructions.
%ORGANIZE_PROMO%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeAuthRequired: {
    html: `We'd love to help organize your entire Google Drive!
<br><br>To do this, we need expanded access to view and move all your files (not just the ones we've uploaded).
<br><br><a href="%FULL_SCOPE_SIGNUP_LINK%"><img src="%HOSTING_URL%/signup-with-google.png" alt="Sign Up with Google" width="182" height="42" style="display: block;"></a>
<br><br>We take your privacy seriously. We will only propose changes &mdash; nothing moves until you approve.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeScanStarted: {
    html: `Got it &mdash; we're scanning your Google Drive now to build an organization proposal.
<br><br>Please wait, this may take a few minutes depending on the size of your Drive. We'll send you a proposal to review once it's ready &mdash; nothing will be moved without your approval.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeExecutionStarted: {
    html: `Your approval has been received &mdash; we're reorganizing your Google Drive now.
<br><br>Please wait, this may take a few minutes depending on the size of your Drive. You'll receive a confirmation email when it's done.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeProposal: {
    html: `Here's our proposal to organize your Google Drive:
<br><br>
<b>Summary:</b> %SUMMARY%
<br><br>
<b>%TOTAL_FILES% files scanned</b> &nbsp;|&nbsp; <b>%FILES_TO_CHANGE% files to reorganize</b> &nbsp;|&nbsp; <b>%FILES_TO_KEEP% files already organized</b>
<br><br>
<hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
<b>Proposed folder structure:</b>
<br><br>
<div style="font-family:monospace;background:#f7f7f7;padding:16px;border-radius:8px;font-size:13px;line-height:1.6;">
%FOLDER_TREE%
</div>
<br>
<hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
<b>Cost:</b> %TOTAL_COST% (%TEXT_FILES% text files: %TEXT_COST% | %IMAGE_FILES% images: %IMAGE_COST%)
<br><br>
<a href="%APPROVE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Approve &amp; Organize</a>
<br><br>
<span style="color:#999;font-size:13px;">Or reply &quot;approve&quot; to this email.</span>
<br>
<span style="color:#999;font-size:13px;">Want changes? Reply with your instructions and we'll revise the proposal.</span>
%EMBEDDED_DATA%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeFolderPreferences: {
    html: `We scanned your Google Drive. Before proposing the folder structure, please confirm the folder naming style.
<br><br>
<b>Detected convention:</b> %DETECTED_CONVENTION%
<br>
%CONVENTION_DESCRIPTION%
<br>
<b>Suggested convention:</b> %SUGGESTED_CONVENTION%
<br><br>
<b>Folder examples:</b>
<br>
%FOLDER_EXAMPLES%
<br>
Reply &quot;approve&quot; to use this style, or reply with your preferred folder naming style.
%EMBEDDED_DATA%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizePhase1aProposal: {
    html: `%PHASE1A_HEADER%
<br><br>
<b>Convention:</b> %CONVENTION_SUMMARY%
<br><br>
<b>Summary:</b> %SUMMARY%
<br><br>
<div style="font-family:monospace;background:#f7f7f7;padding:16px;border-radius:8px;font-size:13px;line-height:1.6;">
%FOLDER_TREE%
</div>
<br>
Reply with changes, or reply &quot;approve&quot; to continue.
%EMBEDDED_DATA%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizePhase2Proposal: {
    html: `Let's use this filename convention:
<br><br>
<b>%FILENAME_CONVENTION%</b>
<br><br>
Examples:
<br>
%FILENAME_EXAMPLES%
<br>
Reply with changes, or reply &quot;approve&quot; to start generating file proposals.
%EMBEDDED_DATA%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeCostEstimate: {
    html: `Here's the final check before organizing your Google Drive:
<br><br>
<b>Approved folder structure:</b>
<br><br>
<div style="font-family:monospace;background:#f7f7f7;padding:16px;border-radius:8px;font-size:13px;line-height:1.6;">
%FOLDER_TREE%
</div>
<br>
<b>Filename convention:</b> %FILENAME_CONVENTION%
<br><br>
Examples:
<br>
%FILENAME_EXAMPLES%
<br><br>
<b>%TOTAL_FILES% files scanned</b> &nbsp;|&nbsp; <b>%TEXT_FILES% text/doc files</b> &nbsp;|&nbsp; <b>%IMAGE_FILES% image files</b>
<br><br>
<b>Estimated cost:</b> %TOTAL_COST% (%TEXT_COST% text/doc processing | %IMAGE_COST% image processing)
<br><br>
<a href="%APPROVE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Approve &amp; Organize</a>
<br><br>
<span style="color:#999;font-size:13px;">Or reply &quot;approve&quot; to this email.</span>
<br>
<span style="color:#999;font-size:13px;">Want changes? Reply with what you'd like to adjust.</span>
%EMBEDDED_DATA%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizePlanReview: {
    html: `Your organization plan is ready.
<br><br>
Review the attached CSV before moving files. Nothing has changed in Google Drive yet.
<br><br>
<b>%TOTAL_FILES% files planned</b> &nbsp;|&nbsp; <b>%FILES_TO_MOVE% moves</b> &nbsp;|&nbsp; <b>%FILES_TO_RENAME% renames</b> &nbsp;|&nbsp; <b>%FILES_TO_KEEP% unchanged</b>
<br><br>
<b>Planned folder structure:</b>
<br>
<div style="font-family:monospace;background:#f7f7f7;padding:16px;border-radius:8px;font-size:13px;line-height:1.6;">
%FOLDER_TREE%
</div>
<br>
%AFFECTED_FILES%
%PREVIEW_BLOCK%
<a href="%MOVE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Move Files</a>
<br><br>
<span style="color:#999;font-size:13px;">Need changes? Reply with the exact file change, or tell us to ignore a folder and leave it as-is.</span>
%REVISION_NOTE%
%EMBEDDED_DATA%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizePlanReviewScopeTooBroad: {
    html: `Your organization plan is ready.
<br><br>
Your latest reply still affects too many files for a safe in-email revision. Review the attached CSV and reply with a narrower request.
<br><br>
<b>%TOTAL_FILES% files planned</b> &nbsp;|&nbsp; <b>%FILES_TO_MOVE% moves</b> &nbsp;|&nbsp; <b>%FILES_TO_RENAME% renames</b> &nbsp;|&nbsp; <b>%FILES_TO_KEEP% unchanged</b>
<br><br>
<b>Planned folder structure:</b>
<br>
<div style="font-family:monospace;background:#f7f7f7;padding:16px;border-radius:8px;font-size:13px;line-height:1.6;">
%FOLDER_TREE%
</div>
<br>
<b>Preview:</b>
<br>
<div style="font-family:monospace;background:#f7f7f7;padding:16px;border-radius:8px;font-size:13px;line-height:1.6;">
%ACTION_PREVIEW%
</div>
<br>
<span style="color:#999;font-size:13px;">Try narrowing it to one folder, one filename pattern, or one extension.</span>
%REVISION_NOTE%
%EMBEDDED_DATA%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeError: {
    html: `Sorry &mdash; there was an error while scanning your Google Drive. Please try again by sending another &quot;organize my drive&quot; email.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeNoFiles: {
    html: `Your Google Drive appears to be empty or contains no files we can organize. Start by forwarding some files to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a> and we'll keep them tidy for you!
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeComplete: {
    html: `Your Google Drive has been reorganized!
<br><br>
<b>Summary:</b> %SUMMARY%
<br><br>
<b>%FILES_CHANGED% files reorganized</b>
<br><br>
<div style="font-family:monospace;background:#f7f7f7;padding:16px;border-radius:8px;font-size:13px;line-height:1.6;">
%FOLDER_TREE%
</div>
<br>
<a href="%UNDO_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#e74c3c; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Undo Reorganization</a>
<br><br>
<span style="color:#999;font-size:13px;">Or reply &quot;undo&quot; to this email within 30 days.</span>
%EMBEDDED_DATA%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeUndone: {
    html: `Your Google Drive has been restored to its previous state.
<br><br>All files have been moved back to their original locations and renamed to their original names.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  preferencesUpdated: {
    html: `Your fwd2drive preferences are up to date.
%PREFERENCES_UPDATED%
<br><br>
<b>Current folder convention:</b> %CURRENT_FOLDER_CONVENTION%
<br>
<b>Current filename convention:</b> %CURRENT_FILENAME_CONVENTION%
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  userDeleted: {
    html: `Your fwd2drive account has been deleted. All your data has been removed.
<br><br>Your files in Google Drive have not been affected.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  emailRemoved: {
    html: `The email address <b>%EMAIL_TO_REMOVE%</b> has been removed from your account.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  emailNotOwned: {
    html: `The email address <b>%EMAIL_TO_REMOVE%</b> is not associated with your account and cannot be removed.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
};

export {driveMailTemplates};
