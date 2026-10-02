import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { createDiagnostic } from "../result.js";
import { loadYaml } from "./documents.js";
import { assessEvidence, evaluateCompletion, loadEvidenceRegistry, } from "./evidence.js";
import { createRegistry } from "./schemas.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { acquireConsumerOperationLock } from "./operation-lock.js";
import { resolveSafePath } from "./safe-path.js";
import { authorizeTool, buildArgv, captureToolExecution, resolveTool, sanitizeToolOutput, sensitiveArgvInputNames, toEvidenceCheck, validateImplementation, validateTool, validateToolInputs, validateToolResult, } from "./tools.js";
const OUTPUT_LIMIT_BYTES = 16 * 1024;
const RUNTIME_VERSION = "paved-cli-verification-runner/0.1.0";
// Process basics plus the variables that select a toolchain. Without them a check runs on
// whatever the launcher finds first (for example the newest JDK), not the one the user chose.
// Credentials and tokens are never forwarded.
export const verificationEnvironmentAllowlist = new Set([
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "JAVA_HOME",
    "MAVEN_HOME",
    "M2_HOME",
    "GRADLE_USER_HOME",
    "CHROME_BIN",
]);
/** The environment a governed check runs in: allowlisted variables and a non-interactive CI mode. */
export function verificationEnvironment(source = process.env) {
    const env = {};
    for (const [name, value] of Object.entries(source)) {
        if (value !== undefined && verificationEnvironmentAllowlist.has(name.toUpperCase()))
            env[name] = value;
    }
    // Test runners that would otherwise watch for changes or prompt exit after one run.
    env.CI = "true";
    return env;
}
let evidenceCounter = 0;
function diagnostic(input) {
    return createDiagnostic({
        severity: input.severity ?? (input.category === "findings" ? "warning" : "error"),
        category: input.category,
        code: input.code,
        component: input.component,
        message: input.message,
        ...(input.remediation === undefined ? {} : { remediation: input.remediation }),
    });
}
function safe(root, path) {
    return resolveSafePath(root, path);
}
function sha(value) {
    return createHash("sha256").update(value).digest("hex");
}
function supportedApiVersions(coreRoot) {
    try {
        const manifest = loadYaml(join(coreRoot, "manifest.yaml"));
        return Array.isArray(manifest.supported_api_versions) && manifest.supported_api_versions.every((item) => typeof item === "string")
            ? manifest.supported_api_versions
            : ["paved/v1"];
    }
    catch {
        return ["paved/v1"];
    }
}
function registry(coreRoot) {
    return createRegistry(join(coreRoot, "schemas"), supportedApiVersions(coreRoot));
}
function validateDocument(schemaRegistry, file, expectedKind, diagnostics) {
    try {
        const document = loadYaml(file);
        const validation = schemaRegistry.validate(document);
        const kind = document !== null && typeof document === "object" ? document.kind : undefined;
        if (!validation.valid || kind !== expectedKind) {
            diagnostics.push(diagnostic({
                code: `PAVED_VERIFY_${expectedKind.toUpperCase()}_INVALID`,
                category: "config",
                component: "verification.config",
                message: `${file} is not a valid ${expectedKind} document.`,
                remediation: validation.errors.join("; ") || `Expected kind ${expectedKind}.`,
            }));
            return undefined;
        }
        return document;
    }
    catch {
        diagnostics.push(diagnostic({
            code: `PAVED_VERIFY_${expectedKind.toUpperCase()}_INVALID`,
            category: "config",
            component: "verification.config",
            message: `${file} cannot be parsed or read.`,
        }));
        return undefined;
    }
}
function yamlFiles(root) {
    if (!existsSync(root))
        return [];
    const files = [];
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            }
            else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
                files.push(full);
            }
        }
    };
    walk(root);
    return files.sort();
}
function findDocument(roots, id, kind, schemaRegistry, diagnostics) {
    const matches = [];
    for (const root of roots) {
        for (const file of yamlFiles(root)) {
            const raw = loadContentDocument(file, kind, diagnostics);
            if (raw === undefined || raw.kind !== kind || raw.id !== id)
                continue;
            const document = validateDocument(schemaRegistry, file, kind, diagnostics);
            if (document !== undefined)
                matches.push(document);
        }
    }
    if (matches.length === 1)
        return matches[0];
    if (matches.length > 1) {
        diagnostics.push(diagnostic({
            code: `PAVED_VERIFY_${kind.toUpperCase()}_AMBIGUOUS`,
            category: "config",
            component: "verification.config",
            message: `${kind} ${id} is declared more than once in selected Paved content roots.`,
        }));
    }
    return undefined;
}
function loadContentDocument(file, kind, diagnostics) {
    try {
        const document = loadYaml(file);
        if (document !== null && typeof document === "object" && !Array.isArray(document)) {
            return document;
        }
    }
    catch {
        // Report malformed content uniformly without exposing parser internals.
    }
    const code = `PAVED_VERIFY_${kind.toUpperCase()}_INVALID`;
    const message = `${file} is not a valid ${kind} document.`;
    if (diagnostics.some((item) => item.code === code && item.message === message))
        return undefined;
    diagnostics.push(diagnostic({
        code,
        category: "config",
        component: "verification.config",
        message,
        remediation: "Fix the YAML syntax or ensure the file contains a mapping document.",
    }));
    return undefined;
}
function findImplementations(roots, toolId, schemaRegistry, diagnostics) {
    const implementations = [];
    for (const root of roots) {
        for (const file of yamlFiles(root)) {
            const raw = loadContentDocument(file, "ToolImplementation", diagnostics);
            if (raw === undefined)
                continue;
            if (raw.kind !== "ToolImplementation" || raw.tool !== toolId)
                continue;
            const document = validateDocument(schemaRegistry, file, "ToolImplementation", diagnostics);
            if (document !== undefined)
                implementations.push(document);
        }
    }
    return implementations;
}
function manifestAdapters(projectRoot) {
    const manifestPath = join(projectRoot, ".paved/manifest.yaml");
    if (!existsSync(manifestPath))
        return [];
    try {
        const manifest = loadYaml(manifestPath);
        return (manifest.adapters ?? []).map((entry) => entry.id).filter((id) => typeof id === "string");
    }
    catch {
        return [];
    }
}
function contentRoots(input) {
    const selectedAdapters = input.adapterSelections?.length
        ? [...input.adapterSelections]
        : manifestAdapters(input.projectRoot);
    const adapterRoots = selectedAdapters.map((id) => safe(input.coreRoot, join("adapters", id)));
    return {
        checks: [
            safe(input.coreRoot, "core/verification/checks"),
            ...adapterRoots.map((root) => join(root, "verification/checks")),
            safe(input.projectRoot, ".paved/verification/checks"),
        ],
        tools: [
            safe(input.coreRoot, "core/tools"),
            ...adapterRoots.map((root) => join(root, "tools")),
            safe(input.projectRoot, ".paved/tools"),
        ],
        implementations: [
            safe(input.coreRoot, "core/tool-implementations"),
            ...adapterRoots.map((root) => join(root, "tool-implementations")),
            safe(input.projectRoot, ".paved/tool-implementations"),
        ],
    };
}
function currentRevision(projectRoot) {
    const git = (args) => spawnSync("git", args, { cwd: projectRoot, shell: false, encoding: "utf8" });
    const revision = git(["rev-parse", "HEAD"]);
    if (revision.status !== 0 || !revision.stdout.trim()) {
        return { revision: "unversioned", uncommitted: false };
    }
    const status = git(["status", "--porcelain=v1"]);
    const uncommitted = status.status === 0 && status.stdout.trim().length > 0;
    if (!uncommitted)
        return { revision: revision.stdout.trim(), uncommitted };
    const diff = git(["diff", "HEAD", "--binary"]);
    const material = `${status.stdout}\n${diff.stdout}`;
    return { revision: revision.stdout.trim(), uncommitted, worktreeSha: sha(material) };
}
function collectChunk(chunks, next, state) {
    if (state.bytes >= OUTPUT_LIMIT_BYTES) {
        state.truncated = true;
        return;
    }
    const remaining = OUTPUT_LIMIT_BYTES - state.bytes;
    chunks.push(next.length <= remaining ? next : next.subarray(0, remaining));
    state.bytes += Math.min(next.length, remaining);
    if (next.length > remaining)
        state.truncated = true;
}
function evidenceCheckId(checkId) {
    const prefix = checkId.toLowerCase().replaceAll(".", "_").replace(/[^a-z0-9_-]/g, "-").slice(0, 220).replace(/[-_]+$/g, "") || "check";
    return `${prefix}-${sha(checkId).slice(0, 12)}-run`;
}
export function signalProcessGroup(child, signal) {
    try {
        if (process.platform !== "win32" && child.pid !== undefined) {
            process.kill(-child.pid, signal);
            return true;
        }
        return child.kill(signal);
    }
    catch (error) {
        // macOS reports EPERM instead of ESRCH when the group only holds an exited, unreaped child.
        if (error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM"))
            return false;
        throw error;
    }
}
export async function spawnApproved(args) {
    const env = verificationEnvironment();
    return new Promise((resolveRun) => {
        const stdout = [];
        const stderr = [];
        const state = { bytes: 0, truncated: false };
        let settled = false;
        let timedOut = false;
        const child = spawn(args.executable, args.argv, {
            cwd: args.cwd,
            env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
        });
        const signalGroup = (signal) => signalProcessGroup(child, signal);
        const signalHandlers = [];
        const forwardSignal = (signal, exitCode) => {
            signalGroup(signal);
            signalGroup("SIGKILL");
            process.exit(exitCode);
        };
        for (const [signal, exitCode] of [
            ...(process.platform === "win32" ? [] : [["SIGHUP", 129]]),
            ["SIGINT", 130],
            ["SIGTERM", 143],
            ...(process.platform === "win32" ? [] : [["SIGQUIT", 131]]),
        ]) {
            const handler = () => forwardSignal(signal, exitCode);
            signalHandlers.push({ signal, handler });
            process.once(signal, handler);
        }
        const finish = (code, kind) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            for (const { signal, handler } of signalHandlers)
                process.removeListener(signal, handler);
            child.stdout.destroy();
            child.stderr.destroy();
            resolveRun({
                kind: kind ?? (timedOut ? "timeout" : "completed"),
                ...(code === null ? {} : { exitCode: code }),
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                truncated: state.truncated,
            });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            if (signalGroup("SIGTERM"))
                setTimeout(() => signalGroup("SIGKILL"), 1_000);
            finish(null);
        }, Math.max(1, args.timeoutSeconds) * 1_000);
        child.stdout.on("data", (chunk) => collectChunk(stdout, chunk, state));
        child.stderr.on("data", (chunk) => collectChunk(stderr, chunk, state));
        child.on("error", () => {
            finish(null, "launch-error");
        });
        child.on("exit", (code) => {
            if (!settled) {
                if (signalGroup("SIGTERM"))
                    setTimeout(() => signalGroup("SIGKILL"), 1_000);
            }
            finish(code);
        });
    });
}
function parseToolOutput(tool, stdout) {
    if (tool.outputs.format === "text")
        return { output: stdout, problems: [] };
    if (tool.outputs.format === "none")
        return { output: undefined, problems: [] };
    if (tool.outputs.format === "json") {
        try {
            return { output: JSON.parse(stdout), problems: [] };
        }
        catch {
            return { output: undefined, problems: [`${tool.id} stdout is not valid JSON for its declared output format`] };
        }
    }
    if (tool.outputs.format === "yaml") {
        try {
            return { output: parseYaml(stdout), problems: [] };
        }
        catch {
            return { output: undefined, problems: [`${tool.id} stdout is not valid YAML for its declared output format`] };
        }
    }
    return { output: stdout, problems: [] };
}
function stderrMessages(stderr, secretValues) {
    if (stderr.trim().length === 0)
        return { warnings: [], errors: [] };
    const sanitized = sanitizeToolOutput(stderr, [...secretValues]);
    return {
        warnings: [`Verification command wrote to stderr:\n${sanitized}`],
        errors: [`Verification command wrote to stderr:\n${sanitized}`],
    };
}
function evidenceId() {
    evidenceCounter += 1;
    return `verify-${new Date().toISOString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${process.pid}-${evidenceCounter}`;
}
function claimTypeFor(checkTypes) {
    if (checkTypes.some((type) => ["unit", "integration", "e2e", "runtime", "database", "deployment", "observability"].includes(type)))
        return "non-regression";
    if (checkTypes.some((type) => ["security", "formal"].includes(type)))
        return "security";
    if (checkTypes.includes("performance"))
        return "performance";
    if (checkTypes.some((type) => ["static-analysis", "architecture", "contract", "configuration"].includes(type)))
        return "structure";
    return "documentation";
}
function buildEvidence(args) {
    const now = new Date().toISOString();
    const change = currentRevision(args.projectRoot);
    const id = evidenceId();
    const checkTypes = [...new Set(args.checks.map((check) => check.type))].sort();
    const checkIds = args.evidenceChecks.map((check) => check.id);
    const met = args.evidenceChecks.length > 0 && args.evidenceChecks.every((check) => check.status === "passed");
    const record = {
        apiVersion: "paved/v1",
        kind: "Evidence",
        id,
        created_at: now,
        producer: { agent: "paved-cli" },
        verification: {
            profile: ".paved/verification/profile.yaml",
            profile_sha256: args.profileSha,
        },
        retention: "local",
        change: {
            summary: "Local Paved verification run.",
            revision: change.revision,
            ...(change.uncommitted ? { uncommitted_changes: true, worktree_sha256: change.worktreeSha ?? sha("unknown-worktree") } : {}),
        },
        plan: {
            required: checkTypes,
            evidence: ["check-result"],
        },
        claims: [
            {
                id: "configured-verification",
                statement: "The configured verification checks were executed by the Paved runner.",
                type: claimTypeFor(checkTypes),
                supported_by: checkIds.length > 0 ? checkIds : ["missing-check-result"],
            },
        ],
        checks: args.evidenceChecks,
        artifacts: args.outputLogs.map((log, index) => ({
            id: `check-output-${index + 1}`,
            kind: "log",
            description: "Sanitized verification command output.",
            recorded_by: "paved",
            revision: change.revision,
            created_at: now,
            source: {
                type: "file",
                location: log.relativePath,
                sha256: sha(log.content),
            },
        })),
        completion: {
            status: "incomplete",
            verification: "unverified",
            decided_by: "paved",
            criteria: [
                {
                    statement: "Every required configured check passed.",
                    met,
                    ...(checkIds.length > 0 ? { supported_by: checkIds } : {}),
                },
            ],
        },
    };
    for (const check of record.checks) {
        check.execution.revision = change.revision;
        if (change.uncommitted) {
            check.execution.worktree_sha256 = change.worktreeSha ?? sha("unknown-worktree");
        }
    }
    const definitions = new Map(args.checks.map((check) => [check.id, check]));
    const registryData = loadEvidenceRegistry(join(args.coreRoot, "core/verification/registry.yaml"));
    const evaluation = evaluateCompletion(record, registryData, args.policy ?? {}, definitions);
    record.completion = {
        status: evaluation.status,
        verification: evaluation.verification,
        decided_by: "paved",
        criteria: [
            {
                statement: "Every required configured check passed.",
                met: evaluation.status === "complete",
                ...(checkIds.length > 0 ? { supported_by: checkIds } : {}),
            },
        ],
        ...(evaluation.blocking.length > 0 ? { notes: evaluation.blocking.join("; ") } : {}),
    };
    return { record, evaluation };
}
async function executeCheck(args) {
    const resolution = resolveTool(args.check.tool, [...args.tools], [...args.implementations], "local");
    if (resolution.status !== "resolved" || resolution.tool === undefined || resolution.implementation === undefined) {
        return {
            diagnostic: diagnostic({
                code: "PAVED_VERIFY_TOOL_UNRESOLVED",
                category: "verification",
                component: "verification.runner",
                message: `Check ${args.check.id} could not resolve its Tool binding.`,
                ...(resolution.reason === undefined ? {} : { remediation: resolution.reason }),
            }),
        };
    }
    if (args.check.preconditions && args.check.preconditions.length > 0) {
        const now = new Date().toISOString();
        const captured = captureToolExecution({
            tool: resolution.tool,
            implementation: resolution.implementation,
            environment: "local",
            revision: args.revision,
            runtime_version: RUNTIME_VERSION,
            recorded_by: "paved",
            started_at: now,
            finished_at: now,
            status: "blocked",
            error_code: "failed-precondition",
            output: "",
            inputs: args.check.inputs ?? {},
            errors: [`precondition ${args.check.preconditions[0].id} is unmet`],
        });
        return { evidenceCheck: toEvidenceCheck(captured, args.check, evidenceCheckId(args.check.id)) };
    }
    const validation = validateToolInputs(resolution.tool, args.check.inputs ?? {});
    if (validation.problems.length > 0) {
        return {
            diagnostic: diagnostic({
                code: "PAVED_VERIFY_INPUT_INVALID",
                category: "config",
                component: "verification.runner",
                message: `Check ${args.check.id} supplies invalid Tool inputs.`,
                remediation: validation.problems.join("; "),
            }),
        };
    }
    const sensitiveInputs = sensitiveArgvInputNames(resolution.tool, resolution.implementation, validation.values);
    if (sensitiveInputs.length > 0) {
        const now = new Date().toISOString();
        const captured = captureToolExecution({
            tool: resolution.tool,
            implementation: resolution.implementation,
            environment: "local",
            revision: args.revision,
            runtime_version: RUNTIME_VERSION,
            recorded_by: "paved",
            started_at: now,
            finished_at: now,
            status: "blocked",
            error_code: "policy-violation",
            output: undefined,
            inputs: validation.values,
            errors: ["Sensitive Tool inputs cannot be passed through command argv by the current ToolImplementation contract."],
        });
        return {
            diagnostic: diagnostic({
                code: "PAVED_VERIFY_SENSITIVE_ARGV_INPUT",
                category: "config",
                component: "verification.runner",
                message: `Check ${args.check.id} would expose a sensitive Tool input through its command binding, so it was blocked before execution.`,
                remediation: "Remove the sensitive input binding or introduce a reviewed ToolImplementation contract with an explicit secret channel.",
            }),
            evidenceCheck: toEvidenceCheck(captured, args.check, evidenceCheckId(args.check.id)),
        };
    }
    const authorization = authorizeTool(resolution.tool, {
        environment: "local",
        permissions: ["repository-read", "process-read", "process-control"],
        preconditions: Object.fromEntries(resolution.tool.preconditions.map((precondition) => [precondition.id, false])),
    });
    if (!authorization.allowed) {
        const now = new Date().toISOString();
        const captured = captureToolExecution({
            tool: resolution.tool,
            implementation: resolution.implementation,
            environment: "local",
            revision: args.revision,
            runtime_version: RUNTIME_VERSION,
            recorded_by: "paved",
            started_at: now,
            finished_at: now,
            status: "blocked",
            error_code: "failed-precondition",
            output: "",
            inputs: validation.values,
            errors: authorization.reasons,
        });
        return {
            diagnostic: diagnostic({
                code: "PAVED_VERIFY_TOOL_UNAUTHORIZED",
                category: "verification",
                component: "verification.runner",
                message: `Check ${args.check.id} was not authorized to run.`,
                remediation: authorization.reasons.join("; "),
            }),
            evidenceCheck: toEvidenceCheck(captured, args.check, evidenceCheckId(args.check.id)),
        };
    }
    const command = buildArgv(resolution.tool, resolution.implementation, validation.values);
    const timeoutSeconds = Math.min(args.check.timeout_seconds ?? resolution.tool.timeout_seconds, resolution.implementation.invocation.timeout_seconds ?? resolution.tool.timeout_seconds, resolution.tool.timeout_seconds);
    const invocation = resolution.implementation.invocation;
    const cwd = invocation.working_directory === undefined
        ? args.projectRoot
        : safe(args.projectRoot, invocation.working_directory);
    const started = new Date().toISOString();
    const execution = await spawnApproved({ executable: command.executable, argv: command.argv, cwd, timeoutSeconds });
    const finished = new Date().toISOString();
    const secretValues = resolution.tool.inputs
        .filter((input) => input.sensitive)
        .map((input) => validation.values[input.name])
        .filter((value) => typeof value === "string");
    const sanitizedOutput = [
        `stdout:\n${sanitizeToolOutput(execution.stdout, secretValues)}`,
        `stderr:\n${sanitizeToolOutput(execution.stderr, secretValues)}`,
    ].join("\n");
    if (execution.kind === "launch-error") {
        return {
            diagnostic: diagnostic({
                code: "PAVED_VERIFY_LAUNCH_FAILED",
                category: "environment",
                component: "verification.runner",
                message: `Check ${args.check.id} could not start its configured executable.`,
                remediation: "Ensure the selected ToolImplementation executable is installed and executable.",
            }),
        };
    }
    const parsed = parseToolOutput(resolution.tool, execution.stdout);
    const malformedOutputProblems = execution.kind === "completed"
        ? [...parsed.problems, ...validateToolResult(resolution.tool, sanitizeToolOutput(parsed.output, secretValues))]
        : [];
    const malformedOutput = malformedOutputProblems.length > 0;
    const stderr = stderrMessages(execution.stderr, secretValues);
    const commandFailed = execution.kind === "completed" && execution.exitCode !== undefined && execution.exitCode !== 0;
    const captured = captureToolExecution({
        tool: resolution.tool,
        implementation: resolution.implementation,
        environment: "local",
        revision: args.revision,
        runtime_version: RUNTIME_VERSION,
        recorded_by: "paved",
        started_at: started,
        finished_at: finished,
        status: execution.kind === "timeout" ? "timed-out" : malformedOutput ? "failed" : "succeeded",
        ...(execution.exitCode === undefined || malformedOutput ? {} : { exit_code: execution.exitCode }),
        ...(execution.kind === "timeout" ? { error_code: "timeout" } : {}),
        ...(malformedOutput ? { error_code: "malformed-output" } : {}),
        output: parsed.output,
        inputs: validation.values,
        warnings: [
            ...(execution.truncated ? ["Verification output was truncated."] : []),
            ...(!commandFailed ? stderr.warnings : []),
        ],
        errors: [
            ...(execution.kind === "timeout" ? ["Verification command timed out."] : []),
            ...malformedOutputProblems,
            ...(commandFailed ? stderr.errors : []),
        ],
    });
    const evidenceCheck = toEvidenceCheck(captured, args.check, evidenceCheckId(args.check.id));
    const outputRef = `.paved/generated/evidence/${evidenceCheck.id}.log`;
    evidenceCheck.output_ref = outputRef;
    return {
        ...(malformedOutput ? {
            diagnostic: diagnostic({
                code: "PAVED_VERIFY_OUTPUT_MALFORMED",
                category: "verification",
                component: "verification.runner",
                message: `Check ${args.check.id} produced malformed Tool output.`,
                remediation: malformedOutputProblems.join("; "),
            }),
        } : {}),
        evidenceCheck,
        log: { relativePath: outputRef, content: sanitizedOutput },
    };
}
function writeValidatedEvidence(args) {
    const schemaRegistry = registry(args.coreRoot);
    const registryData = loadEvidenceRegistry(join(args.coreRoot, "core/verification/registry.yaml"));
    const schemaValidation = schemaRegistry.validate(args.record);
    const assessment = schemaValidation.valid
        ? assessEvidence(args.record, registryData, args.policy ?? {}, args.definitions)
        : [];
    if (!schemaValidation.valid || assessment.length > 0) {
        args.diagnostics.push(diagnostic({
            code: "PAVED_VERIFY_EVIDENCE_INVALID",
            category: "verification",
            component: "verification.evidence",
            message: "Verification evidence could not be validated.",
            remediation: [...schemaValidation.errors, ...assessment].join("; "),
        }));
        return [];
    }
    const evidenceDir = safe(args.projectRoot, ".paved/generated/evidence");
    mkdirSync(evidenceDir, { recursive: true });
    for (const log of args.logs) {
        const target = safe(args.projectRoot, log.relativePath);
        mkdirSync(dirname(target), { recursive: true });
        atomicWriteFileSync(target, log.content);
    }
    const evidenceFile = join(evidenceDir, `${args.record.id}.yaml`);
    atomicWriteFileSync(evidenceFile, stringify(args.record));
    return [evidenceFile];
}
async function runVerificationUnlocked(input) {
    const diagnostics = [];
    const schemaRegistry = registry(input.coreRoot);
    const profilePath = safe(input.projectRoot, ".paved/verification/profile.yaml");
    if (!existsSync(profilePath)) {
        return {
            status: "failed",
            checks: [],
            evidenceFiles: [],
            diagnostics: [
                diagnostic({
                    code: "PAVED_VERIFY_PROFILE_MISSING",
                    category: "verification",
                    component: "verification.profile",
                    message: ".paved/verification/profile.yaml is missing; no verification checks are authorized.",
                    remediation: "Create an explicit verification profile or record the verification gap.",
                }),
            ],
        };
    }
    const profile = validateDocument(schemaRegistry, profilePath, "VerificationProfile", diagnostics);
    if (profile === undefined) {
        return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
    }
    if (profile.checks.length === 0) {
        return {
            status: "failed",
            checks: [],
            evidenceFiles: [],
            diagnostics: [
                diagnostic({
                    code: "PAVED_VERIFY_NO_CHECKS",
                    category: "verification",
                    component: "verification.profile",
                    message: "The verification profile lists no checks, so nothing can be verified.",
                    remediation: "Add explicit Check ids to .paved/verification/profile.yaml or record a gap.",
                }),
            ],
        };
    }
    const roots = contentRoots(input);
    const checks = profile.checks
        .map((id) => {
        const check = findDocument(roots.checks, id, "Check", schemaRegistry, diagnostics);
        if (check === undefined && !diagnostics.some((item) => item.message.includes(id))) {
            diagnostics.push(diagnostic({
                code: "PAVED_VERIFY_CHECK_UNRESOLVED",
                category: "verification",
                component: "verification.config",
                message: `Check ${id} is listed in the verification profile but no selected Check document defines it.`,
            }));
        }
        return check;
    })
        .filter((check) => check !== undefined);
    if (diagnostics.some((item) => item.category === "config")) {
        return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
    }
    if (checks.length !== profile.checks.length) {
        return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
    }
    const tools = [];
    const implementations = [];
    for (const toolId of [...new Set(checks.map((check) => check.tool))]) {
        const tool = findDocument(roots.tools, toolId, "Tool", schemaRegistry, diagnostics);
        if (tool === undefined) {
            diagnostics.push(diagnostic({
                code: "PAVED_VERIFY_TOOL_UNRESOLVED",
                category: "verification",
                component: "verification.config",
                message: `Tool ${toolId} is required by a configured Check but is not available in selected Paved content roots.`,
            }));
            continue;
        }
        const toolProblems = validateTool(tool);
        if (toolProblems.length > 0) {
            diagnostics.push(diagnostic({
                code: "PAVED_VERIFY_TOOL_INVALID",
                category: "config",
                component: "verification.config",
                message: `Tool ${toolId} is invalid.`,
                remediation: toolProblems.join("; "),
            }));
        }
        tools.push(tool);
        const candidates = findImplementations(roots.implementations, toolId, schemaRegistry, diagnostics);
        for (const implementation of candidates) {
            const problems = validateImplementation(implementation, tool);
            if (problems.length > 0) {
                diagnostics.push(diagnostic({
                    code: "PAVED_VERIFY_IMPLEMENTATION_INVALID",
                    category: "config",
                    component: "verification.config",
                    message: `ToolImplementation ${implementation.id} is invalid for Tool ${toolId}.`,
                    remediation: problems.join("; "),
                }));
            }
        }
        implementations.push(...candidates);
    }
    if (diagnostics.some((item) => item.category === "config")) {
        return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
    }
    if (diagnostics.some((item) => item.code === "PAVED_VERIFY_TOOL_UNRESOLVED")) {
        return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
    }
    const revision = currentRevision(input.projectRoot).revision;
    const evidenceChecks = [];
    const logs = [];
    for (const check of checks) {
        const result = await executeCheck({ check, tools, implementations, projectRoot: input.projectRoot, revision });
        if (result.diagnostic)
            diagnostics.push(result.diagnostic);
        if (result.evidenceCheck)
            evidenceChecks.push(result.evidenceCheck);
        if (result.log)
            logs.push(result.log);
    }
    const profileSha = sha(readFileSync(profilePath));
    const built = buildEvidence({
        projectRoot: input.projectRoot,
        coreRoot: input.coreRoot,
        profilePath,
        profileSha,
        ...(profile.policy === undefined ? {} : { policy: profile.policy }),
        checks,
        evidenceChecks,
        outputLogs: logs,
    });
    const definitions = new Map(checks.map((check) => [check.id, check]));
    const evidenceFiles = writeValidatedEvidence({
        projectRoot: input.projectRoot,
        coreRoot: input.coreRoot,
        record: built.record,
        logs,
        definitions,
        ...(profile.policy === undefined ? {} : { policy: profile.policy }),
        diagnostics,
    });
    const blocking = built.evaluation.status !== "complete" || built.evaluation.verification !== "verified";
    if (blocking) {
        diagnostics.push(diagnostic({
            code: "PAVED_VERIFY_INCOMPLETE",
            category: "verification",
            component: "verification.evidence",
            message: "Configured verification did not complete successfully.",
            remediation: [...built.evaluation.blocking, ...built.evaluation.warnings].join("; "),
        }));
    }
    return {
        status: diagnostics.some((item) => item.category !== "findings") ? "failed" : "success",
        diagnostics,
        evidenceFiles,
        evidence: built.record,
        evaluation: built.evaluation,
        checks: evidenceChecks.map((check) => ({ id: check.check, status: check.status, type: check.type })),
    };
}
export async function runVerification(input) {
    const release = acquireConsumerOperationLock(input.projectRoot, "verify");
    try {
        return await runVerificationUnlocked(input);
    }
    finally {
        release();
    }
}
