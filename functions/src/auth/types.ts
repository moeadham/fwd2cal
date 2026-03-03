// ============================================================================
// AGENT TYPES
// ============================================================================

export type AgentName = "calendar" | "drive";

// ============================================================================
// USER AND OAUTH TYPES
// ============================================================================

// User document from Firestore
export interface UserDocument {
  uid: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_scope: string;
}

// Email address document from Firestore
export interface EmailAddressDocument {
  uid: string;
  email: string;
  default: boolean;
}

// Pending email address document from Firestore
export interface PendingEmailAddressDocument {
  id: string;
  ownerUid: string;
  ownerEmail: string;
  verificationCode: string;
}

// OAuth tokens from Google
export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

// Result from signupCallbackHandler — includes granted scopes for validation
export interface SignupCallbackResult {
  user: FirebaseUserRecord;
  grantedScope: string;
}

// Firebase user record
export interface FirebaseUserRecord {
  uid: string;
  email: string;
  emailVerified?: boolean;
}

// Google OAuth2 credentials
export interface GoogleOAuthCredentials {
  web: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

// User with expiring tokens query result
export interface UserWithExpiringTokens {
  id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

// Email item for adding to user
export interface EmailItem {
  email: string;
  default: boolean;
}
