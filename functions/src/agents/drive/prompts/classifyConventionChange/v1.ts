/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const ClassifyConventionChangeSchema = z.object({
  is_change: z.boolean().describe("True if the user's reply asks to change the filename convention"),
  new_convention: z.string().describe("Updated convention when is_change is true; otherwise repeat the current convention"),
});

type ClassifyConventionChangeResult = z.infer<typeof ClassifyConventionChangeSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  temperature: 0,
  prompt: `Determine whether the user is changing a filename convention.

Return is_change true when the reply requests a different format, date style, separator, casing, or naming rule. Return false when the reply is approval, vague discussion, or unrelated. If true, extract the complete new convention as a concise rule.`,
};

export {prompt, ClassifyConventionChangeSchema, ClassifyConventionChangeResult};
