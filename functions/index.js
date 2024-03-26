/* eslint-disable require-jsdoc */
/* eslint-disable max-len */

const fs = require("fs");
const path = require("path");
const CREDENTIALS_PATH = path.join(
    "../",
    ".auth",
    "google-auth-credentials.json",
);

const CREDENTIALS = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, {encoding: "utf-8"}),
);
const {
  getAuth,
  signInWithCredential,
  GoogleAuthProvider,
} = require("firebase-admin/auth");

const {google} = require("googleapis");
const {logger} = require("firebase-functions");
const functions = require("firebase-functions");
const {getFirestore} = require("firebase-admin/firestore");
const admin = require("firebase-admin");

admin.initializeApp();

const URL = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${CREDENTIALS.web.client_id}&redirect_uri=${CREDENTIALS.web.redirect_uris[1]}&scope=https://www.googleapis.com/auth/calendar+https://www.googleapis.com/auth/userinfo.email+https://www.googleapis.com/auth/userinfo.profile+openid&access_type=offline&prompt=consent`;
logger.log(URL);

async function storeUser(tokens, user) {
  await getFirestore().collection("Users").doc(user.uid).set({
    email: user.email,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_scope: tokens.scope,
  });
}

async function storeUserCalendars(user, oauth2Client) {
  const calendar = google.calendar({version: "v3", auth: oauth2Client});
  const calendarList = await calendar.calendarList.list();
  const calendars = calendarList.data.items.map((calendar) => ({
    id: calendar.id,
    summary: calendar.summary,
    timeZone: calendar.timeZone,
  }));
  logger.log("Calendars:", calendars);
}

exports.oauthCallback = functions.https.onRequest(async (req, res) => {
  logger.log("oauthCallback", req.query);
  const oauth2Client = new google.auth.OAuth2(
      CREDENTIALS.web.client_id,
      CREDENTIALS.web.client_secret,
      CREDENTIALS.web.redirect_uris[1],
  );
  const code = req.query.code;
  try {
    const {tokens} = await oauth2Client.getToken(req.query);
    logger.log("tokens", tokens);
    // Assuming you've got the tokens, specifically the id_token
    if (!tokens.id_token) {
      res.status(400).send("Google ID token not found in the response");
      return;
    }
    const id_token = tokens.id_token;
    logger.log("id_token", id_token);

    const auth = getAuth();
    oauth2Client.setCredentials(tokens);
    const userInfoResponse = await oauth2Client.request({url: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json"});
    const userEmail = userInfoResponse.data.email;
    logger.log("User Email:", userEmail);
    let userRecord;

    try {
      userRecord = await auth.getUserByEmail(userEmail);
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        try {
          userRecord = await auth.createUser({
            email: userEmail,
            emailVerified: true,
          });
          logger.log("Successfully created new user:", userRecord.uid);
        } catch (error) {
          logger.error("Error creating new user:", error);
          res.status(500).send("Authentication failed");
          return;
        }
      } else {
        logger.error("Error fetching user:", error);
        res.status(500).send("Authentication failed");
        return;
      }
    }

    await storeUser(tokens, userRecord);
    res.json({message: "Authentication successful", uid: userRecord.uid});
  } catch (error) {
    console.error("Error exchanging code for tokens", error);
    res.status(500).send("Authentication failed");
  }
});

exports.signin = functions.https.onRequest((req, res) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Sign In with Google</title>
        <script type="module">
        // Import the functions you need from the SDKs you need
        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
        import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-analytics.js";
        import { getAuth, signInWithPopup, GoogleAuthProvider, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
        import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-functions.js';

        // TODO: Add SDKs for Firebase products that you want to use
        // https://firebase.google.com/docs/web/setup#available-libraries
    
        // Your web app's Firebase configuration
        // For Firebase JS SDK v7.20.0 and later, measurementId is optional
        const firebaseConfig = {
        apiKey: "AIzaSyDMWGsG6_bcETYIGc3PSOVNzQf6QZfjpxQ",
        authDomain: "fwd2cal.firebaseapp.com",
        projectId: "fwd2cal",
        storageBucket: "fwd2cal.appspot.com",
        messagingSenderId: "535781060024",
        appId: "1:535781060024:web:3e02a2d4006dcf56a9334d",
        measurementId: "G-YDR4TFPVYZ"
        };
    
        // Initialize Firebase
        const app = initializeApp(firebaseConfig);
        const analytics = getAnalytics(app);
        const functions = getFunctions(app);
        const auth = getAuth(app);
        connectAuthEmulator(auth, "http://127.0.0.1:9099");
        connectFunctionsEmulator(functions, "localhost", 5001);


        function signInWithGoogle() {
            const provider = new GoogleAuthProvider();
            provider.addScope('https://www.googleapis.com/auth/contacts.readonly');
            provider.addScope('https://www.googleapis.com/auth/calendar');
            signInWithPopup(auth, provider)
                .then((result) => {
                    // This gives you a Google Access Token. You can use it to access the Google API.
                    const credential = GoogleAuthProvider.credentialFromResult(result);
                    const token = credential.accessToken;
                    // The signed-in user info.
                    const user = result.user;
                    // IdP data available using getAdditionalUserInfo(result)
                    console.log(result);
                    console.log(credential);
                    const storeTokensFunction = httpsCallable(functions, 'storeUserTokens');
                    storeTokensFunction(credential)
                        .then((result) => {
                            console.log(result.data.result); // Tokens stored successfully.
                        })
                        .catch((error) => {
                            console.error("Error storing tokens:", error);
                        });
                    // ...
}).catch((error) => {
                    // Handle Errors here.
                    console.log(error);
                    const errorCode = error.code;
                    const errorMessage = error.message;
                    // The email of the user's account used.
                    // The AuthCredential type that was used.
                    const credential = GoogleAuthProvider.credentialFromError(error);
                    console.log(credential);
                    
                    // ...
                });
        }
        window.signInWithGoogle = signInWithGoogle;
        window.signInWithPopup = signInWithPopup;
        // window.storeTokensFunction = storeTokensFunction;
    </script>
    </head>
    <body>
        <h2>Sign In with Google</h2>
        <button onclick="signInWithGoogle()">Sign In/Sign Up</button>
        
    </body>
    </html>
    `;
  res.send(html);
});

exports.newUserCreated = functions.auth.user().onCreate(async (user) => {
  logger.log(user);
  return await getFirestore().collection("Users").doc(user.uid).set({
    email: user.email,
  });
});

exports.storeUserTokens = functions.https.onCall(async (data, context) => {
  // Ensure the user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "The function must be called while authenticated.");
  }

  const uid = context.auth.uid;
  logger.log(data);

  // Validate accessToken and refreshToken if necessary

  //   await admin.firestore().collection("Users").doc(uid).set({
  //     accessToken,
  //     refreshToken,
  //   }, {merge: true});

  return {result: "Tokens stored successfully."};
});
