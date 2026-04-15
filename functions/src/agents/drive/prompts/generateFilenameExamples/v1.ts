/* eslint-disable max-len */
import {DrivePromptConfig} from "../../types";

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  prompt: `You generate filename examples for a Google Drive organization assistant.

You will receive:
1. A filename convention
2. Today's date
3. Three fixed document descriptions and extensions

Return exactly three filenames, one for each description, that conform to the given convention.

## Rules:
- Preserve each requested extension exactly
- Use today's date where the convention includes date tokens
- Replace description placeholders such as Description, description, desc, or name with the requested document description
- Keep the examples concise and realistic
- Do not include folder paths
- Do not explain the examples`,
};

export {prompt};
