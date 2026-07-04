import * as os from "node:os";
import * as path from "node:path";

export const GLOBAL_LORE_MODELS_PATH = path.join(os.homedir(), ".pi", "agent", "lore", "models.json");
export const PI_AGENT_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
export const USER_AGENT_DIR = path.join(os.homedir(), ".pi", "agent", "agents");
export const PROJECT_AGENT_DIRNAME = path.join(".pi", "agents");
export const MANAGED_AGENT_SETTING_ENABLED = "enabled";
export const MANAGED_AGENT_SETTING_DISABLED = "disabled";

export const DELEGATION_RETENTION_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "lore", "delegation-retention.json");
export const DELEGATION_RETENTION_PATH_ENV = "LORE_PI_RUNTIME_RETENTION_PATH";
export const DELEGATION_RETENTION_ENABLED_ENV = "LORE_PI_RUNTIME_RETENTION_ENABLED";
export const DELEGATION_RETENTION_DRY_RUN_ENV = "LORE_PI_RUNTIME_RETENTION_DRY_RUN";
export const DELEGATION_RETENTION_HEAVY_LOG_AGE_DAYS_ENV = "LORE_PI_RUNTIME_RETENTION_HEAVY_LOG_AGE_DAYS";
export const DELEGATION_RETENTION_MAX_AGE_DAYS_ENV = "LORE_PI_RUNTIME_RETENTION_MAX_AGE_DAYS";
export const DELEGATION_RETENTION_KEEP_LAST_ENV = "LORE_PI_RUNTIME_RETENTION_KEEP_LAST";
export const DELEGATION_RETENTION_MAX_TOTAL_SIZE_ENV = "LORE_PI_RUNTIME_RETENTION_MAX_TOTAL_SIZE";
export const DELEGATION_RETENTION_AUTO_COOLDOWN_MS_ENV = "LORE_PI_RUNTIME_RETENTION_AUTO_COOLDOWN_MS";
export const DELEGATION_RETENTION_ROOT_DIR_ENV = "LORE_PI_RUNTIME_RETENTION_ROOT_DIR";
export const DEFAULT_DELEGATION_RETENTION_MAX_TOTAL_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_DELEGATION_RETENTION_POLICY = Object.freeze({
  enabled: false,
  dryRun: true,
  heavyLogAgeDays: 3,
  maxAgeDays: 21,
  keepLast: 150,
  maxTotalSizeBytes: DEFAULT_DELEGATION_RETENTION_MAX_TOTAL_SIZE_BYTES,
  autoCooldownMs: 60 * 60 * 1000,
  maxScanEntries: 10_000,
});
