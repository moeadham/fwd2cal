/* eslint-disable max-len */
import {PromptConfig} from "../../types";

const prompt: PromptConfig = {
  model: "openai/gpt-4.1-mini",
  prompt: `Task: Analyze the email subject and body to select the most appropriate skill/action.

Available Skills:
{skills_context}

Rules:
1. Check BOTH subject and body for skill triggers
2. For "add-email" and "remove-email", extract the email address if present
3. When uncertain, default to "add-event"
4. Return confidence score reflecting certainty

Respond with JSON:
{
  "skill_id": "the skill ID from the list above",
  "confidence": 0.0 to 1.0,
  "reasoning": "brief explanation",
  "extracted_value": "any extracted value like email address, or null"
}

Respond only with JSON.
`,
};

export {prompt};
