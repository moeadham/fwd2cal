import {logger} from "firebase-functions/v2";
import {
  getUserFromEmail,
  getUserFromUID,
  addPendingEmailAddress,
  removeEmailAddress,
  deleteUser,
} from "../../util/firestoreHandler";
import {deleteAccount} from "../../auth/authHandler";
import {removeContactFromSegment} from "../../util/resend";
import {RESEND_REGISTERED_USERS_SEGMENT_ID} from "../../util/config";
import {sendEvent} from "../../util/analytics";
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
  // Get primary email address before deleting user (may not have a calendar doc)
  let primaryEmail = sender;
  try {
    const user = await getUserFromUID(uid, "calendar");
    primaryEmail = user.email;
  } catch {
    // User may only have a drive account — use sender as primary email
  }

  await deleteUser(uid, "calendar");
  await deleteAccount(uid);

  // Remove primary email from registered users segment (fire-and-forget)
  removeContactFromSegment(
      primaryEmail,
      RESEND_REGISTERED_USERS_SEGMENT_ID.value(),
  );

  const response: EmailResponseTemplate = {
    ...EMAIL_RESPONSES.userDeleted,
    replace: {},
  };
  await sendEmailResponse(sender, email, response, true);
  sendEvent(uid, "deleteAccount");
  return {result: `${uid} account deleted.`};
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
  // Use extracted email from skill matcher, or try to parse from subject
  let emailAddressToRemove = extractedEmail;
  if (!emailAddressToRemove) {
    const subject = email.subject;
    const emailRegex =
      /^remove\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})$/i;
    const match = subject.match(emailRegex);
    if (match) {
      emailAddressToRemove = match[1];
    }
  }
  if (!emailAddressToRemove) {
    logger.log(`remove-email skill matched but no valid email address found`);
    logger.log(`Subject: ${email.subject}`);
    return await eventHandler(email, sender, uid, files, imageUrls, documents);
  }
  // Check if the email address is already added.
  // If not, add it to the pending email address list.
  const existingUid = await getUserFromEmail(emailAddressToRemove);
  if (existingUid !== uid) {
    logger.warn(`${uid} attempted to remove
      ${emailAddressToRemove}, but registered to ${existingUid}`);
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.removalEmailInUse,
      replace: {
        EMAIL_TO_REMOVE: emailAddressToRemove,
      },
    };
    logger.log(`Sending email additionalEmailInUse to ${sender}`);
    sendEvent(uid, "removeEmailFailed", {reason: "not_owned"});
    await sendEmailResponse(sender, email, response, true);
    return;
  } else {
    await removeEmailAddress(emailAddressToRemove);
    logger.log(`${uid} to removed
      ${emailAddressToRemove}, uid ${existingUid}`);
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.emailAddressRemoved,
      replace: {
        EMAIL_TO_REMOVE: emailAddressToRemove,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    sendEvent(uid, "removeEmail");
    return {result: `${emailAddressToRemove} removed.`};
  }
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
    logger.log(`add-email skill matched but no valid email address found`);
    return await eventHandler(email, sender, uid, files, imageUrls, documents);
  }
  // Check if the email address is already added.
  // If not, add it to the pending email address list.
  const existingUid = await getUserFromEmail(emailAddressToAdd);
  if (existingUid) {
    logger.warn(`${uid} attempted to add
      ${emailAddressToAdd}, but already registered to ${existingUid}`);
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.additionalEmailInUse,
      replace: {
        EMAIL_TO_ADD: emailAddressToAdd,
      },
    };
    logger.log(`Sending email additionalEmailInUse to ${sender}`);
    sendEvent(uid, "addUserFailed", {reason: "email_in_use"});
    await sendEmailResponse(sender, email, response, true);
    return;
  }
  const verificationCode = await addPendingEmailAddress(uid, emailAddressToAdd, sender);
  // Send email to the user with the verification code.
  const response: EmailResponseTemplate = {
    ...EMAIL_RESPONSES.addAdditionalEmailAddress,
    replace: {
      VERIFICATION_CODE: verificationCode,
      ORIGINATOR_EMAIL: sender,
    },
  };
  logger.log(
      `Sending email addAdditionalEmailAddress ${emailAddressToAdd} to pending list for ${uid}`,
  );
  await sendEmailResponse(emailAddressToAdd, email, response, false);
  sendEvent(uid, "addUserRequest");
  return {verificationCode};
}
