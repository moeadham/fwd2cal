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
- Merge folders that name the same proper-noun entity whether they appear under the same parent or different roots. Treat deepest-segment matches case-insensitively when the surrounding paths show the same named subject.
- Choose the merge destination by preferring an active root over an archive root when both are in use, then the more specific or convention-consistent ancestry, then the higher "(N files)" count as a tiebreaker.
- Entities are named subjects only, such as a client, vendor, project, matter, place, vehicle, season, or opaque code. Never treat generic category words as entities.
- Prefer the shorter, cleaner, convention-consistent destination.
- Preserve meaningful project, client, matter, vehicle, season, or opaque-code subfolders.
- Use "rename" only when the "from" path appears verbatim (including casing) in the input tree. For casing-only consolidation, use "merge" with the surviving casing as "into".
- When uncertain, return no operation rather than risking a bad consolidation.

## Operation fields
- rename: action, from, to, description
- merge: action, from, into
- Set unused fields to null.

## Example: cross-root entity dedup
Input tree:
- 02-Business/Holdings/AcmeCo (5 files)
- 07-Archive/AcmeCo (3 files)
- 07-Archive/AcmeCo/Graphical Assets (3 files)

Correct response:
{
  "folder_operations": [
    {
      "action": "merge",
      "from": "07-Archive/AcmeCo",
      "into": "02-Business/Holdings/AcmeCo",
      "path": null,
      "to": null,
      "description": null,
      "source_path": null
    }
  ],
  "summary": "Merged duplicate AcmeCo entity folders into the active business holdings path."
}

Reasoning: AcmeCo is the same named entity under two roots. The active 02-Business/Holdings path is already in use and has the higher file count, so it is the canonical destination while 07-Archive/AcmeCo and its descendants fold underneath it.`,
};

export {prompt};
