export type AgentId = "codex" | "claude-code";
export type AgentOperation = "install" | "update" | "uninstall" | "status" | "validate";
export type AgentCommandId = "init" | "status" | "intent" | "plan" | "execute" | "preview" | "update";

export interface IntegrationMetadata {
  readonly id: string;
  readonly version: string;
  readonly target: AgentId;
  readonly capabilities: readonly string[];
  readonly root: string;
}

export interface ProjectionFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface ProjectionPlan {
  readonly integration: IntegrationMetadata;
  readonly files: readonly ProjectionFile[];
  readonly diagnostics: readonly string[];
}
