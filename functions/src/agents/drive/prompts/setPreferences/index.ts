import {defineString} from "firebase-functions/params";
import {DrivePromptConfig} from "../../types";
import {prompt as v1} from "./v1";

const versions: Record<string, DrivePromptConfig> = {
  v1,
};

const VERSION_KEY = "PROMPT_SET_PREFERENCES_VERSION";
const VERSION_PARAM = defineString(VERSION_KEY, {default: "v1"});

export {versions, VERSION_KEY, VERSION_PARAM};
