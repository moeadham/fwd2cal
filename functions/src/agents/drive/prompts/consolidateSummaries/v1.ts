/* eslint-disable max-len */
import {DrivePromptConfig} from "../../types";

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  prompt: `Combine these per-batch summaries into a single concise summary (2-3 sentences max) of all proposed Drive changes.`,
};

export {prompt};
