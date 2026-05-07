/* eslint-disable max-len */
import {DrivePromptConfig} from "../../types";
import {REFINE_TREE_PER_CHUNK_MODEL} from "../../config";

const prompt: DrivePromptConfig = {
  model: REFINE_TREE_PER_CHUNK_MODEL.value(),
  temperature: 0.1,
  prompt: `You refine an in-progress Google Drive organization folder tree.

You will receive approved folders, optional user conventions and rules, and the proposed folder tree accumulated so far during automatic planning. Return folder_operations that simplify this tree without changing the intended file groupings.

## Output contract
- Return JSON with folder_operations and summary.
- folder_operations may contain ONLY action "rename" or "merge".
- Use "rename" to relocate or rename a subtree while preserving its descendants.
- Use "merge" to fold one duplicate or redundant subtree into another.
- Return an empty folder_operations array when no safe refinement is needed.

Hard rule: folders listed in ## Approved Folder Structure are user-approved and MUST NOT appear as from, into, path, or to in any operation, nor may any ancestor of an approved folder. Skip any operation that would affect them.

Hard rule: if the user's ## Placement Rules or its examples explicitly mention a folder, that folder is also off-limits.

## Strictly forbidden
- Do not emit create.
- Do not emit delete.
- Do not emit preserve_source.
- Do not invent folders absent from the input tree except as the destination path for a rename of an existing subtree.
- Do not perform file-level regrouping. The system will cascade folder changes deterministically.

## Refinement guidance
Only consolidate folders that are clearly redundant duplicates of each other: the same proper-noun entity under two roots, or case-only variants of the same name. Otherwise return no operations. Use "rename" only when the "from" path appears verbatim in the input tree. For casing-only consolidation, use "merge" with the surviving casing as "into". When uncertain, return no operation rather than risking a bad consolidation.

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
