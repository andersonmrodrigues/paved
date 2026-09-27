import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorHandler } from "./commands/doctor.ts";
import { generateHandler } from "./commands/generate.ts";
import { initHandler } from "./commands/init.ts";
import { statusHandler } from "./commands/status.ts";
import { updateHandler } from "./commands/update.ts";
import { createDiagnostic, createResult, type CommandResult } from "./result.ts";
import { CliPathError, resolveCoreRoot, resolveProjectRoot } from "./paths.ts";

export const COMMAND_NAMES = ["init", "update", "generate", "verify", "status", "doctor"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface CliFlags {
  readonly adapters: readonly string[];
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly noGenerate: boolean;
  readonly project?: string;
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
  init: { adapters: true, dryRun: true, noGenerate: true, selectors: false },
  update: { adapters: false, dryRun: true, noGenerate: false, selectors: false },
  generate: { adapters: true, dryRun: true, noGenerate: false, selectors: true },
  verify: { adapters: true, dryRun: false, noGenerate: false, selectors: false },
  status: { adapters: true, dryRun: false, noGenerate: false, selectors: false },
  doctor: { adapters: true, dryRun: false, noGenerate: false, selectors: false },
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
  const commandSuffix = command === undefined ? " <command>" : ` ${command}`;
  return [
    `Usage: paved${commandSuffix} [options]`,
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
    "Command options:",
    "  --adapter <id>   Select an adapter; repeatable.",
    "  --dry-run        Plan without writes for init, update, and generate.",
    "  --no-generate    Initialize without running generators (init only).",
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
  const adapters: string[] = [];
  const selectors: string[] = [];

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

  const flags = project === undefined
    ? { adapters, dryRun, json, noGenerate }
    : { adapters, dryRun, json, noGenerate, project };

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
    status: "success",
    data: {
      command: invocation.command,
      selectors: invocation.selectors,
      projectRoot: invocation.paths.projectRoot,
      coreRoot: invocation.paths.coreRoot,
      adapters: invocation.flags.adapters,
      dryRun: invocation.flags.dryRun,
      noGenerate: invocation.flags.noGenerate,
    },
  });
}

const DEFAULT_HANDLERS: CommandHandlers = {
  doctor: doctorHandler,
  generate: generateHandler,
  init: initHandler,
  status: statusHandler,
  update: updateHandler,
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
