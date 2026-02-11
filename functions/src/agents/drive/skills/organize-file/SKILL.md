---
name: organize-file
description: Upload forwarded email attachments to the user's Google Drive, automatically choosing the best folder and filename based on the file content and existing Drive structure.
triggers:
  - fwd:
  - fw:
  - forwarded
  - file
  - save
  - drive
  - upload
  - organize
subjectOnly: true
---

# Organize File in Drive

## When to use
- Email contains file attachments the user wants saved to Drive
- Forwarded emails with documents, spreadsheets, PDFs, images, etc.
- Any email with attachments sent to the Drive address

## Execution
1. Authenticate with user's Google Drive (OAuth)
2. Download attachment(s) from the email
3. Read user's full Drive folder tree
4. Extract content summary from each file for context
5. Use LLM to pick the best folder and filename for each file
6. Upload file(s) to the chosen location (create folders if needed)
7. Send confirmation email with file locations and Drive links
