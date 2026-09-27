import { createHash } from "node:crypto";
import type { CheckResult } from "./evidence.ts";
import { namespaceOf } from "./references.ts";

/** Tool contracts describe capabilities. ToolImplementation documents supply bindings. */
export interface ToolContract {
  kind: "Tool";
  id: string;
  version: string;
  title: string;
  purpose: string;
  capability: string;
  safety: "read-only" | "safe-mutation" | "destructive" | "high-impact";
  permissions: string[];
  environments: string[];
  inputs: { name: string; description: string; type: "string" | "integer" | "boolean" | "path"; required: boolean; pattern?: string; default?: string | number | boolean; sensitive?: boolean }[];
  outputs: { format: string; description: string; fields?: string[] };
  side_effects: string[];
  preconditions: { id: string; kind: string; description?: string }[];
  idempotency: "idempotent" | "conditionally-idempotent" | "non-idempotent" | "unknown";
  timeout_seconds: number;
  retry: { max_attempts: number; backoff_seconds: number };
  errors: string[];
  evidence: { capture: string[] };
  availability: "available" | "planned" | "disabled";
  confirmation?: "none" | "required";
}

export interface ToolImplementation {
  kind: "ToolImplementation";
  id: string;
  tool: string;
  version: string;
  contract: string;
  source: "core" | "adapter" | "project";
  environments: string[];
  invocation: { type: "command" | "synthetic"; executable?: string; arguments?: string[]; input_bindings?: { input: string; flag?: string }[]; timeout_seconds?: number; synthetic_result?: Record<string, unknown> };
  availability: "available" | "planned" | "disabled";
}

export interface ToolOverride {
  target: string;
  action: "disable" | "restrict" | "select-implementation";
  implementation?: string;
  allowed_environments?: string[];
  timeout_seconds?: number;
  max_attempts?: number;
  require_approval?: true;
  owner: string;
  reason: string;
  target_sha256?: string;
}

export interface Resolution {
  status: "resolved" | "blocked";
  tool?: ToolContract;
  implementation?: ToolImplementation;
  reason?: string;
}

export interface Authorization {
  allowed: boolean;
  reasons: string[];
}

export type ToolErrorCode = "invalid-input" | "failed-precondition" | "unavailable-dependency" | "permission-denied" | "timeout" | "execution-failure" | "environment-failure" | "transient-failure" | "policy-violation" | "unsupported-capability" | "implementation-unavailable" | "malformed-output" | "partial-execution" | "evidence-unavailable";

/** A deliberately small, deterministic SemVer range evaluator for Core's full-version comparators. */
export function compatible(version: string, range: string): boolean {
  const parse = (s: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(s);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const actual = parse(version);
  if (!actual) return false;
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return range.split("||").some((branch) => {
    const tokens = branch.trim().match(/(?:\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g);
    if (!tokens || tokens.join("").length !== branch.replace(/\s+/g, "").length) return false;
    return tokens.every((token) => {
      const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)!;
      const op = match[1] ?? "=";
      const target = parse(match[2]!);
      if (!target) return false;
      const difference = cmp(actual, target);
      if (op === "=") return difference === 0;
      if (op === ">") return difference > 0;
      if (op === ">=") return difference >= 0;
      if (op === "<") return difference < 0;
      if (op === "<=") return difference <= 0;
      const upper = op === "~"
        ? [target[0]!, target[1]! + 1, 0]
        : target[0] === 0
          ? target[1] === 0 ? [0, 0, target[2]! + 1] : [0, target[1]! + 1, 0]
          : [target[0]! + 1, 0, 0];
      return difference >= 0 && cmp(actual, upper) < 0;
    });
  });
}

export function validateTool(tool: ToolContract): string[] {
  const problems: string[] = [];
  const unique = (values: string[], what: string) => {
    if (new Set(values).size !== values.length) problems.push(`${tool.id} has duplicate ${what}`);
  };
  unique(tool.inputs.map((i) => i.name), "input names");
  unique(tool.preconditions.map((p) => p.id), "precondition ids");
  if (tool.safety === "read-only" && tool.side_effects.length > 0) problems.push(`${tool.id} is read-only but declares side effects`);
  const mutating = ["repository-write", "process-control", "database-write", "network-write", "infrastructure-write", "browser-control"];
  if (tool.safety === "read-only" && tool.permissions.some((p) => mutating.includes(p))) problems.push(`${tool.id} is read-only but requests write permission`);
  if (tool.safety !== "read-only" && tool.side_effects.length === 0) problems.push(`${tool.id} mutates state but declares no side effect`);
  if ((tool.safety === "destructive" || tool.safety === "high-impact") && tool.confirmation !== "required") problems.push(`${tool.id} requires human confirmation`);
  if ((tool.safety === "destructive" || tool.safety === "high-impact" || tool.idempotency === "unknown" || tool.idempotency === "non-idempotent") && tool.retry.max_attempts !== 1) problems.push(`${tool.id} cannot automatically retry`);
  if (tool.outputs.format === "json" && (tool.outputs.fields?.length ?? 0) === 0) problems.push(`${tool.id} JSON output has no declared fields`);
  return problems;
}

export function validateImplementation(implementation: ToolImplementation, tool: ToolContract, allowSynthetic = false): string[] {
  const problems: string[] = [];
  if (implementation.tool !== tool.id) problems.push(`${implementation.id} names Tool ${implementation.tool}, not ${tool.id}`);
  if (!compatible(tool.version, implementation.contract)) problems.push(`${implementation.id} is not compatible with Tool version ${tool.version}`);
  for (const environment of implementation.environments) if (!tool.environments.includes(environment)) problems.push(`${implementation.id} environment ${environment} is outside the Tool contract`);
  if (implementation.invocation.timeout_seconds !== undefined && implementation.invocation.timeout_seconds > tool.timeout_seconds) problems.push(`${implementation.id} timeout exceeds the Tool contract`);
  if (implementation.source === "core" && namespaceOf(implementation.id) !== "core") problems.push(`${implementation.id} has a false Core source`);
  if (implementation.source === "adapter" && !namespaceOf(implementation.id).startsWith("adapter-")) problems.push(`${implementation.id} has a false adapter source`);
  if (implementation.source === "project" && namespaceOf(implementation.id) !== "project") problems.push(`${implementation.id} has a false project source`);
  if (implementation.invocation.type === "synthetic" && !allowSynthetic) problems.push(`${implementation.id} uses a synthetic invocation outside a fixture`);
  const inputNames = new Set(tool.inputs.map((input) => input.name));
  const boundInputs = (implementation.invocation.input_bindings ?? []).map((binding) => binding.input);
  if (new Set(boundInputs).size !== boundInputs.length) problems.push(`${implementation.id} binds an input more than once`);
  for (const binding of implementation.invocation.input_bindings ?? []) if (!inputNames.has(binding.input)) problems.push(`${implementation.id} binds unknown input ${binding.input}`);
  if (implementation.invocation.type === "command") {
    const bound = new Set((implementation.invocation.input_bindings ?? []).map((binding) => binding.input));
    for (const input of tool.inputs) if (input.required && !bound.has(input.name)) problems.push(`${implementation.id} does not bind required input ${input.name}`);
  }
  return problems;
}

export function validateToolOverrides(overrides: ToolOverride[], tools: ToolContract[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  for (const entry of overrides) {
    if (seen.has(entry.target)) problems.push(`duplicate Tool override for ${entry.target}`);
    seen.add(entry.target);
    const tool = byId.get(entry.target);
    if (!tool) { problems.push(`unknown Tool ${entry.target}`); continue; }
    if (namespaceOf(entry.target) === "project") problems.push(`project Tool ${entry.target} must be edited directly`);
    for (const env of entry.allowed_environments ?? []) if (!tool.environments.includes(env)) problems.push(`${entry.target} override environment ${env} is outside the Tool contract`);
    if (entry.timeout_seconds !== undefined && entry.timeout_seconds > tool.timeout_seconds) problems.push(`${entry.target} override timeout exceeds the Tool contract`);
    if (entry.max_attempts !== undefined && entry.max_attempts > tool.retry.max_attempts) problems.push(`${entry.target} override retry count exceeds the Tool contract`);
    if (entry.action === "select-implementation" && !entry.implementation) problems.push(`${entry.target} override names no implementation`);
  }
  return problems;
}

export function resolveTool(id: string, tools: ToolContract[], implementations: ToolImplementation[], environment: string, override?: ToolOverride, allowSynthetic = false): Resolution {
  const tool = tools.find((candidate) => candidate.id === id);
  if (!tool) return { status: "blocked", reason: `unknown Tool ${id}` };
  if (tool.availability !== "available") return { status: "blocked", reason: `Tool ${id} is ${tool.availability}` };
  if (override?.target === id && override.action === "disable") return { status: "blocked", reason: `Tool ${id} is disabled by override` };
  if (!tool.environments.includes(environment) || (override?.allowed_environments && !override.allowed_environments.includes(environment))) return { status: "blocked", reason: `Tool ${id} is not allowed in ${environment}` };
  const matching = implementations.filter((candidate) =>
    candidate.tool === id && candidate.availability === "available" && candidate.environments.includes(environment) &&
    validateImplementation(candidate, tool, allowSynthetic).length === 0,
  );
  const selected = override?.target === id && override.action === "select-implementation"
    ? matching.filter((candidate) => candidate.id === override.implementation)
    : matching.filter((candidate) => namespaceOf(candidate.id) === namespaceOf(id));
  if (selected.length === 1) return { status: "resolved", tool, implementation: selected[0]! };
  if (selected.length > 1) return { status: "blocked", reason: `Tool ${id} has ambiguous implementations` };
  if (override?.action === "select-implementation") return { status: "blocked", reason: `selected implementation is unavailable or incompatible with Tool ${id}` };
  // An adapter may implement an abstract Core capability when no Core binding exists.
  const adapters = matching.filter((candidate) => candidate.source === "adapter");
  if (adapters.length === 1) return { status: "resolved", tool, implementation: adapters[0]! };
  return { status: "blocked", reason: adapters.length > 1 ? `Tool ${id} has ambiguous adapter implementations` : `no compatible implementation for Tool ${id}` };
}

export function discoverTools(tools: ToolContract[], implementations: ToolImplementation[], environment: string, allowSynthetic = false) {
  return tools.map((tool) => ({
    id: tool.id, version: tool.version, capability: tool.capability, title: tool.title,
    safety: tool.safety, permissions: tool.permissions, environments: tool.environments,
    inputs: tool.inputs, outputs: tool.outputs, available: resolveTool(tool.id, tools, implementations, environment, undefined, allowSynthetic).status === "resolved",
  }));
}

export function validateToolInputs(tool: ToolContract, inputs: Record<string, unknown>): { values: Record<string, unknown>; problems: string[] } {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  const names = new Set(tool.inputs.map((input) => input.name));
  for (const name of Object.keys(inputs)) if (!names.has(name)) problems.push(`unknown input ${name}`);
  for (const input of tool.inputs) {
    const value = inputs[input.name] ?? input.default;
    if (value === undefined) { if (input.required) problems.push(`required input ${input.name} is missing`); continue; }
    const validType = input.type === "integer" ? typeof value === "number" && Number.isInteger(value)
      : input.type === "boolean" ? typeof value === "boolean" : typeof value === "string";
    if (!validType) { problems.push(`input ${input.name} has the wrong type`); continue; }
    if (input.type === "path" && (String(value).startsWith("/") || String(value).split("/").includes(".."))) problems.push(`input ${input.name} must be a repository-relative path`);
    if (input.pattern && (typeof value !== "string" || !new RegExp(input.pattern).test(value))) problems.push(`input ${input.name} does not match its pattern`);
    values[input.name] = value;
  }
  return { values, problems };
}

function argvIncludesBoundValue(value: unknown): boolean {
  return value !== undefined && value !== false;
}

export function sensitiveArgvInputNames(tool: ToolContract, implementation: ToolImplementation, inputs: Record<string, unknown>): string[] {
  const inputByName = new Map(tool.inputs.map((input) => [input.name, input]));
  const names = new Set<string>();
  for (const binding of implementation.invocation.input_bindings ?? []) {
    const input = inputByName.get(binding.input);
    if (input?.sensitive === true && argvIncludesBoundValue(inputs[binding.input])) names.add(binding.input);
  }
  return [...names].sort();
}

/** Construct separate argv elements only after contract validation; callers must spawn without a shell. */
export function buildArgv(tool: ToolContract, implementation: ToolImplementation, inputs: Record<string, unknown>): { executable: string; argv: string[] } {
  if (implementation.invocation.type !== "command" || !implementation.invocation.executable) throw new Error("implementation is not a command binding");
  const checked = validateToolInputs(tool, inputs);
  if (checked.problems.length > 0) throw new Error(checked.problems.join("; "));
  const sensitiveInputs = sensitiveArgvInputNames(tool, implementation, checked.values);
  if (sensitiveInputs.length > 0) throw new Error("sensitive Tool inputs cannot be bound to command argv");
  const argv = [...(implementation.invocation.arguments ?? [])];
  for (const binding of implementation.invocation.input_bindings ?? []) {
    const value = checked.values[binding.input];
    if (value === undefined || value === false) continue;
    if (binding.flag) argv.push(binding.flag);
    if (value !== true || !binding.flag) argv.push(String(value));
  }
  return { executable: implementation.invocation.executable, argv };
}

export function validateToolResult(tool: ToolContract, output: unknown): string[] {
  const problems: string[] = [];
  if (tool.outputs.format === "json" || tool.outputs.format === "yaml") {
    if (output === null || typeof output !== "object" || Array.isArray(output)) return [`${tool.id} output must be a structured object`];
    for (const field of tool.outputs.fields ?? []) if (!(field in output)) problems.push(`${tool.id} output is missing field ${field}`);
  } else if (tool.outputs.format === "text" && typeof output !== "string") {
    problems.push(`${tool.id} output must be text`);
  } else if (tool.outputs.format === "none" && output !== null && output !== undefined) {
    problems.push(`${tool.id} declares no output`);
  }
  return problems;
}

export function authorizeTool(tool: ToolContract, context: {
  environment: string;
  permissions: string[];
  preconditions: Record<string, boolean>;
  approval?: { approved_by: string };
}, override?: ToolOverride): Authorization {
  const reasons: string[] = [];
  if (tool.availability !== "available") reasons.push(`Tool is ${tool.availability}`);
  if (!tool.environments.includes(context.environment) || (override?.allowed_environments && !override.allowed_environments.includes(context.environment))) reasons.push(`environment ${context.environment} is not allowed`);
  for (const permission of tool.permissions) if (!context.permissions.includes(permission)) reasons.push(`missing permission ${permission}`);
  for (const precondition of tool.preconditions) if (context.preconditions[precondition.id] !== true) reasons.push(`precondition ${precondition.id} is unmet`);
  if (override?.action === "disable") reasons.push("Tool is disabled");
  if (tool.safety === "safe-mutation" && !["local", "ci", "ephemeral"].includes(context.environment)) reasons.push("safe mutation requires a controlled environment");
  const mustApprove = tool.safety === "destructive" || tool.safety === "high-impact" || tool.confirmation === "required" || override?.require_approval === true;
  if (mustApprove && (!context.approval?.approved_by || ["agent", "paved", "ci"].includes(context.approval.approved_by))) reasons.push("independent human approval is required");
  return { allowed: reasons.length === 0, reasons };
}

export function retryDecision(tool: ToolContract, error: string, attempt: number): { retry: boolean; backoff_seconds: number } {
  const retry = (tool.safety === "read-only" || tool.safety === "safe-mutation") &&
    tool.idempotency === "idempotent" && ["transient-failure", "environment-failure"].includes(error) &&
    attempt < tool.retry.max_attempts;
  return { retry, backoff_seconds: retry ? tool.retry.backoff_seconds : 0 };
}

const KEY_NAME_PATTERN = String.raw`[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*`;
const SECRET_KEY_SEGMENT = /(^|[_-])(secret|secrets|token|tokens|password|passwords|passwd|credential|credentials|authorization)(?=$|[_-])/i;
const COMPOUND_SECRET_KEY = /(^|[_-])(private[_-]?key|api[_-]?key)(?=$|[_-])/i;
const QUOTED_KEY_VALUE = /(["'])([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)\1(\s*:\s*)(["'])(?:\\.|(?!\4).)*\4/g;
const ASSIGNED_KEY_VALUE = new RegExp(
  String.raw`(^|[^A-Za-z0-9_-])(${KEY_NAME_PATTERN})(\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&]+)`,
  "g",
);
const COLON_KEY_VALUE = new RegExp(
  String.raw`(^|[^A-Za-z0-9_-])(${KEY_NAME_PATTERN})(\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}]+)`,
  "g",
);

function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_SEGMENT.test(key) || COMPOUND_SECRET_KEY.test(key);
}

function redactedValue(raw: string): string {
  const quote = raw[0];
  return (quote === "\"" || quote === "'") && raw.endsWith(quote) ? `${quote}[REDACTED]${quote}` : "[REDACTED]";
}

export function sanitizeToolOutput(value: unknown, secrets: string[] = []): unknown {
  const clean = secrets.filter(Boolean);
  const scrub = (text: string) => {
    let output = text.replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]");
    output = output.replace(
      QUOTED_KEY_VALUE,
      (match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
        isSensitiveKey(key) ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}` : match,
    );
    output = output.replace(
      ASSIGNED_KEY_VALUE,
      (match, prefix: string, key: string, separator: string, raw: string) =>
        isSensitiveKey(key) ? `${prefix}${key}${separator}${redactedValue(raw)}` : match,
    );
    output = output.replace(
      COLON_KEY_VALUE,
      (match, prefix: string, key: string, separator: string, raw: string) =>
        isSensitiveKey(key) ? `${prefix}${key}${separator}${redactedValue(raw.trimEnd())}` : match,
    );
    for (const secret of clean) output = output.split(secret).join("[REDACTED]");
    return output;
  };
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeToolOutput(item, clean));
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) ? "[REDACTED]" : sanitizeToolOutput(item, clean)]),
  );
  return value;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");

export function captureToolExecution(args: {
  tool: ToolContract; implementation: ToolImplementation; environment: string; revision: string;
  runtime_version: string;
  recorded_by?: "agent" | "paved" | "ci";
  run_url?: string;
  started_at: string; finished_at: string; status: "succeeded" | "failed" | "blocked" | "timed-out" | "partial";
  exit_code?: number;
  error_code?: ToolErrorCode;
  output: unknown; inputs: Record<string, unknown>; warnings?: string[]; errors?: string[];
  worktree_sha256?: string;
}) {
  if (args.recorded_by === "ci" && !args.run_url) throw new Error("CI-recorded Tool result requires run_url");
  const secretValues = args.tool.inputs.filter((input) => input.sensitive).map((input) => args.inputs[input.name]).filter((value): value is string => typeof value === "string");
  const inputs = sanitizeToolOutput(args.inputs, secretValues);
  const output = sanitizeToolOutput(args.output, secretValues);
  const outputProblems = args.status === "succeeded" ? validateToolResult(args.tool, output) : [];
  const errorCode: ToolErrorCode | undefined = outputProblems.length > 0 ? "malformed-output" : args.error_code ?? (
    args.status === "failed" ? "execution-failure" : args.status === "blocked" ? "failed-precondition" :
      args.status === "timed-out" ? "timeout" : args.status === "partial" ? "partial-execution" : undefined
  );
  return {
    tool: { id: args.tool.id, version: args.tool.version, implementation: args.implementation.id, implementation_version: args.implementation.version },
    status: outputProblems.length > 0 ? "failed" as const : args.status,
    ...(args.exit_code !== undefined ? { exit_code: args.exit_code } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    execution: {
      recorded_by: args.recorded_by ?? "agent", revision: args.revision,
      environment: { kind: args.environment, facts: { "tool-runtime-version": args.runtime_version, "tool-implementation-version": args.implementation.version } },
      started_at: args.started_at, finished_at: args.finished_at,
      ...(args.worktree_sha256 ? { worktree_sha256: args.worktree_sha256 } : {}),
      ...(args.run_url ? { run_url: args.run_url } : {}),
    },
    input_sha256: digest(inputs), output_sha256: digest(output), output,
    warnings: (args.warnings ?? []).map((warning) => sanitizeToolOutput(warning, secretValues) as string),
    errors: [...(args.errors ?? []), ...outputProblems].map((error) => sanitizeToolOutput(error, secretValues) as string),
  };
}

/** Convert a captured Tool result into the CheckResult part of the existing Evidence contract. */
export function toEvidenceCheck(
  result: ReturnType<typeof captureToolExecution>,
  check: { id: string; type: string; tool: string; expected: { exit_code?: number } },
  id: string,
): CheckResult {
  if (check.tool !== result.tool.id) throw new Error(`Check ${check.id} names ${check.tool}, but Tool result names ${result.tool.id}`);
  const status = result.status === "succeeded"
    ? check.expected.exit_code === undefined || !("exit_code" in result)
      ? "inconclusive" : result.exit_code === check.expected.exit_code ? "passed" : "failed"
    : ({ failed: "failed", blocked: "blocked", "timed-out": "error", partial: "inconclusive" } as const)[result.status];
  const observation = { name: "tool-status", value: result.status };
  return {
    id, check: check.id, type: check.type,
    tool: { id: result.tool.id, version: result.tool.version },
    status,
    ...(status === "passed" || status === "failed" ? ("exit_code" in result ? { exit_code: result.exit_code } : {}) : {}),
    execution: {
      recorded_by: result.execution.recorded_by,
      revision: result.execution.revision,
      ...("worktree_sha256" in result.execution ? { worktree_sha256: result.execution.worktree_sha256 } : {}),
      ...("run_url" in result.execution ? { run_url: result.execution.run_url } : {}),
      started_at: result.execution.started_at,
      finished_at: result.execution.finished_at,
      environment: result.execution.environment,
      output_sha256: result.output_sha256,
    },
    observations: [observation],
    ...(status === "failed" || status === "error" ? { summary: result.errors.join("; ") || "Tool execution did not meet the Check expectation" } : {}),
    ...(status === "blocked" ? { reason: result.errors.join("; ") || "Tool execution was blocked" } : {}),
  } as CheckResult;
}
