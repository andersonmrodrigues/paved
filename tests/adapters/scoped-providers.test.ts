import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { capabilityEvidence, capabilityLockEntries, detectAdapters, loadAdapters, resolveAdapters, resolveCapability, type ProviderSelection } from '../../cli/lib/adapters.ts';
import { discoverSources, initializeConsumer } from '../../cli/lib/generator-runtime.ts';
import { dispatchCli } from '../../cli/runtime.ts';
import type { CommandResult } from '../../cli/result.ts';
import { createRegistry } from '../../cli/lib/schemas.ts';
import { cleanupTemporaryDirectories, temporaryDirectory } from '../helpers.ts';

const core = fileURLToPath(new URL('../..', import.meta.url));
const adapters = loadAdapters(core);
afterEach(cleanupTemporaryDirectories);

type Files = Record<string, string>;
function repository(files: Files): string {
  const root = temporaryDirectory('paved-scoped');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
function resolve(root: string) {
  const sources = discoverSources(root);
  const detected = detectAdapters(root, adapters, sources);
  const selected = detected.filter(d => d.confidence === 'strong').map(d => ({ id: d.adapter.id, version: `^${d.adapter.version}` }));
  return { sources, resolved: resolveAdapters(detected, selected, '1.0.0') };
}
function evidenceFor(root: string, selections: Record<string, ProviderSelection> = {}) {
  const { sources, resolved } = resolve(root);
  assert.deepEqual(resolved.diagnostics, []);
  return { adapters: resolved.adapters, ...capabilityEvidence(root, sources, resolved.adapters, selections) };
}
const scopeMap = (entries: { scope: string; provider: string }[]) => Object.fromEntries(entries.map(s => [s.scope, s.provider]));
const scopes = (resolution: { scopes: { scope: string; provider: string }[] }) => scopeMap(resolution.scopes);

const pom = (artifacts: string[] = []) => `<project><artifactId>service</artifactId>${artifacts.map(a => `<dependency><artifactId>${a}</artifactId></dependency>`).join('')}</project>`;
const tsconfig = '{"compilerOptions":{"strict":true}}';
const angularPackage = '{"dependencies":{"@angular/core":"^19.2.15"},"devDependencies":{"typescript":"~5.6.0"},"scripts":{"test":"ng test"}}';
function angularWorkspace(dir: string): Files {
  return {
    [`${dir}/angular.json`]: '{"projects":{}}',
    [`${dir}/package.json`]: angularPackage,
    [`${dir}/tsconfig.json`]: tsconfig,
    [`${dir}/tsconfig.spec.json`]: '{"extends":"./tsconfig.json"}',
    [`${dir}/e2e/tsconfig.e2e.json`]: '{"extends":"../tsconfig.json"}',
    [`${dir}/src/app/app.routes.ts`]: "export const routes = [{ path: 'catalog', component: Page }];\n",
    [`${dir}/src/app/catalog.service.ts`]: 'export class CatalogService {}\n',
    [`${dir}/src/app/catalog.service.spec.ts`]: "describe('CatalogService', () => {});\n",
  };
}
function quarkusService(dir: string): Files {
  return {
    [`${dir}/pom.xml`]: pom(['quarkus-arc', 'quarkus-resteasy-jackson', 'junit-jupiter']),
    [`${dir}/src/main/java/example/ItemResource.java`]: 'package example;\n@Path("/items")\npublic class ItemResource {}\n',
  };
}
// Mirrors a real multi-stack product repository: Quarkus services and a shared library beside Angular frontends,
// with no root build file and a non-TypeScript package.json inside a backend.
function javaQuarkusAngularMonorepo(): string {
  return repository({
    'README.md': '# Product\n',
    ...quarkusService('manager/backend'),
    'manager/backend/package.json': '{"dependencies":{"some-player":"^0.1.1"}}',
    ...quarkusService('user/backend'),
    'library/pom.xml': pom(['quarkus-resteasy-jackson']),
    'library/src/main/java/example/shared/Shared.java': 'package example.shared;\npublic class Shared {}\n',
    ...angularWorkspace('admin/frontend'),
    ...angularWorkspace('manager/frontend'),
    ...angularWorkspace('user/frontend'),
  });
}

describe('scoped capability provider resolution', () => {
  test('a single-stack repository resolves unscoped and records no decision in the lock', () => {
    const root = repository({ 'pom.xml': pom(), 'src/main/java/example/App.java': 'package example;\nclass App {}\n' });
    const { resolutions, evidence } = evidenceFor(root);
    assert.equal(resolutions['source.structure']?.status, 'resolved');
    assert.deepEqual(resolutions['source.structure']?.scopes.map(s => s.scope), ['.']);
    assert.ok(evidence.some(e => e.capability === 'source.structure' && e.value === 'example'));
    assert.deepEqual(capabilityLockEntries(resolutions), []);
    initializeConsumer(core, root, 'single');
    const lock = parse(readFileSync(join(root, '.paved/paved.lock'), 'utf8')) as Record<string, unknown>;
    assert.equal('capabilities' in lock, false);
  });

  test('a multi-stack monorepo resolves each scope to the stack that owns it', () => {
    const root = repository({
      ...quarkusService('services/api'),
      'web/tsconfig.json': tsconfig,
      'web/package.json': '{"devDependencies":{"typescript":"~5.6.0"}}',
      'web/src/client.ts': 'export interface Client {}\n',
    });
    const { resolutions, evidence } = evidenceFor(root);
    assert.equal(resolutions['source.build']?.status, 'scoped');
    assert.deepEqual(scopes(resolutions['source.build']!), { 'services/api': 'technology/java', web: 'technology/typescript' });
    const structure = evidence.filter(e => e.capability === 'source.structure');
    assert.ok(structure.some(e => e.adapter === 'technology/java' && e.source.path.startsWith('services/api/')));
    assert.ok(structure.some(e => e.adapter === 'technology/typescript' && e.source.path.startsWith('web/')));
    assert.ok(structure.every(e => (e.adapter === 'technology/java') === e.source.path.startsWith('services/api/')));
    assert.ok(Object.values(resolutions).every(r => r.diagnostics.length === 0));
  });

  test('the nearest scope wins below a repository-wide build file', () => {
    const root = repository({
      'pom.xml': pom(),
      'src/main/java/example/App.java': 'package example;\nclass App {}\n',
      'web/tsconfig.json': tsconfig,
      'web/src/client.ts': 'export interface Client {}\n',
    });
    const { resolutions } = evidenceFor(root);
    assert.deepEqual(scopes(resolutions['source.structure']!), { '.': 'technology/java', web: 'technology/typescript' });
  });

  test('a specialized adapter wins over the adapter it requires in the same scope', () => {
    const root = repository(angularWorkspace('.'));
    const { resolutions } = evidenceFor(root);
    const testing = resolutions['testing.structure']!;
    assert.equal(testing.status, 'resolved');
    assert.equal(testing.provider?.id, 'technology/angular');
    assert.deepEqual(testing.candidates, ['technology/angular', 'technology/typescript']);
    assert.deepEqual(capabilityLockEntries(resolutions).map(e => e.id), ['testing.structure']);
  });

  test('unrelated providers claiming the same scope stay ambiguous instead of guessing', () => {
    const root = repository({ 'pom.xml': pom(), 'tsconfig.json': tsconfig, 'src/App.java': 'package example;\nclass App {}\n' });
    const { resolutions, evidence } = evidenceFor(root);
    const build = resolutions['source.build']!;
    assert.equal(build.status, 'ambiguous');
    assert.deepEqual(build.ambiguousScopes, ['.']);
    assert.equal(build.diagnostics[0]?.code, 'ambiguous-provider');
    assert.equal(evidence.some(e => e.capability === 'source.build'), false);
    assert.deepEqual(capabilityLockEntries(resolutions).find(e => e.id === 'source.build')?.ambiguous_scopes, ['.']);
  });

  test('an ambiguous parent scope does not block deterministic child scopes', () => {
    const root = repository({
      'pom.xml': pom(), 'tsconfig.json': tsconfig,
      'mobile/pubspec.yaml': 'name: mobile\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n',
      'mobile/lib/app.dart': 'class App {}\n',
    });
    const { resolutions, evidence } = evidenceFor(root);
    const structure = resolutions['source.structure']!;
    assert.equal(structure.status, 'ambiguous');
    assert.deepEqual(structure.ambiguousScopes, ['.']);
    assert.deepEqual(scopes(structure), { mobile: 'technology/dart' });
    assert.ok(evidence.some(e => e.capability === 'source.structure' && e.source.path === 'mobile/lib/app.dart'));
  });

  test('nested roots of one adapter belong to its outermost scope rather than splitting a shared scope', () => {
    const root = repository({ 'pom.xml': pom(), 'tsconfig.json': tsconfig, 'web/tsconfig.json': tsconfig });
    const { resolutions } = evidenceFor(root);
    assert.deepEqual(resolutions['source.build']?.ambiguousScopes, ['.']);
    assert.deepEqual(resolutions['source.build']?.scopes, []);
  });

  test('an explicit override takes precedence over repository inference', () => {
    const root = javaQuarkusAngularMonorepo();
    const { resolutions } = evidenceFor(root, { 'source.build': 'technology/java' });
    const build = resolutions['source.build']!;
    assert.equal(build.status, 'explicitly-selected');
    assert.deepEqual(build.scopes, [{ scope: '.', provider: 'technology/java', source: 'explicit', evidence: [] }]);
  });

  test('an explicit scoped provider takes precedence over inference in its scope only', () => {
    const root = javaQuarkusAngularMonorepo();
    const { resolutions } = evidenceFor(root, { 'testing.structure': [{ path: './admin/frontend/', provider: 'technology/typescript' }] });
    const testing = resolutions['testing.structure']!;
    assert.equal(testing.status, 'scoped');
    const admin = testing.scopes.find(s => s.scope === 'admin/frontend');
    assert.deepEqual(admin, { scope: 'admin/frontend', provider: 'technology/typescript', source: 'explicit-scoped', evidence: [] });
    assert.equal(testing.scopes.find(s => s.scope === 'user/frontend')?.source, 'inferred');
    assert.equal(testing.scopes.find(s => s.scope === 'user/frontend')?.provider, 'technology/angular');
  });

  test('an explicit scoped provider resolves a genuinely ambiguous scope', () => {
    const root = repository({ 'pom.xml': pom(), 'tsconfig.json': tsconfig });
    const { resolutions } = evidenceFor(root, { 'source.build': [{ path: '.', provider: 'technology/typescript' }] });
    assert.equal(resolutions['source.build']?.status, 'explicitly-selected');
    assert.deepEqual(resolutions['source.build']?.diagnostics, []);
  });

  test('an explicit selection of a provider that cannot supply the capability is rejected', () => {
    const root = javaQuarkusAngularMonorepo();
    const { resolved } = resolve(root);
    const resolution = resolveCapability('api.http', resolved.adapters, [{ path: 'user/backend', provider: 'technology/postgresql' }]);
    assert.equal(resolution.status, 'unavailable');
    assert.equal(resolution.diagnostics[0]?.code, 'invalid-selection');
  });

  test('inferred decisions carry provenance and the supporting evidence', () => {
    const root = javaQuarkusAngularMonorepo();
    const { resolutions } = evidenceFor(root);
    const http = capabilityLockEntries(resolutions).find(e => e.id === 'api.http')!;
    assert.deepEqual(http.candidates, ['technology/quarkus', 'technology/typescript']);
    const backend = http.providers.find(p => p.scope === 'user/backend')!;
    assert.equal(backend.source, 'inferred');
    assert.deepEqual(backend.evidence, ['user/backend/pom.xml']);
    const frontend = http.providers.find(p => p.scope === 'user/frontend')!;
    assert.ok(frontend.evidence.includes('user/frontend/tsconfig.json'));
    assert.ok(frontend.evidence.every(path => path.startsWith('user/frontend/')));
  });

  test('the manifest accepts both selection forms and rejects paths that escape the repository', () => {
    const registry = createRegistry(join(core, 'schemas'), ['paved/v1']);
    const manifest = (providers: unknown) => ({ apiVersion: 'paved/v1', kind: 'Project', project: { name: 'sample' }, paved: { core: '^1.0.0' }, capability_providers: providers });
    assert.equal(registry.validate(manifest({ 'source.build': 'technology/java' })).valid, true);
    assert.equal(registry.validate(manifest({ 'source.build': [{ path: 'services/api', provider: 'technology/java' }, { path: '.', provider: 'technology/typescript' }] })).valid, true);
    for (const path of ['../outside', '/abs', 'web/', 'a/../b', '']) {
      assert.equal(registry.validate(manifest({ 'source.build': [{ path, provider: 'technology/java' }] })).valid, false, path);
    }
  });
});

describe('Java/Quarkus and TypeScript/Angular repository through the CLI', () => {
  const cli = (root: string, ...argv: string[]): Promise<CommandResult> => dispatchCli({ argv: [...argv, '--project', root], cwd: core, executablePath: join(core, 'cli/index.ts') });
  type Entry = { id: string; status: string; providers: { scope: string; provider: string; source: string }[] };
  const providersOf = (result: CommandResult) => (result.data as { capabilityProviders: Entry[] }).capabilityProviders;

  test('init resolves every provider from repository evidence and persists inferred decisions in the lock only', async () => {
    const root = javaQuarkusAngularMonorepo();
    const init = await cli(root, 'init');
    const codes = init.diagnostics.map(d => d.code);
    assert.ok(!codes.some(code => /AMBIGUOUS|PROVIDER_INVALID|UNAVAILABLE/.test(code)), codes.join(', '));
    assert.equal((init.data as { initialized: boolean }).initialized, true);

    const byId = new Map(providersOf(init).map(e => [e.id, e]));
    for (const id of ['source.build', 'source.dependencies', 'source.structure', 'api.http', 'api.openapi']) assert.equal(byId.get(id)?.status, 'scoped', id);
    const expected = (backend: string) => ({
      'library': backend, 'manager/backend': backend, 'user/backend': backend,
      'admin/frontend': 'technology/typescript', 'manager/frontend': 'technology/typescript', 'user/frontend': 'technology/typescript',
    });
    assert.deepEqual(scopeMap(byId.get('source.build')!.providers), expected('technology/java'));
    assert.deepEqual(scopeMap(byId.get('api.http')!.providers), expected('technology/quarkus'));
    assert.deepEqual(scopeMap(byId.get('testing.structure')!.providers), { 'admin/frontend': 'technology/angular', 'manager/frontend': 'technology/angular', 'user/frontend': 'technology/angular' });

    const manifest = parse(readFileSync(join(root, '.paved/manifest.yaml'), 'utf8')) as Record<string, unknown>;
    assert.equal('capability_providers' in manifest, false);
    const lock = parse(readFileSync(join(root, '.paved/paved.lock'), 'utf8')) as { capabilities: Entry[] };
    assert.ok(lock.capabilities.every(e => e.providers.every(p => p.source === 'inferred')));
    assert.deepEqual(lock.capabilities.map(e => e.id), ['api.http', 'api.openapi', 'source.build', 'source.dependencies', 'source.structure', 'testing.structure']);

    const status = await cli(root, 'status');
    assert.deepEqual(providersOf(status), providersOf(init));
    assert.ok(!status.diagnostics.some(d => d.code === 'PAVED_LOCK_CAPABILITIES_STALE'));

    const agent = await cli(root, 'agent', 'commands', '--json');
    assert.deepEqual(providersOf(agent), providersOf(init));
  });

  test('status reports lock drift after the repository topology changes, and update records the new decisions', async () => {
    const root = javaQuarkusAngularMonorepo();
    await cli(root, 'init', '--no-generate');
    for (const [path, content] of Object.entries(angularWorkspace('partner/frontend'))) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const stale = await cli(root, 'status');
    assert.ok(stale.diagnostics.some(d => d.code === 'PAVED_LOCK_CAPABILITIES_STALE'));
    assert.equal((stale.data as { lifecycleState: string }).lifecycleState, 'STALE');

    await cli(root, 'update');
    const lock = parse(readFileSync(join(root, '.paved/paved.lock'), 'utf8')) as { capabilities: Entry[] };
    assert.ok(lock.capabilities.find(e => e.id === 'source.build')?.providers.some(p => p.scope === 'partner/frontend'));
    const fresh = await cli(root, 'status');
    assert.ok(!fresh.diagnostics.some(d => d.code === 'PAVED_LOCK_CAPABILITIES_STALE'));
  });

  test('explicit scoped providers in the manifest are honored and recorded as explicit', async () => {
    const root = javaQuarkusAngularMonorepo();
    await cli(root, 'init', '--no-generate');
    const path = join(root, '.paved/manifest.yaml');
    const manifest = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, stringify({ ...manifest, capability_providers: { 'testing.structure': [{ path: 'admin/frontend', provider: 'technology/typescript' }] } }));
    const status = await cli(root, 'status');
    const testing = providersOf(status).find(e => e.id === 'testing.structure')!;
    assert.deepEqual(testing.providers.find(p => p.scope === 'admin/frontend'), { scope: 'admin/frontend', provider: 'technology/typescript', source: 'explicit-scoped', evidence: [] });
    assert.ok(status.diagnostics.some(d => d.code === 'PAVED_LOCK_CAPABILITIES_STALE'));
  });
});
