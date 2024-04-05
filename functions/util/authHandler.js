/* eslint-disable require-jsdoc */
const {getUserFromUID,
  findUsersWithExpiringTokens,
  storeUser,
  addUserEmailAddress,
  storeUserCalendars,
  updateUserTokens,
  getPendingEmailAddressByCode} = require("./firestoreHandler");
const {getUserCalendars} = require("./calendarHelper");
const {google} = require("googleapis");
const {CREDENTIALS, REDIRECT_URI_INDEX} = require("./credentials");
const {getAuth} = require("firebase-admin/auth");
const {logger} = require("firebase-functions");
const {isUUID} = require("validator");

async function refreshOAuthTokens(uid) {
  const oauth2Client = await getOauthClient(uid);
  let tokens;
  try {
    tokens = await refreshAccessToken(oauth2Client);
    await updateUserTokens(tokens, uid);
    logger.log(`uid ${uid} access token refreshed to ${tokens.expiry_date}`);
  } catch (error) {
    logger.error("Failed to refresh access token:", uid, error);
    throw error;
  }
}

async function refreshAccessToken(oauth2Client) {
  return new Promise((resolve, reject) => {
    oauth2Client.refreshAccessToken((err, tokens) => {
      if (err) {
        logger.error("Error refreshing access token", err);
        reject(err);
      } else {
        resolve(tokens);
      }
    });
  });
}

async function getOauthClient(uid) {
  const userData = await getUserFromUID(uid);
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

async function oauthCronJob() {
  try {
    const users = await findUsersWithExpiringTokens();
    logger.log("Refreshing tokens for Users with expiring tokens ",
        users.length);
    for (const user of users) {
      await refreshOAuthTokens(user.id);
    }
  } catch (error) {
    logger.error("Error refreshing tokens:", error);
  }
}

async function signupCallbackHandler(query) {
  logger.log("oauthCallback", query);
  const oauth2Client = new google.auth.OAuth2(
      CREDENTIALS.web.client_id,
      CREDENTIALS.web.client_secret,
      CREDENTIALS.web.redirect_uris[REDIRECT_URI_INDEX],
  );
  try {
    const {tokens} = await oauth2Client.getToken(query);
    // Assuming you've got the tokens, specifically the id_token
    if (!tokens.id_token) {
      const error = new Error("Google ID token not found in the response");
      error.code = 400;
      throw error;
    }
    const idToken = tokens.id_token;
    logger.log("id_token", idToken);

    const auth = getAuth();
    oauth2Client.setCredentials(tokens);
    const userInfoResponse = await oauth2Client.request({url: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json"});
    const userEmail = userInfoResponse.data.email;
    logger.log("User Email:", userEmail);
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(userEmail);
    } catch (error) {
      if (error.code === "auth/user-not-found") {
        try {
          userRecord = await auth.createUser({
            email: userEmail,
            emailVerified: true,
          });
          logger.log("Successfully created new user:", userRecord.uid);
        } catch (error) {
          const err = new Error("Authentication failed");
          err.code = 500;
          throw err;
        }
      } else {
        logger.log("Error fetching user record", error.code, error.message);
        const err = new Error("Authentication failed");
        err.code = 500;
        throw err;
      }
    }

    await storeUser(tokens, userRecord);
    await addUserEmailAddress(userRecord, [{email: userEmail, default: true}]);
    const calendars = await getUserCalendars(oauth2Client, userRecord.uid);
    await storeUserCalendars(userRecord, calendars);
    return userRecord;
  } catch (error) {
    console.error("Error exchanging code for tokens", error);
    const err = new Error("Authentication failed");
    err.code = 500;
    throw err;
  }
}

// TODO: other handlers should probably just handle res
// directly as well.
async function verifyAdditionalEmail(req, res) {
  if (!(req?.query?.uuid) && isUUID(req.query.uuid)) {
    // return a 404.
    return res.redirect(302, "https://fwd2cal.com/not-found");
  }

  logger.log("Adding pending email with uuid:", req.query.uuid);
  const pendingEmail = await getPendingEmailAddressByCode(req.query.uuid);
  if (!pendingEmail) {
    return res.redirect(302, "https://fwd2cal.com/not-found");
  }
  const mainUser = await getUserFromUID(pendingEmail.ownerUid);
  await addUserEmailAddress(mainUser, [{
    email: pendingEmail.id,
    default: false,
  }]);
  logger.log(`added ${pendingEmail.id} to user account ${mainUser.uid}`);
  return res.send({data: mainUser.email});
}

module.exports = {
  getOauthClient,
  refreshOAuthTokens,
  oauthCronJob,
  signupCallbackHandler,
  verifyAdditionalEmail,
};


