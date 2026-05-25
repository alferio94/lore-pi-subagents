export type AgentSource = "builtin" | "user" | "project";
export type SystemPromptMode = "append" | "replace";
export type FrontmatterPrimitive = string | number | boolean | null;
export type FrontmatterValue = FrontmatterPrimitive | FrontmatterPrimitive[];

export interface ParsedFrontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
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
