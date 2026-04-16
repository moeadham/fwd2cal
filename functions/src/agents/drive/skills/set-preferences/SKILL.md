---
name: set-preferences
description: Update the user's fwd2drive folder and filename naming conventions.
triggers:
  - preference
  - preferences
  - convention
fastPattern: "(preference|convention)"
subjectOnly: false
checkBody: true
---

# Set Preferences

## When to use
- User asks to update folder or filename conventions
- User uses terms like "preferences", "convention", "folder naming", or "filename format"

## Execution
1. Parse requested folder and filename convention changes.
2. Persist only explicitly requested changes.
3. Reply with current conventions and before/after values for changed conventions.
