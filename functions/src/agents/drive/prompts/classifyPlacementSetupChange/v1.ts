/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const PlacementSetupUpdateSchema = z.object({
  granularity: z.string().nullable().describe("Updated granularity, if changed; otherwise null"),
  namedEntities: z.array(z.string()).nullable().describe("Complete updated named entity list, if changed; otherwise null"),
});

const ClassifyPlacementSetupChangeSchema = z.object({
  is_change: z.boolean().describe("True if the user's reply asks to change placement setup"),
  updated: PlacementSetupUpdateSchema.describe("Only the placement setup fields actually changed by the reply"),
});

type ClassifyPlacementSetupChangeResult = z.infer<typeof ClassifyPlacementSetupChangeSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  temperature: 0,
  prompt: `Determine whether the user is changing Google Drive placement setup before directory tree generation.

Current placement setup includes:
- granularity: how specific folder destinations should be
- namedEntities: specific companies, organizations, institutions, projects, or matters the user wants treated as placement anchors

Return is_change true when the reply asks to add, remove, or alter granularity or named entities. Return false when the reply is approval, vague discussion, or an unrelated folder/filename change.

When is_change is true:
- Return only the fields actually changed by the user's reply inside updated.
- For namedEntities, return the complete intended list after applying the user's change, not just the new or removed item.
- Preserve user wording for named entities.
- granularity must be one of: by_entity, by_document_type, by_date, mixed. Map user phrasing to the closest value only when clear; otherwise leave granularity null.

When is_change is false, set every field in updated to null.

Return JSON only.`,
};

export {prompt, ClassifyPlacementSetupChangeSchema, ClassifyPlacementSetupChangeResult};
