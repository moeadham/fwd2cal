import {Prompts} from "../types";
import {resolvePrompt} from "../../../util/promptVersioning";
import {
  versions as getEventDataVersions,
  VERSION_KEY as GET_EVENT_DATA_VERSION_KEY,
  VERSION_PARAM as GET_EVENT_DATA_VERSION_PARAM,
} from "./getEventData";
import {
  versions as getEventTimezoneVersions,
  VERSION_KEY as GET_EVENT_TIMEZONE_VERSION_KEY,
  VERSION_PARAM as GET_EVENT_TIMEZONE_VERSION_PARAM,
} from "./getEventTimezone";
import {
  versions as parseICSVersions,
  VERSION_KEY as PARSE_ICS_VERSION_KEY,
  VERSION_PARAM as PARSE_ICS_VERSION_PARAM,
} from "./parseICS";
import {
  versions as selectSkillVersions,
  VERSION_KEY as SELECT_SKILL_VERSION_KEY,
  VERSION_PARAM as SELECT_SKILL_VERSION_PARAM,
} from "./selectSkill";

function getPrompts(): { prompts: Prompts; versions: Record<string, string> } {
  const getEventData = resolvePrompt(GET_EVENT_DATA_VERSION_PARAM, getEventDataVersions);
  const getEventTimezone = resolvePrompt(GET_EVENT_TIMEZONE_VERSION_PARAM, getEventTimezoneVersions);
  const parseICS = resolvePrompt(PARSE_ICS_VERSION_PARAM, parseICSVersions);
  const selectSkill = resolvePrompt(SELECT_SKILL_VERSION_PARAM, selectSkillVersions);

  const prompts: Prompts = {
    getEventData: getEventData.prompt,
    getEventTimezone: getEventTimezone.prompt,
    parseICS: parseICS.prompt,
    selectSkill: selectSkill.prompt,
  };

  const versions: Record<string, string> = {
    [GET_EVENT_DATA_VERSION_KEY]: getEventData.version,
    [GET_EVENT_TIMEZONE_VERSION_KEY]: getEventTimezone.version,
    [PARSE_ICS_VERSION_KEY]: parseICS.version,
    [SELECT_SKILL_VERSION_KEY]: selectSkill.version,
  };

  return {prompts, versions};
}

export {getPrompts};
