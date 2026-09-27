import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { createDiagnostic, type Diagnostic } from "../result.ts";
import { capabilityEvidence, detectAdapters, loadAdapters, resolveAdapters, type Detection } from "./adapters.ts";
import { loadYaml, loadMarkdown } from "./documents.ts";
import { discoverSources } from "./generator-runtime.ts";
import { hashLocalCore, hashLocalTree } from "./local-core.ts";
import { assessProvenance } from "./provenance.ts";
import { createRegistry, type SchemaRegistry } from "./schemas.ts";
import { compatible } from "./tools.ts";

export interface InspectConsumerInput {
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly manifestPath?: string;
  readonly adapterSelections?: readonly string[];
}

export interface ConsumerInspection {
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly initialized: boolean;
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
  readonly core?: ResolvedLockEntry;
  readonly adapters?: readonly ResolvedLockEntry[];
  readonly generators?: readonly ResolvedLockEntry[];
}

interface GeneratorContract {
  readonly id: string;
  readonly version: string;
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
  if (!lock?.generators?.length) return;
  const localById = new Map(generators.map((generator) => [generator.id, generator]));
  for (const locked of lock.generators) {
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

function inspectLastRun(projectRoot: string, diagnostics: Diagnostic[]): ConsumerInspection["lastRun"] {
  const path = join(projectRoot, ".paved/generated/state/last-run.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { executions?: unknown };
    const executions = Array.isArray(parsed.executions) ? parsed.executions : [];
    const proposals: string[] = [];
    const conflicts: string[] = [];
    for (const item of executions) {
      if (item === null || typeof item !== "object") continue;
      const execution = item as { generator?: unknown; status?: unknown; proposals?: unknown };
      if (Array.isArray(execution.proposals)) {
        proposals.push(...execution.proposals.filter((proposal): proposal is string => typeof proposal === "string"));
      }
      if (execution.status === "conflict" && typeof execution.generator === "string") {
        conflicts.push(execution.generator);
      }
    }
    if (proposals.length > 0) {
      diagnostics.push(diagnostic({
        code: "PAVED_GENERATOR_PROPOSALS_PENDING",
        component: "consumer.generated",
        category: "findings",
        message: `${proposals.length} generated proposal(s) are pending review.`,
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
      proposals: proposals.filter((proposal, index) => proposals.indexOf(proposal) === index),
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
    return { present: true, proposals: [], conflicts: [] };
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
    if (existsSync(sourcePath) && hashFile(sourcePath) !== entry.sha256) {
      diagnostics.push(diagnostic({
        code: "PAVED_GENERATED_SOURCE_STALE",
        component: "consumer.generated",
        category: "findings",
        message: `${path} cites a source file whose digest has changed: ${entry.location}.`,
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
      initialized: true,
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
  const lastRun = inspectLastRun(input.projectRoot, diagnostics);
  inspectGeneratedProvenance(registry, input.projectRoot, diagnostics);

  return {
    projectRoot: input.projectRoot,
    coreRoot: input.coreRoot,
    initialized: true,
    ...(manifest?.project?.name === undefined ? {} : { projectName: manifest.project.name }),
    core: {
      ...(core?.version === undefined ? {} : { localVersion: core.version }),
      ...(manifest?.paved?.core === undefined ? {} : { requestedRange: manifest.paved.core }),
      ...(lockResult.lock?.core?.version === undefined ? {} : { lockedVersion: lockResult.lock.core.version }),
      ...(coreDigestMatches === undefined ? {} : { lockDigestMatches: coreDigestMatches }),
    },
    lockHealth: lockHealthFromDiagnostics(lockResult.health, diagnostics),
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
