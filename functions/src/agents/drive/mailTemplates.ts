/* eslint-disable max-len */
import {DriveMailTemplates} from "./types";

const isDevProject = process.env.GCLOUD_PROJECT === "fwd2cal-dev-2578e";
const driveSignupUrl = isDevProject ?
  "https://us-central1-fwd2cal-dev-2578e.cloudfunctions.net/v2driveSignup" :
  "https://www.fwd2cal.com/drive-signup-consent";

const driveMailTemplates: DriveMailTemplates = {
  fileUploaded: {
    html: `Your file has been saved to Google Drive.
<br><br>File: <b>%FILE_NAME%</b>
<br>Location: <b>%FOLDER_PATH%</b>
<br><a href="%FILE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View in Drive</a>

<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  multipleFilesUploaded: {
    html: `Your files have been saved to Google Drive.
<br><br>%FILE_LIST%

<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  driveAuthFailed: {
    html: `Sorry - there was an issue authenticating with Google Drive. Please click <a href="${driveSignupUrl}">to authorize Google Drive again</a>, and then forward your file another time.

<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  noAttachments: {
    html: `Sorry - your email didn't have any attachments. Forward an email with files attached and they'll be saved to your Google Drive.

<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  notDriveUser: {
    html: `Welcome!<br><br>
To use fwd2cal Drive, please sign up by clicking the link below.<br><br>
<a href="${driveSignupUrl}">Sign Up for Drive</a><br><br>
Once signed up, forward any email with attachments and they'll be automatically organized in your Google Drive.

<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
  uploadFailed: {
    html: `Sorry - there was an error uploading your file to Google Drive. Please try forwarding it again.

<br><br>You can always ask for help: <a href="mailto:%SUPPORT_EMAIL%">%SUPPORT_EMAIL%</a><br>`,
  },
};

export {driveMailTemplates};
