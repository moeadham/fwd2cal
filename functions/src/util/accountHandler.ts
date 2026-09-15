import {logger} from "firebase-functions/v2";
import {
  getUserFromEmail,
  getUserFromUID,
  removeEmailAddress,
  deleteUser,
  USERS_COLLECTION,
  DRIVE_USERS_COLLECTION,
} from "./firestoreHandler";
import {deleteAccount} from "../auth/authHandler";
import {removeContactFromSegment} from "./resend";
import {RESEND_REGISTERED_USERS_SEGMENT_ID} from "./config";
import {sendEvent} from "./analytics";

export interface DeleteAccountResult {
  result: string;
  primaryEmail: string;
}

export interface RemoveEmailResult {
  result: string;
  removedEmail: string;
}

export interface RemoveEmailError {
  error: "not_owned" | "no_email";
  email?: string;
}

/**
 * Delete a user account: remove Firestore data, Firebase Auth, and Resend segment.
 * Returns the primary email for the caller to send a confirmation email.
 */
export async function deleteUserAccount(
    uid: string,
    sender: string,
): Promise<DeleteAccountResult> {
  let primaryEmail = sender;
  try {
    const user = await getUserFromUID(uid, USERS_COLLECTION);
    primaryEmail = user.email;
  } catch {
    try {
      const user = await getUserFromUID(uid, DRIVE_USERS_COLLECTION);
      primaryEmail = user.email;
    } catch {
      // User document may not exist in either collection — use sender as primary email
    }
  }

  await deleteUser(uid);
  await deleteAccount(uid);

  removeContactFromSegment(
      primaryEmail,
      RESEND_REGISTERED_USERS_SEGMENT_ID.value(),
  );

  sendEvent(uid, "deleteAccount", "system");
  return {result: `${uid} account deleted.`, primaryEmail};
}

/**
 * Remove an email address from a user's account.
 * Validates ownership before removing.
 */
export async function removeEmailFromUser(
    uid: string,
    extractedEmail: string | undefined,
    emailSubject: string,
): Promise<RemoveEmailResult | RemoveEmailError> {
  let emailAddressToRemove = extractedEmail;
  if (!emailAddressToRemove) {
    const emailRegex =
      /^remove\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})$/i;
    const match = emailSubject.match(emailRegex);
    if (match) {
      emailAddressToRemove = match[1];
    }
  }
  if (!emailAddressToRemove) {
    logger.log("remove-email skill matched but no valid email address found");
    logger.log(`Subject: ${emailSubject}`);
    return {error: "no_email"};
  }

  const existingUid = await getUserFromEmail(emailAddressToRemove);
  if (existingUid !== uid) {
    logger.warn(`${uid} attempted to remove ${emailAddressToRemove}, but registered to ${existingUid}`);
    sendEvent(uid, "removeEmailFailed", "system", {reason: "not_owned"});
    return {error: "not_owned", email: emailAddressToRemove};
  }

  await removeEmailAddress(emailAddressToRemove);
  logger.log(`${uid} removed ${emailAddressToRemove}`);
  sendEvent(uid, "removeEmail", "system");
  return {result: `${emailAddressToRemove} removed.`, removedEmail: emailAddressToRemove};
}
