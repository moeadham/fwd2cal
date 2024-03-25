/* eslint-disable max-len */
const {logger} = require("firebase-functions");
const functions = require("firebase-functions");
const {getFirestore} = require("firebase-admin/firestore");
const admin = require("firebase-admin");
admin.initializeApp();

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
  return await getFirestore().collection("Users").add({
    uid: user.uid,
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
