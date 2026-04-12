import * as path from "path";
import {logger} from "firebase-functions/v2";
import {loadSkillsFromDir, generateSkillsContext} from "../../../util/skills/loader";
import {Skill} from "../../../util/skills/types";

// Singleton instances
let _skills: Skill[] | null = null;
let _skillsContext: string | null = null;

/** Returns all Drive-specific and shared skill definitions. */
export function getSkills(): Skill[] {
  if (_skills === null) {
    const agentSkills = loadSkillsFromDir(path.join(__dirname));
    const sharedSkills = loadSkillsFromDir(
        path.join(__dirname, "..", "..", "..", "skills", "shared"),
    );
    _skills = [...agentSkills, ...sharedSkills];
    logger.info(`Loaded ${_skills.length} drive skills (${agentSkills.length} agent + ${sharedSkills.length} shared)`);
  }
  return _skills;
}

/** Builds the Drive skill context text used by prompts. */
export function getSkillsContext(): string {
  if (_skillsContext === null) {
    _skillsContext = generateSkillsContext(getSkills());
  }
  return _skillsContext;
}
