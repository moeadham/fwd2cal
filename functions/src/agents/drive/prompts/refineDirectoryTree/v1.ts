/* eslint-disable max-len */
import {DrivePromptConfig} from "../../types";
import {REFINE_TREE_PER_CHUNK_MODEL} from "../../config";

const prompt: DrivePromptConfig = {
  model: REFINE_TREE_PER_CHUNK_MODEL.value(),
  temperature: 0.1,
  prompt: `You refine an in-progress Google Drive organization folder tree.

You will receive only the proposed folder tree accumulated so far during automatic planning. Return folder_operations that simplify this tree without changing the intended file groupings.

## Output contract
- Return JSON with folder_operations and summary.
- folder_operations may contain ONLY action "rename" or "merge".
- Use "rename" to relocate or rename a subtree while preserving its descendants.
- Use "merge" to fold one duplicate or redundant subtree into another.
- Return an empty folder_operations array when no safe refinement is needed.

## Strictly forbidden
- Do not emit create.
- Do not emit delete.
- Do not emit preserve_source.
- Do not invent folders absent from the input tree except as the destination path for a rename of an existing subtree.
- Do not perform file-level regrouping. The system will cascade folder changes deterministically.

## Refinement guidance
- Collapse status, era, or scope nesting that is redundant with the parent. Examples: a legacy or inactive segment under an archive root; an active or current segment under a live-work root; a year segment under a parent already scoped to that same year.
- Merge near-duplicate siblings caused by casing, whitespace, punctuation, or numeric-prefix drift when their names clearly refer to the same category.
- Prefer the shorter, cleaner, convention-consistent destination.
- Preserve meaningful project, client, matter, person, vehicle, season, or opaque-code subfolders.
- When uncertain, return no operation rather than risking a bad consolidation.

## Operation fields
- rename: action, from, to, description
- merge: action, from, into
- Set unused fields to null.`,
};

export {prompt};
