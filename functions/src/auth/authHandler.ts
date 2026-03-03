import {
  getUserFromUID,
  findUsersWithExpiringTokens,
  storeUser,
  addUserEmailAddress,
  updateUserTokens,
  getPendingEmailAddressByCode,
} from "../util/firestoreHandler";
import {google, Auth} from "googleapis";
import {getAgentCredentials, getRedirectUriIndex} from "./credentials";
import {
  ENVIRONMENT_NAME,
  RESEND_REGISTERED_USERS_SEGMENT_ID,
} from "../util/config";
import {getAuth} from "firebase-admin/auth";
import {logger} from "firebase-functions/v2";
import {isUUID} from "validator";
import {sendEvent} from "../util/analytics";
import {addContactToResend, addContactToSegment} from "../util/resend";
import {OAuthTokens, FirebaseUserRecord, SignupCallbackResult} from "./types";
import {RequestWithQuery} from "../util/types";
import {Response} from "express";

async function refreshOAuthTokens(
    uid: string,
): Promise<void> {
  const oauth2Client = await getOauthClient(uid);
  let tokens: OAuthTokens;
  try {
    tokens = await refreshAccessToken(oauth2Client);
    await updateUserTokens(tokens, uid);
    logger.log(`uid ${uid} access token refreshed to ${tokens.expiry_date}`);
  } catch (error) {
    logger.warn("Failed to refresh access token:", uid, error);
    throw error;
  }
}

async function refreshAccessToken(
    oauth2Client: Auth.OAuth2Client,
): Promise<OAuthTokens> {
  return new Promise((resolve, reject) => {
    oauth2Client.refreshAccessToken((err, tokens) => {
      if (err) {
        logger.warn("Error refreshing access token", err);
        reject(err);
      } else {
        resolve(tokens as OAuthTokens);
      }
    });
  });
}

async function getOauthClient(
    uid: string,
): Promise<Auth.OAuth2Client> {
  const credentials = getAgentCredentials();
  const userData = await getUserFromUID(uid);
  const redirectUriIndex = getRedirectUriIndex(ENVIRONMENT_NAME.value());
  const oauth2Client = new google.auth.OAuth2(
      credentials.web.client_id,
      credentials.web.client_secret,
      credentials.web.redirect_uris[redirectUriIndex],
  );
  oauth2Client.setCredentials({
    access_token: userData.access_token,
    refresh_token: userData.refresh_token,
  });
  return oauth2Client;
}

async function oauthCronJob(): Promise<void> {
  try {
    const users = await findUsersWithExpiringTokens();
    logger.log(
        "Refreshing tokens for Users with expiring tokens ",
        users.length,
    );
    for (const user of users) {
      try {
        await refreshOAuthTokens(user.id);
      } catch (error) {
        logger.warn(`Failed to refresh tokens for user ${user.id}:`, error);
        sendEvent(user.id, "tokenRefreshFailed");
      }
    }
  } catch (error) {
    logger.warn("Error refreshing tokens:", error);
  }
}

async function deleteAccount(uid: string): Promise<void> {
  const auth = getAuth();
  try {
    await auth.deleteUser(uid);
    logger.log(`Successfully deleted user with UID: ${uid}`);
  } catch (error) {
    logger.warn(`Failed to delete user with UID: ${uid}`, error);
    throw error;
  }
}

async function signupCallbackHandler(
    query: Record<string, string>,
): Promise<SignupCallbackResult> {
  const credentials = getAgentCredentials();
  logger.log("oauthCallback", query);
  const redirectUriIndex = getRedirectUriIndex(ENVIRONMENT_NAME.value());
  const oauth2Client = new google.auth.OAuth2(
      credentials.web.client_id,
      credentials.web.client_secret,
      credentials.web.redirect_uris[redirectUriIndex],
  );
  try {
    const {tokens} = await oauth2Client.getToken({code: query.code});
    // Assuming you've got the tokens, specifically the id_token
    if (!tokens.id_token) {
      const error = new Error(
          "Google ID token not found in the response",
      ) as Error & { code?: number };
      error.code = 400;
      throw error;
    }
    const idToken = tokens.id_token;
    logger.log("id_token", idToken);

    const auth = getAuth();
    oauth2Client.setCredentials(tokens);
    const userInfoResponse = await oauth2Client.request<{ email: string }>({
      url: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    });
    const userEmail = userInfoResponse.data.email;
    logger.log("User Email:", userEmail);
    let userRecord: FirebaseUserRecord;
    try {
      const firebaseUser = await auth.getUserByEmail(userEmail);
      userRecord = {uid: firebaseUser.uid, email: firebaseUser.email || userEmail};
    } catch (error) {
      const authError = error as { code?: string };
      if (authError.code === "auth/user-not-found") {
        try {
          const newUser = await auth.createUser({
            email: userEmail,
            emailVerified: true,
          });
          userRecord = {uid: newUser.uid, email: userEmail};
          logger.log("Successfully created new user:", userRecord.uid);
        } catch (_createError) {
          const err = new Error("Authentication failed") as Error & {
            code?: number;
          };
          err.code = 500;
          throw err;
        }
      } else {
        const firebaseError = error as { code?: string; message?: string };
        logger.log(
            "Error fetching user record",
            firebaseError.code,
            firebaseError.message,
        );
        const err = new Error("Authentication failed") as Error & {
          code?: number;
        };
        err.code = 500;
        throw err;
      }
    }

    await storeUser(tokens as OAuthTokens, userRecord);
    await addUserEmailAddress(userRecord, [{email: userEmail, default: true}]);

    sendEvent(userRecord.uid, "sign_up");
    sendEvent(userEmail, "signupConversion");

    // Add user to Resend contacts and registered users (fire-and-forget)
    addContactToResend(userEmail);
    addContactToSegment(
        userEmail,
        RESEND_REGISTERED_USERS_SEGMENT_ID.value(),
    );

    return {user: userRecord, grantedScope: tokens.scope || ""};
  } catch (error) {
    console.error("Error exchanging code for tokens", error);
    const err = new Error("Authentication failed") as Error & { code?: number };
    err.code = 500;
    throw err;
  }
}

async function verifyAdditionalEmail(
    req: RequestWithQuery,
    res: Response,
): Promise<Response | void> {
  if (!req?.query?.uuid || !isUUID(req.query.uuid)) {
    // return a 404.
    return res.redirect(302, "https://www.fwd2cal.com/not-found");
  }

  logger.log("Adding pending email with uuid:", req.query.uuid);
  const pendingEmail = await getPendingEmailAddressByCode(req.query.uuid);
  if (!pendingEmail) {
    return res.redirect(302, "https://www.fwd2cal.com/not-found");
  }
  await addUserEmailAddress(
      {uid: pendingEmail.ownerUid, email: pendingEmail.ownerEmail},
      [
        {
          email: pendingEmail.id,
          default: false,
        },
      ],
  );
  logger.log(`added ${pendingEmail.id} to user account ${pendingEmail.ownerUid}`);
  sendEvent(pendingEmail.ownerUid, "addUserConfirmed");
  return res.send({data: pendingEmail.ownerEmail});
}

function hasRequiredScopes(
    grantedScope: string,
    requiredScopes: string[],
): boolean {
  const granted = new Set(grantedScope.split(/\s+/));
  if (granted.has("https://www.googleapis.com/auth/drive")) {
    return requiredScopes.every(
        (s) => s.startsWith("https://www.googleapis.com/auth/drive") || granted.has(s),
    );
  }
  return requiredScopes.every((scope) => granted.has(scope));
}

export {
  getOauthClient,
  refreshOAuthTokens,
  oauthCronJob,
  signupCallbackHandler,
  hasRequiredScopes,
  verifyAdditionalEmail,
  deleteAccount,
};
