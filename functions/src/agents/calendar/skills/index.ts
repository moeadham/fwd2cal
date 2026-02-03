import {logger} from "firebase-functions/v2";
import {loadSkills, generateSkillsContext} from "./loader";
import {Skill} from "./types";

// Re-export types and functions
export {Skill, SkillMatch} from "./types";
export {loadSkills, generateSkillsContext} from "./loader";
export {fastMatchSkill} from "./matcher";

// Singleton instances
let _skills: Skill[] | null = null;
let _skillsContext: string | null = null;

export function getSkills(): Skill[] {
  if (_skills === null) {
    _skills = loadSkills();
    logger.info(`Loaded ${_skills.length} skills`);
  }
  return _skills;
}

export function getSkillsContext(): string {
  if (_skillsContext === null) {
    _skillsContext = generateSkillsContext(getSkills());
  }
  return _skillsContext;
}
