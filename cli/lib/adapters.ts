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
export interface Detection { adapter: AdapterContract; confidence: 'strong' | 'medium' | 'weak' | 'unknown'; evidence: string[] }
export interface Diagnostic { code: 'missing-adapter' | 'incompatible' | 'dependency' | 'cycle' | 'undetected' | 'ambiguous-provider' | 'missing-provider' | 'invalid-selection'; message: string; id?: string }
export interface AdapterEvidence { adapter: string; adapterVersion: string; capability: string; source: RepositorySource; statement: string; value?: string; detectionConfidence: Detection['confidence']; detectionEvidence: string[]; classification: 'observed' }
export interface CapabilityResolution { status: 'resolved' | 'explicitly-selected' | 'ambiguous' | 'incompatible' | 'unavailable'; provider?: AdapterContract; diagnostics: Diagnostic[] }
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
    let content = false;
    for (const signal of detect.file_contains ?? []) {
      const pattern = new RegExp(signal.pattern, 'm');
      for (const source of matching(signal.glob, sources)) {
        if (pattern.test(sourceText(root, source.path) ?? '')) { evidence.push(source.path); content = true; }
      }
    }
    const confidence = content || (adapter.id === 'infrastructure/git' && any) ? (detect.confidence ?? 'strong') : all ? 'medium' : any ? 'weak' : 'unknown';
    return { adapter, confidence, evidence: [...new Set(evidence)].sort() };
  });
}
export function resolveAdapters(detections: Detection[], selected: { id: string; version: string }[], coreVersion: string): { adapters: Detection[]; diagnostics: Diagnostic[] } {
  const byId = new Map(detections.map(d => [d.adapter.id, d])); const resolved = new Map<string, Detection>(); const diagnostics: Diagnostic[] = []; const visiting = new Set<string>();
  function visit(id: string, range: string) {
    const detection = byId.get(id);
    if (!detection) { diagnostics.push({ code: 'missing-adapter', id, message: `Selected adapter ${id} is unavailable` }); return; }
    if (visiting.has(id)) { diagnostics.push({ code: 'cycle', id, message: `Adapter dependency cycle at ${id}` }); return; }
    if (!compatible(detection.adapter.version, range) || !compatible(coreVersion, detection.adapter.requires.core)) { diagnostics.push({ code: 'incompatible', id, message: `Adapter ${id} is incompatible with the requested or Core version` }); return; }
    if (detection.confidence === 'unknown') { diagnostics.push({ code: 'undetected', id, message: `Adapter ${id} has no matching repository evidence` }); return; }
    if (resolved.has(id)) return;
    visiting.add(id);
    for (const dependency of detection.adapter.requires.adapters ?? []) visit(dependency.id, dependency.version);
    visiting.delete(id);
    if ((detection.adapter.requires.adapters ?? []).every(dep => resolved.has(dep.id))) resolved.set(id, detection);
    else diagnostics.push({ code: 'dependency', id, message: `Adapter ${id} has an unresolved dependency` });
  }
  for (const item of selected) visit(item.id, item.version);
  return { adapters: [...resolved.values()].sort((a,b) => a.adapter.id.localeCompare(b.adapter.id, 'en')), diagnostics };
}
export function resolveCapability(id: string, resolved: Detection[], selection?: string): CapabilityResolution {
  const providers = resolved.filter(d => d.adapter.provides?.capabilities?.some(c => c.id === id));
  if (selection) {
    const match = providers.find(d => d.adapter.id === selection);
    return match ? { status: 'explicitly-selected', provider: match.adapter, diagnostics: [] } : { status: 'unavailable', diagnostics: [{ code: 'invalid-selection', id, message: `Selected provider ${selection} cannot provide ${id}` }] };
  }
  if (providers.length === 1) return { status: 'resolved', provider: providers[0]!.adapter, diagnostics: [] };
  if (providers.length > 1) return { status: 'ambiguous', diagnostics: [{ code: 'ambiguous-provider', id, message: `Capability ${id} has multiple providers: ${providers.map(p => p.adapter.id).join(', ')}` }] };
  return { status: 'unavailable', diagnostics: [{ code: 'missing-provider', id, message: `No adapter provides ${id}` }] };
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
export function capabilityEvidence(root: string, sources: RepositorySource[], resolved: Detection[], selections: Record<string,string> = {}) {
  const ids = [...new Set(resolved.flatMap(d => d.adapter.provides?.capabilities?.map(c => c.id) ?? []))].sort();
  const evidence: AdapterEvidence[] = []; const resolutions: Record<string, CapabilityResolution> = {};
  for (const id of ids) {
    const resolution = resolveCapability(id, resolved, selections[id]); resolutions[id] = resolution;
    const selected = resolved.find(d => d.adapter.id === resolution.provider?.id);
    if (selected) evidence.push(...collectEvidence(root, sources, selected, id));
  }
  return { evidence, resolutions };
}
export function evidenceDigest(evidence: AdapterEvidence) { return hash(`${evidence.adapter}:${evidence.adapterVersion}:${evidence.capability}:${evidence.source.path}:${evidence.source.sha256}:${evidence.statement}:${evidence.value ?? ''}`); }
