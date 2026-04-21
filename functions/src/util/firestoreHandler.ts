import {logger} from "firebase-functions/v2";
import {getFirestore} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";
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
  AgentName,
} from "../auth/types";

const USERS_COLLECTION = "Users";
const DRIVE_USERS_COLLECTION = "DriveUsers";

const AGENT_COLLECTIONS: Record<AgentName, string> = {
  calendar: USERS_COLLECTION,
  drive: DRIVE_USERS_COLLECTION,
};

function getCollectionForAgent(agentName: AgentName): string {
  return AGENT_COLLECTIONS[agentName];
}

async function getUserFromUID(
    uid: string,
    collection: string,
): Promise<UserDocument> {
  const userDoc = await getFirestore().collection(collection).doc(uid).get();
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

async function findUsersWithExpiringTokens(
    collection: string,
): Promise<UserWithExpiringTokens[]> {
  const twoHoursLater = Date.now() + 2 * 60 * 60 * 1000;
  const users: UserWithExpiringTokens[] = [];

  const usersRef = getFirestore().collection(collection);
  let querySnapshot;
  if (ENVIRONMENT_NAME.value() === "production") {
    querySnapshot = await usersRef
        .where("expiry_date", "<=", twoHoursLater)
        .get();
  } else {
    querySnapshot = await usersRef.get(); // For Local testing.
  }
  querySnapshot.forEach((doc) => {
    console.log(`User ${doc.id} has a token expiring soon.`);
    users.push({
      id: doc.id, ...doc.data(),
    } as UserWithExpiringTokens);
  });

  if (users.length === 0) {
    console.log("No users with tokens expiring in the next hour found.");
  }
  return users;
}

async function storeUser(
    tokens: OAuthTokens,
    user: FirebaseUserRecord,
    collection: string,
): Promise<void> {
  try {
    const docRef = getFirestore().collection(collection).doc(user.uid);
    const existing = await docRef.get();
    const existingScope = existing.exists ?
      (existing.data()?.token_scope as string | undefined) : undefined;

    // Keep the broader scope: only narrow token_scope if the new scope
    // includes full drive access, or if there is no existing scope.
    const FULL_DRIVE = "https://www.googleapis.com/auth/drive";
    const newScopes = (tokens.scope || "").split(/\s+/);
    const keepExistingScope = existingScope &&
      !newScopes.includes(FULL_DRIVE) &&
      existingScope.includes(FULL_DRIVE);

    await docRef.set({
      email: user.email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      token_scope: keepExistingScope ? existingScope : tokens.scope,
    }, {merge: true});
  } catch (error) {
    logger.error(`Database error in storeUser for uid ${user.uid}:`, error);
    sendEvent(user.uid, "databaseError", "system", {operation: "storeUser"});
    throw error;
  }
}

async function updateUserTokens(
    tokens: OAuthTokens,
    uid: string,
    collection: string,
): Promise<void> {
  try {
    await getFirestore().collection(collection).doc(uid).update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
    });
  } catch (error) {
    logger.error(`Database error in updateUserTokens for uid ${uid}:`, error);
    sendEvent(uid, "databaseError", "system", {operation: "updateUserTokens"});
    throw error;
  }
}

async function saveDriveUserPreferences(
    uid: string,
    prefs: Record<string, unknown>,
): Promise<void> {
  try {
    const docRef = getFirestore()
        .collection(DRIVE_USERS_COLLECTION)
        .doc(uid);
    const doc = await docRef.get();
    const existingPreferences = (doc.data()?.preferences || {}) as Record<string, unknown>;
    await docRef.set({
      preferences: {
        ...existingPreferences,
        ...prefs,
      },
    }, {merge: true});
  } catch (error) {
    logger.error(`Database error in saveDriveUserPreferences for uid ${uid}:`, error);
    sendEvent(uid, "databaseError", "system", {operation: "saveDriveUserPreferences"});
    throw error;
  }
}

async function getDriveUserPreferences(
    uid: string,
): Promise<Record<string, unknown>> {
  try {
    const doc = await getFirestore()
        .collection(DRIVE_USERS_COLLECTION)
        .doc(uid)
        .get();
    return (doc.data()?.preferences || {}) as Record<string, unknown>;
  } catch (error) {
    logger.error(`Database error in getDriveUserPreferences for uid ${uid}:`, error);
    sendEvent(uid, "databaseError", "system", {operation: "getDriveUserPreferences"});
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
    sendEvent(user.uid, "databaseError", "system", {operation: "addUserEmailAddress"});
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
      sendEvent(uid, "databaseError", "system", {operation: "removeEmailAddress"});
    }
    throw error;
  }
}

async function addPendingEmailAddress(
    uid: string,
    pendingAddress: string,
    ownerEmail: string,
): Promise<string> {
  try {
    const verificationCode = uuidv4();
    await getFirestore()
        .collection("PendingEmailAddress")
        .doc(pendingAddress)
        .set({
          ownerUid: uid,
          ownerEmail: ownerEmail,
          verificationCode: verificationCode,
        });
    return verificationCode;
  } catch (error) {
    logger.error(
        `Database error in addPendingEmailAddress for uid ${uid}:`,
        error,
    );
    sendEvent(uid, "databaseError", "system", {operation: "addPendingEmailAddress"});
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
  // Delete the user document from both agent collections.
  await getFirestore().collection(USERS_COLLECTION).doc(uid).delete();
  await getFirestore().collection(DRIVE_USERS_COLLECTION).doc(uid).delete();
}

// ============================================================================
// ORGANIZE PROPOSAL PERSISTENCE (bulk data in GCS)
// ============================================================================

const getProposalPath = (id: string) => `organize-proposals/${id}.json`;

async function saveOrganizeProposal(
    data: Record<string, unknown>,
): Promise<string> {
  try {
    const {proposal, cost, ...metadata} = data;
    const docRef = getFirestore().collection("OrganizeProposals").doc();
    const storagePath = getProposalPath(docRef.id);

    if (proposal !== undefined || cost !== undefined) {
      const bucket = getStorage().bucket();
      const file = bucket.file(storagePath);
      await file.save(JSON.stringify({proposal, cost}), {
        contentType: "application/json",
      });
    }

    await docRef.set({...metadata, storagePath});
    logger.info("Saved organize proposal", {proposalId: docRef.id});
    return docRef.id;
  } catch (error) {
    logger.error("Database error in saveOrganizeProposal:", error);
    throw error;
  }
}

async function saveOrganizeIntermediateState(
    proposalId: string,
    state: Record<string, unknown>,
): Promise<void> {
  try {
    const doc = await getFirestore()
        .collection("OrganizeProposals")
        .doc(proposalId)
        .get();
    if (!doc.exists) {
      throw new Error("Organize proposal not found");
    }

    const storagePath = doc.data()?.storagePath as string;
    const bucket = getStorage().bucket();
    await bucket.file(storagePath).save(JSON.stringify(state), {
      contentType: "application/json",
    });
  } catch (error) {
    logger.error("Database error in saveOrganizeIntermediateState:", error);
    throw error;
  }
}

async function getOrganizeIntermediateState(
    proposalId: string,
): Promise<Record<string, unknown>> {
  try {
    const doc = await getFirestore()
        .collection("OrganizeProposals")
        .doc(proposalId)
        .get();
    if (!doc.exists) {
      throw new Error("Organize proposal not found");
    }

    const storagePath = doc.data()?.storagePath as string;
    const bucket = getStorage().bucket();
    const [contents] = await bucket.file(storagePath).download();
    return JSON.parse(contents.toString()) as Record<string, unknown>;
  } catch (error) {
    logger.error("Database error in getOrganizeIntermediateState:", error);
    throw error;
  }
}

async function finalizeOrganizeProposal(
    proposalId: string,
    proposal: Record<string, unknown>,
    cost: Record<string, unknown>,
): Promise<void> {
  try {
    const docRef = getFirestore()
        .collection("OrganizeProposals")
        .doc(proposalId);
    const doc = await docRef.get();
    if (!doc.exists) {
      throw new Error("Organize proposal not found");
    }

    const storagePath = doc.data()?.storagePath as string;
    const bucket = getStorage().bucket();
    await bucket.file(storagePath).save(JSON.stringify({proposal, cost}), {
      contentType: "application/json",
    });

    await docRef.update({
      status: "pending",
      generationStartedAt: null,
      lastError: null,
    });
  } catch (error) {
    logger.error("Database error in finalizeOrganizeProposal:", error);
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
    const data = doc.data()!;

    // Fetch bulk data from GCS
    const bucket = getStorage().bucket();
    const [contents] = await bucket.file(data.storagePath as string).download();
    const bulkData = JSON.parse(contents.toString());

    return {id: doc.id, ...data, ...bulkData} as Record<string, unknown>;
  } catch (error) {
    logger.error("Database error in getOrganizeProposal:", error);
    throw error;
  }
}

async function findGeneratingProposal(
    uid: string,
    _emailId: string,
): Promise<{id: string; [key: string]: unknown} | null> {
  try {
    const snapshot = await getFirestore()
        .collection("OrganizeProposals")
        .where("uid", "==", uid)
        .where("status", "==", "generating")
        .limit(1)
        .get();
    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    return {id: doc.id, ...doc.data()};
  } catch (error) {
    logger.error("Database error in findGeneratingProposal:", error);
    throw error;
  }
}

async function getResumableOrganizeProposals():
Promise<Array<{id: string; [key: string]: unknown}>> {
  try {
    const proposalsRef = getFirestore().collection("OrganizeProposals");
    const [failedSnapshot, generatingSnapshot] = await Promise.all([
      proposalsRef
          .where("status", "==", "failed")
          .orderBy("createdAt", "desc")
          .limit(50)
          .get(),
      proposalsRef
          .where("status", "==", "generating")
          .orderBy("createdAt", "desc")
          .limit(50)
          .get(),
    ]);

    const proposals = new Map<string, {id: string; [key: string]: unknown}>();
    for (const doc of [...failedSnapshot.docs, ...generatingSnapshot.docs]) {
      proposals.set(doc.id, {id: doc.id, ...doc.data()});
    }

    return Array.from(proposals.values()).sort((a, b) => {
      const aCreatedAt = typeof a.createdAt === "string" ? a.createdAt : "";
      const bCreatedAt = typeof b.createdAt === "string" ? b.createdAt : "";
      return bCreatedAt.localeCompare(aCreatedAt);
    });
  } catch (error) {
    logger.error("Database error in getResumableOrganizeProposals:", error);
    throw error;
  }
}

async function updateOrganizeProposalStatus(
    proposalId: string,
    status: string,
    extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const firestoreExtra = extra ? {...extra} : undefined;

    const gcsFields: string[] = [];

    // Move large data to GCS instead of Firestore
    if (firestoreExtra?.snapshot) gcsFields.push("snapshot");
    if (firestoreExtra?.phaseData) gcsFields.push("phaseData");

    if (gcsFields.length > 0) {
      const doc = await getFirestore()
          .collection("OrganizeProposals")
          .doc(proposalId)
          .get();
      const storagePath = doc.data()?.storagePath as string;
      const bucket = getStorage().bucket();
      const file = bucket.file(storagePath);
      let bulkData: Record<string, unknown> = {};
      try {
        const [contents] = await file.download();
        bulkData = JSON.parse(contents.toString());
      } catch {
        // File may not exist yet
      }
      for (const field of gcsFields) {
        bulkData[field] = firestoreExtra![field];
        delete firestoreExtra![field];
      }
      await file.save(JSON.stringify(bulkData), {
        contentType: "application/json",
      });
    }

    await getFirestore()
        .collection("OrganizeProposals")
        .doc(proposalId)
        .update({status, ...firestoreExtra});
  } catch (error) {
    logger.error("Database error in updateOrganizeProposalStatus:", error);
    throw error;
  }
}

async function getOrganizePhaseData(
    proposalId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const doc = await getFirestore()
        .collection("OrganizeProposals")
        .doc(proposalId)
        .get();
    if (!doc.exists) return undefined;
    const storagePath = doc.data()?.storagePath as string;
    if (!storagePath) return undefined;
    const bucket = getStorage().bucket();
    const [contents] = await bucket.file(storagePath).download();
    const bulkData = JSON.parse(contents.toString());
    return bulkData.phaseData as Record<string, unknown> | undefined;
  } catch (error) {
    logger.error("Database error in getOrganizePhaseData:", error);
    return undefined;
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
  USERS_COLLECTION,
  DRIVE_USERS_COLLECTION,
  getCollectionForAgent,
  getUserFromUID,
  getUserFromEmail,
  findUsersWithExpiringTokens,
  storeUser,
  addUserEmailAddress,
  updateUserTokens,
  saveDriveUserPreferences,
  getDriveUserPreferences,
  addPendingEmailAddress,
  getPendingEmailAddressByCode,
  removeEmailAddress,
  deleteUser,
  saveOrganizeProposal,
  saveOrganizeIntermediateState,
  getOrganizeIntermediateState,
  getOrganizePhaseData,
  finalizeOrganizeProposal,
  getOrganizeProposal,
  findGeneratingProposal,
  getResumableOrganizeProposals,
  updateOrganizeProposalStatus,
  saveDriveFileData,
  getDriveFileData,
  updateDriveFileData,
  cleanupExpiredDriveFileData,
};
