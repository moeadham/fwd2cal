import type {StringParam} from "firebase-functions/params";

function resolvePrompt<T>(param: StringParam, versions: Record<string, T>): { prompt: T; version: string } {
  const configuredVersion = param.value();
  const selectedVersion = configuredVersion ? configuredVersion.trim() : "v1";
  const resolvedPrompt = versions[selectedVersion];

  if (!resolvedPrompt) {
    const availableVersions = Object.keys(versions).sort().join(", ");
    throw new Error(
        `Unknown prompt version "${selectedVersion}" for ${param.name}. ` +
        `Available versions: ${availableVersions}`,
    );
  }

  return {
    prompt: resolvedPrompt,
    version: selectedVersion,
  };
}

export {resolvePrompt};
