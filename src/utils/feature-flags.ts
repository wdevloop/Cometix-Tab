import type { CursorConfig, FeatureFlagsConfig } from '../types';

export function getFeatureFlags(config: CursorConfig): FeatureFlagsConfig {
  // Backward compatible: features may be undefined in older configs
  const anyConfig = config as unknown as { features?: FeatureFlagsConfig };
  return anyConfig.features || {};
}

export function isFeatureEnabled(
  config: CursorConfig,
  flag: keyof FeatureFlagsConfig
): boolean {
  const features = getFeatureFlags(config);
  return features[flag] === true;
}


