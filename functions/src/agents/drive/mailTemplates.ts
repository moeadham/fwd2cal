/* eslint-disable max-len */
import {DriveMailTemplates} from "./types";

const isDevProject = process.env.GCLOUD_PROJECT === "fwd2cal-dev-2578e";
export const driveSignupUrl = isDevProject ?
  "https://us-central1-fwd2cal-dev-2578e.cloudfunctions.net/v2driveSignup" :
  "https://www.fwd2cal.com/drive-signup-consent";

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
};

export {driveMailTemplates};
