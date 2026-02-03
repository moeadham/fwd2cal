---
name: add-email
description: Link an additional email address to the user's fwd2cal account. Pattern "add" followed by a valid email address can appear in subject OR body.
triggers:
  - add <email>
fastPattern: "add\\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,6})"
checkBody: true
---

# Add Email Address

## When to use
- User wants to forward emails from another address
- Pattern: "add user@example.com" in subject or body

## Execution
1. Extract email address from matched pattern
2. Verify email isn't already registered
3. Send verification email to the new address
