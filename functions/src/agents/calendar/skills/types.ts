// Frontmatter structure from SKILL.md files
export interface SkillFrontmatter {
  name: string;
  description: string;
  triggers?: string[];
  fastPattern?: string;
  checkBody?: boolean;
  subjectOnly?: boolean;
}

// Loaded skill with parsed data
export interface Skill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  fastPattern?: RegExp;
  checkBody: boolean;
  subjectOnly: boolean;
  instructions: string;
}

// Result from fast matching
export interface SkillMatch {
  skillId: string;
  matchedIn: "subject" | "body";
  extractedValue?: string;
}
