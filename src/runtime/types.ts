import type {
  ContractEnvelope,
  ContractPhase,
  ContractRole,
  SkillPolicy,
} from "./contract-schema.ts";

export type AgentSource = "builtin" | "user" | "project";
export type SystemPromptMode = "append" | "replace";
export type FrontmatterPrimitive = string | number | boolean | null;
export type FrontmatterValue = FrontmatterPrimitive | FrontmatterPrimitive[];

export interface ParsedFrontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
}

export interface AgentContractFrontmatter {
  role?: ContractRole;
  phase?: ContractPhase;
  requiredEnvelope?: ContractEnvelope;
  skillPolicyMode?: SkillPolicy["mode"];
  skillPolicyFiles?: string[];
}

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  body: string;
  source: AgentSource;
  filePath: string;
  metadata: Record<string, FrontmatterValue>;
  role?: ContractRole;
  phase?: ContractPhase;
  requiredEnvelope?: ContractEnvelope;
  skillPolicy?: SkillPolicy;
  contractFrontmatter?: AgentContractFrontmatter;
}

export interface AgentRegistry {
  agents: AgentDefinition[];
  byName: Map<string, AgentDefinition>;
  builtinDir: string;
  userDir: string;
  projectDir?: string;
  projectRoot?: string;
}

export interface DiscoverAgentsOptions {
  cwd?: string;
  builtinDir?: string;
  userDir?: string;
  projectRoot?: string;
}
