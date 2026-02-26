import admin from "firebase-admin";
import {getFirestore} from "firebase-admin/firestore";

// Initialize Firebase
admin.initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});

// Re-export all endpoints
export * from "./agents/calendar/endpoints";
export * from "./agents/drive/endpoints";
