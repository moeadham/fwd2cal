/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const ProposeFileNameSchema = z.object({
  file_id: z.string().describe("Google Drive file ID"),
  current_name: z.string().describe("Current filename"),
  current_path: z.string().describe("Current folder path"),
  new_name: z.string().describe("Proposed filename using the approved convention"),
  reason: z.string().describe("Brief reasoning for the filename choice"),
});

type ProposeFileNameResult = z.infer<typeof ProposeFileNameSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  temperature: 0.1,
  prompt: `You are renaming one Google Drive file at a time.

You will receive the approved filename convention, metadata for one file, and any available content summary. Some requests may also include attached images: either rendered document pages or the file itself when the file is an image. Use both the text summary and any attached images for content-aware filename decisions. Pick the best filename only.

Rules:
- Return exactly one filename proposal for the supplied file.
- Placement is out of scope. Do not suggest folders or actions.
- Follow the approved filename convention exactly.
- Preserve the original file extension when possible.
- When images are attached, inspect them for visible text and content, and use that evidence to improve new_name.
- Use the most relevant date from document content first, then visible image text, then the current filename, then the content summary when the convention requires a date.
- Keep meaningful descriptors from the current filename when they help identify the document.
- Keep new_name concise, descriptive, and convention-compliant.
- If the current filename already matches the approved convention exactly, you may return it unchanged.`,
};

export {prompt, ProposeFileNameSchema, ProposeFileNameResult};
