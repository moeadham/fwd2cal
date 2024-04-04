/* eslint-disable require-jsdoc */
// const {logger} = require("firebase-functions");
const {getFirestore} = require("firebase-admin/firestore");
const {ENVIRONMENT} = require("./credentials");
const {v4: uuidv4} = require("uuid");

async function getUserFromUID(uid) {
  const userDoc = await getFirestore().collection("Users").doc(uid).get();
  if (!userDoc.exists) {
    throw new Error("User document does not exist");
  }
  return userDoc.data();
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
  if (ENVIRONMENT === "production") {
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
  await getFirestore().collection("Users").doc(user.uid).set({
    email: user.email,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_scope: tokens.scope,
  });
}

async function updateUserTokens(tokens, uid) {
  await getFirestore().collection("Users").doc(uid).update({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });
}

async function addUserEmailAddress(user, emails) {
  emails.forEach(async (item) => {
    await getFirestore().collection("EmailAddress").doc(item.email).set({
      uid: user.uid,
      email: item.email,
      default: item.default,
    });
  });
}

async function addPendingEmailAddress(user, pendingAddress) {
  const verificationCode = uuidv4();
  await getFirestore().collection("PendingEmailAddress")
      .doc(pendingAddress).set({
        ownerUid: user.uid,
        ownerEmail: user.email,
        verificationCode: verificationCode,
      });
  return verificationCode;
}

async function storeUserCalendars(user, calendars) {
  for (const calendar of calendars) {
    const firestoreID = `${calendar.uid}${calendar.calendar_id}`;
    const calendarRef = getFirestore().collection("Calendars").doc(firestoreID);
    await calendarRef.get().then((doc) => {
      if (doc.exists) {
        calendarRef.update(calendar);
      } else {
        calendarRef.set(calendar);
      }
    });
  }
}

module.exports = {
  getUserFromUID,
  getUserFromEmail,
  findUsersWithExpiringTokens,
  storeUser,
  addUserEmailAddress,
  storeUserCalendars,
  updateUserTokens,
  addPendingEmailAddress,
};

