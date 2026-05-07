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
- edgeCaseRules: rules guiding placement, filename, or any other organize-drive decision.
  A rule pairs a SCOPE with an ACTION.

  Scopes name what set of files the rule applies to. Common forms:
    - by folder or subtree           (e.g. "for files under <folder>/...")
    - by file type / extension       (e.g. "all PDFs", "all images")
    - by date or year                (e.g. "anything from 2023")
    - by named entity                (e.g. "anything mentioning <CompanyName>")
    - by filename pattern            (e.g. "files starting with 'invoice_'")

  Actions name what to do with that scope. Common forms:
    - preserve original placement
    - route to a specific folder
    - normalize filename in a specific way
    - ignore / leave alone
    - reorganize aggressively

  A reply that names a scope and an action is a rule.

  A single reply may produce MULTIPLE rules when it names multiple scopes.
  Example: "keep <X> intact, reorganize the rest" → one rule preserving <X>,
  one rule reorganizing the complement.

- examples: concrete file-to-folder placement examples

Return is_change true when the reply names a scope and an action — i.e. asks to add, remove, or alter any organize-drive preference.

Return is_change false only when the reply is approval, off-topic commentary that names no scope or action, or a request unrelated to organize-drive (e.g. account changes, subscription questions).

When is_change is true:
- Return only the fields actually changed by the user's reply inside updated.
- For array fields, return the complete intended value after applying the user's change to the current rules, not just the new item.
- Preserve user wording for freeform edgeCaseRules and examples.

When is_change is false, set every field in updated to null.

Return JSON only.`,
};

export {prompt, ClassifyPlacementRulesChangeSchema, ClassifyPlacementRulesChangeResult};
