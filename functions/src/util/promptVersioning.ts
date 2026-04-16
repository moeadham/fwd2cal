import type {StringParam} from "firebase-functions/params";

function resolvePrompt<T>(param: StringParam, versions: Record<string, T>): { prompt: T; version: string } {
  const configuredVersion = param.value();
  const selectedVersion = configuredVersion ? configuredVersion.trim() : "v1";
  const resolvedPrompt = versions[selectedVersion];

  if (!resolvedPrompt) {
    const fallbackVersion = Object.keys(versions).sort().pop();
    if (!fallbackVersion) {
      throw new Error(`No prompt versions configured for ${param.name}.`);
    }
    return {
      prompt: versions[fallbackVersion],
      version: fallbackVersion,
    };
  }

  return {
    prompt: resolvedPrompt,
    version: selectedVersion,
  };
}

export {resolvePrompt};
