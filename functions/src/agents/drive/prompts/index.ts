import {DrivePrompts} from "../types";
import {resolvePrompt} from "../../../util/promptVersioning";
import {
  versions as proposeFilePlacementVersions,
  VERSION_KEY as PROPOSE_FILE_PLACEMENT_VERSION_KEY,
  VERSION_PARAM as PROPOSE_FILE_PLACEMENT_VERSION_PARAM,
} from "./proposeFilePlacement";
import {
  versions as interpretMoveInstructionsVersions,
  VERSION_KEY as INTERPRET_MOVE_INSTRUCTIONS_VERSION_KEY,
  VERSION_PARAM as INTERPRET_MOVE_INSTRUCTIONS_VERSION_PARAM,
} from "./interpretMoveInstructions";
import {
  versions as reviseOrganizationVersions,
  VERSION_KEY as REVISE_ORGANIZATION_VERSION_KEY,
  VERSION_PARAM as REVISE_ORGANIZATION_VERSION_PARAM,
} from "./reviseOrganization";
import {
  versions as setPreferencesVersions,
  VERSION_KEY as SET_PREFERENCES_VERSION_KEY,
  VERSION_PARAM as SET_PREFERENCES_VERSION_PARAM,
} from "./setPreferences";
import {
  versions as detectFolderConventionVersions,
  VERSION_KEY as DETECT_FOLDER_CONVENTION_VERSION_KEY,
  VERSION_PARAM as DETECT_FOLDER_CONVENTION_VERSION_PARAM,
} from "./detectFolderConvention";
import {
  versions as analyzeDirectoryStructureVersions,
  VERSION_KEY as ANALYZE_DIRECTORY_STRUCTURE_VERSION_KEY,
  VERSION_PARAM as ANALYZE_DIRECTORY_STRUCTURE_VERSION_PARAM,
} from "./analyzeDirectoryStructure";
import {
  versions as evaluateDirectoryPlacementVersions,
  VERSION_KEY as EVALUATE_DIRECTORY_PLACEMENT_VERSION_KEY,
  VERSION_PARAM as EVALUATE_DIRECTORY_PLACEMENT_VERSION_PARAM,
} from "./evaluateDirectoryPlacement";
import {
  versions as finalizeDirectoryMapVersions,
  VERSION_KEY as FINALIZE_DIRECTORY_MAP_VERSION_KEY,
  VERSION_PARAM as FINALIZE_DIRECTORY_MAP_VERSION_PARAM,
} from "./finalizeDirectoryMap";
import {
  versions as classifyConventionChangeVersions,
  VERSION_KEY as CLASSIFY_CONVENTION_CHANGE_VERSION_KEY,
  VERSION_PARAM as CLASSIFY_CONVENTION_CHANGE_VERSION_PARAM,
} from "./classifyConventionChange";
import {
  versions as proposeFileActionVersions,
  VERSION_KEY as PROPOSE_FILE_ACTION_VERSION_KEY,
  VERSION_PARAM as PROPOSE_FILE_ACTION_VERSION_PARAM,
} from "./proposeFileAction";
import {
  versions as generateFilenameExamplesVersions,
  VERSION_KEY as GENERATE_FILENAME_EXAMPLES_VERSION_KEY,
  VERSION_PARAM as GENERATE_FILENAME_EXAMPLES_VERSION_PARAM,
} from "./generateFilenameExamples";

/** Returns the active Drive prompt set and version metadata. */
function getPrompts(): { prompts: DrivePrompts; versions: Record<string, string> } {
  const proposeFilePlacement = resolvePrompt(
      PROPOSE_FILE_PLACEMENT_VERSION_PARAM,
      proposeFilePlacementVersions,
  );
  const interpretMoveInstructions = resolvePrompt(
      INTERPRET_MOVE_INSTRUCTIONS_VERSION_PARAM,
      interpretMoveInstructionsVersions,
  );
  const reviseOrganization = resolvePrompt(
      REVISE_ORGANIZATION_VERSION_PARAM,
      reviseOrganizationVersions,
  );
  const setPreferences = resolvePrompt(
      SET_PREFERENCES_VERSION_PARAM,
      setPreferencesVersions,
  );
  const detectFolderConvention = resolvePrompt(
      DETECT_FOLDER_CONVENTION_VERSION_PARAM,
      detectFolderConventionVersions,
  );
  const analyzeDirectoryStructure = resolvePrompt(
      ANALYZE_DIRECTORY_STRUCTURE_VERSION_PARAM,
      analyzeDirectoryStructureVersions,
  );
  const evaluateDirectoryPlacement = resolvePrompt(
      EVALUATE_DIRECTORY_PLACEMENT_VERSION_PARAM,
      evaluateDirectoryPlacementVersions,
  );
  const finalizeDirectoryMap = resolvePrompt(
      FINALIZE_DIRECTORY_MAP_VERSION_PARAM,
      finalizeDirectoryMapVersions,
  );
  const classifyConventionChange = resolvePrompt(
      CLASSIFY_CONVENTION_CHANGE_VERSION_PARAM,
      classifyConventionChangeVersions,
  );
  const proposeFileAction = resolvePrompt(
      PROPOSE_FILE_ACTION_VERSION_PARAM,
      proposeFileActionVersions,
  );
  const generateFilenameExamples = resolvePrompt(
      GENERATE_FILENAME_EXAMPLES_VERSION_PARAM,
      generateFilenameExamplesVersions,
  );

  const prompts: DrivePrompts = {
    proposeFilePlacement: proposeFilePlacement.prompt,
    interpretMoveInstructions: interpretMoveInstructions.prompt,
    reviseOrganization: reviseOrganization.prompt,
    setPreferences: setPreferences.prompt,
    detectFolderConvention: detectFolderConvention.prompt,
    analyzeDirectoryStructure: analyzeDirectoryStructure.prompt,
    evaluateDirectoryPlacement: evaluateDirectoryPlacement.prompt,
    finalizeDirectoryMap: finalizeDirectoryMap.prompt,
    classifyConventionChange: classifyConventionChange.prompt,
    proposeFileAction: proposeFileAction.prompt,
    generateFilenameExamples: generateFilenameExamples.prompt,
  };

  const versions: Record<string, string> = {
    [PROPOSE_FILE_PLACEMENT_VERSION_KEY]: proposeFilePlacement.version,
    [INTERPRET_MOVE_INSTRUCTIONS_VERSION_KEY]: interpretMoveInstructions.version,
    [REVISE_ORGANIZATION_VERSION_KEY]: reviseOrganization.version,
    [SET_PREFERENCES_VERSION_KEY]: setPreferences.version,
    [DETECT_FOLDER_CONVENTION_VERSION_KEY]: detectFolderConvention.version,
    [ANALYZE_DIRECTORY_STRUCTURE_VERSION_KEY]: analyzeDirectoryStructure.version,
    [EVALUATE_DIRECTORY_PLACEMENT_VERSION_KEY]: evaluateDirectoryPlacement.version,
    [FINALIZE_DIRECTORY_MAP_VERSION_KEY]: finalizeDirectoryMap.version,
    [CLASSIFY_CONVENTION_CHANGE_VERSION_KEY]: classifyConventionChange.version,
    [PROPOSE_FILE_ACTION_VERSION_KEY]: proposeFileAction.version,
    [GENERATE_FILENAME_EXAMPLES_VERSION_KEY]: generateFilenameExamples.version,
  };

  return {prompts, versions};
}

export {getPrompts};
