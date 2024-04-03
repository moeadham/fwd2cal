/* eslint-disable require-jsdoc */
const {logger} = require("firebase-functions");
const {getFirestore} = require("firebase-admin/firestore");


async function getUser(email) {
  let sender;
  try {
    sender = JSON.parse(email.envelope).from.toLowerCase();
  } catch (error) {
    logger.error("Error parsing envelope", error);
    return null;
  }
  const doc = await getFirestore().collection("EmailAddress").doc(sender).get();
  if (!doc.exists) {
    return null;
  }
  const userObject = doc.data();
  return userObject.uid;
}

module.exports = {
  getUser,
};

