import {defineString} from "firebase-functions/params";
import {PromptConfig} from "../../types";
import {prompt as v1} from "./v1";

const versions: Record<string, PromptConfig> = {
  v1,
};

const VERSION_KEY = "PROMPT_SELECT_SKILL_VERSION";
const VERSION_PARAM = defineString(VERSION_KEY, {default: "v1"});

export {versions, VERSION_KEY, VERSION_PARAM};
