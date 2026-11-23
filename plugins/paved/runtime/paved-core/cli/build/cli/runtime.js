import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorHandler } from "./commands/doctor.js";
import { decisionHandler } from "./commands/decision.js";
import { agentHandler } from "./commands/agent.js";
import { generateHandler } from "./commands/generate.js";
import { gardenerHandler } from "./commands/gardener.js";
import { reviewHandler } from "./commands/review.js";
import { initHandler } from "./commands/init.js";
import { statusHandler } from "./commands/status.js";
import { testHandler } from "./commands/test.js";
import { updateHandler } from "./commands/update.js";
import { verifyHandler } from "./commands/verify.js";
import { stepHandler } from "./commands/workflow.js";
import { previewHandler } from "./commands/preview.js";
import { workbenchHandler } from "./commands/workbench.js";
import { toolHandler } from "./commands/tool.js";
import { delegationHandler } from "./commands/delegation.js";
import { contextHandler } from "./commands/context.js";
import { taskHandler } from "./commands/task.js";
import { deliveryHandler } from "./commands/delivery.js";
import { createDiagnostic, createResult } from "./result.js";
import { CliPathError, resolveCoreRoot, resolveProjectRoot } from "./paths.js";
import { assertAnswerIdentity, parseAnswerFlags, recordedIdentity } from "./lib/decisions/answers.js";
import { reclaimedLockDiagnostics } from "./lib/operation-lock.js";
export const COMMAND_NAMES = ["init", "status", "intent", "plan", "execute", "delegation", "test", "verify", "update", "doctor", "gardener", "review", "generate", "agent", "decision", "preview", "workbench", "tool", "context", "task", "delivery"];
const STEP_COMMANDS = ["intent", "plan", "execute"];
const COMMANDS = new Set(COMMAND_NAMES);
const COMMON_VALUE_FLAGS = new Set(["--project"]);
const COMMON_BOOLEAN_FLAGS = new Set(["--json"]);
const COMMAND_RULES = {
    init: { adapters: false, dryRun: true, noGenerate: true, selectors: false },
    update: { adapters: false, dryRun: true, noGenerate: false, selectors: false },
    generate: { adapters: false, dryRun: true, noGenerate: false, selectors: true },
    verify: { adapters: true, dryRun: false, noGenerate: false, selectors: false },
    status: { adapters: true, dryRun: false, noGenerate: false, selectors: false },
    doctor: { adapters: true, dryRun: false, noGenerate: false, selectors: false },
    gardener: { adapters: false, dryRun: true, noGenerate: false, selectors: true },
    review: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    test: { adapters: false, dryRun: false, noGenerate: false, selectors: false },
    agent: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    decision: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    preview: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    workbench: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    tool: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    delegation: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    context: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    task: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    delivery: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    intent: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    plan: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
    execute: { adapters: false, dryRun: false, noGenerate: false, selectors: true },
};
function usage(command, message, remediation = "Run paved --help to see supported commands and flags.") {
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
function environment(command, message) {
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
function internal(command, error) {
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
function takeValue(argv, index, flag, command) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
        return usage(command, `Missing value for ${flag}.`);
    }
    return value;
}
function commandUsage(command) {
    if (command !== undefined) {
        const selectors = command === "generate" ? " [generator-id...]" : command === "agent"
            ? " <operation> [integration|command-name]" : command === "preview" ? " <start|serve|status|wait|working|resolve|stop> <file.md|folder> [cursor|comment-id]" : command === "workbench" ? " <start|serve|status|stop>"
            : command === "tool" ? " add <check-type> [label] [--scope <dir>] -- <executable> [args...]" : command === "delegation" ? " <plan|approve|ready|start|finish|recover|capabilities>" : command === "delivery" ? " <approve|merge>" : command === "execute" || command === "plan" ? " [request]" : "";
        const commandOptions = [];
        const rule = COMMAND_RULES[command];
        if (rule.adapters)
            commandOptions.push("  --adapter <id>   Select an adapter for status, doctor, or verification content resolution; repeatable.");
        if (rule.dryRun)
            commandOptions.push("  --dry-run        Plan without writes.");
        if (rule.noGenerate)
            commandOptions.push("  --no-generate    Initialize without running generators.");
        if (command === "test")
            commandOptions.push("  --inputs <json>  Supply declared Tool inputs as a JSON object.");
        if (command === "verify")
            commandOptions.push("  --changed [--base <ref>]  Scope checks to changed files, optionally including commits since the merge base.", "  --task <slug>  Attach verification evidence to an open task.", "  --lock-wait <seconds>  Wait for another operation's lock; reuse its run when it verified the same change.", "  --recorded  Report the recorded result for the current change; never run a Check.");
        if (command === "context")
            commandOptions.push("  <topic-or-path> [--budget <bytes>]  Retrieve matching project context and rules.", "  refresh [--areas <area,...>]        Refresh stale context areas, or the named areas.");
        if (command === "task")
            commandOptions.push("  start|note|done <slug> <text>; resume <slug>  Manage a task handoff.");
        if (command === "doctor")
            commandOptions.push("  --quick         Return a read-only maintenance diagnosis.");
        if (command === "decision")
            commandOptions.push("  --decision <json>  Raise an agent-authored question.", "  --reason <text>   Explain a revision.");
        if (command === "preview")
            commandOptions.push("  --reply <text>   With resolve, tell the reviewer what changed.");
        if (STEP_COMMANDS.includes(command))
            commandOptions.push("  --workflow <feature|bug|refactor|performance|investigation> --because <evidence>  Classify the request.", "  --lane <trivial|standard|risky>  With --workflow, the lane whose phases the run follows (covered by --because); without one every phase runs.", "  --run <id> --lane risky --because <evidence>  Escalate a run: reopen planning and require its approval before completion.", "  --recommend <workflow> --because <evidence>  Suggest a workflow and let the user decide.", "  --part <request>  Propose one part of a split; repeat per part.", "  --input <id>=<value>  Supply another declared workflow input; repeatable.", "  --autonomy <guided|balanced|autonomous>  Select a profile for the new run; fixed on resume.");
        if (STEP_COMMANDS.includes(command))
            commandOptions.push("  --host-tool-approval <id>  Acknowledge the exact suspended Tool invocation after host mediation; grants no host permission.");
        if (STEP_COMMANDS.includes(command))
            commandOptions.push("  --run <id> --advance --note <text> --evidence <path>  Advance the run within this step's phases. --evidence takes the phase's record: a Markdown plan or answer, a failing-test Evidence record at bug discovery, or the ChangeReview at review; never a log.");
        if (STEP_COMMANDS.includes(command))
            commandOptions.push("  --run <id> --abandon [--note <reason>]  Cancel the run so the same request can start again.");
        if (command === "plan")
            commandOptions.push("  \"<request>\"      Start new work and stop once its plan is approved.", "  --approve        Record the user's approval of the current plan, given in the conversation.", "  --run <id> --amend --note <change> [--evidence <plan>]  Ask approval for a revised plan mid-run.");
        if (command === "execute")
            commandOptions.push("  \"<request>\"      Start new work: initialize Paved if needed and record the request.", "  --approve        Record the user's approval of the current plan, given in the conversation.", "  --auto           Advance through every phase that needs no human input.", "  --run <id> --checkpoint --note <progress>  Record a finished part of the plan without leaving implementation.");
        if (command === "status")
            commandOptions.push("  --base <ref>     Report whether the latest completed run's evidence still matches the patch HEAD proposes against this target.", "  --stale-after <hours>  Warn about open runs without an event for this many hours (default 24).");
        if (command === "delivery")
            commandOptions.push("  --base <target> --change <id> --head <revision>  Bind the action to the exact target, change request and full head.", "  approve          Record the user's explicit approval after freshness and repository-host identity checks.", "  merge            Merge only with a matching patch-bound approval; the host must still accept the exact head.");
        if (command === "gardener")
            commandOptions.push("  debt             List tracked shortcut: comments.", "  correction --text <words> --evidence <path[:line]|commit|url>  Propose a person's correction, verbatim, as a project rule; --evidence is repeatable.");
        if (command === "review")
            commandOptions.push("  plan [--base <ref>]  Recommend review scope from the change; without a base, consider the working tree against HEAD.", "  --base <ref>     Review everything changed since the merge base with <ref>, including uncommitted and untracked files.", "  --range <a..b>   Review the commits in a range; a...b starts at their merge base.", "  --evidence <path>  Check the reviewer's ChangeReview against the change as it is now.");
        if (command === "tool")
            commandOptions.push("  --scope <dir>    Run the command from this project directory.", "  -- <executable> [args...]  The exact command; everything after -- is passed as argv.");
        if (command === "delegation")
            commandOptions.push("  check --file <path>  Validate a subagent result's format without a run.", "  plan --run <id> --file <path>; approve --run <id> --approve after showing the exact graph to the user.", "  start --run <id> --task <id> --host <codex|claude-code> --model <name> --effort <value> --isolation <shared-workspace|isolated-worktree>.", "  finish --run <id> --task <id> --outcome <completed|blocked|failed> [--result <path>] [--usage <json>] [--changed-path <path> ...].", "  recover --run <id> --task <id> --confirmed-stopped --note <reason>; capabilities --host <codex|claude-code>.", "  Session ids are hashed; usage and isolated-worktree changed paths are host-reported.");
        return [
            `Usage: paved ${command}${selectors} [options]`,
            "",
            "Global options:",
            "  --help, -h       Show help.",
            "  --project <dir>  Select a project directory.",
            "  --json           Render structured JSON output.",
            "  --answer <id>=<value>    Answer a pending Paved decision; repeatable.",
            "  --answered-by <identity> The person who decided; required with --answer. An email is stored as a pseudonym.",
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
function helpResult(json, command) {
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
function packageVersion(coreRoot) {
    const pkg = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
function versionResult(coreRoot, json) {
    return createResult({
        command: "version",
        status: "success",
        data: {
            json,
            version: packageVersion(coreRoot),
        },
    });
}
function isCommandName(value) {
    return COMMANDS.has(value);
}
function parse(argv) {
    let command;
    let project;
    let json = false;
    let dryRun = false;
    let noGenerate = false;
    let changed = false;
    let recorded = false;
    let quick = false;
    let budget;
    let inputs;
    let run;
    let advance = false;
    let approve = false;
    let amend = false;
    let abandon = false;
    let checkpoint = false;
    let auto = false;
    let reply;
    let note;
    let evidence;
    const adapters = [];
    const areas = [];
    const selectors = [];
    const answers = [];
    let answeredBy;
    let decision;
    let workflow;
    let lane;
    let autonomy;
    let hostToolApproval;
    let because;
    let recommend;
    const parts = [];
    const intentInputs = [];
    let scope;
    let base;
    let change;
    let head;
    let range;
    let text;
    const correctionEvidence = [];
    let staleAfterHours;
    let lockWaitSeconds;
    let toolCommand;
    let task;
    let file;
    let host;
    let model;
    let effort;
    let session;
    let result;
    let outcome;
    let usageJson;
    let selectedBy;
    let isolation;
    let confirmedStopped = false;
    const changedPaths = [];
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
        if (token === "--changed") {
            if (command !== "verify")
                return { kind: "error", result: usage(command ?? "cli", "--changed is supported only by verify.") };
            changed = true;
            continue;
        }
        if (token === "--recorded") {
            if (command !== "verify")
                return { kind: "error", result: usage(command ?? "cli", "--recorded is supported only by verify.") };
            recorded = true;
            continue;
        }
        if (token === "--quick") {
            if (command !== "doctor")
                return { kind: "error", result: usage(command ?? "cli", "--quick is supported only by doctor.") };
            quick = true;
            continue;
        }
        if (token === "--budget") {
            if (command !== "context")
                return { kind: "error", result: usage(command ?? "cli", "--budget is supported only by context.") };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (!/^[1-9]\d*$/.test(value) || Number(value) > 100000)
                return { kind: "error", result: usage(command, "--budget must be between 1 and 100000 bytes.") };
            budget = Number(value);
            index += 1;
            continue;
        }
        if (token === "--areas") {
            if (command !== "context")
                return { kind: "error", result: usage(command ?? "cli", "--areas is supported only by context refresh.") };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            const parsed = value.split(",").map((area) => area.trim());
            if (parsed.some((area) => area.length === 0))
                return { kind: "error", result: usage(command, "--areas must contain nonempty comma-separated area names.") };
            areas.push(...parsed);
            index += 1;
            continue;
        }
        if (COMMON_BOOLEAN_FLAGS.has(token)) {
            json = true;
            continue;
        }
        if (token === "--" && command === "tool") {
            toolCommand = argv.slice(index + 1);
            break;
        }
        if (token === "--scope") {
            if (command !== "tool")
                return { kind: "error", result: usage(command ?? "cli", "--scope is supported only by tool add.") };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            scope = value;
            index += 1;
            continue;
        }
        if (token === "--lock-wait") {
            if (command !== "verify")
                return { kind: "error", result: usage(command ?? "cli", "--lock-wait is supported only by verify.") };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (!/^\d+$/.test(value) || Number(value) > 3600)
                return { kind: "error", result: usage(command, "--lock-wait must be between 0 and 3600 seconds.") };
            lockWaitSeconds = Number(value);
            index += 1;
            continue;
        }
        if (token === "--base") {
            if (command !== "status" && command !== "review" && command !== "verify" && command !== "delivery")
                return { kind: "error", result: usage(command ?? "cli", "--base is supported only by status, review, verify and delivery.") };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            base = value;
            index += 1;
            continue;
        }
        if (token === "--change" || token === "--head") {
            if (command !== "delivery")
                return { kind: "error", result: usage(command ?? "cli", `${token} is supported only by delivery.`) };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (token === "--change")
                change = value;
            else
                head = value;
            index += 1;
            continue;
        }
        if (token === "--range" || (token === "--evidence" && command === "review")) {
            if (command !== "review")
                return { kind: "error", result: usage(command ?? "cli", "--range is supported only by review.") };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (token === "--range")
                range = value;
            else
                evidence = value;
            index += 1;
            continue;
        }
        if (command === "gardener" && (token === "--text" || token === "--evidence")) {
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (token === "--text")
                text = value;
            else
                correctionEvidence.push(value);
            index += 1;
            continue;
        }
        if (token === "--stale-after") {
            if (command !== "status")
                return { kind: "error", result: usage(command ?? "cli", "--stale-after is supported only by status.") };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 8760) {
                return { kind: "error", result: usage(command, "--stale-after takes a whole number of hours from 1 to 8760.") };
            }
            staleAfterHours = Number(value);
            index += 1;
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
        if (token === "--host-tool-approval") {
            if (!STEP_COMMANDS.includes(command ?? ""))
                return { kind: "error", result: usage(command ?? "cli", "--host-tool-approval is supported only by workflow commands.") };
            const value = takeValue(argv, index, token, command ?? "cli");
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (!/^[a-f0-9]{64}$/.test(value))
                return { kind: "error", result: usage(command ?? "cli", "--host-tool-approval requires the exact bounded request digest.") };
            hostToolApproval = value;
            index += 1;
            continue;
        }
        if (token === "--inputs") {
            if (command !== "test") {
                return { kind: "error", result: usage(command ?? "cli", "Flag --inputs is supported only by test.") };
            }
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            inputs = value;
            index += 1;
            continue;
        }
        if (token === "--decision") {
            if (command !== "decision") {
                return { kind: "error", result: usage(command ?? "cli", "Flag --decision is supported only by decision.") };
            }
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            decision = value;
            index += 1;
            continue;
        }
        if (token === "--reason") {
            if (command !== "decision") {
                return { kind: "error", result: usage(command ?? "cli", "Flag --reason is supported only by decision.") };
            }
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            note = value;
            index += 1;
            continue;
        }
        if (["--task", "--file", "--host", "--model", "--effort", "--session", "--result", "--outcome", "--usage", "--selected-by", "--isolation", "--changed-path"].includes(token)) {
            if (command !== "delegation" && !(command === "verify" && token === "--task"))
                return { kind: "error", result: usage(command ?? "cli", `${token} is supported only by delegation${token === "--task" ? " or verify" : ""}.`) };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (token === "--task")
                task = value;
            if (token === "--file")
                file = value;
            if (token === "--host")
                host = value;
            if (token === "--model")
                model = value;
            if (token === "--effort")
                effort = value;
            if (token === "--session")
                session = value;
            if (token === "--result")
                result = value;
            if (token === "--outcome")
                outcome = value;
            if (token === "--usage")
                usageJson = value;
            if (token === "--selected-by")
                selectedBy = value;
            if (token === "--isolation")
                isolation = value;
            if (token === "--changed-path")
                changedPaths.push(value);
            index += 1;
            continue;
        }
        if (token === "--confirmed-stopped") {
            if (command !== "delegation")
                return { kind: "error", result: usage(command ?? "cli", "--confirmed-stopped is supported only by delegation recover.") };
            confirmedStopped = true;
            continue;
        }
        if (["--workflow", "--lane", "--because", "--recommend", "--part", "--input", "--autonomy"].includes(token)) {
            if (!command || !STEP_COMMANDS.includes(command))
                return { kind: "error", result: usage(command ?? "cli", `${token} is supported only by intent, plan and execute.`) };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (token === "--lane") {
                if (!["trivial", "standard", "risky"].includes(value))
                    return { kind: "error", result: usage(command, "--lane must be trivial, standard or risky.") };
                lane = value;
            }
            if (token === "--autonomy") {
                if (!["guided", "balanced", "autonomous"].includes(value))
                    return { kind: "error", result: usage(command, "--autonomy must be guided, balanced or autonomous.") };
                autonomy = value;
            }
            if (token === "--workflow")
                workflow = value;
            if (token === "--because")
                because = value;
            if (token === "--recommend")
                recommend = value;
            if (token === "--part")
                parts.push(value);
            if (token === "--input")
                intentInputs.push(value);
            index += 1;
            continue;
        }
        if (["--run", "--note", "--evidence"].includes(token)) {
            const delegationFlag = command === "delegation" && (token === "--run" || (token === "--note" && selectors[0] === "recover"));
            if (!command || (!STEP_COMMANDS.includes(command) && !delegationFlag))
                return { kind: "error", result: usage(command ?? "cli", `${token} is supported only by intent, plan, execute${delegationFlag ? " and delegation" : ""}.`) };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (token === "--run")
                run = value;
            if (token === "--note")
                note = value;
            if (token === "--evidence")
                evidence = value;
            index += 1;
            continue;
        }
        if (token === "--reply") {
            if (command !== "preview")
                return { kind: "error", result: usage(command ?? "cli", "--reply is supported only by preview resolve.") };
            const value = takeValue(argv, index, token, command);
            if (typeof value !== "string")
                return { kind: "error", result: value };
            reply = value;
            index += 1;
            continue;
        }
        if (token === "--approve") {
            if (command !== "plan" && command !== "execute" && command !== "delegation")
                return { kind: "error", result: usage(command ?? "cli", "--approve is supported only by plan, execute and delegation.") };
            approve = true;
            continue;
        }
        if (token === "--amend") {
            if (command !== "plan")
                return { kind: "error", result: usage(command ?? "cli", "--amend is supported only by plan.") };
            amend = true;
            continue;
        }
        if (token === "--auto") {
            if (command !== "execute")
                return { kind: "error", result: usage(command ?? "cli", "--auto is supported only by execute.") };
            auto = true;
            continue;
        }
        if (token === "--checkpoint") {
            if (command !== "execute")
                return { kind: "error", result: usage(command ?? "cli", "--checkpoint is supported only by execute.") };
            checkpoint = true;
            continue;
        }
        if (token === "--abandon") {
            if (!command || !STEP_COMMANDS.includes(command))
                return { kind: "error", result: usage(command ?? "cli", "--abandon is supported only by intent, plan and execute.") };
            abandon = true;
            continue;
        }
        if (token === "--advance") {
            if (!command || !STEP_COMMANDS.includes(command))
                return { kind: "error", result: usage(command ?? "cli", "--advance is supported only by intent, plan and execute.") };
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
            if (typeof value !== "string")
                return { kind: "error", result: value };
            if (token === "--answer")
                answers.push(value);
            else
                answeredBy = value;
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
    if (command === "verify" && base !== undefined && !changed) {
        return { kind: "error", result: usage(command, "--base requires --changed.") };
    }
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
        }
        catch (error) {
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
        ...(changed ? { changed } : {}),
        ...(recorded ? { recorded } : {}),
        ...(quick ? { quick } : {}),
        ...(budget === undefined ? {} : { budget }),
        areas,
        advance,
        approve,
        amend,
        abandon,
        checkpoint,
        auto,
        answers,
        parts,
        intentInputs,
        ...(workflow === undefined ? {} : { workflow }),
        ...(lane === undefined ? {} : { lane }),
        ...(autonomy === undefined ? {} : { autonomy }),
        ...(hostToolApproval === undefined ? {} : { hostToolApproval }),
        ...(because === undefined ? {} : { because }),
        ...(recommend === undefined ? {} : { recommend }),
        ...(reply === undefined ? {} : { reply }),
        ...(answeredBy === undefined ? {} : { answeredBy: recordedIdentity(answeredBy) }),
        ...(run === undefined ? {} : { run }),
        ...(note === undefined ? {} : { note }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(project === undefined ? {} : { project }),
        ...(inputs === undefined ? {} : { inputs }),
        ...(decision === undefined ? {} : { decision }),
        ...(scope === undefined ? {} : { scope }),
        ...(base === undefined ? {} : { base }),
        ...(change === undefined ? {} : { change }),
        ...(head === undefined ? {} : { head }),
        ...(range === undefined ? {} : { range }),
        ...(text === undefined ? {} : { text }),
        correctionEvidence,
        ...(staleAfterHours === undefined ? {} : { staleAfterHours }),
        ...(lockWaitSeconds === undefined ? {} : { lockWaitSeconds }),
        ...(toolCommand === undefined ? {} : { toolCommand }),
        ...(task === undefined ? {} : { task }),
        ...(file === undefined ? {} : { file }),
        ...(host === undefined ? {} : { host }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(session === undefined ? {} : { session }),
        ...(result === undefined ? {} : { result }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(usageJson === undefined ? {} : { usage: usageJson }),
        ...(selectedBy === undefined ? {} : { selectedBy }),
        ...(isolation === undefined ? {} : { isolation }),
        changedPaths,
        ...(confirmedStopped ? { confirmedStopped } : {}),
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
function pathsFor(state, cwd, executablePath) {
    const project = resolveProjectRoot({ cwd, ...(state.flags.project === undefined ? {} : { project: state.flags.project }) });
    const coreRoot = resolveCoreRoot({ executablePath });
    const sourceRoot = project.sourceRoot ?? project.projectRoot;
    return project.manifestPath === undefined
        ? { cwd, projectRoot: project.projectRoot, sourceRoot, coreRoot }
        : { cwd, projectRoot: project.projectRoot, sourceRoot, coreRoot, manifestPath: project.manifestPath };
}
function defaultHandler(invocation) {
    return createResult({
        command: invocation.command,
        status: "failed",
        diagnostics: [createDiagnostic({ severity: "error", category: "internal", code: "PAVED_COMMAND_HANDLER_MISSING",
                component: "cli.runtime", message: `No executable handler is registered for ${invocation.command}.`,
                remediation: "Install a complete Paved runtime package." })],
    });
}
const DEFAULT_HANDLERS = {
    agent: agentHandler,
    decision: decisionHandler,
    preview: previewHandler,
    workbench: workbenchHandler,
    tool: toolHandler,
    delegation: delegationHandler,
    context: contextHandler,
    task: taskHandler,
    delivery: deliveryHandler,
    doctor: doctorHandler,
    generate: generateHandler,
    gardener: gardenerHandler,
    review: reviewHandler,
    init: initHandler,
    status: statusHandler,
    test: testHandler,
    update: updateHandler,
    verify: verifyHandler,
    intent: stepHandler,
    plan: stepHandler,
    execute: stepHandler,
};
export async function dispatchCli(options = {}) {
    const argv = options.argv ?? [];
    const cwd = options.cwd ?? process.cwd();
    const executablePath = options.executablePath ?? fileURLToPath(import.meta.url);
    let coreRoot;
    try {
        coreRoot = resolveCoreRoot({ executablePath });
    }
    catch (error) {
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
        }
        catch (error) {
            return internal("version", error);
        }
    }
    let result;
    try {
        const paths = pathsFor(parsed.state, cwd, executablePath);
        const handler = options.handlers?.[parsed.state.command] ?? DEFAULT_HANDLERS[parsed.state.command] ?? defaultHandler;
        result = await handler({
            command: parsed.state.command,
            flags: parsed.state.flags,
            selectors: parsed.state.selectors,
            paths,
            rawArgv: argv,
            ...(options.launcherCoreVersion === undefined ? {} : { launcherCoreVersion: options.launcherCoreVersion }),
        });
    }
    catch (error) {
        result = error instanceof CliPathError ? environment(parsed.state.command, error.message) : internal(parsed.state.command, error);
    }
    return withReclaimedLocks(result);
}
/** A stale operation lock reclaimed while the command ran is reported whatever the command did. */
function withReclaimedLocks(result) {
    const warnings = reclaimedLockDiagnostics();
    if (warnings.length === 0)
        return result;
    return { ...result, status: result.status === "success" ? "warning" : result.status, diagnostics: [...result.diagnostics, ...warnings] };
}
