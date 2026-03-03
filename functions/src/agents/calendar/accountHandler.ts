import {
  getUserFromEmail,
  addPendingEmailAddress,
} from "../../util/firestoreHandler";
import {sendEvent} from "../../util/analytics";
import {
  deleteUserAccount as deleteAccount,
  removeEmailFromUser,
} from "../../util/accountHandler";
import {sendEmailResponse, EMAIL_RESPONSES} from "./emailResponseUtils";
import {eventHandler} from "./eventHandler";
import {
  TransformedEmail,
  ICSFile,
  EmailResponseTemplate,
  HandleEmailResult,
  GoogleCalendarEvent,
  ParsedDocument,
} from "./types";

export async function deleteUserAccount(
    email: TransformedEmail,
    sender: string,
    uid: string,
): Promise<HandleEmailResult> {
  const result = await deleteAccount(uid, sender);

  const response: EmailResponseTemplate = {
    ...EMAIL_RESPONSES.userDeleted,
    replace: {},
  };
  await sendEmailResponse(sender, email, response, true);
  return {result: result.result};
}

export async function removeEmailAddressFromUser(
    email: TransformedEmail,
    sender: string,
    uid: string,
    files: ICSFile[] = [],
    imageUrls: string[] = [],
    documents: ParsedDocument[] = [],
    extractedEmail?: string,
): Promise<HandleEmailResult | GoogleCalendarEvent | GoogleCalendarEvent[] | undefined> {
  const result = await removeEmailFromUser(uid, extractedEmail, email.subject);

  if ("error" in result) {
    if (result.error === "no_email") {
      return await eventHandler(email, sender, uid, files, imageUrls, documents);
    }
    // not_owned
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.removalEmailInUse,
      replace: {
        EMAIL_TO_REMOVE: result.email || "",
      },
    };
    await sendEmailResponse(sender, email, response, true);
    return;
  }

  const response: EmailResponseTemplate = {
    ...EMAIL_RESPONSES.emailAddressRemoved,
    replace: {
      EMAIL_TO_REMOVE: result.removedEmail,
    },
  };
  await sendEmailResponse(sender, email, response, true);
  return {result: result.result};
}

export async function addEmailAddressToUser(
    email: TransformedEmail,
    sender: string,
    uid: string,
    files: ICSFile[] = [],
    imageUrls: string[] = [],
    documents: ParsedDocument[] = [],
    extractedEmail?: string,
): Promise<HandleEmailResult | GoogleCalendarEvent | GoogleCalendarEvent[] | undefined> {
  // Use extracted email from skill matcher, or try to parse from subject
  let emailAddressToAdd = extractedEmail;
  if (!emailAddressToAdd) {
    const subject = email.subject;
    const emailRegex = /^add\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})$/i;
    const match = subject.match(emailRegex);
    if (match) {
      emailAddressToAdd = match[1];
    }
  }
  if (!emailAddressToAdd) {
    return await eventHandler(email, sender, uid, files, imageUrls, documents);
  }
  const existingUid = await getUserFromEmail(emailAddressToAdd);
  if (existingUid) {
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.additionalEmailInUse,
      replace: {
        EMAIL_TO_ADD: emailAddressToAdd,
      },
    };
    sendEvent(uid, "addUserFailed", {reason: "email_in_use"});
    await sendEmailResponse(sender, email, response, true);
    return;
  }
  const verificationCode = await addPendingEmailAddress(uid, emailAddressToAdd, sender);
  const response: EmailResponseTemplate = {
    ...EMAIL_RESPONSES.addAdditionalEmailAddress,
    replace: {
      VERIFICATION_CODE: verificationCode,
      ORIGINATOR_EMAIL: sender,
    },
  };
  await sendEmailResponse(emailAddressToAdd, email, response, false);
  sendEvent(uid, "addUserRequest");
  return {verificationCode};
}
