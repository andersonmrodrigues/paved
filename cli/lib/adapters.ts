import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { createRegistry } from './schemas.ts';
import { compatible } from './tools.ts';

export interface RepositorySource { path: string; kind: string; sha256: string }
export interface EvidenceRule { glob: string; pattern: string; statement: string; capture?: number; requires_siblings?: string[] }
export interface AdapterContract {
  apiVersion: 'paved/v1'; kind: 'Adapter'; id: string; version: string;
  requires: { core: string; adapters?: { id: string; version: string }[] };
  detect: { any_files?: string[]; all_files?: string[]; file_contains?: { glob: string; pattern: string }[]; confidence?: 'strong' | 'medium' };
  provides?: { capabilities?: { id: string; evidence: EvidenceRule[] }[]; tool_implementations?: string[] };
}
// roots are the outermost directories holding the files that established the detection; they define the adapter's repository scopes.
export interface Detection { adapter: AdapterContract; confidence: 'strong' | 'medium' | 'weak' | 'unknown'; evidence: string[]; roots: string[] }
export interface Diagnostic { code: 'missing-adapter' | 'incompatible' | 'dependency' | 'cycle' | 'undetected' | 'ambiguous-provider' | 'missing-provider' | 'invalid-selection'; message: string; id?: string }
export interface AdapterEvidence { adapter: string; adapterVersion: string; capability: string; source: RepositorySource; statement: string; value?: string; detectionConfidence: Detection['confidence']; detectionEvidence: string[]; classification: 'observed' }
export type ProviderSelection = string | readonly { path: string; provider: string }[];
export interface ScopedProvider { scope: string; provider: string; source: 'explicit' | 'explicit-scoped' | 'answered-decision' | 'inferred'; evidence: string[] }
export interface CapabilityResolution { status: 'resolved' | 'explicitly-selected' | 'scoped' | 'ambiguous' | 'unavailable'; provider?: AdapterContract; candidates: string[]; scopes: ScopedProvider[]; ambiguousScopes: string[]; diagnostics: Diagnostic[] }
export interface CapabilityProviderEntry { id: string; status: CapabilityResolution['status']; candidates: string[]; providers: ScopedProvider[]; ambiguous_scopes?: string[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ignored = /^(?:\.|node_modules$|target$|dist$|build$)/;
function globRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/\*\*\//g, '\u0001')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.')
    .replace(/\u0001/g, '(?:.*/)?');
  return new RegExp(`^(?:.*/)?${escaped}$`);
}
function matching(glob: string, sources: RepositorySource[]) { const pattern = globRegex(glob); return sources.filter(s => pattern.test(s.path)); }
function sourceText(root: string, path: string): string | undefined {
  try { return readFileSync(join(root, path), 'utf8'); } catch { return undefined; }
}
export function loadAdapters(core: string): AdapterContract[] {
  const registry = createRegistry(join(core, 'schemas'), ['paved/v1']);
  const capabilityRegistry = parse(readFileSync(join(core, 'core/capabilities/registry.yaml'), 'utf8')) as { capabilities: { id: string }[] };
  const registryValidation = registry.validate(capabilityRegistry);
  if (!registryValidation.valid) throw new Error(`Capability registry: ${registryValidation.errors.join('; ')}`);
  const knownCapabilities = new Set(capabilityRegistry.capabilities.map(c => c.id));
  const base = join(core, 'adapters'); const result: AdapterContract[] = [];
  for (const category of readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory() && !ignored.test(e.name))) {
    for (const entry of readdirSync(join(base, category.name), { withFileTypes: true }).filter(e => e.isDirectory())) {
      const file = join(base, category.name, entry.name, 'adapter.yaml'); if (!existsSync(file)) continue;
      const adapter = parse(readFileSync(file, 'utf8')) as AdapterContract;
      const validation = registry.validate(adapter); if (!validation.valid) throw new Error(`${file}: ${validation.errors.join('; ')}`);
      if (adapter.id !== `${category.name}/${entry.name}`) throw new Error(`${file}: adapter ID does not match directory`);
      const names = adapter.provides?.capabilities?.map(c => c.id) ?? [];
      if (new Set(names).size !== names.length) throw new Error(`${file}: duplicate capability provider`);
      for (const name of names) if (!knownCapabilities.has(name)) throw new Error(`${file}: unknown capability ${name}`);
      result.push(adapter);
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
export function detectAdapters(root: string, adapters: AdapterContract[], sources: RepositorySource[]): Detection[] {
  return adapters.map(adapter => {
    const evidence: string[] = []; const detect = adapter.detect;
    const fileExists = (glob: string) => glob === '.git' ? existsSync(join(root, '.git')) : matching(glob, sources).length > 0;
    const all = detect.all_files?.length ? detect.all_files.every(fileExists) : false;
    const any = detect.any_files?.some(fileExists) ?? false;
    const pathsFor = (glob: string) => glob === '.git' ? ['.git'] : matching(glob, sources).map(s => s.path);
    if (all) evidence.push(...(detect.all_files ?? []).flatMap(pathsFor));
    else if (any) evidence.push(...(detect.any_files ?? []).flatMap(pathsFor));
    const contentEvidence: string[] = [];
    for (const signal of detect.file_contains ?? []) {
      const pattern = new RegExp(signal.pattern, 'm');
      for (const source of matching(signal.glob, sources)) {
        if (pattern.test(sourceText(root, source.path) ?? '')) contentEvidence.push(source.path);
      }
    }
    evidence.push(...contentEvidence);
    const content = contentEvidence.length > 0;
    const confidence = content || (adapter.id === 'infrastructure/git' && any) ? (detect.confidence ?? 'strong') : all ? 'medium' : any ? 'weak' : 'unknown';
    // Content matches are the stronger signal, so they alone define scopes when present.
    const roots = confidence === 'unknown' ? [] : outermost((content ? contentEvidence : evidence).map(directoryOf));
    return { adapter, confidence, evidence: [...new Set(evidence)].sort(), roots };
  });
}
const directoryOf = (path: string) => path === '.git' || !path.includes('/') ? '.' : dirname(path);
const depth = (scope: string) => scope === '.' ? 0 : scope.split('/').length;
const contains = (scope: string, path: string) => scope === '.' || path === scope || path.startsWith(`${scope}/`);
function outermost(directories: string[]): string[] {
  const unique = [...new Set(directories)];
  return unique.filter(dir => !unique.some(other => other !== dir && contains(other, dir))).sort();
}
function normalizeScope(path: string): string {
  const trimmed = path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '.' : trimmed;
}
function dependsOn(dependent: AdapterContract, id: string, byId: Map<string, AdapterContract>, seen = new Set<string>()): boolean {
  for (const dependency of dependent.requires.adapters ?? []) {
    if (dependency.id === id) return true;
    const next = byId.get(dependency.id);
    if (next && !seen.has(next.id)) { seen.add(next.id); if (dependsOn(next, id, byId, seen)) return true; }
  }
  return false;
}
// The providers whose nearest root encloses the scope; when one provider specializes another (requires it), the specialization wins.
function nearestProviders(providers: Detection[], scope: string): Detection[] {
  const claims = providers.flatMap(provider => {
    const depths = provider.roots.filter(root => contains(root, scope)).map(depth);
    return depths.length ? [{ provider, depth: Math.max(...depths) }] : [];
  });
  const deepest = Math.max(...claims.map(claim => claim.depth));
  const top = claims.filter(claim => claim.depth === deepest).map(claim => claim.provider);
  const byId = new Map(providers.map(p => [p.adapter.id, p.adapter]));
  return top.filter(candidate => !top.some(other => other !== candidate && dependsOn(other.adapter, candidate.adapter.id, byId)));
}
export function capabilityCandidates(id: string, resolved: Detection[], scope: string): Detection[] {
  const providers = resolved.filter(d => d.adapter.provides?.capabilities?.some(c => c.id === id));
  return nearestProviders(providers, scope);
}
const scopeLabel = (scope: string) => scope === '.' ? 'the repository root' : scope;
export function resolveAdapters(detections: Detection[], selected: { id: string; version: string }[], coreVersion: string): { adapters: Detection[]; diagnostics: Diagnostic[] } {
  const byId = new Map(detections.map(d => [d.adapter.id, d])); const resolved = new Map<string, Detection>(); const diagnostics: Diagnostic[] = []; const visiting = new Set<string>();
  function visit(id: string, range: string) {
    const detection = byId.get(id);
    if (!detection) { diagnostics.push({ code: 'missing-adapter', id, message: `Selected adapter ${id} is unavailable` }); return; }
    if (visiting.has(id)) { diagnostics.push({ code: 'cycle', id, message: `Adapter dependency cycle at ${id}` }); return; }
    if (resolved.has(id)) return;
    if (detection.confidence === 'unknown') { diagnostics.push({ code: 'undetected', id, message: `Adapter ${id} has no matching repository evidence` }); return; }
    visiting.add(id);
    for (const dependency of detection.adapter.requires.adapters ?? []) visit(dependency.id, dependency.version);
    visiting.delete(id);
    if (!compatible(detection.adapter.version, range) || !compatible(coreVersion, detection.adapter.requires.core)) {
      diagnostics.push({ code: 'incompatible', id, message: `Adapter ${id} is incompatible with the requested or Core version` }); return;
    }
    if ((detection.adapter.requires.adapters ?? []).every(dep => resolved.has(dep.id))) resolved.set(id, detection);
    else diagnostics.push({ code: 'dependency', id, message: `Adapter ${id} has an unresolved dependency` });
  }
  for (const item of selected) visit(item.id, item.version);
  return { adapters: [...resolved.values()].sort((a,b) => a.adapter.id.localeCompare(b.adapter.id, 'en')), diagnostics };
}
// Precedence: explicit override > explicit scoped provider > answered decision > inference.
export function resolveCapability(id: string, resolved: Detection[], selection?: ProviderSelection, answered: ReadonlyMap<string, string> = new Map()): CapabilityResolution {
  const providers = resolved.filter(d => d.adapter.provides?.capabilities?.some(c => c.id === id));
  const candidates = providers.map(p => p.adapter.id).sort();
  const unavailable = (diagnostics: Diagnostic[]): CapabilityResolution => ({ status: 'unavailable', candidates, scopes: [], ambiguousScopes: [], diagnostics });
  if (typeof selection === 'string') {
    const match = providers.find(d => d.adapter.id === selection);
    return match
      ? { status: 'explicitly-selected', provider: match.adapter, candidates, scopes: [{ scope: '.', provider: match.adapter.id, source: 'explicit', evidence: [] }], ambiguousScopes: [], diagnostics: [] }
      : unavailable([{ code: 'invalid-selection', id, message: `Selected provider ${selection} cannot provide ${id}` }]);
  }
  const explicit = new Map<string, string>();
  const invalid: Diagnostic[] = [];
  for (const entry of selection ?? []) {
    const scope = normalizeScope(entry.path);
    if (!providers.some(d => d.adapter.id === entry.provider)) invalid.push({ code: 'invalid-selection', id, message: `Selected provider ${entry.provider} cannot provide ${id} in ${scopeLabel(scope)}` });
    else explicit.set(scope, entry.provider);
  }
  if (invalid.length) return unavailable(invalid);
  if (providers.length === 0) return unavailable([{ code: 'missing-provider', id, message: `No adapter provides ${id}` }]);
  if (providers.length === 1 && explicit.size === 0) {
    const only = providers[0]!;
    return { status: 'resolved', provider: only.adapter, candidates, scopes: [{ scope: '.', provider: only.adapter.id, source: 'inferred', evidence: only.evidence }], ambiguousScopes: [], diagnostics: [] };
  }

  const scopeCandidates = [...new Set([...explicit.keys(), ...providers.flatMap(p => p.roots)])]
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b, 'en'));
  const scopes: ScopedProvider[] = []; const ambiguousScopes: string[] = []; const diagnostics: Diagnostic[] = [];
  let answeredUsed = false;
  for (const scope of scopeCandidates) {
    const selected = explicit.get(scope);
    if (selected) { scopes.push({ scope, provider: selected, source: 'explicit-scoped', evidence: [] }); continue; }
    if ([...explicit.keys()].some(path => contains(path, scope))) continue;
    const winners = nearestProviders(providers, scope);
    const decided = answered.get(`${id}@${scope}`) ?? (scope === '.' ? answered.get(id) : undefined);
    const chosen = winners.find((winner) => winner.adapter.id === decided);
    if (chosen !== undefined && winners.length > 1) {
      scopes.push({ scope, provider: chosen.adapter.id, source: 'answered-decision', evidence: chosen.evidence });
      answeredUsed = true;
      continue;
    }
    if (winners.length !== 1) {
      ambiguousScopes.push(scope);
      const names = winners.map(p => p.adapter.id).join(', ');
      diagnostics.push({ code: 'ambiguous-provider', id, message: scope === '.' ? `Capability ${id} has multiple providers: ${names}` : `Capability ${id} has multiple providers in ${scope}: ${names}` });
      continue;
    }
    const winner = winners[0]!;
    const enclosing = scopes.filter(entry => contains(entry.scope, scope)).at(-1);
    if (enclosing?.provider === winner.adapter.id && !ambiguousScopes.some(path => contains(path, scope) && depth(path) > depth(enclosing.scope))) continue;
    scopes.push({ scope, provider: winner.adapter.id, source: 'inferred', evidence: winner.evidence.filter(path => contains(scope, path === '.git' ? '.' : path)) });
  }
  const distinct = [...new Set(scopes.map(entry => entry.provider))];
  const single = distinct.length === 1 ? providers.find(p => p.adapter.id === distinct[0])?.adapter : undefined;
  const status = ambiguousScopes.length ? 'ambiguous' : distinct.length > 1 ? 'scoped' : explicit.size || answeredUsed ? 'explicitly-selected' : 'resolved';
  return { status, ...(single && !ambiguousScopes.length ? { provider: single } : {}), candidates, scopes, ambiguousScopes, diagnostics };
}
// The scope decision that governs a repository path: the deepest resolved or ambiguous scope enclosing it.
function governingProvider(resolution: CapabilityResolution, path: string): string | undefined {
  let best: { depth: number; provider?: string } | undefined;
  for (const entry of resolution.scopes) if (contains(entry.scope, path) && (!best || depth(entry.scope) > best.depth)) best = { depth: depth(entry.scope), provider: entry.provider };
  for (const scope of resolution.ambiguousScopes) if (contains(scope, path) && (!best || depth(scope) > best.depth)) best = { depth: depth(scope) };
  return best?.provider;
}
export function collectEvidence(root: string, sources: RepositorySource[], detection: Detection, capability: string): AdapterEvidence[] {
  const rules = detection.adapter.provides?.capabilities?.find(c => c.id === capability)?.evidence ?? [];
  const out: AdapterEvidence[] = [];
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern, 'gm');
    for (const source of matching(rule.glob, sources)) {
      if (rule.requires_siblings?.some(sibling => !existsSync(join(root, dirname(source.path), sibling)))) continue;
      const content = sourceText(root, source.path); if (!content) continue;
      let count = 0;
      for (const match of content.matchAll(pattern)) {
        const value = rule.capture ? match[rule.capture] : undefined;
        // Captured data is a bounded identifier, never free-form file content or configuration value.
        if (value !== undefined && (!/^[a-zA-Z0-9_./:{}@^~-]{1,120}$/.test(value) || /secret|token|password|credential|private|api.?key/i.test(value))) continue;
        if (out.some(item => item.source.path === source.path && item.statement === rule.statement && item.value === value)) continue;
        out.push({ adapter: detection.adapter.id, adapterVersion: detection.adapter.version, capability, source, statement: rule.statement, ...(value ? { value } : {}), detectionConfidence: detection.confidence, detectionEvidence: detection.evidence, classification: 'observed' });
        if (++count >= 20 || out.length >= 200) break;
      }
      if (out.length >= 200) break;
    }
    if (out.length >= 200) break;
  }
  return out.sort((a,b) => `${a.source.path}:${a.statement}:${a.value ?? ''}`.localeCompare(`${b.source.path}:${b.statement}:${b.value ?? ''}`, 'en'));
}
export function resolveCapabilities(resolved: Detection[], selections: Record<string, ProviderSelection> = {}, answered: ReadonlyMap<string, string> = new Map()): Record<string, CapabilityResolution> {
  const ids = [...new Set(resolved.flatMap(d => d.adapter.provides?.capabilities?.map(c => c.id) ?? []))].sort();
  return Object.fromEntries(ids.map(id => [id, resolveCapability(id, resolved, selections[id], answered)]));
}
export function capabilityEvidence(root: string, sources: RepositorySource[], resolved: Detection[], selections: Record<string, ProviderSelection> = {}, answered: ReadonlyMap<string, string> = new Map()) {
  const evidence: AdapterEvidence[] = []; const resolutions = resolveCapabilities(resolved, selections, answered);
  for (const [id, resolution] of Object.entries(resolutions)) {
    const unscoped = resolution.scopes.length === 1 && resolution.scopes[0]!.scope === '.' && !resolution.ambiguousScopes.length;
    for (const provider of new Set(resolution.scopes.map(entry => entry.provider))) {
      const selected = resolved.find(d => d.adapter.id === provider); if (!selected) continue;
      const governed = unscoped ? sources : sources.filter(source => governingProvider(resolution, source.path) === provider);
      evidence.push(...collectEvidence(root, governed, selected, id));
    }
  }
  return { evidence, resolutions };
}
export function capabilityProviders(resolutions: Record<string, CapabilityResolution>): CapabilityProviderEntry[] {
  return Object.entries(resolutions).filter(([, r]) => r.status !== 'unavailable').map(([id, r]) => ({
    id, status: r.status, candidates: r.candidates,
    providers: [...r.scopes].sort((a, b) => a.scope.localeCompare(b.scope, 'en')).map(entry => ({ scope: entry.scope, provider: entry.provider, source: entry.source, evidence: [...entry.evidence].sort() })),
    ...(r.ambiguousScopes.length ? { ambiguous_scopes: [...r.ambiguousScopes].sort() } : {}),
  }));
}
// The decisions persisted in paved.lock with their provenance: only capabilities that had more than one candidate or an
// explicit selection. Inferred decisions live in the lock and never enter the human-owned manifest.
export function capabilityLockEntries(resolutions: Record<string, CapabilityResolution>): CapabilityProviderEntry[] {
  return capabilityProviders(resolutions).filter(entry => entry.candidates.length > 1 || entry.providers.some(p => p.source !== 'inferred'));
}
export function evidenceDigest(evidence: AdapterEvidence) { return hash(`${evidence.adapter}:${evidence.adapterVersion}:${evidence.capability}:${evidence.source.path}:${evidence.source.sha256}:${evidence.statement}:${evidence.value ?? ''}`); }
