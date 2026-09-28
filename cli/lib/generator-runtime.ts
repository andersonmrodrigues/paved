import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { createRegistry } from './schemas.ts';
import { loadMarkdown } from './documents.ts';
import { assessProvenance } from './provenance.ts';
import { loadAdapters, detectAdapters, resolveAdapters, capabilityEvidence, type AdapterEvidence, type Detection, type Diagnostic } from './adapters.ts';
import { hashLocalCore, hashLocalTree } from './local-core.ts';
import { atomicWriteFileSync } from './atomic-write.ts';
import { acquireConsumerOperationLock } from './operation-lock.ts';
import { resolveSafePath } from './safe-path.ts';

export interface Source { path: string; kind: string; sha256: string; adapter?: string; adapterVersion?: string; capability?: string; detectionConfidence?: Detection['confidence']; detectionEvidence?: string[]; classification?: 'observed'; adapterEvidence?: { adapter: string; adapter_version: string; capability: string; detection_confidence: Detection['confidence']; classification: 'observed' }[] }
export interface Execution { generator: string; version: string; contractSha256?: string; engineSha256?: string; manifestSha256?: string; status: 'written' | 'unchanged' | 'conflict' | 'proposed' | 'failed'; sources: Source[]; outputs: string[]; outputHashes: Record<string, string>; proposals: string[]; unknowns: string[]; warnings: string[]; errors: string[] }
export interface RunResult { executionId: string; timestamp: string; coreVersion: string; consumer: string; sourceRevision?: string; unmatchedTechnologies: string[]; unmodeledTechnologies: string[]; adapterWarnings: string[]; adapterDiagnostics: Diagnostic[]; detectedAdapters: { id: string; confidence: string; evidence: string[] }[]; selectedAdapters: string[]; capabilityResolutions: Record<string, string>; adapterEvidence: AdapterEvidence[]; executions: Execution[]; errors: string[] }
export interface LockEntry { id?: string; version: string; source: string; sha256: string }
export interface GenerationLock { core: LockEntry; adapters?: readonly LockEntry[]; generators?: readonly LockEntry[] }
export interface RunGeneratorOptions { dryRun?: boolean; generators?: string[]; lock?: GenerationLock }
export interface ConsumerInitializationPlan { manifest: Record<string, unknown>; lock: Record<string, unknown>; selectedAdapters: string[]; resolvedAdapters: string[]; adapterDiagnostics: Diagnostic[]; plannedWrites: string[] }
type Registry = ReturnType<typeof createRegistry>;
interface Contract { apiVersion: string; kind: 'Generator'; id: string; version: string; status: string; summary: string; depends_on?: string[]; inputs: unknown[]; outputs: { path: string; format: string; metadata: string; schema?: string }[]; change_detection: unknown }
interface Output { path: string; content: string; schema: string }
type WriteOutputStatus = 'written' | 'unchanged' | 'conflict' | 'proposed';
interface WriteOutputResult { status: WriteOutputStatus; finalContent: string; sha256: string }
export const IGNORED_SOURCE_ENTRY_NAMES = ['.git', '.paved', '.paved-operation-lock', '.claude', '.agents', '.superpowers', 'node_modules', 'target', 'dist', 'build', '.angular', '.next', '.venv', 'venv', '.worktrees', 'coverage'] as const;
const ignoredSourceEntryNames = new Set<string>(IGNORED_SOURCE_ENTRY_NAMES);
export function isIgnoredSourceEntry(name: string): boolean { return name.startsWith('.env') || ignoredSourceEntryNames.has(name); }
const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
function outputHash(schema: string, content: string): string {
  if (schema === 'ContextDocument') return sha(content.slice(content.indexOf('\n---\n') + 5));
  return sha(content);
}
function safe(root: string, path: string) { return resolveSafePath(root, path); }
export function hashSource(root: string, path: string) { return sha(readFileSync(safe(root, path))); }
export function discoverSources(root: string): Source[] {
  const result: Source[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isIgnoredSourceEntry(entry.name) || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !/\.(md|txt|yaml|yml|json|xml|properties|java|ts|tsx|js|jsx|sql|gradle|kts|sh|py|dart|toml)$/i.test(entry.name) || statSync(full).size > 1024 * 1024) continue;
      const path = relative(root, full).split(sep).join('/');
      const kind = /README|docs\//i.test(path) ? 'documentation' : /(^|\/)(test|tests|integration_test)\//.test(path) || /\.spec\./.test(path) ? 'test' : /\.gitlab-ci|\.github\/workflows/.test(path) ? 'ci' : /package\.json$|package-lock\.json$|pubspec\.yaml$|tsconfig(?:\.[^/]+)?\.json$|pom\.xml$|angular\.json$/.test(path) ? 'manifest' : /application\.|analysis_options\.yaml$|\.properties$/.test(path) ? 'configuration' : /Dockerfile|compose/.test(path) ? 'infrastructure' : 'source-module';
      result.push({ path, kind, sha256: hashSource(root, path) });
    }
  }
  walk(root); return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function validate(registry: Registry, doc: unknown) { const result = registry.validate(doc); if (!result.valid) throw new Error(result.errors.join('; ')); }
function coreManifest(core: string) { return parse(readFileSync(join(core, 'manifest.yaml'), 'utf8')) as { version: string; consumer_layout: { path: string; ownership: string }[] }; }
function revision(root: string) { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; } }
function unmatchedTechnologies(sources: Source[]): string[] {
  const paths = sources.map(s => s.path);
  const result: string[] = [];
  if (paths.some(p => p.endsWith('package.json'))) result.push('Node.js package scripts');
  if (paths.some(p => /\.gitlab-ci\.yml$/.test(p))) result.push('GitLab CI');
  if (paths.some(p => p.startsWith('.github/workflows/'))) result.push('GitHub Actions');
  return result;
}
export function planConsumerInitialization(core: string, consumer: string, name: string): ConsumerInitializationPlan {
  const registry = createRegistry(join(core, 'schemas'), ['paved/v1']); const version = coreManifest(core).version;
  const detected = detectAdapters(consumer, loadAdapters(core), discoverSources(consumer));
  const adapters = detected.filter(d => d.confidence === 'strong' || (d.adapter.id === 'infrastructure/git' && d.confidence !== 'unknown')).map(d => d.adapter);
  const manifest = { apiVersion: 'paved/v1', kind: 'Project', project: { name }, paved: { core: `^${version}` }, adapters: adapters.map(a => ({ id: a.id, version: `^${a.version}` })) };
  validate(registry, manifest);
  const selected = resolveAdapters(detected, manifest.adapters, version);
  const generators = loadContracts(core, registry).map(c => ({ id: c.id, version: c.version, source: 'local-core', sha256: hashLocalTree(core, [`generators/${c.id}`]) }));
  const lock = { apiVersion: 'paved/v1', kind: 'Lock', resolved_at: new Date().toISOString(), core: { version, source: 'local-core', sha256: hashLocalCore(core) }, adapters: selected.adapters.map(d => ({ id: d.adapter.id, version: d.adapter.version, source: 'local-core', sha256: hashLocalTree(core, [`adapters/${d.adapter.id}`]) })), generators };
  validate(registry, lock);
  return { manifest, lock, selectedAdapters: manifest.adapters.map(a => a.id).sort(), resolvedAdapters: selected.adapters.map(d => d.adapter.id).sort(), adapterDiagnostics: selected.diagnostics, plannedWrites: ['.paved/manifest.yaml', '.paved/paved.lock', '.paved/.gitignore'] };
}
export function initializeConsumer(core: string, consumer: string, name: string) {
  const registry = createRegistry(join(core, 'schemas'), ['paved/v1']); const version = coreManifest(core).version;
  const detected = detectAdapters(consumer, loadAdapters(core), discoverSources(consumer));
  const adapters = detected.filter(d => d.confidence === 'strong' || (d.adapter.id === 'infrastructure/git' && d.confidence !== 'unknown')).map(d => d.adapter);
  const dir = join(consumer, '.paved'); mkdirSync(dir, { recursive: true });
  const manifest = { apiVersion: 'paved/v1', kind: 'Project', project: { name }, paved: { core: `^${version}` }, adapters: adapters.map(a => ({ id: a.id, version: `^${a.version}` })) };
  const path = join(dir, 'manifest.yaml'); if (existsSync(path)) validate(registry, parse(readFileSync(path, 'utf8'))); else { validate(registry, manifest); atomicWriteFileSync(path, stringify(manifest)); }
  const effectiveManifest = parse(readFileSync(path, 'utf8')) as { adapters?: { id: string; version: string }[] };
  const selected = resolveAdapters(detected, effectiveManifest.adapters ?? [], version);
  const generators = loadContracts(core, registry).map(c => ({ id: c.id, version: c.version, source: 'local-core', sha256: hashLocalTree(core, [`generators/${c.id}`]) }));
  const lock = { apiVersion: 'paved/v1', kind: 'Lock', resolved_at: new Date().toISOString(), core: { version, source: 'local-core', sha256: hashLocalCore(core) }, adapters: selected.adapters.map(d => ({ id: d.adapter.id, version: d.adapter.version, source: 'local-core', sha256: hashLocalTree(core, [`adapters/${d.adapter.id}`]) })), generators };
  const lockPath = join(dir, 'paved.lock');
  if (existsSync(lockPath)) {
    const previous = parse(readFileSync(lockPath, 'utf8')) as typeof lock; validate(registry, previous);
    const same = JSON.stringify({ core: previous.core, adapters: previous.adapters, generators: previous.generators }) === JSON.stringify({ core: lock.core, adapters: lock.adapters, generators: lock.generators });
    if (!same) { if (previous.core.source !== 'local-core') throw new Error('Existing lock uses a different distribution source'); validate(registry, lock); atomicWriteFileSync(lockPath, stringify(lock)); }
  } else { validate(registry, lock); atomicWriteFileSync(lockPath, stringify(lock)); }
  const ignore = join(dir, '.gitignore'); if (!existsSync(ignore)) atomicWriteFileSync(ignore, '/generated/\n');
  return manifest;
}
function loadContracts(core: string, registry: Registry): Contract[] {
  const found: Contract[] = [];
  function walk(dir: string) { for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.name === 'runtime') continue; const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name === 'generator.yaml') { const c = parse(readFileSync(path, 'utf8')) as Contract; validate(registry, c); found.push(c); } } }
  walk(join(core, 'generators')); return found.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
function ordered(contracts: Contract[]) { const map = new Map(contracts.map(c => [c.id, c])); const active = new Set<string>(); const done = new Set<string>(); const out: Contract[] = []; function visit(id: string) { if (done.has(id)) return; if (active.has(id)) throw new Error(`Dependency cycle: ${id}`); const c = map.get(id); if (!c) throw new Error(`Missing generator dependency: ${id}`); active.add(id); for (const d of c.depends_on ?? []) visit(d); active.delete(id); done.add(id); out.push(c); } for (const c of contracts) visit(c.id); return out; }
const patterns: Record<string, RegExp> = {
  'project-context/architecture': /pom\.xml$|package\.json$|angular\.json$|Dockerfile|compose|\.gitlab-ci|README|app-routing\.module\.ts$/i,
  'project-context/domain': /\/domain\/.*\.java$|\/model\/.*\.java$|\/migration\/|\.sql$|README/i,
  'project-context/product': /README|\/docs\/|routing\.module\.ts$|permission|role/i,
  'project-context/integrations': /pom\.xml$|package\.json$|application\..*|environment\..*|Dockerfile|compose/i,
  'project-context/feature-map': /app-routing\.module\.ts$|Resource\.java$|Controller\.java$|\.spec\.ts$|src\/test\//i,
  verification: /pom\.xml$|package\.json$|\.gitlab-ci|\.github\/workflows|README/i,
  rules: /checkstyle|eslint|tslint|pom\.xml$|CONTRIBUTING|\/decisions\/|\/adr\//i,
  skills: /CONTRIBUTING|runbook|how-to|README|\/scripts\//i,
  tools: /package\.json$|pom\.xml$|\/scripts\/|Makefile|README/i,
};
export function sourcesFor(id: string, all: Source[]): Source[] {
  if (id === 'project-context/architecture') return all.filter(s => s.kind === 'manifest' || s.path === 'README.md').slice(0, 80);
  if (id === 'project-context/domain') return all.filter(s => s.path === 'README.md').slice(0, 20);
  if (id === 'project-context/product') return all.filter(s => /(^|\/)README\.md$/.test(s.path)).slice(0, 25);
  if (id === 'project-context/integrations') return all.filter(s => s.kind === 'configuration' || ['api.http', 'api.openapi'].includes(s.capability ?? '')).slice(0, 30);
  if (id === 'project-context/feature-map') return [];
  return all.filter(s => patterns[id]?.test(s.path) ?? false).slice(0, 80);
}
export function relevantEvidenceFor(id: string, evidence: readonly AdapterEvidence[]): AdapterEvidence[] {
  return evidence.filter(e => id.endsWith('/architecture') ? ['source.build','source.dependencies','application.runtime','application.modules','database.configuration'].includes(e.capability)
    : id.endsWith('/domain') ? ['source.structure','database.migrations'].includes(e.capability)
    : id.endsWith('/integrations') ? ['application.http-routes','application.ui-routes','database.configuration','api.http','api.openapi'].includes(e.capability)
    : id.endsWith('/feature-map') ? ['application.ui-routes','application.http-routes'].includes(e.capability)
    : id.endsWith('/product') ? e.capability === 'application.ui-routes'
    : id === 'verification' ? ['source.test', 'testing.structure'].includes(e.capability) : false);
}
function provenance(contract: Contract, sources: Source[], at: string, rev: string | undefined, hash: string) { return { generator: contract.id, generator_version: contract.version, generated_at: at, ...(rev ? { source_revision: rev } : {}), sources: sources.map((s, i) => ({ id: `s${i + 1}`, type: 'file', location: s.path, sha256: s.sha256, ...(s.adapter ? { adapter: s.adapter, adapter_version: s.adapterVersion, capability: s.capability, detection_confidence: s.detectionConfidence, detection_evidence: [...(s.detectionEvidence ?? [])], classification: s.classification, adapter_evidence: s.adapterEvidence?.map(e => ({ ...e })) } : {}) })), output_sha256: hash, review: { status: 'unreviewed' } }; }
function context(contract: Contract, sources: Source[], evidence: AdapterEvidence[], root: string, at: string, rev: string | undefined): { output: Output; unknowns: string[] } {
  const area = contract.id.split('/')[1] ?? ''; const lines: string[] = []; const unknowns: string[] = [];
  const cite = (s: Source) => `s${sources.indexOf(s) + 1}`;
  if (area === 'architecture') {
    lines.push('## Implemented structure');
    for (const s of sources.filter(s => s.kind === 'manifest')) lines.push(`- ${s.path} (${s.kind}; ${cite(s)}).`);
    lines.push('', '## Declared structural evidence');
    lines.push('', '## Documented architectural constraints', 'No constraint was classified from the selected documentation by this generic extractor.');
    lines.push('', '## Mechanically enforced boundaries', 'No architecture check was classified from the selected build and CI files by this generic extractor.');
    lines.push('', '## Intended boundaries', 'No architectural recommendation is derived from source layout alone.');
    unknowns.push('Intended component boundaries', 'Documented architectural constraints', 'Enforced architecture checks');
  } else if (area === 'domain') {
    lines.push('## Selected implemented entity declarations');
    for (const item of evidence.slice(0, 120)) { const source = sources.find(s => s.path === item.source.path); if (source) lines.push(`- ${item.statement}${item.value ? `: ${item.value}` : ''} (${source.path}; ${cite(source)}).`); }
    unknowns.push('Business meaning of models');
  } else if (area === 'product') {
    lines.push('## Documented product');
    for (const s of sources.filter(s => /README|\/docs\//i.test(s.path)).slice(0, 15)) { const heading = readFileSync(safe(root, s.path), 'utf8').split(/\r?\n/).find(l => /^#\s+/.test(l)); if (heading && !/secret|token|password|key/i.test(heading)) lines.push(`- ${heading.replace(/^#+\s*/, '').slice(0, 100)} (${s.path}; ${cite(s)}).`); }
    lines.push('', '## Implemented navigation');
    for (const item of evidence.filter(e => e.capability === 'application.ui-routes').slice(0, 40)) { const source = sources.find(s => s.path === item.source.path); if (source) lines.push(`- ${item.value} (${source.path}; ${cite(source)}).`); }
    unknowns.push('Product goals and expected behavior');
  } else {
    lines.push('## Implemented integration signals');
    lines.push('', '## Configuration keys (values omitted)');
    for (const s of sources.filter(s => /application\.properties$/.test(s.path))) {
      const keys = readFileSync(safe(root, s.path), 'utf8').split(/\r?\n/).map(l => /^([A-Za-z0-9_.%-]+)\s*=/.exec(l)?.[1]).filter((key): key is string => Boolean(key) && !/secret|token|password|credential|private|api.?key/i.test(key ?? '')).filter(key => /datasource|mailer|s3|storage|oauth|oidc|http|url/i.test(key)).slice(0, 25);
      if (keys.length) lines.push(`- ${s.path}: ${keys.join(', ')} (${cite(s)}).`);
    }
    unknowns.push('Integration purpose and runtime configuration');
  }
  if (evidence.length) { lines.push('', '## Adapter evidence'); for (const item of evidence.slice(0, 100)) { const source = sources.find(s => s.path === item.source.path); if (source) lines.push(`- ${item.statement}${item.value ? `: ${item.value}` : ''} (${item.source.path}; ${cite(source)}).`); } }
  if (!lines.some(l => l.startsWith('- '))) lines.push('- No supported statement was extracted.');
  const body = `<!-- paved:begin generated id=observations sources=${sources.map(cite).join(',')} confidence=observed -->\n${lines.join('\n')}\n<!-- paved:end generated -->\n`;
  const doc = { apiVersion: 'paved/v1', kind: 'ContextDocument', area, title: `${area[0]?.toUpperCase() ?? ''}${area.slice(1)} observations`, confidence: 'observed', unknowns: unknowns.map(topic => ({ topic, reason: 'Repository evidence does not establish intent or business meaning.', question: `Can a project owner clarify ${topic.toLowerCase()}?` })), provenance: provenance(contract, sources, at, rev, sha(body)) };
  return { output: { path: `.paved/project/${area}/overview.md`, content: `---\n${stringify(doc)}---\n${body}`, schema: 'ContextDocument' }, unknowns };
}
function features(contract: Contract, sources: Source[], evidence: AdapterEvidence[], at: string, rev: string | undefined): Output[] {
  const outputs: Output[] = []; const ids = new Set<string>();
  for (const item of evidence.filter(e => e.capability === 'application.ui-routes' && e.value)) {
    const s = sources.find(source => source.path === item.source.path); if (!s) continue;
    const app = s.path.split('/')[0] ?? 'app'; const route = item.value!;
    const id = `${app}-${route}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/g, ''); if (ids.has(id)) continue; ids.add(id);
    const doc: Record<string, unknown> = { apiVersion: 'paved/v1', kind: 'Feature', id, name: route, summary: `Observed UI route '${route}'. Product purpose is unconfirmed.`, status: 'active', confidence: 'observed', code: { paths: [s.path], entrypoints: [{ kind: 'ui', name: route, location: { path: s.path }, confidence: 'observed' }] }, unknowns: [{ topic: 'Product purpose', reason: 'A route does not establish intended product behavior.', question: `What is the intended purpose of '${route}'?` }] };
    doc.provenance = provenance(contract, [s], at, rev, sha(stringify(doc)));
    outputs.push({ path: `.paved/project/feature-map/${id}.yaml`, content: stringify(doc), schema: 'Feature' });
  }
  return outputs;
}
function verificationProposal(contract: Contract, sources: Source[], evidence: AdapterEvidence[], root: string, at: string, rev: string | undefined): Output[] {
  const profile = { apiVersion: 'paved/v1', kind: 'VerificationProfile', checks: [] };
  const observations: string[] = [];
  for (const s of sources.filter(s => /package\.json$/.test(s.path))) {
    try {
      const pkg = JSON.parse(readFileSync(safe(root, s.path), 'utf8')) as { scripts?: Record<string, unknown> };
      for (const name of Object.keys(pkg.scripts ?? {}).sort()) if (/^[a-z0-9:_-]+$/i.test(name) && !/secret|token|password|credential|key/i.test(name)) observations.push(`# Observed script: ${s.path} -> npm run ${name}`);
    } catch { /* malformed package manifests contribute no command observation */ }
  }
  for (const item of evidence.filter(e => e.capability === 'source.test').slice(0, 30)) observations.push(`# Observed test configuration: ${item.statement} (${item.source.path})`);
  const path = '.paved/generated/proposals/verification/profile.yaml';
  const content = `# Draft only. Existing commands are observations, not approved checks.\n# A human must create reviewed Tool and Check bindings before adopting this profile.\n${observations.join('\n')}\n${stringify(profile)}`;
  const sidecar = { apiVersion: 'paved/v1', kind: 'GeneratedArtifact', artifact: { path, format: 'yaml', schema: 'VerificationProfile', api_version: 'paved/v1', proposal_for: '.paved/verification/profile.yaml' }, ownership: 'disposable', provenance: provenance(contract, sources, at, rev, sha(content)) };
  return [{ path, content, schema: 'VerificationProfile' }, { path: `${path}.paved.yaml`, content: stringify(sidecar), schema: 'GeneratedArtifact' }];
}
function ruleProposals(contract: Contract, sources: Source[], root: string, at: string, rev: string | undefined): Output[] {
  const outputs: Output[] = [];
  for (const pom of sources.filter(s => /pom\.xml$/.test(s.path))) {
    const text = readFileSync(safe(root, pom.path), 'utf8');
    if (!/maven-checkstyle-plugin/.test(text) || !/<phase>validate<\/phase>/.test(text) || !/<goal>check<\/goal>/.test(text) || !/<configLocation>checkstyle\.xml<\/configLocation>/.test(text) || !/<failOnViolation>true<\/failOnViolation>/.test(text)) continue;
    const config = sources.find(s => s.path === `${dirname(pom.path)}/checkstyle.xml`);
    if (!config) continue;
    const module = dirname(pom.path).replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().replace(/^-|-$/g, '');
    const id = `project.style.${module}`;
    const doc = { apiVersion: 'paved/v1', kind: 'Rule', id, title: `Configured Checkstyle for ${module}`, rationale: `The Maven validate phase binds the Checkstyle check goal using ${config.path}.`, applies_to: { paths: [`${dirname(pom.path)}/src/main/java/**`] }, rule: 'Java source in this module satisfies the configured Checkstyle checks.', enforcement: { mechanism: 'automated', layer: 'static-analysis', check: 'static-analysis' }, severity: 'warning', verification: 'Run the module Maven validate phase and inspect the Checkstyle result.', references: [pom.path, config.path] };
    const path = `.paved/generated/proposals/rules/${module}.yaml`; const content = stringify(doc); const origins = [pom, config];
    const sidecar = { apiVersion: 'paved/v1', kind: 'GeneratedArtifact', artifact: { path, format: 'yaml', schema: 'Rule', api_version: 'paved/v1', proposal_for: `.paved/rules/style/${module}.yaml` }, ownership: 'disposable', provenance: provenance(contract, origins, at, rev, sha(content)) };
    outputs.push({ path, content, schema: 'Rule' }, { path: `${path}.paved.yaml`, content: stringify(sidecar), schema: 'GeneratedArtifact' });
  }
  return outputs;
}
function writeOutput(root: string, output: Output, registry: Registry, info: ReturnType<typeof coreManifest>, generator: string, dryRun = false): WriteOutputResult {
  const result = (status: WriteOutputStatus, finalContent: string): WriteOutputResult => ({ status, finalContent, sha256: outputHash(output.schema, finalContent) });
  const owner = [...info.consumer_layout].sort((a, b) => b.path.length - a.path.length).find(x => output.path.startsWith(x.path))?.ownership;
  if (owner !== 'generated-reviewed' && owner !== 'disposable') throw new Error(`Disallowed output ownership: ${output.path}`);
  const yaml = output.schema === 'ContextDocument' ? parse(output.content.slice(4, output.content.indexOf('\n---\n'))) : parse(output.content);
  validate(registry, yaml);
  if (output.schema === 'ContextDocument') { const body = output.content.slice(output.content.indexOf('\n---\n') + 5); const errors = assessProvenance(yaml, body); if (errors.length) throw new Error(errors.join('; ')); }
  const target = safe(root, output.path);
  const baselinePath = safe(root, `.paved/generated/state/baselines/${sha(output.path)}.json`);
  let finalContent = output.content;
  if (existsSync(target)) {
    const current = readFileSync(target, 'utf8');
    if (current === output.content) return result('unchanged', current);
    const oldDoc = output.schema === 'ContextDocument' ? loadMarkdown(target) : undefined;
    const newBody = output.schema === 'ContextDocument' ? output.content.slice(output.content.indexOf('\n---\n') + 5) : undefined;
    const oldMeta = oldDoc?.frontmatter ?? parse(current) as Record<string, unknown>;
    const newMeta = yaml as Record<string, unknown>;
    const withoutTime = (value: Record<string, unknown>) => {
      const copy = structuredClone(value);
      const p = copy.provenance as Record<string, unknown> | undefined;
      if (p) delete p.generated_at;
      return stringify(copy);
    };
    if ((oldDoc === undefined || oldDoc.body === newBody) && withoutTime(oldMeta) === withoutTime(newMeta)) return result('unchanged', current);
    if (owner === 'generated-reviewed') {
      if (output.schema === 'Feature') {
        const old = parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
        const p = old.provenance as { generator?: string; output_sha256?: string } | undefined;
        const semantic = { ...old }; delete semantic.provenance;
        if (!p || p.generator !== generator || p.output_sha256 !== sha(stringify(semantic))) return result('conflict', finalContent);
        if (dryRun) return result('written', finalContent);
        mkdirSync(dirname(target), { recursive: true }); atomicWriteFileSync(target, finalContent);
        return result('written', finalContent);
      }
      const old = loadMarkdown(target); const p = old.frontmatter.provenance as { generator?: string; output_sha256?: string; review?: { status?: string } } | undefined;
      if (!p || p.generator !== generator || (p.review?.status === 'reviewed' && !old.body.includes('<!-- paved:begin generated'))) return result('conflict', finalContent);
      if (p.output_sha256 !== sha(old.body)) {
        if (!existsSync(baselinePath)) return result('conflict', finalContent);
        const baseline = parse(readFileSync(baselinePath, 'utf8')) as { generator: string; body: string; sha256: string };
        if (baseline.generator !== generator || baseline.sha256 !== sha(baseline.body) || baseline.sha256 !== p.output_sha256) return result('conflict', finalContent);
        const block = /<!-- paved:begin generated [^\n]+ -->\n[\s\S]*?<!-- paved:end generated -->/g;
        const prior = [...baseline.body.matchAll(block)]; const current = [...old.body.matchAll(block)]; const next = [...(newBody ?? '').matchAll(block)];
        if (prior.length !== 1 || current.length !== 1 || next.length !== 1 || prior[0]?.[0] !== current[0]?.[0]) return result('conflict', finalContent);
        const merged = old.body.replace(block, next[0]?.[0] ?? '');
        const front = structuredClone(yaml as Record<string, unknown>);
        const provenance = front.provenance as Record<string, unknown>; provenance.output_sha256 = sha(merged);
        validate(registry, front);
        const problems = assessProvenance(front as Parameters<typeof assessProvenance>[0], merged); if (problems.length) throw new Error(problems.join('; '));
        finalContent = `---\n${stringify(front)}---\n${merged}`;
      }
    }
  }
  if (dryRun) return result(owner === 'disposable' ? 'proposed' : 'written', finalContent);
  mkdirSync(dirname(target), { recursive: true }); atomicWriteFileSync(target, finalContent);
  if (owner === 'generated-reviewed' && output.schema === 'ContextDocument') {
    const body = loadMarkdown(target).body; mkdirSync(dirname(baselinePath), { recursive: true });
    atomicWriteFileSync(baselinePath, stringify({ generator, body, sha256: sha(body) }));
  }
  return result(owner === 'disposable' ? 'proposed' : 'written', finalContent);
}
function selectedContracts(contracts: Contract[], selectors: readonly string[] | undefined): { contracts: Contract[]; errors: string[] } {
  if (!selectors?.length) return { contracts, errors: [] };
  const byId = new Map(contracts.map(contract => [contract.id, contract]));
  const selected = new Set<string>();
  const errors: string[] = [];
  function visit(id: string) {
    const contract = byId.get(id);
    if (!contract) {
      errors.push(`Unknown generator selector: ${id}`);
      return;
    }
    if (selected.has(id)) return;
    for (const dependency of contract.depends_on ?? []) visit(dependency);
    selected.add(id);
  }
  for (const id of selectors) visit(id);
  return errors.length ? { contracts: [], errors } : { contracts: contracts.filter(contract => selected.has(contract.id)), errors: [] };
}
function generationLockErrors(core: string, consumer: string, registry: Registry, coreVersion: string, adapters: Detection[], contracts: Contract[], override?: GenerationLock): string[] {
  const path = join(consumer, '.paved/paved.lock');
  if (!override && !existsSync(path)) return ['.paved/paved.lock is missing; run paved init or paved update before generation.'];
  const lock = override ?? parse(readFileSync(path, 'utf8')) as GenerationLock;
  validate(registry, lock);
  const errors: string[] = [];
  if (lock.core.version !== coreVersion) errors.push(`Lock pins Core ${lock.core.version}, but the local Core is ${coreVersion}. Run paved update after reviewing the change.`);
  if (lock.core.source === 'local-core' && lock.core.sha256 !== hashLocalCore(core)) errors.push('The locked Core digest does not match the locally available Core content. Run paved update after reviewing the change.');
  const lockedAdapters = new Map<string, LockEntry>();
  for (const entry of lock.adapters ?? []) if (entry.id) lockedAdapters.set(entry.id, entry);
  for (const detection of adapters) {
    const locked = lockedAdapters.get(detection.adapter.id);
    if (!locked) {
      errors.push(`Resolved adapter ${detection.adapter.id} is missing from the lock. Run paved update before generation.`);
      continue;
    }
    if (locked.version !== detection.adapter.version) errors.push(`Lock pins ${detection.adapter.id} ${locked.version}, but the local adapter is ${detection.adapter.version}. Run paved update after reviewing the change.`);
    if (locked.source === 'local-core' && locked.sha256 !== hashLocalTree(core, [`adapters/${detection.adapter.id}`])) errors.push(`The locked digest for adapter ${detection.adapter.id} does not match the locally available adapter content. Run paved update after reviewing the change.`);
  }
  const contractsById = new Map(contracts.map(contract => [contract.id, contract]));
  for (const locked of lock.generators ?? []) {
    if (!locked.id) continue;
    const local = contractsById.get(locked.id);
    if (!local) {
      errors.push(`Locked generator ${locked.id} is unavailable in the local Core. Use the locked Core or run paved update.`);
      continue;
    }
    if (locked.version !== local.version) errors.push(`Lock pins generator ${locked.id} ${locked.version}, but the local generator is ${local.version}. Run paved update after reviewing the change.`);
    if (locked.source === 'local-core' && locked.sha256 !== hashLocalTree(core, [`generators/${locked.id}`])) errors.push(`The locked digest for generator ${locked.id} does not match local generator content. Run paved update after reviewing the change.`);
  }
  const lockedGeneratorIds = new Set((lock.generators ?? []).flatMap(entry => entry.id ? [entry.id] : []));
  for (const contract of contracts) {
    if (!lockedGeneratorIds.has(contract.id)) errors.push(`Generator ${contract.id} is missing from the lock. Run paved update before generation.`);
  }
  return errors;
}
function runGeneratorsUnlocked(core: string, consumer: string, options: RunGeneratorOptions = {}): RunResult {
  const registry = createRegistry(join(core, 'schemas'), ['paved/v1']); const info = coreManifest(core);
  const manifest = parse(readFileSync(join(consumer, '.paved/manifest.yaml'), 'utf8')) as { adapters?: { id: string; version: string }[] }; validate(registry, manifest);
  const allSources = discoverSources(consumer); const timestamp = new Date().toISOString(); const sourceRevision = revision(consumer);
  const detected = detectAdapters(consumer, loadAdapters(core), allSources);
  const resolved = resolveAdapters(detected, manifest.adapters ?? [], info.version);
  const capabilities = capabilityEvidence(consumer, allSources, resolved.adapters, (manifest as { capability_providers?: Record<string,string> }).capability_providers);
  const adapterDiagnostics = [...resolved.diagnostics, ...Object.values(capabilities.resolutions).flatMap(r => r.diagnostics).filter(d => d.code !== 'missing-provider')];
  const adapterWarnings = adapterDiagnostics.map(d => d.message);
  const selectedIds = new Set(resolved.adapters.map(d => d.adapter.id));
  const unmatched = unmatchedTechnologies(allSources);
  const result: RunResult = { executionId: sha(`${sourceRevision ?? ''}:${timestamp}`).slice(0, 20), timestamp, coreVersion: info.version, consumer: String((manifest as { project?: { name?: string } }).project?.name ?? ''), ...(sourceRevision ? { sourceRevision } : {}), unmatchedTechnologies: unmatched, unmodeledTechnologies: unmatched, adapterWarnings, adapterDiagnostics, detectedAdapters: detected.filter(d => d.confidence !== 'unknown').map(d => ({ id: d.adapter.id, confidence: d.confidence, evidence: d.evidence })), selectedAdapters: [...selectedIds].sort(), capabilityResolutions: Object.fromEntries(Object.entries(capabilities.resolutions).map(([id, r]) => [id, r.status])), adapterEvidence: capabilities.evidence, executions: [], errors: [] };
  let contracts: Contract[];
  try {
    const orderedContracts = ordered(loadContracts(core, registry));
    const selected = selectedContracts(orderedContracts, options.generators);
    contracts = selected.contracts;
    result.errors.push(...selected.errors);
    if (result.errors.length === 0) result.errors.push(...generationLockErrors(core, consumer, registry, info.version, resolved.adapters, orderedContracts, options.lock));
  } catch (error) { result.errors.push(String(error)); return result; }
  if (result.errors.length) return result;
  const completed = new Set<string>();
  for (const contract of contracts) {
    const entry: Execution = { generator: contract.id, version: contract.version,
      contractSha256: hashLocalTree(core, [`generators/${contract.id}`]),
      engineSha256: hashLocalTree(core, ['manifest.yaml', 'cli/lib/generator-runtime.ts', 'schemas/project-context.schema.yaml', 'schemas/feature.schema.yaml', 'schemas/provenance.schema.yaml']),
      manifestSha256: hashSource(consumer, '.paved/manifest.yaml'),
      status: 'unchanged', sources: [], outputs: [], outputHashes: {}, proposals: [], unknowns: [], warnings: [], errors: [] }; result.executions.push(entry);
    try {
      if ((contract.depends_on ?? []).some(d => !completed.has(d))) throw new Error('Required generator dependency failed');
      const relevant = relevantEvidenceFor(contract.id, capabilities.evidence);
      const sources = sourcesFor(contract.id, allSources).map(source => ({ ...source }));
      for (const item of relevant) if (!sources.some(s => s.path === item.source.path)) sources.push({ ...item.source });
      for (const source of sources) { const matches = relevant.filter(e => e.source.path === source.path); const item = matches[0]; if (item) Object.assign(source, { adapter: item.adapter, adapterVersion: item.adapterVersion, capability: item.capability, detectionConfidence: item.detectionConfidence, detectionEvidence: item.detectionEvidence, classification: item.classification, adapterEvidence: [...new Map(matches.map(e => [`${e.adapter}:${e.capability}`, { adapter: e.adapter, adapter_version: e.adapterVersion, capability: e.capability, detection_confidence: e.detectionConfidence, classification: e.classification }])).values()] }); }
      entry.sources = sources;
      if (!sources.length) {
        entry.warnings.push('No matching source found.');
        if (contract.id === 'project-context/feature-map') {
          entry.unknowns.push('UI and HTTP route evidence');
          completed.add(contract.id);
          continue;
        }
        if (contract.id === 'project-context/integrations') {
          entry.unknowns.push('Integration configuration and route evidence');
          completed.add(contract.id);
          continue;
        }
        if (contract.id.startsWith('project-context/')) throw new Error('Required repository source missing');
      }
      const outputs: Output[] = [];
      if (contract.id.startsWith('project-context/') && !contract.id.endsWith('/feature-map')) { const generated = context(contract, sources, relevant, consumer, timestamp, sourceRevision); outputs.push(generated.output); entry.unknowns = generated.unknowns; }
      else if (contract.id.endsWith('/feature-map')) outputs.push(...features(contract, sources, relevant, timestamp, sourceRevision));
      else if (contract.id === 'verification') outputs.push(...verificationProposal(contract, sources, relevant, consumer, timestamp, sourceRevision));
      else if (contract.id === 'rules') outputs.push(...ruleProposals(contract, sources, consumer, timestamp, sourceRevision));
      else entry.warnings.push('No explicit, schema-safe project policy was established; no proposal emitted.');
      for (const output of outputs) {
        const writeResult = writeOutput(consumer, output, registry, info, contract.id, options.dryRun === true);
        const status = writeResult.status;
        if (status === 'conflict') {
          const path = `.paved/generated/proposals/${output.path.replace(/^\.paved\//, '')}`;
          const proposal = options.dryRun === true ? writeResult : writeOutput(consumer, { ...output, path }, registry, info, contract.id);
          entry.proposals.push(path);
          entry.outputHashes[path] = proposal.sha256;
          entry.status = 'conflict';
        }
        else {
          entry.outputs.push(output.path);
          entry.outputHashes[output.path] = writeResult.sha256;
          if (status === 'proposed') entry.proposals.push(output.path);
          if (entry.status !== 'conflict' && status !== 'unchanged') entry.status = status;
        }
      }
      completed.add(contract.id);
    } catch (error) { entry.status = 'failed'; entry.errors.push(String(error)); result.errors.push(`${contract.id}: ${String(error)}`); }
  }
  if (options.dryRun !== true) {
    const state = join(consumer, '.paved/generated/state'); mkdirSync(state, { recursive: true });
    const path = join(state, 'last-run.json');
    let prior: Execution[] = [];
    if (existsSync(path)) { try { prior = (JSON.parse(readFileSync(path, 'utf8')) as { executions?: Execution[] }).executions ?? []; } catch { /* disposable state */ } }
    const updated = new Set(result.executions.map(e => e.generator));
    const stored = { ...result, executions: [...prior.filter(e => !updated.has(e.generator)), ...result.executions].sort((a, b) => a.generator.localeCompare(b.generator, 'en')) };
    atomicWriteFileSync(path, JSON.stringify(stored, null, 2) + '\n');
  }
  return result;
}

export function runGenerators(core: string, consumer: string, options: RunGeneratorOptions = {}): RunResult {
  if (options.dryRun === true) return runGeneratorsUnlocked(core, consumer, options);
  const release = acquireConsumerOperationLock(consumer, "generate");
  try {
    return runGeneratorsUnlocked(core, consumer, options);
  } finally {
    release();
  }
}
