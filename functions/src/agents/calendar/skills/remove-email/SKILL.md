---
name: remove-email
description: Unlink an email address from the user's fwd2cal account. Pattern "remove" followed by a valid email address can appear in subject OR body.
triggers:
  - remove <email>
fastPattern: "remove\\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,6})"
checkBody: true
---

# Remove Email Address

## When to use
- User wants to stop forwarding from a linked address
- Pattern: "remove user@example.com" in subject or body

## Execution
1. Extract email address from matched pattern
2. Verify user owns the email address
3. Remove the email association
4. Send confirmation email
