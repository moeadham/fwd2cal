/* eslint-disable max-len */
import {DriveMailTemplates} from "./types";

const isDevProject = process.env.GCLOUD_PROJECT?.includes("-dev") ?? false;

export const driveFullScopeSignupUrl = isDevProject ?
  "https://us-central1-fwd2drive-dev.cloudfunctions.net/v2driveFullScopeSignup" :
  "https://www.fwd2drive.com/full-scope-consent";

export const driveSignupUrl = isDevProject ?
  "https://us-central1-fwd2drive-dev.cloudfunctions.net/v2driveSignup" :
  "https://www.fwd2drive.com/signup-consent";

export const driveOrganizeActionUrl = isDevProject ?
  "https://us-central1-fwd2drive-dev.cloudfunctions.net/v2driveOrganizeAction" :
  "https://www.fwd2drive.com/organize-action";

const driveMailTemplates: DriveMailTemplates = {
  fileProposal: {
    html: `We'd like to organize your file in Google Drive:
<br><br>File: <b>%PROPOSED_NAME%</b>
<br>Folder: <b>%PROPOSED_FOLDER%</b>
<br><br>To get started, please grant access to your Google Drive:
<br><br><a href="%SIGNUP_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Grant Drive Access</a>
<br><br>Once authorized, your file will be organized automatically.

<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  multipleFileProposal: {
    html: `We'd like to organize your files in Google Drive:
<br><br>Folder: <b>%PROPOSED_FOLDER%</b>
<br><br>%FILE_LIST%
<br><br>To get started, please grant access to your Google Drive:
<br><br><a href="%SIGNUP_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Grant Drive Access</a>
<br><br>Once authorized, your files will be organized automatically.

<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  fileUploaded: {
    html: `Your file has been saved to Google Drive.
<br><br>File: <b>%FILE_NAME%</b>
<br>Location: <b>%FOLDER_PATH%</b>
<br><a href="%FILE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View in Drive</a>
<br><br>If you'd prefer it somewhere else, just reply to this email with instructions and we'll move it for you.
%EMBEDDED_DATA%
<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  multipleFilesUploaded: {
    html: `Your files have been saved to Google Drive.
<br><br>%FILE_LIST%
<br><br>If you'd prefer them somewhere else, just reply to this email with instructions and we'll move them for you.
%EMBEDDED_DATA%
<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  fileMoved: {
    html: `Done! Your file has been moved.
<br><br>File: <b>%FILE_NAME%</b>
<br>New location: <b>%NEW_PATH%</b>
<br><a href="%FILE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View in Drive</a>
%EMBEDDED_DATA%
<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  multipleFilesMoved: {
    html: `Done! Your files have been moved.
<br><br>%FILE_LIST%
<br><br>Want them somewhere else? Just reply again and we'll move them.
%EMBEDDED_DATA%
<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  driveAuthFailed: {
    html: `Sorry - there was an issue authenticating with Google Drive. Please click <a href="${driveSignupUrl}">to authorize Google Drive again</a>, and then forward your file another time.

<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  noAttachments: {
    html: `Sorry - your email didn't have any attachments. Forward an email with files attached and they'll be saved to your Google Drive.

<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  uploadFailed: {
    html: `Sorry - there was an error uploading your file to Google Drive. Please try forwarding it again.

<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  moveFailed: {
    html: `Sorry - there was an error moving your file in Google Drive. Please try replying again with your move instructions.

<br><br><b>Did you know?</b> fwd2drive can organize your entire drive. Just email &quot;organize my drive please&quot; to <a href="mailto:drive@fwd2drive.com">drive@fwd2drive.com</a>.
<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  organizeAuthRequired: {
    html: `We'd love to help organize your entire Google Drive!
<br><br>To do this, we need expanded access to view and move all your files (not just the ones we've uploaded).
<br><br><a href="%FULL_SCOPE_SIGNUP_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Grant Full Drive Access</a>
<br><br>We take your privacy seriously. We will only propose changes &mdash; nothing moves until you approve.
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
<b>File changes preview:</b>
<br><br>
%FILE_CHANGES_PREVIEW%
<br>
<hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
<b>Cost:</b> %TOTAL_COST% (%COST_PER_FILE% per file &times; %FILES_TO_CHANGE% files)
<br><br>
<a href="%APPROVE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Approve &amp; Organize</a>
<br><br>
<span style="color:#999;font-size:13px;">Or reply &quot;approve&quot; to this email.</span>
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
