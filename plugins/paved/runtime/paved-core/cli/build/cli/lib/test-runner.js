import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import { planMavenDependencies } from "../../adapters/technology/java/maven-dependencies.js";
import { createDiagnostic } from "../result.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadYaml } from "./documents.js";
import { inspectOverrides } from "./override-safety.js";
import { createRegistry } from "./schemas.js";
import { resolveSafePath } from "./safe-path.js";
import { authorizeTool, buildArgv, captureToolExecution, resolveTool, sanitizeToolOutput, validateImplementation, validateTool, validateToolInputs, validateToolResult, } from "./tools.js";
import { spawnApproved } from "./verification-runner.js";
import { listDecisions } from "./decisions/store.js";
const TEST_RUNTIME_VERSION = "paved-test-runner/0.1.0";
const TEST_PERMISSIONS = ["repository-read", "process-read", "process-control"];
function diagnostic(code, category, message, remediation) {
    return createDiagnostic({
        severity: category === "findings" ? "warning" : "error",
        category,
        code,
        component: "test.runner",
        message,
        ...(remediation === undefined ? {} : { remediation }),
    });
}
function sha(value) {
    return createHash("sha256").update(value).digest("hex");
}
function files(root) {
    if (!existsSync(root))
        return [];
    const output = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
            const full = join(directory, entry.name);
            if (entry.isSymbolicLink())
                throw new Error(`Refusing to follow a symbolic link in Tool content: ${full}`);
            if (entry.isDirectory())
                walk(full);
            else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")))
                output.push(full);
        }
    };
    walk(root);
    return output;
}
function readDocuments(roots, kind, registry) {
    const documents = [];
    for (const root of roots) {
        for (const file of files(root)) {
            const raw = loadYaml(file);
            if (raw.kind !== kind)
                continue;
            const validation = registry.validate(raw);
            if (!validation.valid)
                throw new Error(`${file} is not a valid ${kind} document: ${validation.errors.join("; ")}`);
            documents.push(raw);
        }
    }
    return documents;
}
function manifestAdapters(projectRoot) {
    const path = resolveSafePath(projectRoot, ".paved/manifest.yaml");
    const manifest = loadYaml(path);
    return (manifest.adapters ?? []).map((adapter) => adapter.id).filter((id) => typeof id === "string");
}
function contentRoots(projectRoot, coreRoot) {
    const adapterIds = manifestAdapters(projectRoot);
    const adapters = adapterIds.map((id) => resolveSafePath(coreRoot, join("adapters", id)));
    return {
        tools: [
            resolveSafePath(coreRoot, "core/tools"),
            ...adapters.map((root) => join(root, "tools")),
            resolveSafePath(projectRoot, ".paved/tools"),
        ],
        implementations: [
            resolveSafePath(coreRoot, "core/tool-implementations"),
            ...adapters.map((root) => join(root, "tool-implementations")),
            resolveSafePath(projectRoot, ".paved/tool-implementations"),
        ],
    };
}
function selectedOverride(projectRoot, coreRoot, tool) {
    const overridePath = resolveSafePath(projectRoot, ".paved/overrides/overrides.yaml");
    if (!existsSync(overridePath))
        return undefined;
    const problems = inspectOverrides(projectRoot, coreRoot, manifestAdapters(projectRoot));
    if (problems.some((problem) => problem.severity === "error")) {
        throw new Error(problems.map((problem) => problem.message).join("; "));
    }
    const document = loadYaml(overridePath);
    return (document.tools ?? []).find((entry) => entry.target === tool.id);
}
export function resolveTestingTool(projectRoot, coreRoot) {
    return resolveTestingToolCandidate(projectRoot, coreRoot);
}
function resolveTestingToolCandidate(projectRoot, coreRoot, selectedId) {
    const registry = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]);
    let roots;
    let tools;
    try {
        roots = contentRoots(projectRoot, coreRoot);
        const discovered = readDocuments(roots.tools, "Tool", registry)
            .filter((tool) => tool.capability === "testing-run" && tool.availability === "available");
        const projectTools = discovered.filter((tool) => tool.id.startsWith("project."));
        const adapterTools = discovered.filter((tool) => tool.id.startsWith("adapter-"));
        tools = projectTools.length > 0 ? projectTools
            : adapterTools.length > 0 ? adapterTools
                : discovered.filter((tool) => tool.id.startsWith("core."));
    }
    catch (error) {
        return {
            status: "unavailable",
            code: "PAVED_TEST_CONTENT_INVALID",
            message: error instanceof Error ? error.message : "Testing Tool content is invalid.",
            remediation: "Fix the Tool documents and references before retrying.",
        };
    }
    if (selectedId !== undefined)
        tools = tools.filter((tool) => tool.id === selectedId);
    if (tools.length > 1) {
        if (tools.every((tool) => tool.id.startsWith("project.testing-detected-"))) {
            const members = tools.map((tool) => resolveTestingToolCandidate(projectRoot, coreRoot, tool.id));
            const unavailable = members.find((member) => member.status === "unavailable");
            if (unavailable?.status === "unavailable")
                return unavailable;
            const resolved = members;
            try {
                const maven = resolved.filter((member) => member.implementation.invocation.executable === "mvn")
                    .map((member) => member.implementation.invocation.working_directory ?? ".");
                const plan = planMavenDependencies(projectRoot, maven);
                const rank = new Map(plan.scopes.map((scope, index) => [scope, index]));
                for (const member of resolved) {
                    const binding = member.implementation.invocation;
                    if (binding.executable !== "mvn")
                        continue;
                    const scope = binding.working_directory ?? ".";
                    if (plan.installs.has(scope) && binding.arguments?.[0] !== "install") {
                        return {
                            status: "unavailable", code: "PAVED_TEST_DEPENDENCY_PREPARATION_STALE",
                            message: `Testing Tool for ${scope} must install its artifact before local consumers run.`,
                            remediation: "Review and update the module's testing ToolImplementation before retrying.",
                        };
                    }
                }
                resolved.sort((a, b) => {
                    const aRank = a.implementation.invocation.executable === "mvn" ? rank.get(a.implementation.invocation.working_directory ?? ".") : undefined;
                    const bRank = b.implementation.invocation.executable === "mvn" ? rank.get(b.implementation.invocation.working_directory ?? ".") : undefined;
                    if (aRank !== undefined && bRank !== undefined)
                        return aRank - bRank;
                    if (aRank !== undefined)
                        return -1;
                    if (bRank !== undefined)
                        return 1;
                    return a.tool.id.localeCompare(b.tool.id, "en");
                });
                return { status: "suite", members: resolved };
            }
            catch (error) {
                return {
                    status: "unavailable", code: "PAVED_TEST_MAVEN_DEPENDENCIES_INVALID",
                    message: error instanceof Error ? error.message : "Local Maven dependencies could not be resolved.",
                    remediation: "Fix the local Maven project coordinates and dependency graph before retrying.",
                };
            }
        }
        const candidates = tools.flatMap((tool) => {
            const resolution = resolveTestingToolCandidate(projectRoot, coreRoot, tool.id);
            return resolution.status === "resolved" ? [tool.id] : [];
        }).sort((a, b) => a.localeCompare(b, "en"));
        if (candidates.length === 1)
            return resolveTestingToolCandidate(projectRoot, coreRoot, candidates[0]);
        if (candidates.length > 1) {
            const candidateInputs = candidates.map((id) => `candidate:${id}`);
            const manifestHash = sha(readFileSync(join(projectRoot, ".paved/manifest.yaml")));
            const selected = listDecisions(projectRoot, coreRoot)
                .filter((decision) => decision.handler === "testing.select" && decision.status === "APPLIED")
                .filter((decision) => {
                const recorded = decision.fingerprint.inputs.filter((item) => item.startsWith("candidate:"));
                return JSON.stringify(recorded) === JSON.stringify(candidateInputs)
                    && decision.fingerprint.inputs.includes(`evidence:.paved/manifest.yaml@${manifestHash}`);
            })
                .flatMap((decision) => {
                const option = decision.options.find((item) => item.id === decision.answer);
                return option === undefined ? [] : [option.label];
            }).find((id) => candidates.includes(id));
            if (selected !== undefined)
                return resolveTestingToolCandidate(projectRoot, coreRoot, selected);
            return {
                status: "ambiguous", candidates, code: "PAVED_TEST_TOOL_AMBIGUOUS",
                message: "More than one authorized testing-run Tool is declared.",
                remediation: "Answer the testing Tool selection decision.",
            };
        }
    }
    if (tools.length !== 1) {
        return {
            status: "unavailable",
            code: "PAVED_TEST_TOOL_UNAVAILABLE",
            message: "No authorized testing-run Tool is declared.",
            remediation: "Declare an available project testing Tool or select a technology adapter that provides one.",
        };
    }
    const tool = tools[0];
    const toolProblems = validateTool(tool);
    if (toolProblems.length > 0) {
        return {
            status: "unavailable",
            code: "PAVED_TEST_TOOL_INVALID",
            message: `Testing Tool ${tool.id} is invalid: ${toolProblems.join("; ")}`,
            remediation: "Fix the Tool contract before retrying.",
        };
    }
    let implementations;
    try {
        implementations = readDocuments(roots.implementations, "ToolImplementation", registry).filter((implementation) => implementation.tool === tool.id);
    }
    catch (error) {
        return {
            status: "unavailable",
            code: "PAVED_TEST_CONTENT_INVALID",
            message: error instanceof Error ? error.message : "Testing ToolImplementation content is invalid.",
            remediation: "Fix the ToolImplementation documents before retrying.",
        };
    }
    for (const implementation of implementations) {
        const problems = validateImplementation(implementation, tool);
        if (problems.length > 0) {
            return {
                status: "unavailable",
                code: "PAVED_TEST_IMPLEMENTATION_INVALID",
                message: `${implementation.id} is invalid: ${problems.join("; ")}`,
                remediation: "Fix the ToolImplementation before retrying.",
            };
        }
    }
    let override;
    try {
        override = selectedOverride(projectRoot, coreRoot, tool);
    }
    catch (error) {
        return {
            status: "unavailable",
            code: "PAVED_TEST_OVERRIDE_INVALID",
            message: error instanceof Error ? error.message : "Tool selection override is invalid.",
            remediation: "Review .paved/overrides/overrides.yaml and fix any invalid entries.",
        };
    }
    const resolution = resolveTool(tool.id, [tool], implementations, "local", override);
    if (resolution.status !== "resolved" || resolution.tool === undefined || resolution.implementation === undefined) {
        return {
            status: "unavailable",
            code: "PAVED_TEST_IMPLEMENTATION_UNAVAILABLE",
            message: `Testing Tool ${tool.id} cannot be executed: ${resolution.reason ?? "no implementation resolved"}.`,
            remediation: "Add an available ToolImplementation in the selected adapter or .paved/tool-implementations; select project bindings with a reviewed .paved/overrides/overrides.yaml entry.",
        };
    }
    if (resolution.implementation.invocation.type !== "command") {
        return {
            status: "unavailable",
            code: "PAVED_TEST_SYNTHETIC_BLOCKED",
            message: "Synthetic Tool implementations cannot run outside fixtures.",
            remediation: "Configure an approved command ToolImplementation for real testing.",
        };
    }
    const authorization = authorizeTool(tool, {
        environment: "local",
        permissions: TEST_PERMISSIONS,
        preconditions: Object.fromEntries(tool.preconditions.map((precondition) => [
            precondition.id,
            ["repository", "runtime"].includes(precondition.kind),
        ])),
    }, override);
    if (!authorization.allowed) {
        return {
            status: "unavailable",
            code: "PAVED_TEST_TOOL_UNAUTHORIZED",
            message: `Testing Tool ${tool.id} is not authorized: ${authorization.reasons.join("; ")}.`,
            remediation: "Adjust the Tool contract or approved override so its required permissions, preconditions, and environment are satisfied.",
        };
    }
    return {
        status: "resolved",
        tool: resolution.tool,
        implementation: resolution.implementation,
        ...(override === undefined ? {} : { override }),
    };
}
function currentRevision(projectRoot) {
    const git = (args) => spawnSync("git", args, { cwd: projectRoot, shell: false, encoding: "utf8" });
    const head = git(["rev-parse", "HEAD"]);
    if (head.status !== 0 || !head.stdout.trim())
        return { revision: "unversioned", uncommitted: false };
    const status = git(["status", "--porcelain=v1"]);
    if (status.status !== 0 || !status.stdout.trim())
        return { revision: head.stdout.trim(), uncommitted: false };
    const diff = git(["diff", "HEAD", "--binary"]);
    return {
        revision: head.stdout.trim(),
        uncommitted: true,
        worktreeSha: sha(`${status.stdout}\n${diff.stdout}`),
    };
}
function resultEvidence(args) {
    const createdAt = new Date().toISOString();
    const id = `test-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const logPath = `.paved/generated/evidence/${id}.log`;
    const evidencePath = `.paved/generated/evidence/${id}.yaml`;
    const record = {
        apiVersion: "paved/v1",
        kind: "Evidence",
        id,
        created_at: createdAt,
        producer: { agent: "paved-cli" },
        retention: "local",
        change: {
            summary: `Executed testing Tool ${args.tool.id} via ${args.implementation.id}.`,
            revision: args.revision.revision,
            ...(args.revision.uncommitted ? { uncommitted_changes: true, worktree_sha256: args.revision.worktreeSha } : {}),
        },
        plan: { required: ["unit"], evidence: ["log"] },
        claims: [{
                id: "testing-tool-executed",
                statement: "The configured testing Tool was invoked and its sanitized output was captured.",
                type: "behavior",
                supported_by: [id],
            }],
        checks: [],
        artifacts: [{
                id,
                kind: "log",
                description: `Sanitized output from Tool ${args.tool.id}; execution status ${args.execution.status}.`,
                recorded_by: "paved",
                revision: args.revision.revision,
                created_at: createdAt,
                source: { type: "file", location: logPath, sha256: sha(args.log) },
            }],
        completion: {
            status: "incomplete",
            verification: "unverified",
            decided_by: "paved",
            criteria: [{ statement: "Paved verification was not run by the testing command.", met: false }],
            notes: "A testing Tool result is not a Paved verification result.",
        },
    };
    return { record, path: evidencePath };
}
async function runOneTestingTool(input, selected) {
    const diagnostics = [];
    const schemaRegistry = createRegistry(join(input.coreRoot, "schemas"), ["paved/v1"]);
    const { tool, implementation, override } = selected;
    const validation = validateToolInputs(tool, input.inputs);
    if (validation.problems.length > 0) {
        return { status: "failed", diagnostics: [diagnostic("PAVED_TEST_INPUT_INVALID", "usage", validation.problems.join("; "))] };
    }
    const authorization = authorizeTool(tool, {
        environment: "local",
        permissions: TEST_PERMISSIONS,
        preconditions: Object.fromEntries(tool.preconditions.map((precondition) => [
            precondition.id,
            ["repository", "runtime"].includes(precondition.kind),
        ])),
    }, override);
    if (!authorization.allowed) {
        return { status: "failed", diagnostics: [diagnostic("PAVED_TEST_TOOL_UNAUTHORIZED", "config", authorization.reasons.join("; "))] };
    }
    let command;
    try {
        command = buildArgv(tool, implementation, validation.values);
    }
    catch (error) {
        return { status: "failed", diagnostics: [diagnostic("PAVED_TEST_INPUT_INVALID", "usage", error instanceof Error ? error.message : "Tool inputs are invalid.")] };
    }
    let cwd;
    try {
        const relativeWorkingDirectory = implementation.invocation.working_directory ?? ".";
        cwd = resolveSafePath(input.projectRoot, relativeWorkingDirectory);
        const stat = lstatSync(cwd);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("working directory is not a real directory");
    }
    catch (error) {
        return { status: "failed", diagnostics: [diagnostic("PAVED_TEST_WORKING_DIRECTORY_INVALID", "config", error instanceof Error ? error.message : "Tool working directory is unsafe.")] };
    }
    const revision = currentRevision(input.projectRoot);
    const startedAt = new Date().toISOString();
    const processResult = await spawnApproved({
        executable: command.executable,
        argv: command.argv,
        cwd,
        timeoutSeconds: Math.min(tool.timeout_seconds, override?.timeout_seconds ?? tool.timeout_seconds, implementation.invocation.timeout_seconds ?? tool.timeout_seconds),
    });
    const finishedAt = new Date().toISOString();
    if (processResult.kind === "launch-error") {
        return { status: "failed", diagnostics: [diagnostic("PAVED_TEST_LAUNCH_FAILED", "environment", "The selected testing executable could not be started.", "Install the executable declared by the selected ToolImplementation, then retry.")] };
    }
    let output;
    let outputMalformed = false;
    const rawOutput = processResult.stdout;
    if (processResult.kind === "timeout") {
        output = undefined;
    }
    else if (tool.outputs.format === "json") {
        try {
            output = JSON.parse(rawOutput);
        }
        catch {
            outputMalformed = true;
            diagnostics.push(diagnostic("PAVED_TEST_OUTPUT_MALFORMED", "verification", "The testing Tool did not emit valid JSON; its declared structured output is unavailable."));
        }
    }
    else if (tool.outputs.format === "yaml") {
        try {
            output = parse(rawOutput);
        }
        catch {
            outputMalformed = true;
            diagnostics.push(diagnostic("PAVED_TEST_OUTPUT_MALFORMED", "verification", "The testing Tool did not emit valid YAML; its declared structured output is unavailable."));
        }
    }
    else if (tool.outputs.format === "text") {
        output = rawOutput;
    }
    let outputInvalid = false;
    let outputProblems = [];
    if ((tool.outputs.format === "json" || tool.outputs.format === "yaml") && output !== undefined) {
        outputProblems = validateToolResult(tool, sanitizeToolOutput(output));
        if (outputProblems.length > 0) {
            outputInvalid = true;
            diagnostics.push(diagnostic("PAVED_TEST_OUTPUT_INVALID", "verification", outputProblems.join("; ")));
        }
    }
    const status = processResult.kind === "timeout" ? "timed-out"
        : outputMalformed || outputInvalid ? "failed"
            : processResult.exitCode === 0 ? "succeeded" : "failed";
    const execution = captureToolExecution({
        tool,
        implementation,
        environment: "local",
        revision: revision.revision,
        ...(revision.worktreeSha === undefined ? {} : { worktree_sha256: revision.worktreeSha }),
        runtime_version: TEST_RUNTIME_VERSION,
        recorded_by: "paved",
        started_at: startedAt,
        finished_at: finishedAt,
        status,
        ...(processResult.exitCode === undefined ? {} : { exit_code: processResult.exitCode }),
        ...(processResult.kind === "timeout" ? { error_code: "timeout" }
            : outputMalformed || outputInvalid ? { error_code: "malformed-output" } : {}),
        output,
        inputs: validation.values,
        ...(processResult.truncated ? { warnings: ["Testing Tool output was truncated."] } : {}),
        errors: [
            ...(processResult.stderr.trim() ? [processResult.stderr] : []),
            ...(outputMalformed ? [`The testing Tool did not emit valid ${tool.outputs.format.toUpperCase()} output.`] : []),
            ...outputProblems,
        ],
    });
    const log = [
        `status: ${execution.status}`,
        `exit_code: ${processResult.exitCode ?? "unknown"}`,
        `implementation: ${implementation.id}@${implementation.version}`,
        `input_sha256: ${execution.input_sha256}`,
        `output_sha256: ${execution.output_sha256}`,
        `tool_result_json: ${JSON.stringify(execution)}`,
        "",
        "stdout:",
        sanitizeToolOutput(processResult.stdout),
        "",
        "stderr:",
        sanitizeToolOutput(processResult.stderr),
        "",
        "errors:",
        execution.errors.join("\n"),
    ].join("\n");
    const evidence = resultEvidence({
        tool,
        implementation,
        revision,
        execution,
        log,
    });
    const validationResult = schemaRegistry.validate(evidence.record);
    if (!validationResult.valid) {
        return {
            status: "failed",
            diagnostics: [diagnostic("PAVED_TEST_EVIDENCE_INVALID", "internal", validationResult.errors.join("; "))],
        };
    }
    const evidenceDirectory = resolveSafePath(input.projectRoot, ".paved/generated/evidence");
    mkdirSync(evidenceDirectory, { recursive: true });
    const evidenceId = evidence.record.id;
    const logPath = resolveSafePath(input.projectRoot, `.paved/generated/evidence/${evidenceId}.log`);
    const recordPath = resolveSafePath(input.projectRoot, evidence.path);
    atomicWriteFileSync(logPath, log);
    atomicWriteFileSync(recordPath, stringify(evidence.record));
    return {
        status: processResult.kind === "completed" && processResult.exitCode === 0 && execution.status === "succeeded" ? "success" : "failed",
        diagnostics,
        tool: execution,
        evidence: relative(realpathSync(input.projectRoot), realpathSync(recordPath)).split(sep).join("/"),
    };
}
export async function runTestingTool(input) {
    const selected = resolveTestingTool(input.projectRoot, input.coreRoot);
    if (selected.status === "unavailable" || selected.status === "ambiguous") {
        return { status: "failed", diagnostics: [diagnostic(selected.code, "config", selected.message, selected.remediation)] };
    }
    if (selected.status === "resolved")
        return runOneTestingTool(input, selected);
    const results = [];
    for (const member of selected.members)
        results.push(await runOneTestingTool(input, member));
    const failed = results.find((result) => result.status === "failed");
    const representative = failed ?? results[0];
    return {
        status: failed ? "failed" : "success",
        diagnostics: results.flatMap((result) => result.diagnostics),
        ...(representative?.tool === undefined ? {} : { tool: representative.tool }),
        ...(representative?.evidence === undefined ? {} : { evidence: representative.evidence }),
        tools: results.flatMap((result) => result.tool ? [result.tool] : []),
        evidences: results.flatMap((result) => result.evidence ? [result.evidence] : []),
    };
}
