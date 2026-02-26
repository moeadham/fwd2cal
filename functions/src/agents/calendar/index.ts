import admin from "firebase-admin";
import {getFirestore} from "firebase-admin/firestore";

admin.initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});

export * from "./routes";
