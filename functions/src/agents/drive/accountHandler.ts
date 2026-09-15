import {
  deleteUserAccount as deleteAccount,
  removeEmailFromUser,
} from "../../util/accountHandler";
import {driveMailTemplates} from "./mailTemplates";
import {applyTemplate, sendDriveEmailResponse} from "./driveUtils";
import {TransformedEmail} from "../../util/types";

export async function driveDeleteUserAccount(
    email: TransformedEmail,
    sender: string,
    uid: string,
): Promise<{result: string}> {
  const result = await deleteAccount(uid, sender);

  const html = applyTemplate(driveMailTemplates.userDeleted.html, {});
  await sendDriveEmailResponse(sender, email, html);
  return {result: result.result};
}

export async function driveRemoveEmailFromUser(
    email: TransformedEmail,
    sender: string,
    uid: string,
    extractedEmail?: string,
): Promise<{result?: string; error?: string}> {
  const result = await removeEmailFromUser(uid, extractedEmail, email.subject);

  if ("error" in result) {
    if (result.error === "no_email") {
      return {error: "no_email"};
    }
    // not_owned
    const html = applyTemplate(driveMailTemplates.emailNotOwned.html, {
      EMAIL_TO_REMOVE: result.email || "",
    });
    await sendDriveEmailResponse(sender, email, html);
    return {error: "not_owned"};
  }

  const html = applyTemplate(driveMailTemplates.emailRemoved.html, {
    EMAIL_TO_REMOVE: result.removedEmail,
  });
  await sendDriveEmailResponse(sender, email, html);
  return {result: result.result};
}
