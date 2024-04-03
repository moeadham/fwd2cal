/* eslint-disable require-jsdoc */
const {getFirestore} = require("firebase-admin/firestore");
const {google} = require("googleapis");
const {CREDENTIALS, REDIRECT_URI_INDEX} = require("./credentials");

async function getOauthClient(uid) {
  const userDoc = await getFirestore().collection("Users").doc(uid).get();
  if (!userDoc.exists) {
    throw new Error("User document does not exist");
  }
  const userData = userDoc.data();
  const oauth2Client = new google.auth.OAuth2(
      CREDENTIALS.web.client_id,
      CREDENTIALS.web.client_secret,
      CREDENTIALS.web.redirect_uris[REDIRECT_URI_INDEX],
  );
  oauth2Client.setCredentials({
    access_token: userData.access_token,
    refresh_token: userData.refresh_token,
  });
  return oauth2Client;
}

module.exports = {
  getOauthClient,
}

