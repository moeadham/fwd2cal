import {getRemoteConfig, ServerTemplate} from "firebase-admin/remote-config";
import {logger} from "firebase-functions/v2";

const DEFAULT_CONFIG = {
  organize_drive_enabled: false,
};

let template: ServerTemplate | null = null;
let loaded = false;
let overrides: Partial<typeof DEFAULT_CONFIG> | null = null;

function getBooleanFlag(flag: keyof typeof DEFAULT_CONFIG): boolean {
  const overrideValue = overrides?.[flag];
  if (typeof overrideValue === "boolean") {
    return overrideValue;
  }
  if (!template) return DEFAULT_CONFIG[flag] as boolean;
  try {
    return template.evaluate().getBoolean(flag);
  } catch {
    return DEFAULT_CONFIG[flag] as boolean;
  }
}

/**
 * Load feature flags from Firebase Remote Config.
 * Call once per request (no-ops after first successful load).
 */
export async function loadFeatureFlags(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    template = await getRemoteConfig().getServerTemplate({
      defaultConfig: DEFAULT_CONFIG,
    });
  } catch (err) {
    logger.warn("Feature flags: failed to load Remote Config, using defaults", err);
  }
}

/**
 * Check if the organize-drive feature is enabled.
 * Returns false (disabled) if feature flags haven't been loaded yet.
 */
export function isOrganizeDriveEnabled(): boolean {
  return getBooleanFlag("organize_drive_enabled");
}


function setFeatureFlagOverridesForTest(
    nextOverrides: Partial<typeof DEFAULT_CONFIG> | null,
): void {
  overrides = nextOverrides;
}

export {setFeatureFlagOverridesForTest};
