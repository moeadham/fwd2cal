import * as path from "path";
import {logger} from "firebase-functions/v2";
import {loadSkillsFromDir, generateSkillsContext} from "../../../util/skills/loader";
import {Skill} from "../../../util/skills/types";

// Singleton instances
let _skills: Skill[] | null = null;
let _skillsContext: string | null = null;

export function getSkills(): Skill[] {
  if (_skills === null) {
    _skills = loadSkillsFromDir(path.join(__dirname));
    logger.info(`Loaded ${_skills.length} drive skills`);
  }
  return _skills;
}

export function getSkillsContext(): string {
  if (_skillsContext === null) {
    _skillsContext = generateSkillsContext(getSkills());
  }
  return _skillsContext;
}
