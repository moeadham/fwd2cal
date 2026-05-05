/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const PlacementRulesUpdateSchema = z.object({
  edgeCaseRules: z.array(z.string()).nullable().describe("Complete updated edge-case rule list, if changed; otherwise null"),
  examples: z.array(z.string()).nullable().describe("Complete updated file-to-folder example list, if changed; otherwise null"),
});

const ClassifyPlacementRulesChangeSchema = z.object({
  is_change: z.boolean().describe("True if the user's reply asks to change organize-drive rules"),
  updated: PlacementRulesUpdateSchema.describe("Only the organize-drive rule fields actually changed by the reply"),
});

type ClassifyPlacementRulesChangeResult = z.infer<typeof ClassifyPlacementRulesChangeSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  temperature: 0,
  prompt: `Determine whether the user is changing organize-drive rules — these may concern file placement, filename formatting, or any other organize-drive instruction.

Current placement rules include:
- edgeCaseRules: freeform rules guiding placement, filename, or any other organize-drive decision.
- examples: concrete file-to-folder placement examples

Return is_change true when the reply asks to add, remove, or alter any of those organize-drive preferences. Return false when the reply is approval, vague discussion, or a request unrelated to organize-drive (e.g. account changes, subscription questions).

When is_change is true:
- Return only the fields actually changed by the user's reply inside updated.
- For array fields, return the complete intended value after applying the user's change to the current rules, not just the new item.
- Preserve user wording for freeform edgeCaseRules and examples.

When is_change is false, set every field in updated to null.

Return JSON only.`,
};

export {prompt, ClassifyPlacementRulesChangeSchema, ClassifyPlacementRulesChangeResult};
