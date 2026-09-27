import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { createDiagnostic, type Diagnostic } from "../result.ts";
import { capabilityEvidence, detectAdapters, loadAdapters, resolveAdapters, type AdapterEvidence, type Detection } from "./adapters.ts";
import { loadYaml, loadMarkdown } from "./documents.ts";
import { discoverSources, relevantEvidenceFor, sourcesFor } from "./generator-runtime.ts";
import { hashLocalCore, hashLocalTree } from "./local-core.ts";
import { inspectOverrides } from "./override-safety.ts";
import { assessProvenance } from "./provenance.ts";
import { createRegistry, type SchemaRegistry } from "./schemas.ts";
import { compatible } from "./tools.ts";

export interface InspectConsumerInput {
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly manifestPath?: string;
  readonly adapterSelections?: readonly string[];
}

export interface PlanConsumerUpdateInput {
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly manifestPath?: string;
}

export interface UpdateLockEntry {
  readonly id?: string;
  readonly version: string;
  readonly source: string;
  readonly sha256: string;
}

export interface UpdateLockDocument {
  readonly apiVersion: "paved/v1";
  readonly kind: "Lock";
  readonly resolved_at: string;
  readonly core: UpdateLockEntry;
  readonly adapters?: readonly UpdateLockEntry[];
  readonly generators?: readonly UpdateLockEntry[];
}

export interface ConsumerUpdatePlan {
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly remoteResolution: "unsupported";
  readonly changed: boolean;
  readonly compatibility?: "compatible" | "migration-required" | "incompatible" | "unknown";
  readonly plannedWrites: readonly string[];
  readonly plannedGeneratorIds: readonly string[];
  readonly currentLock?: LockDocument;
  readonly nextLock?: UpdateLockDocument;
  readonly selectedAdapters: readonly string[];
  readonly resolvedAdapters: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ConsumerInspection {
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly initialized: boolean;
  readonly lifecycleState: ConsumerLifecycleState;
  readonly projectName?: string;
  readonly core: {
    readonly localVersion?: string;
    readonly requestedRange?: string;
    readonly lockedVersion?: string;
    readonly lockDigestMatches?: boolean;
  };
  readonly lockHealth: "healthy" | "missing" | "invalid" | "mismatch" | "unknown";
  readonly selectedAdapters: readonly string[];
  readonly detectedAdapters: readonly { id: string; confidence: string; evidence: readonly string[] }[];
  readonly resolvedAdapters: readonly string[];
  readonly verificationProfile: "present" | "missing" | "invalid";
  readonly lastRun?: {
    readonly present: boolean;
    readonly proposals: readonly string[];
    readonly conflicts: readonly string[];
  };
  readonly proposals: readonly string[];
  readonly conflicts: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export type ConsumerLifecycleState =
  | "UNINITIALIZED" | "INITIALIZED" | "RESOLVED" | "GENERATED"
  | "VALIDATED" | "READY" | "STALE" | "INCOMPATIBLE" | "BROKEN";

function lifecycleState(input: {
  hasManifest: boolean;
  manifestValid: boolean;
  lockHealth: ConsumerInspection["lockHealth"];
  profile: ConsumerInspection["verificationProfile"];
  generated: boolean;
  diagnostics: readonly Diagnostic[];
}): ConsumerLifecycleState {
  if (!input.hasManifest) return "UNINITIALIZED";
  if (!input.manifestValid || input.diagnostics.some((item) =>
    item.code === "PAVED_CORE_MANIFEST_INVALID" || item.code === "PAVED_GENERATED_PROVENANCE_INVALID" ||
    item.code === "PAVED_VERIFICATION_PROFILE_INVALID")) return "BROKEN";
  if (input.diagnostics.some((item) => item.code === "PAVED_MANIFEST_CORE_INCOMPATIBLE" ||
    item.code === "PAVED_LOCK_CORE_VERSION_MISMATCH" || item.code === "PAVED_ADAPTER_INCOMPATIBLE" ||
    item.code === "PAVED_LOCK_ADAPTER_VERSION_MISMATCH")) return "INCOMPATIBLE";
  if (input.diagnostics.some((item) => item.code === "PAVED_GENERATED_SOURCE_STALE" ||
    item.code === "PAVED_GENERATOR_INPUTS_STALE" || item.code === "PAVED_GENERATOR_SOURCE_SET_STALE" ||
    item.code === "PAVED_GENERATED_OUTPUT_MISSING" ||
    item.code === "PAVED_LOCK_CORE_DIGEST_MISMATCH" || item.code === "PAVED_LOCK_ADAPTER_DIGEST_MISMATCH" ||
    item.code === "PAVED_LOCK_GENERATOR_DIGEST_MISMATCH" || item.code === "PAVED_LOCK_GENERATOR_VERSION_MISMATCH")) return "STALE";
  if (input.lockHealth !== "healthy") return "INITIALIZED";
  if (!input.generated) return "RESOLVED";
  if (input.profile !== "present") return "GENERATED";
  if (input.diagnostics.some((item) => item.category !== "findings" || item.code === "PAVED_GENERATOR_PROPOSALS_PENDING")) return "VALIDATED";
  return "READY";
}

interface CoreManifest {
  readonly version: string;
  readonly consumer_layout: readonly { path: string; required: boolean; ownership: string; schema?: string }[];
}

interface ProjectManifest {
  readonly project?: { readonly name?: string };
  readonly paved?: { readonly core?: string };
  readonly adapters?: readonly { readonly id: string; readonly version: string }[];
  readonly capability_providers?: Record<string, string>;
}

interface ResolvedLockEntry {
  readonly id?: string;
  readonly version: string;
  readonly source: string;
  readonly sha256: string;
}

interface LockDocument {
  readonly apiVersion?: string;
  readonly core?: ResolvedLockEntry;
  readonly adapters?: readonly ResolvedLockEntry[];
  readonly generators?: readonly ResolvedLockEntry[];
}

interface GeneratorContract {
  readonly id: string;
  readonly version: string;
  readonly depends_on?: readonly string[];
  readonly inputs?: readonly { kind: string }[];
  readonly outputs?: readonly { path: string }[];
}

function impactedGenerators(
  contracts: readonly GeneratorContract[],
  changedIds: readonly string[],
  changedAdapterIds: readonly string[],
  projectRoot: string,
): string[] {
  const affected = new Set(changedIds);
  if (changedAdapterIds.length > 0) {
    const runPath = join(projectRoot, ".paved/generated/state/last-run.json");
    let used = new Map<string, Set<string>>();
    if (existsSync(runPath)) {
      try {
        const run = JSON.parse(readFileSync(runPath, "utf8")) as { executions?: {
          generator?: string; sources?: { adapter?: string; adapterEvidence?: { adapter: string }[] }[];
        }[] };
        used = new Map((run.executions ?? []).filter((entry) => typeof entry.generator === "string").map((entry) => [
          entry.generator as string,
          new Set((entry.sources ?? []).flatMap((source) => [source.adapter, ...(source.adapterEvidence ?? []).map((e) => e.adapter)].filter((id): id is string => typeof id === "string"))),
        ]));
      } catch { /* Invalid run state is handled by inspection; assume adapter inputs need regeneration. */ }
    }
    for (const contract of contracts) {
      if (!contract.inputs?.some((entry) => entry.kind === "adapter")) continue;
      const previous = used.get(contract.id);
      if (!previous || changedAdapterIds.some((id) => previous.has(id))) affected.add(contract.id);
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

function diagnostic(input: {
  readonly code: string;
  readonly component: string;
  readonly message: string;
  readonly remediation?: string;
  readonly category?: Diagnostic["category"];
  readonly severity?: Diagnostic["severity"];
}): Diagnostic {
  return createDiagnostic({
    category: input.category ?? "config",
    severity: input.severity ?? (input.category === "findings" ? "warning" : "error"),
    code: input.code,
    component: input.component,
    message: input.message,
    ...(input.remediation === undefined ? {} : { remediation: input.remediation }),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safe(root: string, path: string): string {
  const full = resolve(root, path);
  const resolvedRoot = resolve(root);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + sep)) {
    throw new Error(`Path escapes root: ${path}`);
  }
  return full;
}

function hashFile(path: string): string {
  return sha(readFileSync(path));
}

function readValidated<T>(
  registry: SchemaRegistry,
  path: string,
  code: string,
  component: string,
  diagnostics: Diagnostic[],
): T | undefined {
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
    return document as T;
  } catch (error) {
    diagnostics.push(diagnostic({
      code,
      component,
      message: `${relative(dirname(dirname(path)), path)} cannot be parsed or read.`,
      remediation: "Fix the YAML syntax or file permissions.",
    }));
    return undefined;
  }
}

function loadCoreManifest(coreRoot: string, registry: SchemaRegistry, diagnostics: Diagnostic[]): CoreManifest | undefined {
  return readValidated<CoreManifest>(
    registry,
    join(coreRoot, "manifest.yaml"),
    "PAVED_CORE_MANIFEST_INVALID",
    "core.manifest",
    diagnostics,
  );
}

function missingRequiredLayout(projectRoot: string, layout: readonly CoreManifest["consumer_layout"][number][]): Diagnostic[] {
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

function readLock(
  registry: SchemaRegistry,
  projectRoot: string,
  diagnostics: Diagnostic[],
): { lock?: LockDocument; health: ConsumerInspection["lockHealth"] } {
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
  const lock = readValidated<LockDocument>(registry, lockPath, "PAVED_LOCK_INVALID", "consumer.lock", diagnostics);
  return lock === undefined || diagnostics.length > before ? { health: "invalid" } : { lock, health: "healthy" };
}

function compareCoreLock(lock: LockDocument | undefined, core: CoreManifest | undefined, coreRoot: string, diagnostics: Diagnostic[]): boolean | undefined {
  if (!lock?.core || !core) return undefined;
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

function compareAdapterLocks(
  lock: LockDocument | undefined,
  coreRoot: string,
  resolved: readonly Detection[],
  diagnostics: Diagnostic[],
): void {
  if (!lock) return;
  const lockedById = new Map((lock.adapters ?? []).filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
  const resolvedIds = new Set(resolved.map((item) => item.adapter.id));
  for (const locked of lock.adapters ?? []) {
    if (locked.id && !resolvedIds.has(locked.id)) diagnostics.push(diagnostic({ code: "PAVED_LOCK_ADAPTER_EXTRA",
      component: "consumer.lock", message: `Lock includes unselected adapter ${locked.id}.`, remediation: "Refresh the lock after reviewing manifest selections." }));
    if (locked.source !== "local-core") diagnostics.push(diagnostic({ code: "PAVED_LOCK_SOURCE_UNAVAILABLE", component: "consumer.lock", category: "resolution",
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

function discoverGenerators(coreRoot: string, registry: SchemaRegistry, diagnostics: Diagnostic[]): GeneratorContract[] {
  const root = join(coreRoot, "generators");
  const contracts: GeneratorContract[] = [];
  if (!existsSync(root)) return contracts;
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "runtime") walk(full);
        continue;
      }
      if (entry.name !== "generator.yaml") continue;
      const before = diagnostics.length;
      const contract = readValidated<GeneratorContract>(registry, full, "PAVED_GENERATOR_CONTRACT_INVALID", "core.generators", diagnostics);
      if (contract && diagnostics.length === before) contracts.push(contract);
    }
  }
  walk(root);
  return contracts.sort((a, b) => a.id.localeCompare(b.id, "en"));
}

function compareGeneratorLocks(
  lock: LockDocument | undefined,
  coreRoot: string,
  generators: readonly GeneratorContract[],
  diagnostics: Diagnostic[],
): void {
  if (!lock) return;
  const localById = new Map(generators.map((generator) => [generator.id, generator]));
  const lockedIds = new Set((lock.generators ?? []).map((entry) => entry.id));
  for (const generator of generators) if (!lockedIds.has(generator.id)) diagnostics.push(diagnostic({
    code: "PAVED_LOCK_GENERATOR_MISSING", component: "consumer.lock", message: `Generator ${generator.id} is missing from the lock.`,
    remediation: "Refresh the lock before generating context." }));
  for (const locked of lock.generators ?? []) {
    if (typeof locked.id !== "string") continue;
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
    else diagnostics.push(diagnostic({ code: "PAVED_LOCK_SOURCE_UNAVAILABLE", component: "consumer.lock", category: "resolution",
      message: `Locked generator ${locked.id} has a source the local resolver cannot verify.` }));
  }
}

function mapAdapterDiagnostic(code: string): { code: string; category: Diagnostic["category"] } {
  if (code === "missing-adapter") return { code: "PAVED_ADAPTER_UNAVAILABLE", category: "resolution" };
  if (code === "undetected") return { code: "PAVED_ADAPTER_UNDETECTED", category: "resolution" };
  if (code === "ambiguous-provider") return { code: "PAVED_CAPABILITY_AMBIGUOUS", category: "resolution" };
  if (code === "missing-provider") return { code: "PAVED_CAPABILITY_UNAVAILABLE", category: "resolution" };
  if (code === "invalid-selection") return { code: "PAVED_CAPABILITY_PROVIDER_INVALID", category: "resolution" };
  return { code: `PAVED_ADAPTER_${code.toUpperCase().replace(/-/g, "_")}`, category: "resolution" };
}

function verificationProfile(
  registry: SchemaRegistry,
  projectRoot: string,
  diagnostics: Diagnostic[],
): ConsumerInspection["verificationProfile"] {
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

function inspectLastRun(projectRoot: string, coreRoot: string, evidence: readonly AdapterEvidence[], diagnostics: Diagnostic[]): ConsumerInspection["lastRun"] {
  const path = join(projectRoot, ".paved/generated/state/last-run.json");
  const proposalRoot = join(projectRoot, ".paved/generated/proposals");
  const proposalsOnDisk: string[] = [];
  walkFiles(proposalRoot, (full) => {
    if (!full.endsWith(".paved.yaml")) proposalsOnDisk.push(relative(projectRoot, full).split(sep).join("/"));
  });
  proposalsOnDisk.sort();
  if (!existsSync(path)) {
    if (proposalsOnDisk.length === 0) return undefined;
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
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { executions?: unknown };
    const executions = Array.isArray(parsed.executions) ? parsed.executions : [];
    const currentSources = discoverSources(projectRoot);
    const engineDigest = hashLocalTree(coreRoot, ["manifest.yaml", "cli/lib/generator-runtime.ts", "schemas/project-context.schema.yaml", "schemas/feature.schema.yaml", "schemas/provenance.schema.yaml"]);
    const manifestDigest = hashFile(join(projectRoot, ".paved/manifest.yaml"));
    const proposals = [...proposalsOnDisk];
    const conflicts: string[] = [];
    for (const item of executions) {
      if (item === null || typeof item !== "object") continue;
      const execution = item as { generator?: unknown; status?: unknown; proposals?: unknown;
        contractSha256?: unknown; engineSha256?: unknown; manifestSha256?: unknown;
        sources?: { path?: string }[]; outputs?: string[] };
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
        proposals.push(...execution.proposals.filter((proposal): proposal is string => typeof proposal === "string"));
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
  } catch (error) {
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

function walkFiles(root: string, callback: (path: string) => void): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, callback);
    else if (entry.isFile()) callback(full);
  }
}

function inspectProvenanceObject(
  registry: SchemaRegistry,
  projectRoot: string,
  document: Record<string, unknown>,
  body: string,
  path: string,
  diagnostics: Diagnostic[],
): void {
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
  const problems = assessProvenance(document as Parameters<typeof assessProvenance>[0], body);
  if (problems.length > 0) {
    diagnostics.push(diagnostic({
      code: "PAVED_GENERATED_PROVENANCE_INVALID",
      component: "consumer.generated",
      category: "config",
      message: `${path} has invalid provenance markers: ${problems.join("; ")}`,
      remediation: "Fix the generated markers or regenerate the artifact.",
    }));
  }
  const provenance = document.provenance as { output_sha256?: unknown; sources?: unknown } | undefined;
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
    if (source === null || typeof source !== "object") continue;
    const entry = source as { type?: unknown; location?: unknown; sha256?: unknown };
    if (entry.type !== "file" || typeof entry.location !== "string" || typeof entry.sha256 !== "string") continue;
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

function inspectGeneratedProvenance(registry: SchemaRegistry, projectRoot: string, diagnostics: Diagnostic[]): void {
  walkFiles(join(projectRoot, ".paved/project"), (full) => {
    const repoPath = relative(projectRoot, full).split(sep).join("/");
    try {
      if (full.endsWith(".md")) {
        const markdown = loadMarkdown(full);
        if (markdown.frontmatter.kind === "ContextDocument") {
          inspectProvenanceObject(registry, projectRoot, markdown.frontmatter, markdown.body, repoPath, diagnostics);
        }
      } else if (full.endsWith(".yaml") || full.endsWith(".yml")) {
        const document = loadYaml(full);
        if (document !== null && typeof document === "object" && (document as { provenance?: unknown }).provenance !== undefined) {
          const withoutProvenance = structuredClone(document) as Record<string, unknown>;
          delete withoutProvenance.provenance;
          inspectProvenanceObject(registry, projectRoot, document as Record<string, unknown>, stringify(withoutProvenance), repoPath, diagnostics);
        }
      }
    } catch (error) {
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
    if (!full.endsWith(".paved.yaml")) return;
    const repoPath = relative(projectRoot, full).split(sep).join("/");
    try {
      const sidecar = loadYaml(full);
      if (sidecar === null || typeof sidecar !== "object") return;
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
      const artifact = (sidecar as { artifact?: { path?: unknown }; provenance?: { output_sha256?: unknown } }).artifact;
      const targetPath = typeof artifact?.path === "string" ? safe(projectRoot, artifact.path) : undefined;
      const expected = (sidecar as { provenance?: { output_sha256?: unknown } }).provenance?.output_sha256;
      if (targetPath && existsSync(targetPath) && typeof expected === "string" && hashFile(targetPath) !== expected) {
        diagnostics.push(diagnostic({
          code: "PAVED_GENERATED_PROVENANCE_TAMPERED",
          component: "consumer.generated",
          category: "conflict",
          message: `${repoPath} records a generated artifact whose content hash no longer matches.`,
          remediation: "Review the artifact before accepting or regenerating the proposal.",
        }));
      }
    } catch (error) {
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

function lockHealthFromDiagnostics(initial: ConsumerInspection["lockHealth"], diagnostics: readonly Diagnostic[]): ConsumerInspection["lockHealth"] {
  if (initial === "invalid" || diagnostics.some((item) => item.code === "PAVED_LOCK_INVALID")) return "invalid";
  if (initial === "missing") return "missing";
  if (diagnostics.some((item) => item.code.startsWith("PAVED_LOCK_"))) return "mismatch";
  return initial;
}

function entryChanged(previous: ResolvedLockEntry | undefined, next: UpdateLockEntry | undefined): boolean {
  if (!previous || !next) return previous !== next;
  return previous.version !== next.version || previous.source !== next.source || previous.sha256 !== next.sha256;
}

function entriesChanged(previous: readonly ResolvedLockEntry[] | undefined, next: readonly UpdateLockEntry[] | undefined): boolean {
  const before = new Map((previous ?? []).filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
  const after = new Map((next ?? []).filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
  if (before.size !== after.size) return true;
  for (const [id, entry] of after) {
    if (entryChanged(before.get(id), entry)) return true;
  }
  return false;
}

function updateStatusDiagnostics(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.category !== "findings");
}

function candidateCompatibility(previous: string | undefined, next: string): "compatible" | "unknown" {
  if (!previous || previous === next) return "compatible";
  const before = previous.split(".").map(Number);
  const after = next.split(".").map(Number);
  // For pre-1.0 Core, only patch movement within the same minor line has a
  // compatibility claim. A broader move needs explicit migration evidence.
  return before[0] === after[0] && before[1] === after[1] ? "compatible" : "unknown";
}

function validateConsumerDocuments(registry: SchemaRegistry, projectRoot: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const directory of ["project", "rules", "skills", "workflows", "tools", "tool-implementations", "verification/checks"]) {
    walkFiles(join(projectRoot, ".paved", directory), (full) => {
      if (!/\.(yaml|yml|md)$/.test(full)) return;
      if (full.endsWith("SKILL.md") || full.endsWith("WORKFLOW.md")) return;
      const path = relative(projectRoot, full).split(sep).join("/");
      try {
        const doc = full.endsWith(".md") ? loadMarkdown(full).frontmatter : loadYaml(full);
        const validation = registry.validate(doc);
        if (validation.valid) return;
        diagnostics.push(diagnostic({ code: "PAVED_UPDATE_MIGRATION_REQUIRED", component: "consumer.documents", category: "config",
          message: `${path} does not validate against the candidate Core: ${validation.errors.join("; ")}`,
          remediation: "Review and migrate this project-owned document before updating; Paved will not rewrite it automatically." }));
      } catch {
        diagnostics.push(diagnostic({ code: "PAVED_UPDATE_MIGRATION_REQUIRED", component: "consumer.documents", category: "config",
          message: `${path} cannot be parsed under the candidate Core.`, remediation: "Repair or migrate the document before updating." }));
      }
    });
  }
  return diagnostics;
}

function updateLockGenerators(
  lock: LockDocument,
  coreRoot: string,
  generators: readonly GeneratorContract[],
): { entries: UpdateLockEntry[]; changedIds: string[] } {
  const lockedById = new Map((lock.generators ?? []).filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
  const changedIds: string[] = [];
  const entries = generators.map((local) => {
    const next = {
      id: local.id,
      version: local.version,
      source: "local-core",
      sha256: hashLocalTree(coreRoot, [`generators/${local.id}`]),
    };
    const locked = lockedById.get(local.id);
    if (entryChanged(locked, next)) changedIds.push(local.id);
    return next;
  });
  return { entries, changedIds: changedIds.sort() };
}

function staleGeneratorIds(projectRoot: string, coreRoot: string, resolved: readonly Detection[], manifest: ProjectManifest): string[] {
  const path = join(projectRoot, ".paved/generated/state/last-run.json");
  if (!existsSync(path)) return [];
  let executions: { generator?: string; outputs?: string[]; sources?: { path?: string; sha256?: string }[];
    contractSha256?: string; engineSha256?: string; manifestSha256?: string }[];
  try { executions = (JSON.parse(readFileSync(path, "utf8")) as { executions?: typeof executions }).executions ?? []; }
  catch { return []; }
  const sources = discoverSources(projectRoot);
  const evidence = capabilityEvidence(projectRoot, sources, [...resolved], manifest.capability_providers).evidence;
  const byPath = new Map(sources.map((source) => [source.path, source.sha256]));
  const engineDigest = hashLocalTree(coreRoot, ["manifest.yaml", "cli/lib/generator-runtime.ts", "schemas/project-context.schema.yaml", "schemas/feature.schema.yaml", "schemas/provenance.schema.yaml"]);
  const manifestDigest = hashFile(join(projectRoot, ".paved/manifest.yaml"));
  return executions.filter((execution) => {
    if (!execution.generator || !execution.outputs?.length) return false;
    if (execution.outputs.some((output) => !existsSync(safe(projectRoot, output)))) return true;
    if (execution.contractSha256 !== hashLocalTree(coreRoot, [`generators/${execution.generator}`]) ||
      execution.engineSha256 !== engineDigest || execution.manifestSha256 !== manifestDigest) return true;
    const cited = new Set((execution.sources ?? []).map((source) => source.path));
    if ((execution.sources ?? []).some((source) => byPath.get(source.path ?? "") !== source.sha256)) return true;
    const currentPaths = [...sourcesFor(execution.generator, sources).map((source) => source.path),
      ...relevantEvidenceFor(execution.generator, evidence).map((item) => item.source.path)];
    return currentPaths.some((path) => !cited.has(path));
  }).map((execution) => execution.generator as string).sort();
}

export function planConsumerUpdate(input: PlanConsumerUpdateInput): ConsumerUpdatePlan {
  const diagnostics: Diagnostic[] = [];
  const registry = createRegistry(join(input.coreRoot, "schemas"), ["paved/v1"]);
  const core = loadCoreManifest(input.coreRoot, registry, diagnostics);
  const manifestPath = input.manifestPath ?? join(input.projectRoot, ".paved/manifest.yaml");
  const manifest = existsSync(manifestPath)
    ? readValidated<ProjectManifest>(registry, manifestPath, "PAVED_MANIFEST_INVALID", "consumer.manifest", diagnostics)
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
  if (compatibility === "unknown") diagnostics.push(diagnostic({ code: "PAVED_UPDATE_COMPATIBILITY_UNKNOWN",
    component: "cli.update", category: "resolution",
    message: `No local migration evidence proves Core ${lockResult.lock.core?.version} can update to ${core.version}.`,
    remediation: "Use a compatible Core patch or provide an explicit migration before updating." }));
  diagnostics.push(...validateConsumerDocuments(registry, input.projectRoot));

  let resolvedAdapters: Detection[] = [];
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
  } catch (error) {
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
      currentLock: lockResult.lock,
      selectedAdapters: manifest.adapters?.map((adapter) => adapter.id).sort() ?? [],
      resolvedAdapters: resolvedAdapters.map((detection) => detection.adapter.id).sort(),
      diagnostics,
    };
  }

  const generatorPlan = updateLockGenerators(lockResult.lock, input.coreRoot, generators);
  const nextLock: UpdateLockDocument = {
    apiVersion: "paved/v1",
    kind: "Lock",
    resolved_at: new Date().toISOString(),
    core: {
      version: core.version,
      source: "local-core",
      sha256: hashLocalCore(input.coreRoot),
    },
    adapters: resolvedAdapters.map((detection) => ({
      id: detection.adapter.id,
      version: detection.adapter.version,
      source: "local-core",
      sha256: hashLocalTree(input.coreRoot, [`adapters/${detection.adapter.id}`]),
    })),
    ...(generatorPlan.entries === undefined ? {} : { generators: generatorPlan.entries }),
  };

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
  const lockChanged = coreChanged || adaptersChanged || generatorsChanged;
  const staleIds = staleGeneratorIds(input.projectRoot, input.coreRoot, resolvedAdapters, manifest);
  const priorAdapters = new Map((lockResult.lock.adapters ?? []).filter((entry) => entry.id).map((entry) => [entry.id as string, entry]));
  const nextAdapters = new Map((nextLock.adapters ?? []).filter((entry) => entry.id).map((entry) => [entry.id as string, entry]));
  const changedAdapterIds = [...new Set([...priorAdapters.keys(), ...nextAdapters.keys()])]
    .filter((id) => entryChanged(priorAdapters.get(id), nextAdapters.get(id))).sort();
  const plannedGeneratorIds = impactedGenerators(generators, [...generatorPlan.changedIds, ...staleIds], changedAdapterIds, input.projectRoot);
  const changed = lockChanged || plannedGeneratorIds.length > 0;

  return {
    projectRoot: input.projectRoot,
    coreRoot: input.coreRoot,
    remoteResolution: "unsupported",
    changed,
    compatibility: diagnostics.some((item) => item.code === "PAVED_UPDATE_MIGRATION_REQUIRED") ? "migration-required"
      : diagnostics.some((item) => item.code === "PAVED_MANIFEST_CORE_INCOMPATIBLE" || item.code === "PAVED_ADAPTER_INCOMPATIBLE") ? "incompatible"
      : compatibility,
    plannedWrites: lockChanged ? [".paved/paved.lock"] : [],
    plannedGeneratorIds,
    currentLock: lockResult.lock,
    nextLock,
    selectedAdapters: manifest.adapters?.map((adapter) => adapter.id).sort() ?? [],
    resolvedAdapters: resolvedAdapters.map((detection) => detection.adapter.id).sort(),
    diagnostics,
  };
}

export function inspectConsumer(input: InspectConsumerInput): ConsumerInspection {
  const diagnostics: Diagnostic[] = [];
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
      verificationProfile: "missing",
      proposals: [],
      conflicts: [],
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
      verificationProfile: "missing",
      proposals: [],
      conflicts: [],
      diagnostics,
    };
  }

  const manifest = readValidated<ProjectManifest>(registry, manifestPath, "PAVED_MANIFEST_INVALID", "consumer.manifest", diagnostics);
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
  const coreDigestMatches = compareCoreLock(lockResult.lock, core, input.coreRoot, diagnostics);
  const generators = discoverGenerators(input.coreRoot, registry, diagnostics);
  compareGeneratorLocks(lockResult.lock, input.coreRoot, generators, diagnostics);

  let detectedAdapters: Detection[] = [];
  let resolvedAdapters: Detection[] = [];
  let adapterEvidence: AdapterEvidence[] = [];
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
      const capabilities = capabilityEvidence(input.projectRoot, sources, resolvedAdapters, manifest.capability_providers);
      adapterEvidence = capabilities.evidence;
      for (const item of Object.values(capabilities.resolutions).flatMap((resolution) => resolution.diagnostics)) {
        if (item.code === "missing-provider") continue;
        const mapped = mapAdapterDiagnostic(item.code);
        diagnostics.push(diagnostic({
          code: mapped.code,
          component: "consumer.capabilities",
          category: mapped.category,
          message: item.message,
          remediation: "Set manifest capability_providers for ambiguous capabilities or adjust selected adapters.",
        }));
      }
    } catch (error) {
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
  if (manifest) diagnostics.push(...inspectOverrides(input.projectRoot, input.coreRoot, selectedAdapters.map((adapter) => adapter.id)));
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
    verificationProfile: profile,
    ...(lastRun === undefined ? {} : { lastRun }),
    proposals: lastRun?.proposals ?? [],
    conflicts: lastRun?.conflicts ?? [],
    diagnostics,
  };
}
