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
  versions as proposeOrganizationVersions,
  VERSION_KEY as PROPOSE_ORGANIZATION_VERSION_KEY,
  VERSION_PARAM as PROPOSE_ORGANIZATION_VERSION_PARAM,
} from "./proposeOrganization";
import {
  versions as reviseOrganizationVersions,
  VERSION_KEY as REVISE_ORGANIZATION_VERSION_KEY,
  VERSION_PARAM as REVISE_ORGANIZATION_VERSION_PARAM,
} from "./reviseOrganization";
import {
  versions as refineOrganizationVersions,
  VERSION_KEY as REFINE_ORGANIZATION_VERSION_KEY,
  VERSION_PARAM as REFINE_ORGANIZATION_VERSION_PARAM,
} from "./refineOrganization";
import {
  versions as consolidateSummariesVersions,
  VERSION_KEY as CONSOLIDATE_SUMMARIES_VERSION_KEY,
  VERSION_PARAM as CONSOLIDATE_SUMMARIES_VERSION_PARAM,
} from "./consolidateSummaries";

function getPrompts(): { prompts: DrivePrompts; versions: Record<string, string> } {
  const proposeFilePlacement = resolvePrompt(
      PROPOSE_FILE_PLACEMENT_VERSION_PARAM,
      proposeFilePlacementVersions,
  );
  const interpretMoveInstructions = resolvePrompt(
      INTERPRET_MOVE_INSTRUCTIONS_VERSION_PARAM,
      interpretMoveInstructionsVersions,
  );
  const proposeOrganization = resolvePrompt(
      PROPOSE_ORGANIZATION_VERSION_PARAM,
      proposeOrganizationVersions,
  );
  const reviseOrganization = resolvePrompt(
      REVISE_ORGANIZATION_VERSION_PARAM,
      reviseOrganizationVersions,
  );
  const refineOrganization = resolvePrompt(
      REFINE_ORGANIZATION_VERSION_PARAM,
      refineOrganizationVersions,
  );
  const consolidateSummaries = resolvePrompt(
      CONSOLIDATE_SUMMARIES_VERSION_PARAM,
      consolidateSummariesVersions,
  );

  const prompts: DrivePrompts = {
    proposeFilePlacement: proposeFilePlacement.prompt,
    interpretMoveInstructions: interpretMoveInstructions.prompt,
    proposeOrganization: proposeOrganization.prompt,
    reviseOrganization: reviseOrganization.prompt,
    refineOrganization: refineOrganization.prompt,
    consolidateSummaries: consolidateSummaries.prompt,
  };

  const versions: Record<string, string> = {
    [PROPOSE_FILE_PLACEMENT_VERSION_KEY]: proposeFilePlacement.version,
    [INTERPRET_MOVE_INSTRUCTIONS_VERSION_KEY]: interpretMoveInstructions.version,
    [PROPOSE_ORGANIZATION_VERSION_KEY]: proposeOrganization.version,
    [REVISE_ORGANIZATION_VERSION_KEY]: reviseOrganization.version,
    [REFINE_ORGANIZATION_VERSION_KEY]: refineOrganization.version,
    [CONSOLIDATE_SUMMARIES_VERSION_KEY]: consolidateSummaries.version,
  };

  return {prompts, versions};
}

export {getPrompts};
