import {logger} from "firebase-functions/v2";
import {getFirestore} from "firebase-admin/firestore";
import {ENVIRONMENT_NAME} from "./config";
import {v4 as uuidv4} from "uuid";
import {sendEvent} from "./analytics";
import {
  UserDocument,
  OAuthTokens,
  FirebaseUserRecord,
  PendingEmailAddressDocument,
  UserWithExpiringTokens,
  EmailItem,
} from "../auth/types";

async function getUserFromUID(uid: string): Promise<UserDocument> {
  const userDoc = await getFirestore().collection("Users").doc(uid).get();
  if (!userDoc.exists) {
    throw new Error("User document does not exist");
  }
  return {uid: userDoc.id, ...userDoc.data()} as UserDocument;
}

async function getUserFromEmail(email: string): Promise<string | null> {
  const doc = await getFirestore().collection("EmailAddress").doc(email).get();
  if (!doc.exists) {
    return null;
  }
  const userObject = doc.data();
  return userObject?.uid || null;
}

async function findUsersWithExpiringTokens(): Promise<UserWithExpiringTokens[]> {
  const usersRef = getFirestore().collection("Users");
  const now = new Date();
  const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  let querySnapshot;
  if (ENVIRONMENT_NAME.value() === "production") {
    querySnapshot = await usersRef
        .where("expiry_date", "<=", twoHoursLater)
        .get();
  } else {
    querySnapshot = await usersRef.get(); // For Local testing.
  }
  if (querySnapshot.empty) {
    console.log("No users with tokens expiring in the next hour found.");
    return [];
  }
  const users: UserWithExpiringTokens[] = [];
  querySnapshot.forEach((doc) => {
    console.log(`User ${doc.id} has a token expiring soon.`);
    users.push({id: doc.id, ...doc.data()} as UserWithExpiringTokens);
  });
  return users;
}

async function storeUser(
    tokens: OAuthTokens,
    user: FirebaseUserRecord,
): Promise<void> {
  try {
    await getFirestore().collection("Users").doc(user.uid).set({
      email: user.email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      token_scope: tokens.scope,
    });
  } catch (error) {
    logger.error(`Database error in storeUser for uid ${user.uid}:`, error);
    sendEvent(user.uid, "databaseError", {operation: "storeUser"});
    throw error;
  }
}

async function updateUserTokens(
    tokens: OAuthTokens,
    uid: string,
): Promise<void> {
  try {
    await getFirestore().collection("Users").doc(uid).update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
    });
  } catch (error) {
    logger.error(`Database error in updateUserTokens for uid ${uid}:`, error);
    sendEvent(uid, "databaseError", {operation: "updateUserTokens"});
    throw error;
  }
}

async function addUserEmailAddress(
    user: FirebaseUserRecord,
    emails: EmailItem[],
): Promise<void> {
  try {
    for (const item of emails) {
      await getFirestore().collection("EmailAddress").doc(item.email).set({
        uid: user.uid,
        email: item.email,
        default: item.default,
      });
    }
  } catch (error) {
    logger.error(
        `Database error in addUserEmailAddress for uid ${user.uid}:`,
        error,
    );
    sendEvent(user.uid, "databaseError", {operation: "addUserEmailAddress"});
    throw error;
  }
}

async function removeEmailAddress(email: string): Promise<void> {
  try {
    // Get uid before deleting for analytics
    const uid = await getUserFromEmail(email);
    await getFirestore().collection("EmailAddress").doc(email).delete();
    if (!uid) {
      logger.warn(`Could not find uid for email ${email} when removing`);
    }
  } catch (error) {
    logger.error(
        `Database error in removeEmailAddress for email ${email}:`,
        error,
    );
    // Try to get uid for analytics, but don't fail if we can't
    const uid = await getUserFromEmail(email).catch((): null => null);
    if (uid) {
      sendEvent(uid, "databaseError", {operation: "removeEmailAddress"});
    }
    throw error;
  }
}

async function addPendingEmailAddress(
    uid: string,
    pendingAddress: string,
): Promise<string> {
  try {
    const user = await getUserFromUID(uid);
    const verificationCode = uuidv4();
    await getFirestore()
        .collection("PendingEmailAddress")
        .doc(pendingAddress)
        .set({
          ownerUid: user.uid,
          ownerEmail: user.email,
          verificationCode: verificationCode,
        });
    return verificationCode;
  } catch (error) {
    logger.error(
        `Database error in addPendingEmailAddress for uid ${uid}:`,
        error,
    );
    sendEvent(uid, "databaseError", {operation: "addPendingEmailAddress"});
    throw error;
  }
}

async function getPendingEmailAddressByCode(
    code: string,
): Promise<PendingEmailAddressDocument | null> {
  const doc = await getFirestore()
      .collection("PendingEmailAddress")
      .where("verificationCode", "==", code)
      .get();
  if (doc.empty) {
    return null;
  }
  const firstDoc = doc.docs[0];
  return {
    id: firstDoc.id,
    ...firstDoc.data(),
  } as PendingEmailAddressDocument;
}

async function setDriveEnabled(uid: string, enabled: boolean): Promise<void> {
  try {
    await getFirestore().collection("Users").doc(uid).update({
      driveEnabled: enabled,
    });
  } catch (error) {
    logger.error(`Database error in setDriveEnabled for uid ${uid}:`, error);
    sendEvent(uid, "databaseError", {operation: "setDriveEnabled"});
    throw error;
  }
}

async function deleteUser(uid: string): Promise<void> {
  // Delete all email addresses associated to the uid.
  const batch = getFirestore().batch();
  const emailSnapshot = await getFirestore()
      .collection("EmailAddress")
      .where("uid", "==", uid)
      .get();
  emailSnapshot.forEach((doc) => {
    batch.delete(doc.ref);
  });

  const pendingEmailSnapshot = await getFirestore()
      .collection("PendingEmailAddress")
      .where("ownerUid", "==", uid)
      .get();
  pendingEmailSnapshot.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
  // Delete the account.
  await getFirestore().collection("Users").doc(uid).delete();
  // You still need to delete the user from firebase.
}

// ============================================================================
// ORGANIZE PROPOSAL PERSISTENCE
// ============================================================================

async function saveOrganizeProposal(
    data: Record<string, unknown>,
): Promise<string> {
  try {
    const docRef = await getFirestore()
        .collection("OrganizeProposals")
        .add(data);
    logger.info("Saved organize proposal", {proposalId: docRef.id});
    return docRef.id;
  } catch (error) {
    logger.error("Database error in saveOrganizeProposal:", error);
    throw error;
  }
}

async function getOrganizeProposal(
    proposalId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const doc = await getFirestore()
        .collection("OrganizeProposals")
        .doc(proposalId)
        .get();
    if (!doc.exists) return null;
    return {id: doc.id, ...doc.data()} as Record<string, unknown>;
  } catch (error) {
    logger.error("Database error in getOrganizeProposal:", error);
    throw error;
  }
}

async function updateOrganizeProposalStatus(
    proposalId: string,
    status: string,
    extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await getFirestore()
        .collection("OrganizeProposals")
        .doc(proposalId)
        .update({status, ...extra});
  } catch (error) {
    logger.error("Database error in updateOrganizeProposalStatus:", error);
    throw error;
  }
}

// ============================================================================
// DRIVE FILE DATA PERSISTENCE
// ============================================================================

async function saveDriveFileData(
    data: Record<string, unknown>,
): Promise<string> {
  try {
    const docRef = await getFirestore()
        .collection("DriveFileData")
        .add(data);
    logger.info("Saved drive file data", {fileDataId: docRef.id});
    return docRef.id;
  } catch (error) {
    logger.error("Database error in saveDriveFileData:", error);
    throw error;
  }
}

async function getDriveFileData(
    fileDataId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const doc = await getFirestore()
        .collection("DriveFileData")
        .doc(fileDataId)
        .get();
    if (!doc.exists) return null;
    return {id: doc.id, ...doc.data()} as Record<string, unknown>;
  } catch (error) {
    logger.error("Database error in getDriveFileData:", error);
    throw error;
  }
}

async function updateDriveFileData(
    fileDataId: string,
    files: unknown[],
): Promise<void> {
  try {
    await getFirestore()
        .collection("DriveFileData")
        .doc(fileDataId)
        .update({files});
  } catch (error) {
    logger.error("Database error in updateDriveFileData:", error);
    throw error;
  }
}

async function cleanupExpiredDriveFileData(): Promise<number> {
  const now = new Date().toISOString();
  const snapshot = await getFirestore()
      .collection("DriveFileData")
      .where("expiresAt", "<", now)
      .get();
  if (snapshot.empty) return 0;

  const batch = getFirestore().batch();
  snapshot.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  logger.info("Cleaned up expired drive file data", {count: snapshot.size});
  return snapshot.size;
}

export {
  getUserFromUID,
  getUserFromEmail,
  findUsersWithExpiringTokens,
  storeUser,
  addUserEmailAddress,
  updateUserTokens,
  addPendingEmailAddress,
  getPendingEmailAddressByCode,
  removeEmailAddress,
  setDriveEnabled,
  deleteUser,
  saveOrganizeProposal,
  getOrganizeProposal,
  updateOrganizeProposalStatus,
  saveDriveFileData,
  getDriveFileData,
  updateDriveFileData,
  cleanupExpiredDriveFileData,
};
