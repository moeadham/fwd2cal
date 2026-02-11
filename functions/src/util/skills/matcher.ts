import {Skill, SkillMatch} from "./types";

/**
 * Try to match a skill using fast path (regex matching).
 * Checks both subject and body based on skill configuration.
 */
export function fastMatchSkill(
    subject: string,
    body: string,
    skills: Skill[],
): SkillMatch | null {
  const normalizedSubject = (subject || "").toLowerCase().trim();
  const normalizedBody = (body || "").toLowerCase();

  for (const skill of skills) {
    // If skill has a fastPattern (regex), use it
    if (skill.fastPattern) {
      // Check subject first
      const subjectMatch = skill.fastPattern.exec(normalizedSubject);
      if (subjectMatch) {
        return {
          skillId: skill.id,
          matchedIn: "subject",
          extractedValue: subjectMatch[1] || undefined,
        };
      }

      // Check body if skill allows it
      if (skill.checkBody) {
        const bodyMatch = skill.fastPattern.exec(normalizedBody);
        if (bodyMatch) {
          return {
            skillId: skill.id,
            matchedIn: "body",
            extractedValue: bodyMatch[1] || undefined,
          };
        }
      }
    }

    // If skill has simple triggers (e.g., "fwd:"), check them
    if (skill.triggers && skill.triggers.length > 0) {
      for (const trigger of skill.triggers) {
        // Skip placeholder triggers like "add <email>"
        if (trigger.includes("<") && trigger.includes(">")) {
          continue;
        }

        const normalizedTrigger = trigger.toLowerCase();

        // Check subject
        if (normalizedSubject.startsWith(normalizedTrigger) ||
            normalizedSubject.includes(normalizedTrigger)) {
          return {
            skillId: skill.id,
            matchedIn: "subject",
          };
        }

        // Check body if allowed and not subjectOnly
        if (skill.checkBody && !skill.subjectOnly) {
          if (normalizedBody.includes(normalizedTrigger)) {
            return {
              skillId: skill.id,
              matchedIn: "body",
            };
          }
        }
      }
    }
  }

  return null;
}
