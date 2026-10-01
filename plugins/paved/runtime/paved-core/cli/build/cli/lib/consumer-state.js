import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { createDiagnostic } from "../result.js";
import { capabilityEvidence, capabilityLockEntries, capabilityProviders as providerReport, resolveCapabilities, detectAdapters, loadAdapters, resolveAdapters } from "./adapters.js";
import { loadYaml, loadMarkdown } from "./documents.js";
import { discoverSources, relevantEvidenceFor, sourcesFor } from "./generator-runtime.js";
import { hashLocalCore, hashLocalTree } from "./local-core.js";
import { inspectOverrides } from "./override-safety.js";
import { assessProvenance } from "./provenance.js";
import { createRegistry } from "./schemas.js";
import { compatible } from "./tools.js";
import { answeredProviders } from "./decisions/capability-answers.js";
import { DecisionStoreError, listDecisions } from "./decisions/store.js";
import { readActiveRuntimeSelection, readRuntimeSelection } from "./runtime-lock.js";
import { planDocumentMigrations } from "./document-migrations.js";
function lifecycleState(input) {
    if (!input.hasManifest)
        return "UNINITIALIZED";
    if (!input.manifestValid || input.diagnostics.some((item) => item.code === "PAVED_CORE_MANIFEST_INVALID" || item.code === "PAVED_GENERATED_PROVENANCE_INVALID" ||
        item.code === "PAVED_VERIFICATION_PROFILE_INVALID"))
        return "BROKEN";
    if (input.diagnostics.some((item) => item.code === "PAVED_MANIFEST_CORE_INCOMPATIBLE" ||
        item.code === "PAVED_LOCK_CORE_VERSION_MISMATCH" || item.code === "PAVED_ADAPTER_INCOMPATIBLE" ||
        item.code === "PAVED_LOCK_ADAPTER_VERSION_MISMATCH"))
        return "INCOMPATIBLE";
    if (input.diagnostics.some((item) => item.code === "PAVED_GENERATED_SOURCE_STALE" ||
        item.code === "PAVED_GENERATOR_INPUTS_STALE" || item.code === "PAVED_GENERATOR_SOURCE_SET_STALE" ||
        item.code === "PAVED_GENERATED_OUTPUT_MISSING" ||
        item.code === "PAVED_LOCK_CORE_DIGEST_MISMATCH" || item.code === "PAVED_LOCK_ADAPTER_DIGEST_MISMATCH" ||
        item.code === "PAVED_LOCK_GENERATOR_DIGEST_MISMATCH" || item.code === "PAVED_LOCK_GENERATOR_VERSION_MISMATCH" ||
        item.code === "PAVED_LOCK_CAPABILITIES_STALE"))
        return "STALE";
    if (input.lockHealth !== "healthy")
        return "INITIALIZED";
    if (!input.generated)
        return "RESOLVED";
    if (input.profile !== "present")
        return "GENERATED";
    if (input.diagnostics.some((item) => item.category !== "findings" || item.code === "PAVED_GENERATOR_PROPOSALS_PENDING"))
        return "VALIDATED";
    return "READY";
}
function impactedGenerators(contracts, changedIds, changedAdapterIds, projectRoot) {
    const affected = new Set(changedIds);
    if (changedAdapterIds.length > 0) {
        const runPath = join(projectRoot, ".paved/generated/state/last-run.json");
        let used = new Map();
        if (existsSync(runPath)) {
            try {
                const run = JSON.parse(readFileSync(runPath, "utf8"));
                used = new Map((run.executions ?? []).filter((entry) => typeof entry.generator === "string").map((entry) => [
                    entry.generator,
                    new Set((entry.sources ?? []).flatMap((source) => [source.adapter, ...(source.adapterEvidence ?? []).map((e) => e.adapter)].filter((id) => typeof id === "string"))),
                ]));
            }
            catch { /* Invalid run state is handled by inspection; assume adapter inputs need regeneration. */ }
        }
        for (const contract of contracts) {
            if (!contract.inputs?.some((entry) => entry.kind === "adapter"))
                continue;
            const previous = used.get(contract.id);
            if (!previous || changedAdapterIds.some((id) => previous.has(id)))
                affected.add(contract.id);
        }
    }
    let expanded = true;
    while (expanded) {
        expanded = false;
        for (const contract of contracts) {
            if (!affected.has(contract.id) && contract.depends_on?.some((id) => affected.has(id)) &&
                contract.outputs?.some((output) => existsSync(safe(projectRoot, output.path)))) {
                affected.add(contract.id);
                expanded = true;
            }
        }
    }
    return [...affected].sort();
}
function diagnostic(input) {
    return createDiagnostic({
        category: input.category ?? "config",
        severity: input.severity ?? (input.category === "findings" ? "warning" : "error"),
        code: input.code,
        component: input.component,
        message: input.message,
        ...(input.remediation === undefined ? {} : { remediation: input.remediation }),
    });
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function sha(value) {
    return createHash("sha256").update(value).digest("hex");
}
function safe(root, path) {
    const full = resolve(root, path);
    const resolvedRoot = resolve(root);
    if (full !== resolvedRoot && !full.startsWith(resolvedRoot + sep)) {
        throw new Error(`Path escapes root: ${path}`);
    }
    return full;
}
function hashFile(path) {
    return sha(readFileSync(path));
}
function readValidated(registry, path, code, component, diagnostics) {
    try {
        const document = loadYaml(path);
        const validation = registry.validate(document);
        if (!validation.valid) {
            diagnostics.push(diagnostic({
                code,
                component,
                message: `${relative(dirname(dirname(path)), path)} is invalid: ${validation.errors.join("; ")}`,
                remediation: "Fix the document so it matches the current Paved schema.",
            }));
            return undefined;
        }
        return document;
    }
    catch (error) {
        diagnostics.push(diagnostic({
            code,
            component,
            message: `${relative(dirname(dirname(path)), path)} cannot be parsed or read.`,
            remediation: "Fix the YAML syntax or file permissions.",
        }));
        return undefined;
    }
}
function loadCoreManifest(coreRoot, registry, diagnostics) {
    return readValidated(registry, join(coreRoot, "manifest.yaml"), "PAVED_CORE_MANIFEST_INVALID", "core.manifest", diagnostics);
}
function missingRequiredLayout(projectRoot, layout) {
    return layout
        .filter((entry) => entry.required)
        .filter((entry) => !existsSync(safe(projectRoot, entry.path)))
        .map((entry) => diagnostic({
        code: "PAVED_CONSUMER_REQUIRED_PATH_MISSING",
        component: "consumer.layout",
        message: `Required Paved path is missing: ${entry.path}.`,
        remediation: `Create ${entry.path} or run paved init when initialization is implemented.`,
    }));
}
function readLock(registry, projectRoot, diagnostics) {
    const lockPath = join(projectRoot, ".paved/paved.lock");
    if (!existsSync(lockPath)) {
        diagnostics.push(diagnostic({
            code: "PAVED_LOCK_MISSING",
            component: "consumer.lock",
            category: "findings",
            message: ".paved/paved.lock is missing; exact local Core and adapter digests are not pinned.",
            remediation: "Run paved init or paved update when write-capable commands are available.",
        }));
        return { health: "missing" };
    }
    const before = diagnostics.length;
    const lock = readValidated(registry, lockPath, "PAVED_LOCK_INVALID", "consumer.lock", diagnostics);
    return lock === undefined || diagnostics.length > before ? { health: "invalid" } : { lock, health: "healthy" };
}
function compareCoreLock(lock, core, coreRoot, diagnostics) {
    if (!lock?.core || !core)
        return undefined;
    let matches = true;
    if (lock.core.version !== core.version) {
        matches = false;
        diagnostics.push(diagnostic({
            code: "PAVED_LOCK_CORE_VERSION_MISMATCH",
            component: "consumer.lock",
            message: `Lock pins Core ${lock.core.version}, but the local Core is ${core.version}.`,
            remediation: "Use the Core version recorded in the lock or run a safe local update.",
        }));
    }
    if (lock.core.source === "local-core") {
        const localDigest = hashLocalCore(coreRoot);
        if (lock.core.sha256 !== localDigest) {
            matches = false;
            diagnostics.push(diagnostic({
                code: "PAVED_LOCK_CORE_DIGEST_MISMATCH",
                component: "consumer.lock",
                message: "The locked Core digest does not match the locally available Core content.",
                remediation: "Review the local Core changes, then refresh the lock with a safe update.",
            }));
        }
    }
    if (lock.core.source !== "local-core") {
        matches = false;
        diagnostics.push(diagnostic({ code: "PAVED_LOCK_SOURCE_UNAVAILABLE", component: "consumer.lock", category: "resolution",
            message: `Locked Core source ${lock.core.source} cannot be verified by the local resolver.`,
            remediation: "Use locally resolved Paved inputs before generating or updating." }));
    }
    return matches;
}
function compareAdapterLocks(lock, coreRoot, resolved, diagnostics) {
    if (!lock)
        return;
    const lockedById = new Map((lock.adapters ?? []).filter((entry) => typeof entry.id === "string").map((entry) => [entry.id, entry]));
    const resolvedIds = new Set(resolved.map((item) => item.adapter.id));
    for (const locked of lock.adapters ?? []) {
        if (locked.id && !resolvedIds.has(locked.id))
            diagnostics.push(diagnostic({ code: "PAVED_LOCK_ADAPTER_EXTRA",
                component: "consumer.lock", message: `Lock includes unselected adapter ${locked.id}.`, remediation: "Refresh the lock after reviewing manifest selections." }));
        if (locked.source !== "local-core")
            diagnostics.push(diagnostic({ code: "PAVED_LOCK_SOURCE_UNAVAILABLE", component: "consumer.lock", category: "resolution",
                message: `Locked adapter ${locked.id ?? "unknown"} has a source the local resolver cannot verify.` }));
    }
    for (const detection of resolved) {
        const locked = lockedById.get(detection.adapter.id);
        if (!locked) {
            diagnostics.push(diagnostic({
                code: "PAVED_LOCK_ADAPTER_MISSING",
                component: "consumer.lock",
                message: `Resolved adapter ${detection.adapter.id} is missing from the lock.`,
                remediation: "Refresh the lock with a safe local update.",
            }));
            continue;
        }
        if (locked.version !== detection.adapter.version) {
            diagnostics.push(diagnostic({
                code: "PAVED_LOCK_ADAPTER_VERSION_MISMATCH",
                component: "consumer.lock",
                message: `Lock pins ${detection.adapter.id} ${locked.version}, but local adapter version is ${detection.adapter.version}.`,
                remediation: "Use the locked adapter version or refresh the lock with a safe local update.",
            }));
        }
        if (locked.source === "local-core") {
            const localDigest = hashLocalTree(coreRoot, [`adapters/${detection.adapter.id}`]);
            if (locked.sha256 !== localDigest) {
                diagnostics.push(diagnostic({
                    code: "PAVED_LOCK_ADAPTER_DIGEST_MISMATCH",
                    component: "consumer.lock",
                    message: `The locked digest for adapter ${detection.adapter.id} does not match the locally available adapter content.`,
                    remediation: "Review the adapter change, then refresh the lock with a safe local update.",
                }));
            }
        }
    }
}
function discoverGenerators(coreRoot, registry, diagnostics) {
    const root = join(coreRoot, "generators");
    const contracts = [];
    if (!existsSync(root))
        return contracts;
    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== "runtime")
                    walk(full);
                continue;
            }
            if (entry.name !== "generator.yaml")
                continue;
            const before = diagnostics.length;
            const contract = readValidated(registry, full, "PAVED_GENERATOR_CONTRACT_INVALID", "core.generators", diagnostics);
            if (contract && diagnostics.length === before)
                contracts.push(contract);
        }
    }
    walk(root);
    return contracts.sort((a, b) => a.id.localeCompare(b.id, "en"));
}
function compareGeneratorLocks(lock, coreRoot, generators, diagnostics) {
    if (!lock)
        return;
    const localById = new Map(generators.map((generator) => [generator.id, generator]));
    const lockedIds = new Set((lock.generators ?? []).map((entry) => entry.id));
    for (const generator of generators)
        if (!lockedIds.has(generator.id))
            diagnostics.push(diagnostic({
                code: "PAVED_LOCK_GENERATOR_MISSING", component: "consumer.lock", message: `Generator ${generator.id} is missing from the lock.`,
                remediation: "Refresh the lock before generating context."
            }));
    for (const locked of lock.generators ?? []) {
        if (typeof locked.id !== "string")
            continue;
        const local = localById.get(locked.id);
        if (!local) {
            diagnostics.push(diagnostic({
                code: "PAVED_LOCK_GENERATOR_UNAVAILABLE",
                component: "consumer.lock",
                message: `Locked generator ${locked.id} is not available in the local Core.`,
                remediation: "Use the locked Core distribution or refresh the lock with a safe local update.",
            }));
            continue;
        }
        if (locked.version !== local.version) {
            diagnostics.push(diagnostic({
                code: "PAVED_LOCK_GENERATOR_VERSION_MISMATCH",
                component: "consumer.lock",
                message: `Lock pins generator ${locked.id} ${locked.version}, but local version is ${local.version}.`,
                remediation: "Use the locked generator version or refresh the lock with a safe local update.",
            }));
        }
        if (locked.source === "local-core") {
            const localDigest = hashLocalTree(coreRoot, [`generators/${locked.id}`]);
            if (locked.sha256 !== localDigest) {
                diagnostics.push(diagnostic({
                    code: "PAVED_LOCK_GENERATOR_DIGEST_MISMATCH",
                    component: "consumer.lock",
                    message: `The locked digest for generator ${locked.id} does not match local generator content.`,
                    remediation: "Review the generator change, then refresh the lock with a safe local update.",
                }));
            }
        }
        else
            diagnostics.push(diagnostic({ code: "PAVED_LOCK_SOURCE_UNAVAILABLE", component: "consumer.lock", category: "resolution",
                message: `Locked generator ${locked.id} has a source the local resolver cannot verify.` }));
    }
}
function mapAdapterDiagnostic(code) {
    if (code === "missing-adapter")
        return { code: "PAVED_ADAPTER_UNAVAILABLE", category: "resolution" };
    if (code === "undetected")
        return { code: "PAVED_ADAPTER_UNDETECTED", category: "resolution" };
    if (code === "ambiguous-provider")
        return { code: "PAVED_CAPABILITY_AMBIGUOUS", category: "resolution" };
    if (code === "missing-provider")
        return { code: "PAVED_CAPABILITY_UNAVAILABLE", category: "resolution" };
    if (code === "invalid-selection")
        return { code: "PAVED_CAPABILITY_PROVIDER_INVALID", category: "resolution" };
    return { code: `PAVED_ADAPTER_${code.toUpperCase().replace(/-/g, "_")}`, category: "resolution" };
}
function verificationProfile(registry, projectRoot, diagnostics) {
    const profilePath = join(projectRoot, ".paved/verification/profile.yaml");
    if (!existsSync(profilePath)) {
        diagnostics.push(diagnostic({
            code: "PAVED_VERIFICATION_PROFILE_MISSING",
            component: "consumer.verification",
            category: "findings",
            message: "No verification profile is configured; no checks are authorized implicitly.",
            remediation: "Create .paved/verification/profile.yaml with the checks this project explicitly approves.",
        }));
        return "missing";
    }
    const before = diagnostics.length;
    readValidated(registry, profilePath, "PAVED_VERIFICATION_PROFILE_INVALID", "consumer.verification", diagnostics);
    return diagnostics.length === before ? "present" : "invalid";
}
function inspectLastRun(projectRoot, coreRoot, evidence, diagnostics) {
    const path = join(projectRoot, ".paved/generated/state/last-run.json");
    const proposalRoot = join(projectRoot, ".paved/generated/proposals");
    const proposalsOnDisk = [];
    walkFiles(proposalRoot, (full) => {
        if (!full.endsWith(".paved.yaml"))
            proposalsOnDisk.push(relative(projectRoot, full).split(sep).join("/"));
    });
    proposalsOnDisk.sort();
    if (!existsSync(path)) {
        if (proposalsOnDisk.length === 0)
            return undefined;
        diagnostics.push(diagnostic({
            code: "PAVED_GENERATOR_PROPOSALS_PENDING",
            component: "consumer.generated",
            category: "findings",
            message: `${proposalsOnDisk.length} generated proposal(s) are pending review.`,
            remediation: "Review the proposal files and either adopt or discard them.",
        }));
        return { present: false, proposals: proposalsOnDisk, conflicts: [] };
    }
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        const executions = Array.isArray(parsed.executions) ? parsed.executions : [];
        const currentSources = discoverSources(projectRoot);
        const engineDigest = hashLocalTree(coreRoot, ["manifest.yaml", "cli/lib/generator-runtime.ts", "schemas/project-context.schema.yaml", "schemas/feature.schema.yaml", "schemas/provenance.schema.yaml"]);
        const manifestDigest = hashFile(join(projectRoot, ".paved/manifest.yaml"));
        const proposals = [...proposalsOnDisk];
        const conflicts = [];
        for (const item of executions) {
            if (item === null || typeof item !== "object")
                continue;
            const execution = item;
            if (typeof execution.generator === "string" && (execution.outputs?.length ?? 0) > 0) {
                if (execution.outputs?.some((output) => !existsSync(safe(projectRoot, output)))) {
                    diagnostics.push(diagnostic({ code: "PAVED_GENERATED_OUTPUT_MISSING", component: "consumer.generated", category: "findings",
                        message: `Generator ${execution.generator} has a missing recorded output.`, remediation: "Regenerate the affected context." }));
                }
                const contractDigest = hashLocalTree(coreRoot, [`generators/${execution.generator}`]);
                if (execution.contractSha256 !== contractDigest || execution.engineSha256 !== engineDigest || execution.manifestSha256 !== manifestDigest) {
                    diagnostics.push(diagnostic({ code: "PAVED_GENERATOR_INPUTS_STALE", component: "consumer.generated", category: "findings",
                        message: `Generator ${execution.generator} no longer matches its recorded contract, engine, or manifest inputs.`,
                        remediation: "Review and regenerate the affected context." }));
                }
                const cited = new Set((execution.sources ?? []).map((source) => source.path));
                const currentPaths = [...sourcesFor(execution.generator, currentSources).map((source) => source.path),
                    ...relevantEvidenceFor(execution.generator, evidence).map((item) => item.source.path)];
                if (currentPaths.some((path) => !cited.has(path))) {
                    diagnostics.push(diagnostic({ code: "PAVED_GENERATOR_SOURCE_SET_STALE", component: "consumer.generated", category: "findings",
                        message: `Generator ${execution.generator} has new relevant source evidence.`,
                        remediation: "Review and regenerate the affected context." }));
                }
            }
            if (Array.isArray(execution.proposals)) {
                proposals.push(...execution.proposals.filter((proposal) => typeof proposal === "string"));
            }
            if (execution.status === "conflict" && typeof execution.generator === "string") {
                conflicts.push(execution.generator);
            }
        }
        const uniqueProposals = proposals.filter((proposal, index) => proposals.indexOf(proposal) === index);
        if (uniqueProposals.length > 0) {
            diagnostics.push(diagnostic({
                code: "PAVED_GENERATOR_PROPOSALS_PENDING",
                component: "consumer.generated",
                category: "findings",
                message: `${uniqueProposals.length} generated proposal(s) are pending review.`,
                remediation: "Review the proposal files and either adopt or discard them.",
            }));
        }
        if (conflicts.length > 0) {
            diagnostics.push(diagnostic({
                code: "PAVED_GENERATOR_CONFLICTS_PENDING",
                component: "consumer.generated",
                category: "conflict",
                message: `${conflicts.length} generator conflict(s) require human review.`,
                remediation: "Inspect generated proposals and resolve conflicts before regenerating.",
            }));
        }
        return {
            present: true,
            proposals: uniqueProposals,
            conflicts: conflicts.filter((conflict, index) => conflicts.indexOf(conflict) === index),
        };
    }
    catch (error) {
        diagnostics.push(diagnostic({
            code: "PAVED_LAST_RUN_INVALID",
            component: "consumer.generated",
            category: "findings",
            message: `Generator state exists but could not be parsed: ${messageOf(error)}`,
            remediation: "Remove stale generated state or regenerate after resolving configuration issues.",
        }));
        return { present: true, proposals: proposalsOnDisk, conflicts: [] };
    }
}
function walkFiles(root, callback) {
    if (!existsSync(root))
        return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = join(root, entry.name);
        if (entry.isDirectory())
            walkFiles(full, callback);
        else if (entry.isFile())
            callback(full);
    }
}
function inspectProvenanceObject(registry, projectRoot, document, body, path, diagnostics) {
    const validation = registry.validate(document);
    if (!validation.valid) {
        diagnostics.push(diagnostic({
            code: "PAVED_GENERATED_PROVENANCE_INVALID",
            component: "consumer.generated",
            category: "config",
            message: `${path} has invalid generated metadata: ${validation.errors.join("; ")}`,
            remediation: "Review or regenerate the generated artifact after fixing its metadata.",
        }));
        return;
    }
    const problems = assessProvenance(document, body);
    if (problems.length > 0) {
        diagnostics.push(diagnostic({
            code: "PAVED_GENERATED_PROVENANCE_INVALID",
            component: "consumer.generated",
            category: "config",
            message: `${path} has invalid provenance markers: ${problems.join("; ")}`,
            remediation: "Fix the generated markers or regenerate the artifact.",
        }));
    }
    const provenance = document.provenance;
    if (typeof provenance?.output_sha256 === "string" && provenance.output_sha256 !== sha(body)) {
        diagnostics.push(diagnostic({
            code: "PAVED_GENERATED_PROVENANCE_TAMPERED",
            component: "consumer.generated",
            category: "conflict",
            message: `${path} has generated content that no longer matches its recorded provenance hash.`,
            remediation: "Review the human edits and let a write-capable command create a proposal instead of overwriting them.",
        }));
    }
    const sources = Array.isArray(provenance?.sources) ? provenance.sources : [];
    for (const source of sources) {
        if (source === null || typeof source !== "object")
            continue;
        const entry = source;
        if (entry.type !== "file" || typeof entry.location !== "string" || typeof entry.sha256 !== "string")
            continue;
        const sourcePath = safe(projectRoot, entry.location);
        if (!existsSync(sourcePath) || hashFile(sourcePath) !== entry.sha256) {
            diagnostics.push(diagnostic({
                code: "PAVED_GENERATED_SOURCE_STALE",
                component: "consumer.generated",
                category: "findings",
                message: `${path} cites a source file that is missing or whose digest has changed: ${entry.location}.`,
                remediation: "Review whether the generated context is stale.",
            }));
        }
    }
}
function inspectGeneratedProvenance(registry, projectRoot, diagnostics) {
    walkFiles(join(projectRoot, ".paved/project"), (full) => {
        const repoPath = relative(projectRoot, full).split(sep).join("/");
        try {
            if (full.endsWith(".md")) {
                const markdown = loadMarkdown(full);
                if (markdown.frontmatter.kind === "ContextDocument") {
                    inspectProvenanceObject(registry, projectRoot, markdown.frontmatter, markdown.body, repoPath, diagnostics);
                }
            }
            else if (full.endsWith(".yaml") || full.endsWith(".yml")) {
                const document = loadYaml(full);
                if (document !== null && typeof document === "object" && document.provenance !== undefined) {
                    const withoutProvenance = structuredClone(document);
                    delete withoutProvenance.provenance;
                    inspectProvenanceObject(registry, projectRoot, document, stringify(withoutProvenance), repoPath, diagnostics);
                }
            }
        }
        catch (error) {
            diagnostics.push(diagnostic({
                code: "PAVED_GENERATED_PROVENANCE_INVALID",
                component: "consumer.generated",
                category: "config",
                message: `${repoPath} generated metadata could not be parsed or read.`,
                remediation: "Fix the generated document syntax before running generation again.",
            }));
        }
    });
    walkFiles(join(projectRoot, ".paved/generated"), (full) => {
        if (!full.endsWith(".paved.yaml"))
            return;
        const repoPath = relative(projectRoot, full).split(sep).join("/");
        try {
            const sidecar = loadYaml(full);
            if (sidecar === null || typeof sidecar !== "object")
                return;
            const validation = registry.validate(sidecar);
            if (!validation.valid) {
                diagnostics.push(diagnostic({
                    code: "PAVED_GENERATED_SIDECAR_INVALID",
                    component: "consumer.generated",
                    category: "config",
                    message: `${repoPath} is not a valid generated artifact sidecar: ${validation.errors.join("; ")}`,
                    remediation: "Delete stale generated sidecars or regenerate proposals.",
                }));
                return;
            }
            const artifact = sidecar.artifact;
            const targetPath = typeof artifact?.path === "string" ? safe(projectRoot, artifact.path) : undefined;
            const expected = sidecar.provenance?.output_sha256;
            if (targetPath && existsSync(targetPath) && typeof expected === "string" && hashFile(targetPath) !== expected) {
                diagnostics.push(diagnostic({
                    code: "PAVED_GENERATED_PROVENANCE_TAMPERED",
                    component: "consumer.generated",
                    category: "conflict",
                    message: `${repoPath} records a generated artifact whose content hash no longer matches.`,
                    remediation: "Review the artifact before accepting or regenerating the proposal.",
                }));
            }
        }
        catch (error) {
            diagnostics.push(diagnostic({
                code: "PAVED_GENERATED_SIDECAR_INVALID",
                component: "consumer.generated",
                category: "config",
                message: `${repoPath} sidecar could not be parsed or read.`,
                remediation: "Fix the generated sidecar syntax or remove it.",
            }));
        }
    });
}
function lockHealthFromDiagnostics(initial, diagnostics) {
    if (initial === "invalid" || diagnostics.some((item) => item.code === "PAVED_LOCK_INVALID"))
        return "invalid";
    if (initial === "missing")
        return "missing";
    if (diagnostics.some((item) => item.code.startsWith("PAVED_LOCK_")))
        return "mismatch";
    return initial;
}
function entryChanged(previous, next) {
    if (!previous || !next)
        return previous !== next;
    return previous.version !== next.version || previous.source !== next.source || previous.sha256 !== next.sha256;
}
function entriesChanged(previous, next) {
    const before = new Map((previous ?? []).filter((entry) => typeof entry.id === "string").map((entry) => [entry.id, entry]));
    const after = new Map((next ?? []).filter((entry) => typeof entry.id === "string").map((entry) => [entry.id, entry]));
    if (before.size !== after.size)
        return true;
    for (const [id, entry] of after) {
        if (entryChanged(before.get(id), entry))
            return true;
    }
    return false;
}
function updateStatusDiagnostics(diagnostics) {
    return diagnostics.some((item) => item.category !== "findings");
}
function candidateCompatibility(previous, next) {
    if (!previous || previous === next)
        return "compatible";
    const [beforeMajor, beforeMinor] = previous.split(".").map(Number);
    const [afterMajor, afterMinor] = next.split(".").map(Number);
    if (beforeMajor !== afterMajor)
        return "unknown";
    // A 0.x minor may break (docs/concepts/versioning.md), so only patches move freely there.
    // From 1.0 a minor is additive; moving to an older minor could drop what the project uses.
    if (afterMajor === 0)
        return beforeMinor === afterMinor ? "compatible" : "unknown";
    return afterMinor >= beforeMinor ? "compatible" : "unknown";
}
function updateLockGenerators(lock, coreRoot, generators) {
    const lockedById = new Map((lock.generators ?? []).filter((entry) => typeof entry.id === "string").map((entry) => [entry.id, entry]));
    const changedIds = [];
    const entries = generators.map((local) => {
        const next = {
            id: local.id,
            version: local.version,
            source: "local-core",
            sha256: hashLocalTree(coreRoot, [`generators/${local.id}`]),
        };
        const locked = lockedById.get(local.id);
        if (entryChanged(locked, next))
            changedIds.push(local.id);
        return next;
    });
    return { entries, changedIds: changedIds.sort() };
}
function staleGeneratorIds(projectRoot, coreRoot, resolved, manifest) {
    const path = join(projectRoot, ".paved/generated/state/last-run.json");
    if (!existsSync(path))
        return [];
    let executions;
    try {
        executions = JSON.parse(readFileSync(path, "utf8")).executions ?? [];
    }
    catch {
        return [];
    }
    const sources = discoverSources(projectRoot);
    const evidence = capabilityEvidence(projectRoot, sources, [...resolved], manifest.capability_providers, answeredProviders(projectRoot, coreRoot)).evidence;
    const byPath = new Map(sources.map((source) => [source.path, source.sha256]));
    const engineDigest = hashLocalTree(coreRoot, ["manifest.yaml", "cli/lib/generator-runtime.ts", "schemas/project-context.schema.yaml", "schemas/feature.schema.yaml", "schemas/provenance.schema.yaml"]);
    const manifestDigest = hashFile(join(projectRoot, ".paved/manifest.yaml"));
    return executions.filter((execution) => {
        if (!execution.generator || !execution.outputs?.length)
            return false;
        if (execution.outputs.some((output) => !existsSync(safe(projectRoot, output))))
            return true;
        if (execution.contractSha256 !== hashLocalTree(coreRoot, [`generators/${execution.generator}`]) ||
            execution.engineSha256 !== engineDigest || execution.manifestSha256 !== manifestDigest)
            return true;
        const cited = new Set((execution.sources ?? []).map((source) => source.path));
        if ((execution.sources ?? []).some((source) => byPath.get(source.path ?? "") !== source.sha256))
            return true;
        const currentPaths = [...sourcesFor(execution.generator, sources).map((source) => source.path),
            ...relevantEvidenceFor(execution.generator, evidence).map((item) => item.source.path)];
        return currentPaths.some((path) => !cited.has(path));
    }).map((execution) => execution.generator).sort();
}
export function planConsumerUpdate(input) {
    const diagnostics = [];
    const registry = createRegistry(join(input.coreRoot, "schemas"), ["paved/v1"]);
    const core = loadCoreManifest(input.coreRoot, registry, diagnostics);
    const manifestPath = input.manifestPath ?? join(input.projectRoot, ".paved/manifest.yaml");
    const manifest = existsSync(manifestPath)
        ? readValidated(registry, manifestPath, "PAVED_MANIFEST_INVALID", "consumer.manifest", diagnostics)
        : undefined;
    if (!existsSync(manifestPath)) {
        diagnostics.push(diagnostic({
            code: "PAVED_CONSUMER_UNINITIALIZED",
            component: "consumer.manifest",
            message: "This project is not initialized as a Paved consumer.",
            remediation: "Run paved init before update.",
        }));
    }
    const lockResult = readLock(registry, input.projectRoot, diagnostics);
    if (lockResult.health === "missing") {
        diagnostics.push(diagnostic({
            code: "PAVED_UPDATE_LOCK_REQUIRED",
            component: "consumer.lock",
            message: "Update requires an existing valid .paved/paved.lock baseline.",
            remediation: "Run paved init to create a lock before updating.",
        }));
    }
    if (!lockResult.lock || !manifest || !core || updateStatusDiagnostics(diagnostics)) {
        return {
            projectRoot: input.projectRoot,
            coreRoot: input.coreRoot,
            remoteResolution: "unsupported",
            changed: false,
            plannedWrites: [],
            plannedGeneratorIds: [],
            plannedMigrations: [],
            selectedAdapters: manifest?.adapters?.map((adapter) => adapter.id).sort() ?? [],
            resolvedAdapters: [],
            diagnostics,
        };
    }
    diagnostics.push(...inspectOverrides(input.projectRoot, input.coreRoot, manifest.adapters?.map((adapter) => adapter.id) ?? []));
    if (manifest.paved?.core && !compatible(core.version, manifest.paved.core)) {
        diagnostics.push(diagnostic({
            code: "PAVED_MANIFEST_CORE_INCOMPATIBLE",
            component: "consumer.manifest",
            message: `Manifest requires Core ${manifest.paved.core}, but local Core is ${core.version}.`,
            remediation: "Use a compatible local Core. Remote Core resolution is not supported by this update command.",
        }));
    }
    const compatibility = candidateCompatibility(lockResult.lock.core?.version, core.version);
    // A runtime upgrade is staged by the launcher: it verifies and activates the new
    // runtime, which then moves the lock here inside the same update transaction.
    let activeRuntime;
    try {
        activeRuntime = readActiveRuntimeSelection(input.projectRoot, input.coreRoot);
    }
    catch {
        activeRuntime = undefined;
    }
    const nextRuntime = activeRuntime?.version === core.version ? activeRuntime : lockResult.lock.runtime;
    if (nextRuntime && nextRuntime.version !== core.version)
        diagnostics.push(diagnostic({
            code: "PAVED_RUNTIME_UPDATE_REQUIRED", component: "cli.update", category: "resolution",
            message: `The lock pins runtime ${nextRuntime.version}; Core ${core.version} cannot be activated through a local content update.`,
            remediation: "Run update through the Paved launcher so it verifies and activates a matching runtime before the lock changes.",
        }));
    if (compatibility === "unknown")
        diagnostics.push(diagnostic({ code: "PAVED_UPDATE_COMPATIBILITY_UNKNOWN",
            component: "cli.update", category: "resolution",
            message: `No local migration evidence proves Core ${lockResult.lock.core?.version} can update to ${core.version}.`,
            remediation: "Use a compatible Core patch or provide an explicit migration before updating." }));
    const documentCheck = planDocumentMigrations(input.projectRoot, registry);
    for (const item of documentCheck.diagnostics) {
        diagnostics.push(diagnostic({
            code: "PAVED_UPDATE_MIGRATION_REQUIRED",
            component: "consumer.documents",
            category: "config",
            message: `${item.path} requires a known deterministic migration: ${item.message}`,
            remediation: "Provide a Core migration for this document version or migrate it manually before updating.",
        }));
    }
    let resolvedAdapters = [];
    try {
        const sources = discoverSources(input.projectRoot);
        const detectedAdapters = detectAdapters(input.projectRoot, loadAdapters(input.coreRoot), sources);
        const selectedAdapters = (manifest.adapters ?? []).map((adapter) => ({ id: adapter.id, version: adapter.version }));
        const resolved = resolveAdapters(detectedAdapters, selectedAdapters, core.version);
        resolvedAdapters = resolved.adapters;
        for (const item of resolved.diagnostics) {
            const mapped = mapAdapterDiagnostic(item.code);
            diagnostics.push(diagnostic({
                code: mapped.code,
                component: "consumer.adapters",
                category: mapped.category,
                message: item.message,
                remediation: "Adjust .paved/manifest.yaml adapter ranges or provide the required local adapter before updating.",
            }));
        }
    }
    catch (error) {
        diagnostics.push(diagnostic({
            code: "PAVED_UPDATE_PREFLIGHT_FAILED",
            component: "cli.update",
            category: "internal",
            message: `Update preflight failed: ${messageOf(error)}`,
            remediation: "Fix local Core adapter contracts before updating consumers.",
        }));
    }
    const generators = discoverGenerators(input.coreRoot, registry, diagnostics);
    if (updateStatusDiagnostics(diagnostics)) {
        return {
            projectRoot: input.projectRoot,
            coreRoot: input.coreRoot,
            remoteResolution: "unsupported",
            changed: false,
            compatibility: diagnostics.some((item) => item.code === "PAVED_UPDATE_MIGRATION_REQUIRED") ? "migration-required"
                : diagnostics.some((item) => item.code === "PAVED_MANIFEST_CORE_INCOMPATIBLE" || item.code === "PAVED_ADAPTER_INCOMPATIBLE") ? "incompatible"
                    : compatibility,
            plannedWrites: [],
            plannedGeneratorIds: [],
            plannedMigrations: documentCheck.migrations,
            currentLock: lockResult.lock,
            selectedAdapters: manifest.adapters?.map((adapter) => adapter.id).sort() ?? [],
            resolvedAdapters: resolvedAdapters.map((detection) => detection.adapter.id).sort(),
            diagnostics,
        };
    }
    const generatorPlan = updateLockGenerators(lockResult.lock, input.coreRoot, generators);
    let nextLock = {
        apiVersion: "paved/v1",
        kind: "Lock",
        resolved_at: new Date().toISOString(),
        core: {
            version: core.version,
            source: "local-core",
            sha256: hashLocalCore(input.coreRoot),
        },
        ...(nextRuntime === undefined ? {} : { runtime: nextRuntime }),
        adapters: resolvedAdapters.map((detection) => ({
            id: detection.adapter.id,
            version: detection.adapter.version,
            source: "local-core",
            sha256: hashLocalTree(input.coreRoot, [`adapters/${detection.adapter.id}`]),
        })),
        ...(generatorPlan.entries === undefined ? {} : { generators: generatorPlan.entries }),
    };
    const capabilityDecisions = capabilityLockEntries(resolveCapabilities(resolvedAdapters, manifest.capability_providers, answeredProviders(input.projectRoot, input.coreRoot)));
    if (capabilityDecisions.length)
        nextLock = { ...nextLock, capabilities: capabilityDecisions };
    const validation = registry.validate(nextLock);
    if (!validation.valid) {
        diagnostics.push(diagnostic({
            code: "PAVED_UPDATE_LOCK_INVALID",
            component: "consumer.lock",
            message: `Planned lock is invalid: ${validation.errors.join("; ")}`,
            remediation: "Fix local Core metadata before updating the consumer lock.",
        }));
    }
    const coreChanged = entryChanged(lockResult.lock.core, nextLock.core);
    const adaptersChanged = entriesChanged(lockResult.lock.adapters, nextLock.adapters);
    const generatorsChanged = entriesChanged(lockResult.lock.generators, nextLock.generators);
    const runtimeChanged = JSON.stringify(lockResult.lock.runtime) !== JSON.stringify(nextLock.runtime);
    const capabilitiesChanged = JSON.stringify(lockResult.lock.capabilities ?? []) !== JSON.stringify(nextLock.capabilities ?? []);
    const lockChanged = coreChanged || adaptersChanged || generatorsChanged || runtimeChanged || capabilitiesChanged;
    const staleIds = staleGeneratorIds(input.projectRoot, input.coreRoot, resolvedAdapters, manifest);
    const priorAdapters = new Map((lockResult.lock.adapters ?? []).filter((entry) => entry.id).map((entry) => [entry.id, entry]));
    const nextAdapters = new Map((nextLock.adapters ?? []).filter((entry) => entry.id).map((entry) => [entry.id, entry]));
    const changedAdapterIds = [...new Set([...priorAdapters.keys(), ...nextAdapters.keys()])]
        .filter((id) => entryChanged(priorAdapters.get(id), nextAdapters.get(id))).sort();
    const plannedGeneratorIds = impactedGenerators(generators, [...generatorPlan.changedIds, ...staleIds], changedAdapterIds, input.projectRoot);
    const changed = lockChanged || plannedGeneratorIds.length > 0 || documentCheck.migrations.length > 0;
    return {
        projectRoot: input.projectRoot,
        coreRoot: input.coreRoot,
        remoteResolution: "unsupported",
        changed,
        compatibility: diagnostics.some((item) => item.code === "PAVED_UPDATE_MIGRATION_REQUIRED") ? "migration-required"
            : diagnostics.some((item) => item.code === "PAVED_MANIFEST_CORE_INCOMPATIBLE" || item.code === "PAVED_ADAPTER_INCOMPATIBLE") ? "incompatible"
                : compatibility,
        plannedWrites: [
            ...(lockChanged ? [".paved/paved.lock"] : []),
            ...documentCheck.migrations.map((item) => item.path),
        ],
        plannedGeneratorIds,
        plannedMigrations: documentCheck.migrations,
        currentLock: lockResult.lock,
        nextLock,
        selectedAdapters: manifest.adapters?.map((adapter) => adapter.id).sort() ?? [],
        resolvedAdapters: resolvedAdapters.map((detection) => detection.adapter.id).sort(),
        diagnostics,
    };
}
export function inspectConsumer(input) {
    const diagnostics = [];
    const registry = createRegistry(join(input.coreRoot, "schemas"), ["paved/v1"]);
    const core = loadCoreManifest(input.coreRoot, registry, diagnostics);
    const requiredDiagnostics = core === undefined ? [] : missingRequiredLayout(input.projectRoot, core.consumer_layout);
    diagnostics.push(...requiredDiagnostics);
    const pavedDir = join(input.projectRoot, ".paved");
    const manifestPath = input.manifestPath ?? join(pavedDir, "manifest.yaml");
    const hasPavedDir = existsSync(pavedDir);
    const hasManifest = existsSync(manifestPath);
    if (!hasPavedDir && !hasManifest) {
        diagnostics.push(diagnostic({
            code: "PAVED_CONSUMER_UNINITIALIZED",
            component: "consumer.manifest",
            message: "This project is not initialized as a Paved consumer.",
            remediation: "Run paved init when write-capable initialization is available.",
        }));
        return {
            projectRoot: input.projectRoot,
            coreRoot: input.coreRoot,
            initialized: false,
            lifecycleState: "UNINITIALIZED",
            core: core?.version === undefined ? {} : { localVersion: core.version },
            lockHealth: "unknown",
            selectedAdapters: [],
            detectedAdapters: [],
            resolvedAdapters: [],
            capabilityProviders: [],
            verificationProfile: "missing",
            proposals: [],
            conflicts: [],
            pendingDecisions: [],
            pendingApprovals: [],
            diagnostics,
        };
    }
    if (!hasManifest) {
        return {
            projectRoot: input.projectRoot,
            coreRoot: input.coreRoot,
            initialized: false,
            lifecycleState: "UNINITIALIZED",
            core: core?.version === undefined ? {} : { localVersion: core.version },
            lockHealth: "unknown",
            selectedAdapters: [],
            detectedAdapters: [],
            resolvedAdapters: [],
            capabilityProviders: [],
            verificationProfile: "missing",
            proposals: [],
            conflicts: [],
            pendingDecisions: [],
            pendingApprovals: [],
            diagnostics,
        };
    }
    let decisions = [];
    try {
        decisions = listDecisions(input.projectRoot, input.coreRoot);
    }
    catch (error) {
        if (!(error instanceof DecisionStoreError))
            throw error;
        diagnostics.push(diagnostic({
            code: "PAVED_DECISION_INVALID", component: "consumer.decisions", category: "config",
            message: error.message,
            remediation: "Repair the invalid decision record before answering or applying decisions.",
        }));
    }
    const manifest = readValidated(registry, manifestPath, "PAVED_MANIFEST_INVALID", "consumer.manifest", diagnostics);
    const selectedAdapters = [
        ...(manifest?.adapters ?? []),
        ...(input.adapterSelections ?? []).map((id) => ({ id, version: manifest?.adapters?.find((adapter) => adapter.id === id)?.version ?? "^0.0.0" })),
    ].filter((adapter, index, all) => all.findIndex((candidate) => candidate.id === adapter.id) === index);
    if (manifest?.paved?.core && core && !compatible(core.version, manifest.paved.core)) {
        diagnostics.push(diagnostic({
            code: "PAVED_MANIFEST_CORE_INCOMPATIBLE",
            component: "consumer.manifest",
            message: `Manifest requires Core ${manifest.paved.core}, but local Core is ${core.version}.`,
            remediation: "Use a compatible Core or update the manifest range intentionally.",
        }));
    }
    const lockResult = readLock(registry, input.projectRoot, diagnostics);
    try {
        const selectedRuntime = readRuntimeSelection(input.projectRoot);
        if (selectedRuntime && JSON.stringify(selectedRuntime) !== JSON.stringify(lockResult.lock?.runtime)) {
            diagnostics.push(diagnostic({ code: "PAVED_RUNTIME_LOCK_MISMATCH", component: "consumer.lock", category: "resolution",
                message: "The selected project-local runtime differs from paved.lock.", remediation: "Restore the runtime version and integrity pinned by paved.lock." }));
        }
        if (selectedRuntime && core && selectedRuntime.version !== core.version) {
            diagnostics.push(diagnostic({ code: "PAVED_RUNTIME_CORE_VERSION_MISMATCH", component: "consumer.lock", category: "resolution",
                message: `Selected runtime ${selectedRuntime.version} does not match Core ${core.version}.`, remediation: "Restore the runtime and Core versions pinned together by paved.lock." }));
        }
    }
    catch (error) {
        diagnostics.push(diagnostic({ code: "PAVED_RUNTIME_STATE_INVALID", component: "consumer.lock", category: "resolution",
            message: messageOf(error), remediation: "Restore a verified project-local runtime selection." }));
    }
    const coreDigestMatches = compareCoreLock(lockResult.lock, core, input.coreRoot, diagnostics);
    const generators = discoverGenerators(input.coreRoot, registry, diagnostics);
    compareGeneratorLocks(lockResult.lock, input.coreRoot, generators, diagnostics);
    let detectedAdapters = [];
    let resolvedAdapters = [];
    let adapterEvidence = [];
    let capabilityProviders = [];
    if (manifest && core) {
        try {
            const sources = discoverSources(input.projectRoot);
            detectedAdapters = detectAdapters(input.projectRoot, loadAdapters(input.coreRoot), sources);
            const resolved = resolveAdapters(detectedAdapters, selectedAdapters, core.version);
            resolvedAdapters = resolved.adapters;
            compareAdapterLocks(lockResult.lock, input.coreRoot, resolvedAdapters, diagnostics);
            for (const item of resolved.diagnostics) {
                const mapped = mapAdapterDiagnostic(item.code);
                diagnostics.push(diagnostic({
                    code: mapped.code,
                    component: "consumer.adapters",
                    category: mapped.category,
                    message: item.message,
                    remediation: "Adjust .paved/manifest.yaml adapter selections or add the missing repository evidence.",
                }));
            }
            const capabilities = capabilityEvidence(input.projectRoot, sources, resolvedAdapters, manifest.capability_providers, answeredProviders(input.projectRoot, input.coreRoot, decisions));
            adapterEvidence = capabilities.evidence;
            capabilityProviders = providerReport(capabilities.resolutions);
            // A lock without a capabilities section recorded no decisions, which is exact for single-provider repositories.
            if (lockResult.lock && JSON.stringify(lockResult.lock.capabilities ?? []) !== JSON.stringify(capabilityLockEntries(capabilities.resolutions))) {
                diagnostics.push(diagnostic({
                    code: "PAVED_LOCK_CAPABILITIES_STALE",
                    component: "consumer.lock",
                    category: "findings",
                    message: "Capability provider decisions recorded in paved.lock differ from the current manifest and repository evidence.",
                    remediation: "Review the repository structure change, then run paved update to record the current decisions.",
                }));
            }
            for (const item of Object.values(capabilities.resolutions).flatMap((resolution) => resolution.diagnostics)) {
                if (item.code === "missing-provider")
                    continue;
                const mapped = mapAdapterDiagnostic(item.code);
                diagnostics.push(diagnostic({
                    code: mapped.code,
                    component: "consumer.capabilities",
                    category: mapped.category,
                    message: item.message,
                    remediation: "Select a provider for the ambiguous scope in manifest capability_providers (a string for the whole repository or a list of { path, provider }), or adjust selected adapters.",
                }));
            }
        }
        catch (error) {
            diagnostics.push(diagnostic({
                code: "PAVED_ADAPTER_INSPECTION_FAILED",
                component: "consumer.adapters",
                category: "internal",
                message: `Adapter inspection failed: ${messageOf(error)}`,
                remediation: "Fix Core adapter contracts before inspecting consumers.",
            }));
        }
    }
    const profile = verificationProfile(registry, input.projectRoot, diagnostics);
    if (manifest)
        diagnostics.push(...inspectOverrides(input.projectRoot, input.coreRoot, selectedAdapters.map((adapter) => adapter.id)));
    const lastRun = inspectLastRun(input.projectRoot, input.coreRoot, adapterEvidence, diagnostics);
    inspectGeneratedProvenance(registry, input.projectRoot, diagnostics);
    const lockHealth = lockHealthFromDiagnostics(lockResult.health, diagnostics);
    const state = lifecycleState({
        hasManifest: true,
        manifestValid: manifest !== undefined,
        lockHealth,
        profile,
        generated: lastRun?.present === true || existsSync(join(input.projectRoot, ".paved/project")),
        diagnostics,
    });
    const waiting = decisions.filter((decision) => decision.status === "PENDING" || decision.status === "ASKED");
    return {
        projectRoot: input.projectRoot,
        coreRoot: input.coreRoot,
        initialized: true,
        lifecycleState: state,
        ...(manifest?.project?.name === undefined ? {} : { projectName: manifest.project.name }),
        core: {
            ...(core?.version === undefined ? {} : { localVersion: core.version }),
            ...(manifest?.paved?.core === undefined ? {} : { requestedRange: manifest.paved.core }),
            ...(lockResult.lock?.core?.version === undefined ? {} : { lockedVersion: lockResult.lock.core.version }),
            ...(coreDigestMatches === undefined ? {} : { lockDigestMatches: coreDigestMatches }),
        },
        lockHealth,
        selectedAdapters: selectedAdapters.map((adapter) => adapter.id).sort(),
        detectedAdapters: detectedAdapters.filter((detection) => detection.confidence !== "unknown").map((detection) => ({
            id: detection.adapter.id,
            confidence: detection.confidence,
            evidence: detection.evidence,
        })),
        resolvedAdapters: resolvedAdapters.map((detection) => detection.adapter.id).sort(),
        capabilityProviders,
        verificationProfile: profile,
        ...(lastRun === undefined ? {} : { lastRun }),
        proposals: lastRun?.proposals ?? [],
        conflicts: lastRun?.conflicts ?? [],
        pendingDecisions: waiting.map((decision) => ({
            id: decision.id, question: decision.question, required: decision.required,
            command: decision.command,
        })),
        pendingApprovals: waiting.filter((decision) => decision.status === "ASKED" && decision.answer_channel === "human-authored")
            .map((decision) => decision.id),
        diagnostics,
    };
}
