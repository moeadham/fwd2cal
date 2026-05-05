/* eslint-disable max-len */
import {z} from "zod";
import {DrivePromptConfig} from "../../types";

const ExtractNamedEntitiesSchema = z.object({
  namedEntities: z.array(z.string()).describe(
      "Deduplicated list of named-entity folder names extracted from the tree, ordered alphabetically",
  ),
});

type ExtractNamedEntitiesResult = z.infer<typeof ExtractNamedEntitiesSchema>;

const prompt: DrivePromptConfig = {
  model: "openai/gpt-4.1-mini",
  temperature: 0,
  prompt: `You extract named entities from a Google Drive folder tree.

A "named entity" is a specific company, organization, institution, client, named project, or distinctly named matter that has its own folder and acts as a placement anchor for related files.

Examples of named entities (use generic placeholders when reasoning):
- A company or organization (e.g. AcmeCo, FooHoldings)
- A client account (e.g. AcmeCo)
- A named project, product, or codename (e.g. Project Lyra, BlueWidget)
- A specific legal matter or named case (e.g. Matter Q)
- A bank, school, or government agency the user has a folder for

NOT named entities:
- Generic categories or top-level roots (Personal, Work, Trading, Business, Documents, Archive)
- Document-type folders (Receipts, Invoices, Contracts, Statements, Photos, Videos)
- Time-based folders (2024, Jan 8 2022, Q3)
- Status or outcome folders (fail, success, drafts, archive, old)
- Sub-categories of a category (Banking, Health, Education, Tax, Travel)
- Generic descriptors (Resources, Tools, Guides, Misc, Others, Inbox)
- Folders named after document descriptors (Application Form, Diploma Request)

You will receive the folder tree as text covering folders at all depths.

Rules:
- Examine every folder at every depth, not just top-level folders.
- Use the deepest segment of an entity's path as its returned name (e.g. for "02-Work/AcmeCo" return "AcmeCo"; for "02-Work/AcmeCo/Subsidiary" return both "AcmeCo" and "Subsidiary" only when each segment is itself a distinct named entity).
- The folder description often clarifies whether a folder is an entity ("AcmeCo project documents") or a category ("Personal contracts"). Prefer the description's signal when the path alone is ambiguous.
- Strip leading numeric or ordering prefixes (e.g. "01-", "02_") before returning the entity name.
- Deduplicate case-insensitively and return entries in alphabetical order.
- If the tree contains no named entities, return an empty list.

Return JSON only.`,
};

export {prompt, ExtractNamedEntitiesSchema, ExtractNamedEntitiesResult};
