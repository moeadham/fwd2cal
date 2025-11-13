/* eslint-disable require-jsdoc */
const {logger} = require("firebase-functions");
const {getFirestore} = require("firebase-admin/firestore");
const {ENVIRONMENT_NAME} = require("./config");
const {v4: uuidv4} = require("uuid");
const {sendEvent} = require("./analytics");

async function getUserFromUID(uid) {
  const userDoc = await getFirestore().collection("Users").doc(uid).get();
  if (!userDoc.exists) {
    throw new Error("User document does not exist");
  }
  return {uid: userDoc.id, ...userDoc.data()};
}

async function getUserFromEmail(email) {
  const doc = await getFirestore().collection("EmailAddress").doc(email).get();
  if (!doc.exists) {
    return null;
  }
  const userObject = doc.data();
  return userObject.uid;
}

async function findUsersWithExpiringTokens() {
  const usersRef = getFirestore().collection("Users");
  const now = new Date();
  const twoHoursLater = new Date(now.getTime() + (2 * 60 * 60 * 1000));
  let querySnapshot;
  if (ENVIRONMENT_NAME.value() === "production") {
    querySnapshot =
      await usersRef.where("expiry_date", "<=", twoHoursLater).get();
  } else {
    querySnapshot = await usersRef.get(); // For Local testing.
  }
  if (querySnapshot.empty) {
    console.log("No users with tokens expiring in the next hour found.");
    return [];
  }
  const users = [];
  querySnapshot.forEach((doc) => {
    console.log(`User ${doc.id} has a token expiring soon.`);
    users.push({id: doc.id, ...doc.data()});
  });
  return users;
}

async function storeUser(tokens, user) {
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

async function updateUserTokens(tokens, uid) {
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

async function addUserEmailAddress(user, emails) {
  try {
    emails.forEach(async (item) => {
      await getFirestore().collection("EmailAddress").doc(item.email).set({
        uid: user.uid,
        email: item.email,
        default: item.default,
      });
    });
  } catch (error) {
    logger.error(
        `Database error in addUserEmailAddress for uid ${user.uid}:`,
        error);
    sendEvent(user.uid, "databaseError", {operation: "addUserEmailAddress"});
    throw error;
  }
}

async function removeEmailAddress(email) {
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
        error);
    // Try to get uid for analytics, but don't fail if we can't
    const uid = await getUserFromEmail(email).catch(() => null);
    if (uid) {
      sendEvent(uid, "databaseError", {operation: "removeEmailAddress"});
    }
    throw error;
  }
}

async function addPendingEmailAddress(uid, pendingAddress) {
  try {
    // TODO: ID should be the verification code, not the address.
    const user = await getUserFromUID(uid);
    const verificationCode = uuidv4();
    await getFirestore().collection("PendingEmailAddress")
        .doc(pendingAddress).set({
          ownerUid: user.uid,
          ownerEmail: user.email,
          verificationCode: verificationCode,
        });
    return verificationCode;
  } catch (error) {
    logger.error(
        `Database error in addPendingEmailAddress for uid ${uid}:`,
        error);
    sendEvent(uid, "databaseError", {operation: "addPendingEmailAddress"});
    throw error;
  }
}

async function getPendingEmailAddressByCode(code) {
  const doc = await getFirestore().collection("PendingEmailAddress")
      .where("verificationCode", "==", code).get();
  if (doc.empty) {
    return null;
  }
  const firstDoc = doc.docs[0];
  return {
    id: firstDoc.id,
    ...firstDoc.data(),
  };
}

async function deleteUser(uid) {
  // Delete all email addresses associated to the uid.
  const batch = getFirestore().batch();
  const emailSnapshot = await getFirestore()
      .collection("EmailAddress").where("uid", "==", uid).get();
  emailSnapshot.forEach((doc) => {
    batch.delete(doc.ref);
  });

  const pendingEmailSnapshot = await getFirestore()
      .collection("PendingEmailAddress").where("ownerUid", "==", uid).get();
  pendingEmailSnapshot.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
  // Delete the account.
  await getFirestore().collection("Users").doc(uid).delete();
  // You still need to delete the user from firebase.
  return;
}

module.exports = {
  getUserFromUID,
  getUserFromEmail,
  findUsersWithExpiringTokens,
  storeUser,
  addUserEmailAddress,
  updateUserTokens,
  addPendingEmailAddress,
  getPendingEmailAddressByCode,
  removeEmailAddress,
  deleteUser,
};

