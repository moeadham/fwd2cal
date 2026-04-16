import {defineString} from "firebase-functions/params";
import {DrivePromptConfig} from "../../types";
import {prompt as v1} from "./v1";

const versions: Record<string, DrivePromptConfig> = {v1, v2: v1};
const VERSION_KEY = "PROMPT_PROPOSE_FILE_ACTION_VERSION";
const VERSION_PARAM = defineString(VERSION_KEY, {default: "v2"});

export {versions, VERSION_KEY, VERSION_PARAM};
