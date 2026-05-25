import * as os from "node:os";
import * as path from "node:path";

export const GLOBAL_LORE_MODELS_PATH = path.join(os.homedir(), ".pi", "agent", "lore", "models.json");
export const USER_AGENT_DIR = path.join(os.homedir(), ".pi", "agent", "agents");
export const PROJECT_AGENT_DIRNAME = path.join(".pi", "agents");
