import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorHandler } from "./commands/doctor.ts";
import { decisionHandler } from "./commands/decision.ts";
import { agentHandler } from "./commands/agent.ts";
import { generateHandler } from "./commands/generate.ts";
import { gardenerHandler } from "./commands/gardener.ts";
import { initHandler } from "./commands/init.ts";
import { statusHandler } from "./commands/status.ts";
import { testHandler } from "./commands/test.ts";
import { updateHandler } from "./commands/update.ts";
import { verifyHandler } from "./commands/verify.ts";
import { stepHandler } from "./commands/workflow.ts";
import { previewHandler } from "./commands/preview.ts";
import { workbenchHandler } from "./commands/workbench.ts";
import { createDiagnostic, createResult, type CommandResult } from "./result.ts";
import { CliPathError, resolveCoreRoot, resolveProjectRoot } from "./paths.ts";
import { assertAnswerIdentity, parseAnswerFlags } from "./lib/decisions/answers.ts";

export const COMMAND_NAMES = ["init", "status", "intent", "plan", "execute", "test", "verify", "update", "doctor", "gardener", "generate", "agent", "decision", "preview", "workbench"] as const;
const STEP_COMMANDS: readonly string[] = ["intent", "plan", "execute"];
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface CliFlags {
  readonly adapters: readonly string[];
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly noGenerate: boolean;
  readonly inputs?: string;
  readonly run?: string;
  readonly advance?: boolean;
  readonly approve?: boolean;
  readonly reply?: string;
  readonly note?: string;
  readonly evidence?: string;
  readonly project?: string;
  readonly answers: readonly string[];
  readonly answeredBy?: string;
  readonly decision?: string;
  readonly workflow?: string;
  readonly because?: string;
  readonly recommend?: string;
  readonly parts: readonly string[];
  readonly intentInputs: readonly string[];
}

export interface CommandPaths {
  readonly cwd: string;
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly manifestPath?: string;
}

export interface CommandInvocation {
  readonly command: CommandName;
  readonly flags: CliFlags;
  readonly selectors: readonly string[];
  readonly paths: CommandPaths;
  readonly rawArgv: readonly string[];
}

export type CommandHandler = (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
export type CommandHandlers = Partial<Record<CommandName, CommandHandler>>;

export interface DispatchOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly executablePath?: string;
  readonly handlers?: CommandHandlers;
}

interface CommandRule {
  readonly adapters: boolean;
  readonly dryRun: boolean;
  readonly noGenerate: boolean;
  readonly selectors: boolean;
}

interface ParseState {
  readonly command: CommandName;
  readonly flags: CliFlags;
  readonly selectors: readonly string[];
}

type Parsed =
  | { readonly kind: "command"; readonly state: ParseState }
  | { readonly kind: "help"; readonly json: boolean; readonly command?: CommandName }
  | { readonly kind: "version"; readonly json: boolean }
  | { readonly kind: "error"; readonly result: CommandResult };

const COMMANDS = new Set<string>(COMMAND_NAMES);
const COMMON_VALUE_FLAGS = new Set(["--project"]);
const COMMON_BOOLEAN_FLAGS = new Set(["--json"]);
const COMMAND_RULES: Record<CommandName, CommandRule> = {
  init: { adapters: false, dryRun: true, noGenerate: true, selectors: false },
  update: { adapters: false, dryRun: true, noGenerate: false, selectors: false },
  generate: { adapters: false, dryRun: true, noGenerate: false, selectors: true },
  verify: { adapters: true, dryRun: false, noGenerate: false, selectors: false },
  status: { adapters: true, dryRun: false, noGenerate: false, selectors: false },
  doctor: { adapters: true, dryRun: false, noGenerate: false, selectors: false },
  gardener: { adapters: false, dryRun: true, noGenerate: false, selectors: false },
  test: { adapters: false, dryRun: false, noGenerate: false, selectors: false },
  agent: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
  decision: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
  preview: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
  workbench: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
  intent: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
  plan: { adapters: false, dryRun: false, noGenerate: false, selectors: false },
  execute: { adapters: false, dryRun: false, noGenerate: false, selectors: false },
};

function usage(command: string, message: string, remediation = "Run paved --help to see supported commands and flags."): CommandResult {
  return createResult({
    command,
    status: "failed",
    diagnostics: [
      createDiagnostic({
        severity: "error",
        category: "usage",
        code: "PAVED_CLI_USAGE",
        component: "cli.runtime",
        message,
        remediation,
      }),
    ],
  });
}

function environment(command: string, message: string): CommandResult {
  return createResult({
    command,
    status: "failed",
    diagnostics: [
      createDiagnostic({
        severity: "error",
        category: "environment",
        code: "PAVED_CLI_ENVIRONMENT",
        component: "cli.paths",
        message,
      }),
    ],
  });
}

function internal(command: string, error: unknown): CommandResult {
  return createResult({
    command,
    status: "failed",
    diagnostics: [
      createDiagnostic({
        severity: "error",
        category: "internal",
        code: "PAVED_CLI_INTERNAL",
        component: "cli.runtime",
        message: error instanceof Error ? error.message : "Unexpected CLI failure.",
      }),
    ],
  });
}

function takeValue(argv: readonly string[], index: number, flag: string, command: string): string | CommandResult {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    return usage(command, `Missing value for ${flag}.`);
  }
  return value;
}

function commandUsage(command: CommandName | undefined): string {
  if (command !== undefined) {
    const selectors = command === "generate" ? " [generator-id...]" : command === "agent"
      ? " <operation> [integration|command-name]" : command === "preview" ? " <start|serve|status|wait|working|resolve|stop> <file.md|folder> [cursor|comment-id]" : command === "workbench" ? " <start|serve|status|stop>" : "";
    const commandOptions: string[] = [];
    const rule = COMMAND_RULES[command];
    if (rule.adapters) commandOptions.push("  --adapter <id>   Select an adapter for status, doctor, or verification content resolution; repeatable.");
    if (rule.dryRun) commandOptions.push("  --dry-run        Plan without writes.");
    if (rule.noGenerate) commandOptions.push("  --no-generate    Initialize without running generators.");
    if (command === "test") commandOptions.push("  --inputs <json>  Supply declared Tool inputs as a JSON object.");
    if (command === "decision") commandOptions.push("  --decision <json>  Raise an agent-authored question.", "  --reason <text>   Explain a revision.");
    if (command === "preview") commandOptions.push("  --reply <text>   With resolve, tell the reviewer what changed.");
    if (command === "intent") commandOptions.push("  --workflow <feature|bug|refactor> --because <evidence>  Classify the request.", "  --recommend <workflow> --because <evidence>  Suggest a workflow and let the user decide.", "  --part <request>  Propose one part of a split; repeat per part.", "  --input <id>=<value>  Supply another declared workflow input; repeatable.");
    if (STEP_COMMANDS.includes(command)) commandOptions.push("  --run <id> --advance --note <text> --evidence <path>  Advance the run within this step's phases.");
    if (command === "plan") commandOptions.push("  --approve        Record the user's approval of the current plan, given in the conversation.");
    return [
      `Usage: paved ${command}${selectors} [options]`,
      "",
      "Global options:",
      "  --help, -h       Show help.",
      "  --project <dir>  Select a project directory.",
      "  --json           Render structured JSON output.",
      "  --answer <id>=<value>    Answer a pending Paved decision; repeatable.",
      "  --answered-by <identity> The person who decided; required with --answer.",
      "",
      "Command options:",
      ...(commandOptions.length === 0 ? ["  (none)"] : commandOptions),
    ].join("\n");
  }

  return [
    "Usage: paved <command> [options]",
    "",
    "Commands:",
    `  ${COMMAND_NAMES.join(", ")}`,
    "",
    "Global options:",
    "  --help, -h       Show help.",
    "  --version        Show the package version.",
    "  --project <dir>  Select a project directory.",
    "  --json           Render structured JSON output.",
    "",
    "Run paved <command> --help for command-specific inputs and flags.",
  ].join("\n");
}

function helpResult(json: boolean, command?: CommandName): CommandResult {
  return createResult({
    command: "help",
    status: "success",
    data: {
      command,
      json,
      usage: commandUsage(command),
    },
  });
}

function packageVersion(coreRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

function versionResult(coreRoot: string, json: boolean): CommandResult {
  return createResult({
    command: "version",
    status: "success",
    data: {
      json,
      version: packageVersion(coreRoot),
    },
  });
}

function isCommandName(value: string): value is CommandName {
  return COMMANDS.has(value);
}

function parse(argv: readonly string[]): Parsed {
  let command: CommandName | undefined;
  let project: string | undefined;
  let json = false;
  let dryRun = false;
  let noGenerate = false;
  let inputs: string | undefined;
  let run: string | undefined;
  let advance = false;
  let approve = false;
  let reply: string | undefined;
  let note: string | undefined;
  let evidence: string | undefined;
  const adapters: string[] = [];
  const selectors: string[] = [];
  const answers: string[] = [];
  let answeredBy: string | undefined;
  let decision: string | undefined;
  let workflow: string | undefined;
  let because: string | undefined;
  let recommend: string | undefined;
  const parts: string[] = [];
  const intentInputs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      return { kind: "help", json, ...(command === undefined ? {} : { command }) };
    }

    if (token === "--version") {
      return { kind: "version", json };
    }

    if (COMMON_BOOLEAN_FLAGS.has(token)) {
      json = true;
      continue;
    }

    if (COMMON_VALUE_FLAGS.has(token)) {
      const value = takeValue(argv, index, token, command ?? "cli");
      if (typeof value !== "string") {
        return { kind: "error", result: value };
      }
      project = value;
      index += 1;
      continue;
    }

    if (token === "--adapter") {
      const value = takeValue(argv, index, token, command ?? "cli");
      if (typeof value !== "string") {
        return { kind: "error", result: value };
      }
      adapters.push(value);
      index += 1;
      continue;
    }

    if (token === "--inputs") {
      if (command !== "test") {
        return { kind: "error", result: usage(command ?? "cli", "Flag --inputs is supported only by test.") };
      }
      const value = takeValue(argv, index, token, command);
      if (typeof value !== "string") return { kind: "error", result: value };
      inputs = value;
      index += 1;
      continue;
    }

    if (token === "--decision") {
      if (command !== "decision") {
        return { kind: "error", result: usage(command ?? "cli", "Flag --decision is supported only by decision.") };
      }
      const value = takeValue(argv, index, token, command);
      if (typeof value !== "string") return { kind: "error", result: value };
      decision = value;
      index += 1;
      continue;
    }

    if (token === "--reason") {
      if (command !== "decision") {
        return { kind: "error", result: usage(command ?? "cli", "Flag --reason is supported only by decision.") };
      }
      const value = takeValue(argv, index, token, command);
      if (typeof value !== "string") return { kind: "error", result: value };
      note = value;
      index += 1;
      continue;
    }

    if (["--workflow", "--because", "--recommend", "--part", "--input"].includes(token)) {
      if (command !== "intent") return { kind: "error", result: usage(command ?? "cli", `${token} is supported only by intent.`) };
      const value = takeValue(argv, index, token, command);
      if (typeof value !== "string") return { kind: "error", result: value };
      if (token === "--workflow") workflow = value;
      if (token === "--because") because = value;
      if (token === "--recommend") recommend = value;
      if (token === "--part") parts.push(value);
      if (token === "--input") intentInputs.push(value);
      index += 1;
      continue;
    }
    if (["--run", "--note", "--evidence"].includes(token)) {
      if (!command || !STEP_COMMANDS.includes(command)) return { kind: "error", result: usage(command ?? "cli", `${token} is supported only by intent, plan and execute.`) };
      const value = takeValue(argv, index, token, command);
      if (typeof value !== "string") return { kind: "error", result: value };
      if (token === "--run") run = value;
      if (token === "--note") note = value;
      if (token === "--evidence") evidence = value;
      index += 1;
      continue;
    }
    if (token === "--reply") {
      if (command !== "preview") return { kind: "error", result: usage(command ?? "cli", "--reply is supported only by preview resolve.") };
      const value = takeValue(argv, index, token, command);
      if (typeof value !== "string") return { kind: "error", result: value };
      reply = value;
      index += 1;
      continue;
    }
    if (token === "--approve") {
      if (command !== "plan") return { kind: "error", result: usage(command ?? "cli", "--approve is supported only by plan.") };
      approve = true;
      continue;
    }
    if (token === "--advance") {
      if (!command || !STEP_COMMANDS.includes(command)) return { kind: "error", result: usage(command ?? "cli", "--advance is supported only by intent, plan and execute.") };
      advance = true;
      continue;
    }

    if (token === "--dry-run") {
      if (command === undefined) {
        return { kind: "error", result: usage("cli", "Flag --dry-run must appear after a command that supports it.") };
      }
      if (!COMMAND_RULES[command].dryRun) {
        return { kind: "error", result: usage(command, `Unknown flag for ${command}: --dry-run.`) };
      }
      dryRun = true;
      continue;
    }

    if (token === "--no-generate") {
      if (command === undefined) {
        return { kind: "error", result: usage("cli", "Flag --no-generate must appear after init.") };
      }
      if (!COMMAND_RULES[command].noGenerate) {
        return { kind: "error", result: usage(command, `Unknown flag for ${command}: --no-generate.`) };
      }
      noGenerate = true;
      continue;
    }

    if (token === "--answer" || token === "--answered-by") {
      const value = takeValue(argv, index, token, command ?? "cli");
      if (typeof value !== "string") return { kind: "error", result: value };
      if (token === "--answer") answers.push(value);
      else answeredBy = value;
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      return { kind: "error", result: usage(command ?? "cli", `Unknown flag: ${token}.`) };
    }

    if (command === undefined) {
      if (!isCommandName(token)) {
        return { kind: "error", result: usage(token, `Unknown command: ${token}.`) };
      }
      command = token;
      continue;
    }

    if (!COMMAND_RULES[command].selectors) {
      return { kind: "error", result: usage(command, `Unexpected argument for ${command}: ${token}.`) };
    }
    selectors.push(token);
  }

  if (command === undefined) {
    return { kind: "help", json };
  }

  const rule = COMMAND_RULES[command];
  if (adapters.length > 0 && !rule.adapters) {
    return { kind: "error", result: usage(command, `Unknown flag for ${command}: --adapter.`) };
  }

  if (answers.length > 0) {
    const parsed = parseAnswerFlags(answers);
    if ("problems" in parsed) {
      return { kind: "error", result: usage(command, parsed.problems.join(" ")) };
    }
    try {
      assertAnswerIdentity(answeredBy);
    } catch (error) {
      return {
        kind: "error",
        result: usage(command, error instanceof Error ? error.message : "Invalid --answered-by."),
      };
    }
  }

  const flags = {
    adapters,
    dryRun,
    json,
    noGenerate,
    advance,
    approve,
    answers,
    parts,
    intentInputs,
    ...(workflow === undefined ? {} : { workflow }),
    ...(because === undefined ? {} : { because }),
    ...(recommend === undefined ? {} : { recommend }),
    ...(reply === undefined ? {} : { reply }),
    ...(answeredBy === undefined ? {} : { answeredBy }),
    ...(run === undefined ? {} : { run }),
    ...(note === undefined ? {} : { note }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(project === undefined ? {} : { project }),
    ...(inputs === undefined ? {} : { inputs }),
    ...(decision === undefined ? {} : { decision }),
  };

  return {
    kind: "command",
    state: {
      command,
      flags,
      selectors,
    },
  };
}

function pathsFor(state: ParseState, cwd: string, executablePath: string): CommandPaths {
  const project = resolveProjectRoot({ cwd, ...(state.flags.project === undefined ? {} : { project: state.flags.project }) });
  const coreRoot = resolveCoreRoot({ executablePath });

  return project.manifestPath === undefined
    ? { cwd, projectRoot: project.projectRoot, coreRoot }
    : { cwd, projectRoot: project.projectRoot, coreRoot, manifestPath: project.manifestPath };
}

function defaultHandler(invocation: CommandInvocation): CommandResult {
  return createResult({
    command: invocation.command,
    status: "failed",
    diagnostics: [createDiagnostic({ severity: "error", category: "internal", code: "PAVED_COMMAND_HANDLER_MISSING",
      component: "cli.runtime", message: `No executable handler is registered for ${invocation.command}.`,
      remediation: "Install a complete Paved runtime package." })],
  });
}

const DEFAULT_HANDLERS: CommandHandlers = {
  agent: agentHandler,
  decision: decisionHandler,
  preview: previewHandler,
  workbench: workbenchHandler,
  doctor: doctorHandler,
  generate: generateHandler,
  gardener: gardenerHandler,
  init: initHandler,
  status: statusHandler,
  test: testHandler,
  update: updateHandler,
  verify: verifyHandler,
  intent: stepHandler,
  plan: stepHandler,
  execute: stepHandler,
};

export async function dispatchCli(options: DispatchOptions = {}): Promise<CommandResult> {
  const argv = options.argv ?? [];
  const cwd = options.cwd ?? process.cwd();
  const executablePath = options.executablePath ?? fileURLToPath(import.meta.url);
  let coreRoot: string | undefined;

  try {
    coreRoot = resolveCoreRoot({ executablePath });
  } catch (error) {
    if (error instanceof CliPathError) {
      return environment("cli", error.message);
    }
    return internal("cli", error);
  }

  const parsed = parse(argv);
  if (parsed.kind === "error") {
    return parsed.result;
  }
  if (parsed.kind === "help") {
    return helpResult(parsed.json, parsed.command);
  }
  if (parsed.kind === "version") {
    try {
      return versionResult(coreRoot, parsed.json);
    } catch (error) {
      return internal("version", error);
    }
  }

  try {
    const paths = pathsFor(parsed.state, cwd, executablePath);
    const handler = options.handlers?.[parsed.state.command] ?? DEFAULT_HANDLERS[parsed.state.command] ?? defaultHandler;
    return await handler({
      command: parsed.state.command,
      flags: parsed.state.flags,
      selectors: parsed.state.selectors,
      paths,
      rawArgv: argv,
    });
  } catch (error) {
    if (error instanceof CliPathError) {
      return environment(parsed.state.command, error.message);
    }
    return internal(parsed.state.command, error);
  }
}
