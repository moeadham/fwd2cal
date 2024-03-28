/* eslint-disable camelcase */
/* eslint-disable require-jsdoc */
/* eslint-disable max-len */

const fs = require("fs");
const path = require("path");
const CREDENTIALS_PATH = path.join(
    "auth",
    "google-auth-credentials.json",
);

const CREDENTIALS = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, {encoding: "utf-8"}),
);
const {getAuth} = require("firebase-admin/auth");

const {google} = require("googleapis");
const {logger} = require("firebase-functions");
const functions = require("firebase-functions");
const {getFirestore} = require("firebase-admin/firestore");
const admin = require("firebase-admin");
const busboy = require("busboy");

admin.initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});

const redirectUriIndex = functions.config() && functions.config().environment && functions.config().environment.name === "production" ? 2 : 1;
logger.log("redirectUriIndex", redirectUriIndex);
logger.log("redirectURL", CREDENTIALS.web.redirect_uris[redirectUriIndex]);

const URL = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${CREDENTIALS.web.client_id}&redirect_uri=${CREDENTIALS.web.redirect_uris[redirectUriIndex]}&scope=https://www.googleapis.com/auth/calendar+https://www.googleapis.com/auth/userinfo.email+https://www.googleapis.com/auth/userinfo.profile+openid&access_type=offline&prompt=consent`;
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
  logger.log("CALENDAR OBJECT FULL:", calendarList);
  const calendars = calendarList.data.items.map((calendar) => ({
    kind: calendar.kind,
    etag: calendar.etag,
    selected: calendar.selected,
    accessRole: calendar.accessRole,
    conferenceProperties: calendar.conferenceProperties,
    calendar_id: calendar.id,
    summary: calendar.summary,
    summaryOverride: calendar.summaryOverride,
    description: calendar.description,
    primary: calendar.primary,
    timeZone: calendar.timeZone,
    location: calendar.location,
    hidden: calendar.hidden,
    deleted: calendar.deleted,
    uid: user.uid,
  }));
  logger.log("Calendars:", calendars);
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

async function addUserEmailAddress(user, emails) {
  emails.forEach(async (item) => {
    await getFirestore().collection("EmailAddress").doc(item.email).set({
      uid: user.uid,
      email: item.email,
      default: item.default,
    });
  });
}

exports.oauthCallback = functions.https.onRequest(async (req, res) => {
  logger.log("oauthCallback", req.query);
  const oauth2Client = new google.auth.OAuth2(
      CREDENTIALS.web.client_id,
      CREDENTIALS.web.client_secret,
      CREDENTIALS.web.redirect_uris[redirectUriIndex],
  );
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
      if (error.code === "auth/user-not-found") {
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
    await addUserEmailAddress(userRecord, [{email: userEmail, default: true}]);
    await storeUserCalendars(userRecord, oauth2Client);
    res.json({message: "Authentication successful", uid: userRecord.uid});
  } catch (error) {
    console.error("Error exchanging code for tokens", error);
    res.status(500).send("Authentication failed");
  }
});

exports.sendgridCallback = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }
  const bb = busboy({headers: req.headers});
  const result = {};

  //   bb.on("file", (fieldname, file, filename, encoding, mimetype) => {
  //     console.log(`File [${fieldname}]: filename: ${filename}, encoding: ${encoding}, mimetype: ${mimetype}`);
  //     // You can use file streams here to process the file
  //     file.on("data", (data) => {
  //       console.log(`File [${fieldname}] got ${data.length} bytes`);
  //     }).on("end", () => {
  //       console.log(`File [${fieldname}] Finished`);
  //     });
  //   });

  bb.on("field", (fieldname, val) => {
    // console.log(`Field [${fieldname}]: value: ${val}`);
    result[fieldname] = val;
  });

  bb.on("finish", () => {
    // console.log("Done parsing form!");
    // logger.log("sendgridCallback", result);
    res.json({message: "thanks", data: result});
  });

  bb.end(req.rawBody);
});

