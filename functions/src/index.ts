import admin from "firebase-admin";
import {getFirestore} from "firebase-admin/firestore";

// Initialize Firebase
admin.initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});

// Re-export all routes
export * from "./agents/calendar/routes";
export * from "./agents/drive/routes";
