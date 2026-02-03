---
name: delete-account
description: Permanently delete the user's fwd2cal account and all associated data.
triggers:
  - delete account
  - remove account
  - close account
fastPattern: "delete\\s*account"
checkBody: true
---

# Delete Account

## When to use
- User explicitly requests account deletion
- Pattern: "delete account" in subject or body

## Execution
1. Delete user from Firestore
2. Revoke OAuth tokens
3. Remove from email segments
4. Send confirmation email
