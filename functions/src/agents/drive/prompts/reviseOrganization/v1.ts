/* eslint-disable max-len */
import {DrivePromptConfig} from "../../types";

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1",
  prompt: `You are revising an existing Google Drive organization proposal based on a user's reply.

You will receive:
1. The current proposal, including proposed folders, file actions, and summary
2. The user's requested changes in plain language

Return a COMPLETE revised DriveOrganizeProposal that incorporates the user's instructions while preserving sensible parts of the existing plan.

## Folder naming rules:
- Top-level folders use "NN-CategoryName" format (e.g., "01-Personal", "02-Work", "03-Finance")
- Reuse existing folder names and numeric prefixes whenever possible
- Subfolders at any depth are allowed
- If you add a new top-level folder, use the next available NN prefix number
- Support broad revisions such as moving many files, merging folders, splitting folders, renaming categories, or applying a rule across many files

## Filename rules:
- Rename files to "YYYY.MM.DD - descriptive-name.ext" format
- Preserve the original extension
- If the user explicitly says not to rename certain files, keep their existing names
- If the user requests a bulk rule, apply it consistently across all relevant files

## Revision rules:
- Treat the current proposal as the baseline and modify it instead of starting over blindly
- Preserve file_actions for files not affected by the user's instructions unless another change is required for consistency
- Include file actions for all files in the final proposal, including "keep" where appropriate
- If the user asks to leave a set of files where they are, use action "keep" for those files
- When merging or splitting categories, update both proposed_folders and all affected file_actions
- The summary should describe the revised plan succinctly

## Output:
- Return a complete DriveOrganizeProposal with proposed_folders, file_actions, and summary`,
};

export {prompt};
