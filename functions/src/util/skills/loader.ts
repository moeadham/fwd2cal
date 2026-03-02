import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import {logger} from "firebase-functions/v2";
import {Skill, SkillFrontmatter} from "./types";

/**
 * Load all skills from SKILL.md files in the given directory.
 * Each subdirectory containing a SKILL.md file is treated as a skill.
 */
export function loadSkillsFromDir(skillsDir: string): Skill[] {
  const skills: Skill[] = [];

  try {
    const entries = fs.readdirSync(skillsDir, {withFileTypes: true});

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(skillsDir, entry.name, "SKILL.md");

        if (fs.existsSync(skillPath)) {
          try {
            const fileContent = fs.readFileSync(skillPath, "utf-8");
            const parsed = matter(fileContent);
            const frontmatter = parsed.data as SkillFrontmatter;

            // Ensure triggers are strings
            const triggers = (frontmatter.triggers || [])
                .map((t: unknown) => String(t))
                .filter((t: string) => t.length > 0);

            const skill: Skill = {
              id: frontmatter.name || entry.name,
              name: frontmatter.name || entry.name,
              description: frontmatter.description || "",
              triggers,
              fastPattern: frontmatter.fastPattern ?
                new RegExp(frontmatter.fastPattern, "i") :
                undefined,
              checkBody: frontmatter.checkBody ?? false,
              subjectOnly: frontmatter.subjectOnly ?? false,
              instructions: parsed.content,
            };

            skills.push(skill);
            logger.debug(`Loaded skill: ${skill.id}`);
          } catch (err) {
            logger.error(`Error loading skill from ${skillPath}:`, err);
          }
        }
      }
    }
  } catch (err) {
    logger.error(`Error reading skills directory ${skillsDir}:`, err);
  }

  return skills;
}

/**
 * Generate a context string describing all available skills for the LLM.
 */
export function generateSkillsContext(skills: Skill[]): string {
  return skills
      .map((skill) => {
        const triggers = skill.triggers.length > 0 ?
        ` (triggers: ${skill.triggers.join(", ")})` :
        "";
        return `- ${skill.id}: ${skill.description}${triggers}`;
      })
      .join("\n");
}
