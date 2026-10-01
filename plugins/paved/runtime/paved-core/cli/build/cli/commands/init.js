import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { loadYaml } from "../lib/documents.js";
import { initializeConsumer, isIgnoredSourceEntry, planConsumerInitialization, runGenerators } from "../lib/generator-runtime.js";
import { createRegistry } from "../lib/schemas.js";
import { inspectConsumer } from "../lib/consumer-state.js";
import { runDecisionGate } from "../lib/decisions/gate.js";
import { listDecisions } from "../lib/decisions/store.js";
import { verificationProvider } from "../lib/decisions/providers/verification.js";
import { verificationHandler } from "../lib/decisions/handlers/verification.js";
import { rulesProvider } from "../lib/decisions/providers/rules.js";
import { rulesHandler } from "../lib/decisions/handlers/rules.js";
import { capabilityProvider, capabilityHandler } from "../lib/decisions/providers/capability.js";
import { testingAdoptProvider } from "../lib/decisions/providers/testing.js";
import { testingAdoptHandler } from "../lib/decisions/handlers/testing.js";
import { ensureAgentsBlock } from "../lib/agents-block.js";
import { createDiagnostic, createResult } from "../result.js";
import { diagnosticsForRun, generateData } from "./generate.js";
function statusFor(diagnostics) {
    if (diagnostics.some((diagnostic) => diagnostic.category !== "findings"))
        return "failed";
    return diagnostics.length > 0 ? "warning" : "success";
}
function validateExistingState(projectRoot, coreRoot) {
    const diagnostics = [];
    const registry = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]);
    const checks = [
        { path: join(projectRoot, ".paved/manifest.yaml"), code: "PAVED_MANIFEST_INVALID", component: "consumer.manifest" },
        { path: join(projectRoot, ".paved/paved.lock"), code: "PAVED_LOCK_INVALID", component: "consumer.lock" },
    ];
    for (const check of checks) {
        if (!existsSync(check.path))
            continue;
        try {
            const document = loadYaml(check.path);
            const validation = registry.validate(document);
            if (!validation.valid) {
                diagnostics.push(createDiagnostic({
                    severity: "error",
                    category: "config",
                    code: check.code,
                    component: check.component,
                    message: `${check.path} is invalid: ${validation.errors.join("; ")}`,
                    remediation: "Fix the existing Paved state before running init.",
                }));
            }
        }
        catch {
            diagnostics.push(createDiagnostic({
                severity: "error",
                category: "config",
                code: check.code,
                component: check.component,
                message: `${check.path} cannot be parsed or read.`,
                remediation: "Fix the YAML syntax or file permissions before running init.",
            }));
        }
    }
    return diagnostics;
}
function adapterDiagnostics(diagnostics) {
    return diagnostics.map((diagnostic) => createDiagnostic({
        severity: "warning",
        category: "findings",
        code: `PAVED_ADAPTER_${diagnostic.code.toUpperCase().replace(/-/g, "_")}`,
        component: "consumer.adapters",
        message: diagnostic.message,
    }));
}
function usage(message) {
    return createResult({
        command: "init",
        status: "failed",
        diagnostics: [
            createDiagnostic({
                severity: "error",
                category: "usage",
                code: "PAVED_CLI_USAGE",
                component: "cli.init",
                message,
                remediation: "Run paved init without --adapter to initialize from detected repository evidence.",
            }),
        ],
    });
}
export function copyProjectForInitDryRun(projectRoot, destination) {
    cpSync(projectRoot, destination, {
        recursive: true,
        filter: (source) => source === projectRoot || !isIgnoredSourceEntry(basename(source)),
    });
    copyGitRevisionForInitDryRun(projectRoot, destination);
}
function copyGitRevisionForInitDryRun(projectRoot, destination) {
    if (!existsSync(join(projectRoot, ".git")))
        return;
    const gitDir = join(destination, ".git");
    mkdirSync(join(gitDir, "objects"), { recursive: true });
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    const objectFormatResult = spawnSync("git", ["rev-parse", "--show-object-format"], {
        cwd: projectRoot,
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
    });
    const objectFormat = objectFormatResult.status === 0 && objectFormatResult.stdout.trim() === "sha256" ? "sha256" : "sha1";
    const formatVersion = objectFormat === "sha256" ? 1 : 0;
    const extensions = objectFormat === "sha256" ? "\n[extensions]\n\tobjectformat = sha256\n" : "";
    writeFileSync(join(gitDir, "config"), `[core]\n\trepositoryformatversion = ${formatVersion}\n\tfilemode = true\n\tbare = false\n${extensions}`);
    const revision = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: projectRoot,
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
    });
    if (revision.status === 0 && revision.stdout.trim().length > 0) {
        writeFileSync(join(gitDir, "HEAD"), `${revision.stdout.trim()}\n`);
    }
    else {
        writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/paved-dry-run-unborn\n");
    }
}
export function initDryRunScratchPrefix(tempRoot = tmpdir()) {
    return join(tempRoot, "paved-init-dry-run-");
}
export function createInitDryRunWorkspace(tempRoot = tmpdir()) {
    return mkdtempSync(initDryRunScratchPrefix(tempRoot));
}
// The manifest requires a lowercase slug; any directory name maps onto one.
export function projectNameFor(projectRoot) {
    return basename(projectRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
function planDryRunGeneration(invocation, projectName) {
    const workspace = createInitDryRunWorkspace();
    const copy = join(workspace, "consumer");
    try {
        copyProjectForInitDryRun(invocation.paths.projectRoot, copy);
        initializeConsumer(invocation.paths.coreRoot, copy, projectName);
        return runGenerators(invocation.paths.coreRoot, copy, { dryRun: true });
    }
    finally {
        rmSync(workspace, { recursive: true, force: true });
    }
}
export function initHandler(invocation) {
    const pavedDir = join(invocation.paths.projectRoot, ".paved");
    const manifestPath = join(pavedDir, "manifest.yaml");
    const lockPath = join(pavedDir, "paved.lock");
    const existingDiagnostics = validateExistingState(invocation.paths.projectRoot, invocation.paths.coreRoot);
    if (existingDiagnostics.length > 0) {
        return createResult({
            command: "init",
            status: "failed",
            data: { initialized: existsSync(pavedDir), dryRun: invocation.flags.dryRun },
            diagnostics: existingDiagnostics,
        });
    }
    const bootstrapOnly = existsSync(pavedDir)
        && !lstatSync(pavedDir).isSymbolicLink()
        && readdirSync(pavedDir).every((entry) => entry === "runtime")
        && existsSync(join(pavedDir, "runtime", "selection.json"));
    const resumingDecision = existsSync(manifestPath) && existsSync(lockPath)
        && listDecisions(invocation.paths.projectRoot, invocation.paths.coreRoot)
            .some((decision) => decision.command === "init"
            && ["PENDING", "ASKED", "ANSWERED"].includes(decision.status));
    if (!resumingDecision && (existsSync(manifestPath) || existsSync(lockPath) || (existsSync(pavedDir) && !bootstrapOnly))) {
        return createResult({
            command: "init",
            status: "failed",
            data: { initialized: true, dryRun: invocation.flags.dryRun },
            diagnostics: [
                createDiagnostic({
                    severity: "error",
                    category: "config",
                    code: "PAVED_INIT_ALREADY_INITIALIZED",
                    component: "cli.init",
                    message: "This project already has Paved state; init will not reset or update it.",
                    remediation: "Run paved status to inspect the current state or use a future safe update command.",
                }),
            ],
        });
    }
    if (invocation.flags.adapters.length > 0) {
        return usage("init detects adapters from repository evidence; --adapter is not supported for this command.");
    }
    const projectName = projectNameFor(invocation.paths.projectRoot);
    const plan = planConsumerInitialization(invocation.paths.coreRoot, invocation.paths.projectRoot, projectName);
    // Generation reports capability resolution itself; without it, the plan is the only report.
    const planningDiagnostics = adapterDiagnostics(invocation.flags.noGenerate ? [...plan.adapterDiagnostics, ...plan.capabilityDiagnostics] : plan.adapterDiagnostics);
    if (invocation.flags.dryRun) {
        const generation = invocation.flags.noGenerate ? undefined : planDryRunGeneration(invocation, projectName);
        const diagnostics = generation === undefined ? planningDiagnostics : [...planningDiagnostics, ...diagnosticsForRun(generation, true)];
        const generatedPaths = generation === undefined ? [] : generation.executions.flatMap((execution) => [...execution.outputs, ...execution.proposals]);
        return createResult({
            command: "init",
            status: statusFor(diagnostics),
            data: {
                initialized: false,
                dryRun: true,
                projectName,
                selectedAdapters: plan.selectedAdapters,
                resolvedAdapters: plan.resolvedAdapters,
                capabilityProviders: plan.capabilityProviders,
                plannedWrites: [...plan.plannedWrites, ...generatedPaths, ...(generation === undefined ? [] : [".paved/generated/state/last-run.json"])],
                generate: !invocation.flags.noGenerate,
                ...(generation === undefined ? {} : { generation: generateData(generation, true) }),
            },
            diagnostics,
        });
    }
    initializeConsumer(invocation.paths.coreRoot, invocation.paths.projectRoot, projectName);
    const outcome = runDecisionGate({
        context: {
            projectRoot: invocation.paths.projectRoot,
            coreRoot: invocation.paths.coreRoot,
            command: "init",
            answers: invocation.flags.answers,
            ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
        },
        providers: [verificationProvider, testingAdoptProvider, rulesProvider, capabilityProvider],
        handlers: new Map([
            ["verification.adopt", verificationHandler],
            ["testing.adopt", testingAdoptHandler],
            ["rules.adopt", rulesHandler],
            ["capability.select", capabilityHandler],
        ]),
        persist: true,
    });
    if (outcome.applied.some((decision) => decision.handler === "capability.select")) {
        initializeConsumer(invocation.paths.coreRoot, invocation.paths.projectRoot, projectName);
    }
    const generation = invocation.flags.noGenerate
        ? undefined
        : runGenerators(invocation.paths.coreRoot, invocation.paths.projectRoot);
    const agents = ensureAgentsBlock(invocation.paths.coreRoot, invocation.paths.projectRoot);
    const diagnostics = [
        ...planningDiagnostics,
        ...(generation === undefined ? [] : diagnosticsForRun(generation, false)),
        ...(agents.status === "invalid" ? [createDiagnostic({
                severity: "warning", category: "findings", code: "PAVED_AGENTS_BLOCK_INVALID",
                component: "cli.init", message: agents.reason,
                remediation: "Remove the stray Paved marker from AGENTS.md, then run paved init again.",
            })] : []),
    ];
    diagnostics.push(...outcome.problems.map((message) => createDiagnostic({
        severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID",
        component: "cli.init", message,
        remediation: "Answer with one of the offered option ids.",
    })));
    const lifecycleState = inspectConsumer({ projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot }).lifecycleState;
    const data = {
        initialized: true, dryRun: false, projectName,
        selectedAdapters: plan.selectedAdapters, resolvedAdapters: plan.resolvedAdapters,
        capabilityProviders: plan.capabilityProviders, generated: generation !== undefined, lifecycleState,
        agentsBlock: agents.status,
        ...(generation === undefined ? {} : { generation: generateData(generation, false) }),
    };
    if (outcome.status === "awaiting-input" && statusFor(diagnostics) !== "failed") {
        return createResult({
            command: "init", status: "awaiting_input", data,
            decisions: outcome.projections,
            diagnostics: diagnostics.filter((item) => item.category === "findings"),
        });
    }
    return createResult({
        command: "init",
        status: statusFor(diagnostics),
        data,
        decisions: outcome.projections,
        diagnostics,
    });
}
