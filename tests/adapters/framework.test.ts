import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAdapters, detectAdapters, resolveAdapters, resolveCapability, capabilityEvidence, collectEvidence, type AdapterContract } from '../../cli/lib/adapters.ts';
import { discoverSources, initializeConsumer, runGenerators } from '../../cli/lib/generator-runtime.ts';
import { createRegistry } from '../../cli/lib/schemas.ts';
import { parse } from 'yaml';
import { cleanupTemporaryDirectories, temporaryDirectory } from '../helpers.ts';
const core = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = join(core, 'tests/fixtures/adapters');
const adapters = loadAdapters(core);
afterEach(cleanupTemporaryDirectories);
function inspect(name: string) { const root = temporaryDirectory('paved-fixture'); cpSync(join(fixtures, name), root, { recursive: true }); if (existsSync(join(root, 'git-fixture.txt'))) { mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n'); } const sources = discoverSources(root); return { root, sources, detection: detectAdapters(root, adapters, sources) }; }
function detected(name: string, id: string) { return inspect(name).detection.find(d => d.adapter.id === id)!; }

test('adapter contracts validate and maintain independent versions and compatibility', () => {
  const registry = createRegistry(join(core, 'schemas'), ['paved/v1']);
  assert.equal(adapters.length, 8);
  for (const adapter of adapters) assert.equal(registry.validate(adapter).valid, true, adapter.id);
  const bad = { ...adapters[0], version: 'latest' };
  assert.equal(registry.validate(bad).valid, false);
  assert.equal(resolveAdapters([detected('java-project', 'technology/java')], [{ id: 'technology/java', version: '^0.1.0' }], '9.0.0').diagnostics[0]?.code, 'incompatible');
});

test('detection uses content evidence and preserves weak and unknown states', () => {
  assert.equal(detected('java-project', 'technology/java').confidence, 'strong');
  assert.equal(detected('quarkus-project', 'technology/quarkus').confidence, 'strong');
  assert.equal(detected('angular-project', 'technology/angular').confidence, 'strong');
  assert.equal(detected('postgresql-project', 'technology/postgresql').confidence, 'strong');
  assert.equal(detected('git-project', 'infrastructure/git').confidence, 'strong');
  assert.equal(detected('java-project', 'technology/angular').confidence, 'unknown');
  const root = temporaryDirectory('paved-weak');
  writeFileSync(join(root, 'pom.xml'), 'ambiguous file');
  const sources = discoverSources(root);
  assert.equal(detectAdapters(root, adapters, sources).find(d => d.adapter.id === 'technology/java')?.confidence, 'weak');
});

test('Phase 18 language adapters distinguish TypeScript, Dart and Flutter evidence', () => {
  const root = temporaryDirectory('paved-phase18-languages');
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(join(root, 'pubspec.yaml'), [
    'name: sample',
    'environment:',
    '  sdk: ">=3.0.0 <4.0.0"',
    'dependencies:',
    '  flutter:',
    '    sdk: flutter',
  ].join('\n'));
  writeFileSync(join(root, 'lib.dart'), 'class Sample {}');
  const sources = discoverSources(root);
  const detection = detectAdapters(root, adapters, sources);
  assert.equal(detection.find(d => d.adapter.id === 'technology/typescript')?.confidence, 'strong');
  assert.equal(detection.find(d => d.adapter.id === 'technology/dart')?.confidence, 'strong');
  assert.equal(detection.find(d => d.adapter.id === 'technology/flutter')?.confidence, 'strong');
  const resolved = resolveAdapters(detection, [
    { id: 'technology/typescript', version: '^0.1.0' },
    { id: 'technology/flutter', version: '^0.1.0' },
  ], '1.0.0');
  assert.deepEqual(resolved.diagnostics, []);
  assert.deepEqual(resolved.adapters.map(item => item.adapter.id), ['technology/dart', 'technology/flutter', 'technology/typescript']);
  const evidence = capabilityEvidence(root, sources, resolved.adapters);
  assert.ok(evidence.evidence.some(item => item.capability === 'testing.structure') === false);
});

test('Phase 18 negative detection does not resolve Flutter for a Dart-only project', () => {
  const root = temporaryDirectory('paved-phase18-dart-only');
  writeFileSync(join(root, 'pubspec.yaml'), [
    'name: sample',
    'environment:',
    '  sdk: ">=3.0.0 <4.0.0"',
    'dependencies:',
    '  http: ^1.0.0',
  ].join('\n'));
  const sources = discoverSources(root);
  const detection = detectAdapters(root, adapters, sources);
  assert.equal(detection.find(d => d.adapter.id === 'technology/dart')?.confidence, 'strong');
  assert.equal(detection.find(d => d.adapter.id === 'technology/flutter')?.confidence, 'unknown');
  const resolved = resolveAdapters(detection, [{ id: 'technology/dart', version: '^0.1.0' }], '1.0.0');
  assert.deepEqual(resolved.diagnostics, []);
  assert.deepEqual(resolved.adapters.map(item => item.adapter.id), ['technology/dart']);
});

test('evidence globs with a recursive prefix include files at the repository root', () => {
  const root = temporaryDirectory('paved-root-evidence');
  mkdirSync(join(root, 'angular-src'));
  writeFileSync(join(root, 'Sample.java'), 'package example; class Sample {}');
  writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE root_items (id integer);');
  writeFileSync(join(root, 'angular.json'), '{"projects":{}}');
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"@angular/core":"^19.0.0"}}');
  writeFileSync(join(root, 'app-routing.module.ts'), "const routes = [{ path: 'root-items', component: Page }];");
  const sources = discoverSources(root);
  const java = detected('java-project', 'technology/java');
  const postgres = detected('postgresql-project', 'technology/postgresql');
  const angular = detectAdapters(root, adapters, sources).find(d => d.adapter.id === 'technology/angular')!;

  assert.ok(collectEvidence(root, sources, java, 'source.structure').some(e => e.source.path === 'Sample.java'));
  assert.ok(collectEvidence(root, sources, postgres, 'database.migrations').some(e => e.source.path === 'schema.sql'));
  assert.ok(collectEvidence(root, sources, angular, 'application.ui-routes').some(e => e.source.path === 'app-routing.module.ts'));
});

test('Java adapter detects Kotlin DSL Gradle build files', () => {
  const root = temporaryDirectory('paved-gradle-kts');
  writeFileSync(join(root, 'build.gradle.kts'), 'plugins { java }');
  const sources = discoverSources(root);

  assert.equal(detectAdapters(root, adapters, sources).find(d => d.adapter.id === 'technology/java')?.confidence, 'strong');
});

test('adapter evidence rejects captured values that contain secret-like terms', () => {
  const root = temporaryDirectory('paved-secret-capture');
  writeFileSync(join(root, 'secrets.txt'), 'credential=TOP_SECRET_VALUE');
  const source = discoverSources(root);
  const java = detected('java-project', 'technology/java');
  const contract: AdapterContract = {
    ...java.adapter,
    provides: {
      capabilities: [{
        id: 'source.dependencies',
        evidence: [{
          glob: 'secrets.txt',
          pattern: 'credential=([A-Za-z0-9_-]+)',
          statement: 'Captured dependency identifier',
          capture: 1,
        }],
      }],
    },
  };

  writeFileSync(join(root, 'secrets.txt'), 'credential=host-42');
  const safeEvidence = collectEvidence(root, source, { ...java, adapter: contract }, 'source.dependencies');
  assert.equal(safeEvidence.length, 1);
  assert.equal(safeEvidence[0]?.value, 'host-42');

  writeFileSync(join(root, 'secrets.txt'), 'credential=TOP_SECRET_VALUE');
  const evidence = collectEvidence(root, source, { ...java, adapter: contract }, 'source.dependencies');

  assert.deepEqual(evidence, []);
  assert.doesNotMatch(JSON.stringify(safeEvidence), /TOP_SECRET_VALUE/);
});

test('Quarkus route evidence preserves parameterized path templates', () => {
  const root = temporaryDirectory('paved-quarkus-routes');
  writeFileSync(join(root, 'pom.xml'), '<project><artifactId>quarkus-resteasy</artifactId></project>');
  writeFileSync(join(root, 'Resource.java'), '@Path("/items/{id}") class Resource {}');
  const sources = discoverSources(root);
  const detection = detectAdapters(root, adapters, sources).find(d => d.adapter.id === 'technology/quarkus')!;

  const evidence = collectEvidence(root, sources, detection, 'application.http-routes');

  assert.ok(evidence.some(item => item.value === '/items/{id}'));
});

test('adapter evidence deduplicates repeated matches without captured values', () => {
  const root = temporaryDirectory('paved-deduplicated-evidence');
  writeFileSync(join(root, 'pom.xml'), '<project>testImplementation testImplementation useJUnitPlatform testImplementation</project>');
  const sources = discoverSources(root);
  const java = detected('java-project', 'technology/java');
  const contract: AdapterContract = {
    ...java.adapter,
    provides: {
      capabilities: [{
        id: 'source.test',
        evidence: [{
          glob: 'pom.xml',
          pattern: 'testImplementation|useJUnitPlatform',
          statement: 'Gradle Java test configuration',
        }],
      }],
    },
  };

  const evidence = collectEvidence(root, sources, { ...java, adapter: contract }, 'source.test');

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.statement, 'Gradle Java test configuration');
});

test('generator provenance does not inherit adapter attribution from another generator', () => {
  const root = temporaryDirectory('paved-isolated-source-attribution');
  mkdirSync(join(root, 'src/main/java/example'), { recursive: true });
  mkdirSync(join(root, 'module'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Sample\n');
  writeFileSync(join(root, 'src/main/java/example/Resource.java'), 'package example;\nclass Resource {}\n');
  writeFileSync(join(root, 'module/checkstyle.xml'), '<module name="Checker"/>');
  writeFileSync(join(root, 'module/pom.xml'), [
    '<project><artifactId>sample</artifactId>',
    '<dependency><groupId>io.quarkus</groupId><artifactId>quarkus-resteasy</artifactId></dependency>',
    '<plugin><artifactId>maven-checkstyle-plugin</artifactId><phase>validate</phase>',
    '<goal>check</goal><configLocation>checkstyle.xml</configLocation><failOnViolation>true</failOnViolation></plugin>',
    '</project>',
  ].join(''));
  initializeConsumer(core, root, 'sample');
  const result = runGenerators(core, root);
  const lastRun = JSON.parse(readFileSync(join(root, '.paved/generated/state/last-run.json'), 'utf8')) as {
    executions: { generator: string; sources: { path: string; adapter?: string; capability?: string }[] }[];
  };

  for (const id of ['verification', 'rules']) {
    const execution = lastRun.executions.find(entry => entry.generator === id)!;
    const pom = execution.sources.find(source => source.path === 'module/pom.xml')!;
    assert.equal(pom.adapter, undefined, `${id} must not inherit adapter metadata`);
    assert.equal(pom.capability, undefined, `${id} must not inherit capability metadata`);
    const sidecarPath = result.executions.find(entry => entry.generator === id)?.proposals.find(path => path.endsWith('.paved.yaml'));
    assert.ok(sidecarPath, `${id} proposal sidecar should exist`);
    const sidecar = parse(readFileSync(join(root, sidecarPath!), 'utf8')) as {
      provenance: { sources: { location: string; adapter?: string; capability?: string }[] };
    };
    const sidecarPom = sidecar.provenance.sources.find(source => source.location === 'module/pom.xml')!;
    assert.equal(sidecarPom.adapter, undefined, `${id} provenance must not inherit adapter metadata`);
    assert.equal(sidecarPom.capability, undefined, `${id} provenance must not inherit capability metadata`);
  }
});

test('evidence-driven generators treat absent routes and integration settings as unknowns', () => {
  const root = temporaryDirectory('paved-no-route-evidence');
  mkdirSync(join(root, 'src/main/java/example'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Sample Java library\n');
  writeFileSync(join(root, 'pom.xml'), '<project><artifactId>sample</artifactId></project>');
  writeFileSync(join(root, 'src/main/java/example/Util.java'), 'package example;\nclass Util {}\n');
  initializeConsumer(core, root, 'sample');

  const result = runGenerators(core, root);

  assert.deepEqual(result.errors, []);
  for (const id of ['project-context/feature-map', 'project-context/integrations']) {
    const execution = result.executions.find(entry => entry.generator === id)!;
    assert.notEqual(execution.status, 'failed', id);
    assert.deepEqual(execution.outputs, [], id);
    assert.deepEqual(execution.proposals, [], id);
    assert.ok(execution.warnings.length > 0, id);
    assert.ok(execution.unknowns.length > 0, id);
  }
  assert.equal(existsSync(join(root, '.paved/project/integrations/overview.md')), false);
  assert.equal(existsSync(join(root, '.paved/project/feature-map')), false);
});

test('combined repository resolves five adapters and all declared evidence capabilities', () => {
  const {root, sources, detection} = inspect('combined-project');
  const selected = detection.filter(d => d.confidence === 'strong' || d.adapter.id === 'infrastructure/git').map(d => ({ id: d.adapter.id, version: '^0.1.0' }));
  const result = resolveAdapters(detection, selected, '1.0.0');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.adapters.map(d => d.adapter.id), adapters.filter(a => !['technology/typescript', 'technology/dart', 'technology/flutter'].includes(a.id)).map(a => a.id));
  const capabilities = capabilityEvidence(root, sources, result.adapters);
  assert.ok(capabilities.evidence.some(e => e.capability === 'application.ui-routes' && e.value === 'items'));
  assert.ok(capabilities.evidence.some(e => e.statement === 'Angular core resolved version in package lock' && e.value === '19.2.15'));
  assert.ok(!capabilities.evidence.some(e => e.statement === 'Angular core resolved version in package lock' && e.value === '7.2.16'));
  assert.ok(capabilities.evidence.some(e => e.capability === 'database.migrations' && e.value === 'items'));
  assert.ok(Object.values(capabilities.resolutions).every(r => r.status === 'resolved' || r.status === 'unavailable'));
  assert.ok(capabilities.evidence.every(e => e.adapterVersion === '0.1.0' && e.source.sha256.length === 64 && e.detectionEvidence.length > 0 && e.classification === 'observed'));
});

test('resolution diagnoses missing, incompatible, cyclic and ambiguous providers', () => {
  const base = detected('java-project', 'technology/java');
  assert.equal(resolveAdapters([base], [{ id: 'technology/missing', version: '^0.1.0' }], '1.0.0').diagnostics[0]?.code, 'missing-adapter');
  assert.equal(resolveAdapters([base], [{ id: base.adapter.id, version: '^1.0.0' }], '1.0.0').diagnostics[0]?.code, 'incompatible');
  const duplicate: AdapterContract = { ...base.adapter, id: 'technology/other' };
  const duplicateDetection = { ...base, adapter: duplicate };
  const providers = [base, duplicateDetection];
  assert.equal(resolveCapability('source.build', providers).status, 'ambiguous');
  assert.equal(resolveCapability('source.build', providers, base.adapter.id).status, 'explicitly-selected');
  assert.equal(resolveCapability('source.build', providers, 'technology/missing').status, 'unavailable');
  assert.equal(resolveCapability('missing.capability', providers).status, 'unavailable');
  const cyclic: AdapterContract = { ...base.adapter, requires: { core: '^0.2.0', adapters: [{ id: base.adapter.id, version: '^0.1.0' }] } };
  assert.equal(resolveAdapters([{ ...base, adapter: cyclic }], [{ id: cyclic.id, version: '^0.1.0' }], '1.0.0').diagnostics[0]?.code, 'cycle');
  const broken: AdapterContract = { ...base.adapter, requires: { core: '^1.0.0', adapters: [{ id: 'technology/missing', version: '^0.1.0' }] } };
  assert.ok(resolveAdapters([{ ...base, adapter: broken }], [{ id: broken.id, version: '^0.1.0' }], '1.0.0').diagnostics.some(d => d.code === 'dependency'));
});

test('adapter evidence omits sensitive values and generators consume resolved evidence', () => {
  const root = temporaryDirectory('paved-adapter');
  mkdirSync(join(root, 'frontend/src/app'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Sample\n');
  writeFileSync(join(root, 'frontend/package.json'), '{"dependencies":{"@angular/core":"^19.2.15"},"scripts":{"test":"ng test"}}');
  writeFileSync(join(root, 'frontend/angular.json'), '{"projects":{}}');
  writeFileSync(join(root, 'frontend/src/app/app-routing.module.ts'), "const routes = [{path: 'items', component: Page}];");
  writeFileSync(join(root, 'frontend/application.properties'), 'password=TOP_SECRET_VALUE\nquarkus.datasource.jdbc.url=jdbc:postgresql://secret-host/database\n');
  const sources = discoverSources(root), detection = detectAdapters(root, adapters, sources);
  const selected = resolveAdapters(detection, [{ id: 'technology/angular', version: '^0.1.0' }, { id: 'technology/postgresql', version: '^0.1.0' }], '1.0.0');
  const evidence = capabilityEvidence(root, sources, selected.adapters).evidence;
  assert.doesNotMatch(JSON.stringify(evidence), /TOP_SECRET_VALUE|secret-host/);
  assert.ok(evidence.some(e => e.capability === 'application.modules' && e.value === '^19.2.15'));
  initializeConsumer(core, root, 'sample');
  const result = runGenerators(core, root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.capabilityResolutions['application.ui-routes'], 'resolved');
  assert.ok(result.executions.find(e => e.generator === 'project-context/feature-map')?.outputs.some(p => p.endsWith('items.yaml')));
  const architecture = readFileSync(join(root, '.paved/project/architecture/overview.md'), 'utf8');
  assert.match(architecture, /Angular core dependency version/);
  assert.match(architecture, /adapter_version: 0.1.0/);
  assert.doesNotMatch(architecture, /TOP_SECRET_VALUE|secret-host/);
  const manifest = parse(readFileSync(join(root, '.paved/manifest.yaml'), 'utf8')) as {adapters: {id:string}[]};
  assert.deepEqual(manifest.adapters.map(a=>a.id), ['technology/angular','technology/postgresql']);
  assert.ok(result.unmatchedTechnologies.includes('Node.js package scripts'));
});

test('adapter content and framework are independent of consumer business terminology', () => {
  const content = adapters.map(a => readFileSync(join(core, 'adapters', a.id, 'adapter.yaml'), 'utf8')).join('\n');
  assert.doesNotMatch(content, /Apecatus|Student|Subscription|Course/i);
  const root = join(fixtures, 'postgresql-project'); const sources = discoverSources(root);
  assert.equal(collectEvidence(root, sources, detected('postgresql-project', 'technology/postgresql'), 'database.migrations')[0]?.value, 'items');
});

test('Core capability meanings are complete and technology neutral', () => {
  const registry = parse(readFileSync(join(core, 'core/capabilities/registry.yaml'), 'utf8')) as {capabilities:{id:string;meaning:string;consumer:string;tool_capability?:string}[]};
  const ids = registry.capabilities.map(c=>c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(registry.capabilities.every(c=>c.consumer && c.meaning));
  assert.doesNotMatch(JSON.stringify(registry), /Apecatus|Quarkus|Angular|PostgreSQL|Maven|Java/i);
  for (const adapter of adapters) for (const cap of adapter.provides?.capabilities ?? []) assert.ok(ids.includes(cap.id));
  for (const capability of registry.capabilities.filter(c => c.tool_capability)) { const tool = parse(readFileSync(join(core, 'core/tools', capability.id.replace('.', '/') + '.yaml'), 'utf8')) as { id:string; capability:string }; assert.equal(tool.id, capability.consumer); assert.equal(tool.capability, capability.tool_capability); }
});

test('repeated adapter provenance serializes without YAML alias exhaustion', () => {
  const root = temporaryDirectory('paved-many');
  mkdirSync(join(root, 'src/main/java/example'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Sample\n');
  writeFileSync(join(root, 'pom.xml'), '<project><artifactId>sample</artifactId></project>');
  for (let i=0;i<90;i++) writeFileSync(join(root, `src/main/java/example/Item${i}.java`), `package example.item${i}; class Item${i} {}`);
  initializeConsumer(core, root, 'sample');
  const result = runGenerators(core, root);
  assert.equal(result.executions.find(e => e.generator === 'project-context/domain')?.status, 'written');
  const document = readFileSync(join(root, '.paved/project/domain/overview.md'), 'utf8');
  assert.match(document, /adapter_version: 0.1.0/);
});

test('generator code does not select a concrete adapter by technology name', () => {
  const runtime = readFileSync(join(core, 'cli/lib/generator-runtime.ts'), 'utf8');
  assert.doesNotMatch(runtime, /technology\/(?:java|quarkus|angular|postgresql)/);
  assert.doesNotMatch(runtime, /if\s*\([^)]*technology\s*===/);
});

test('incompatible adapter dependency is diagnosed without selecting dependent adapter', () => {
  const base = detected('quarkus-project', 'technology/quarkus');
  const java = detected('quarkus-project', 'technology/java');
  const incompatible: AdapterContract = { ...base.adapter, requires: { core: '^1.0.0', adapters: [{ id: 'technology/java', version: '^9.0.0' }] } };
  const result = resolveAdapters([{...base, adapter: incompatible}, java], [{id: incompatible.id, version: '^0.1.0'}], '1.0.0');
  assert.ok(result.diagnostics.some(d => d.code === 'incompatible'));
  assert.ok(result.diagnostics.some(d => d.code === 'dependency'));
  assert.ok(!result.adapters.some(d => d.adapter.id === incompatible.id));
});

test('Node scripts and CI files remain unmodeled without requiring adapters', () => {
  const root = temporaryDirectory('paved-unmodeled');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Sample\n');
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  writeFileSync(join(root, '.github/workflows/check.yml'), 'name: sample\n');
  initializeConsumer(core, root, 'sample');
  const result = runGenerators(core, root);
  assert.deepEqual(result.selectedAdapters, []);
  assert.ok(result.unmodeledTechnologies.includes('Node.js package scripts'));
  assert.ok(result.unmodeledTechnologies.includes('GitHub Actions'));
  assert.ok(!adapters.some(a => /node|ci/i.test(a.id)));
  assert.equal(result.adapterDiagnostics.length, 0);
});

test('Core has no consumer business names and adapters do not generate project policy', () => {
  const coreFiles = [join(core, 'core/capabilities/registry.yaml'), join(core, 'schemas/adapter.schema.yaml')];
  for (const path of coreFiles) assert.doesNotMatch(readFileSync(path, 'utf8'), /Apecatus|Student|Subscription|Course/i);
  for (const adapter of adapters) {
    assert.ok((adapter.provides?.capabilities ?? []).every(c=>c.evidence.every(e=>!/(?:must|should|recommended)\b/i.test(e.statement))));
  }
});
