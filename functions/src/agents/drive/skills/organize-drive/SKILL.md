---
name: organize-drive
description: Scan and reorganize the user's entire Google Drive with a proposed new directory structure and standardized filenames.
triggers:
  - organize my drive
  - organize drive
  - reorganize my drive
  - reorganize drive
  - clean up my drive
  - clean up drive
  - sort my drive
  - sort drive
fastPattern: "organiz(?:e|ing)\\s+(?:my\\s+)?drive|clean\\s+up\\s+(?:my\\s+)?drive|sort\\s+(?:my\\s+)?drive|reorganiz(?:e|ing)\\s+(?:my\\s+)?drive"
subjectOnly: false
---

# Organize Drive

## When to use
- User explicitly asks to have their entire Google Drive reorganized
- Subject contains phrases like "organize my drive", "clean up drive", "sort my drive"

## Execution
1. Verify user has OAuth with full `drive` scope (not just `drive.file`)
2. If not, send auth-upgrade email with link to full-scope OAuth
3. Scan all files and folders in user's Drive
4. Send file listing to LLM to propose new directory structure
5. Calculate per-file cost for reorganization
6. Send proposal email showing before/after structure and cost
7. Handle approval reply and execute reorganization
