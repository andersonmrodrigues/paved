import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { discoverSources, hashSource, initializeConsumer, runGenerators } from '../../cli/lib/generator-runtime.ts';

const core = fileURLToPath(new URL('../..', import.meta.url));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'paved-generator-'));
  mkdirSync(join(dir, 'web', 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Example\n');
  writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ name: 'example', dependencies: { '@angular/core': '^19.2.15' }, scripts: { test: 'node --test' } }));
  writeFileSync(join(dir, 'web', 'angular.json'), '{"projects":{}}');
  writeFileSync(join(dir, 'web', 'src', 'app-routing.module.ts'), "const routes = [{ path: 'courses', component: CoursesPage }];\n");
  return dir;
}

test('discovery and content hashes are stable and exclude Paved state', () => {
  const dir = fixture();
  const first = discoverSources(dir);
  assert.deepEqual(first.map(s => s.path), [...first.map(s => s.path)].sort());
  assert.equal(hashSource(dir, 'README.md'), hashSource(dir, 'README.md'));
  initializeConsumer(core, dir, 'example');
  assert.deepEqual(discoverSources(dir), first);
});

test('run validates contracts, orders dependencies, records unknowns and regenerates safely', () => {
  const dir = fixture();
  initializeConsumer(core, dir, 'example');
  const first = runGenerators(core, dir);
  assert.equal(first.errors.length, 0);
  assert.ok(first.executions.find(e => e.generator === 'project-context/feature-map'));
  const architecture = join(dir, '.paved/project/architecture/overview.md');
  const before = readFileSync(architecture, 'utf8');
  assert.match(before, /provenance:/);
  assert.match(before, /unknowns:/);
  assert.doesNotMatch(before, /recommended|must use/i);
  const second = runGenerators(core, dir);
  assert.equal(readFileSync(architecture, 'utf8'), before);
  assert.ok(second.executions.some(e => e.status === 'unchanged'));
  writeFileSync(architecture, before.replace('Implemented structure', 'Human note'));
  const third = runGenerators(core, dir);
  assert.match(readFileSync(architecture, 'utf8'), /Human note/);
  assert.ok(third.executions.some(e => e.status === 'conflict'));
  assert.ok(third.executions.some(e => e.proposals.length > 0));
});

test('dry-run plans generator work without creating generated state or outputs', () => {
  const dir = fixture();
  initializeConsumer(core, dir, 'example');
  const beforeManifest = readFileSync(join(dir, '.paved/manifest.yaml'), 'utf8');
  const beforeLock = readFileSync(join(dir, '.paved/paved.lock'), 'utf8');

  const result = runGenerators(core, dir, { dryRun: true });

  assert.equal(result.errors.length, 0);
  assert.ok(result.executions.some(e => e.generator === 'project-context/architecture'));
  assert.equal(readFileSync(join(dir, '.paved/manifest.yaml'), 'utf8'), beforeManifest);
  assert.equal(readFileSync(join(dir, '.paved/paved.lock'), 'utf8'), beforeLock);
  assert.equal(existsSync(join(dir, '.paved/generated')), false);
  assert.equal(existsSync(join(dir, '.paved/project')), false);
});

test('selected generators run with dependency closure in topological order', () => {
  const dir = fixture();
  initializeConsumer(core, dir, 'example');

  const result = runGenerators(core, dir, { generators: ['project-context/feature-map'] });

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.executions.map(e => e.generator), [
    'project-context/architecture',
    'project-context/domain',
    'project-context/product',
    'project-context/feature-map',
  ]);
  assert.ok(existsSync(join(dir, '.paved/project/feature-map')));
  assert.equal(existsSync(join(dir, '.paved/generated/proposals/verification/profile.yaml')), false);
});

test('invalid generator selectors fail before writing generated files', () => {
  const dir = fixture();
  initializeConsumer(core, dir, 'example');

  const result = runGenerators(core, dir, { generators: ['project-context/not-real'] });

  assert.ok(result.errors.some(error => /Unknown generator selector: project-context\/not-real/.test(error)));
  assert.deepEqual(result.executions, []);
  assert.equal(existsSync(join(dir, '.paved/generated')), false);
  assert.equal(existsSync(join(dir, '.paved/project')), false);
});

test('dry-run conflict planning does not write proposals, baselines, or last-run', () => {
  const dir = fixture();
  initializeConsumer(core, dir, 'example');
  runGenerators(core, dir);
  const path = join(dir, '.paved/project/architecture/overview.md');
  const humanEdited = readFileSync(path, 'utf8').replace('Implemented structure', 'Human note');
  writeFileSync(path, humanEdited);
  const proposals = join(dir, '.paved/generated/proposals');
  const state = join(dir, '.paved/generated/state');
  const proposalEntries = existsSync(proposals) ? readdirSync(proposals, { recursive: true }).map(String).sort() : [];
  const stateEntries = existsSync(state) ? readdirSync(state, { recursive: true }).map(String).sort() : [];
  const lastRun = readFileSync(join(state, 'last-run.json'), 'utf8');

  const result = runGenerators(core, dir, { dryRun: true });

  assert.equal(readFileSync(path, 'utf8'), humanEdited);
  assert.ok(result.executions.some(e => e.generator === 'project-context/architecture' && e.status === 'conflict'));
  assert.deepEqual(existsSync(proposals) ? readdirSync(proposals, { recursive: true }).map(String).sort() : [], proposalEntries);
  assert.deepEqual(existsSync(state) ? readdirSync(state, { recursive: true }).map(String).sort() : [], stateEntries);
  assert.equal(existsSync(join(state, 'last-run.json')), true, 'pre-existing last-run stays untouched');
  assert.equal(readFileSync(join(state, 'last-run.json'), 'utf8'), lastRun);
});

test('repeated code and scripts are observations, not project policy', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'web/src/a.ts'), 'directDatabaseAccess();\n');
  writeFileSync(join(dir, 'web/src/b.ts'), 'directDatabaseAccess();\n');
  initializeConsumer(core, dir, 'example');
  const result = runGenerators(core, dir);
  assert.equal(result.errors.length, 0);
  const proposalPaths = result.executions.flatMap(e => e.proposals);
  assert.equal(proposalPaths.filter(p => /proposals\/(rules|skills|tools)\//.test(p)).length, 0);
  const product = readFileSync(join(dir, '.paved/project/product/overview.md'), 'utf8');
  assert.match(product, /unknowns:/);
  assert.doesNotMatch(product, /subscription|payment/);
});

test('managed block regeneration preserves human text outside a trusted baseline', () => {
  const dir = fixture(); initializeConsumer(core, dir, 'example'); runGenerators(core, dir);
  const path = join(dir, '.paved/project/architecture/overview.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nHuman architecture note.\n');
  writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ name: 'example', scripts: { build: 'node build.js' } }));
  const result = runGenerators(core, dir);
  assert.equal(result.errors.length, 0);
  assert.match(readFileSync(path, 'utf8'), /Human architecture note/);
  assert.ok(!result.executions.some(e => e.generator === 'project-context/architecture' && e.status === 'conflict'));
});

test('dry-run trusted managed-block merge reports the same final hash as a later write without mutating files', () => {
  const dir = fixture();
  try {
    initializeConsumer(core, dir, 'example');
    runGenerators(core, dir, { generators: ['project-context/architecture'] });
    const outputPath = '.paved/project/architecture/overview.md';
    const absoluteOutputPath = join(dir, outputPath);
    const withHumanText = `${readFileSync(absoluteOutputPath, 'utf8')}\nHuman architecture note.\n`;
    writeFileSync(absoluteOutputPath, withHumanText);
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeFileSync(join(dir, 'server', 'package.json'), JSON.stringify({ name: 'server', scripts: { build: 'node build.js' } }));
    const beforeDryRun = readFileSync(absoluteOutputPath, 'utf8');

    const dryRun = runGenerators(core, dir, { dryRun: true, generators: ['project-context/architecture'] });
    const dryRunExecution = dryRun.executions.find(e => e.generator === 'project-context/architecture');

    assert.equal(readFileSync(absoluteOutputPath, 'utf8'), beforeDryRun);
    assert.equal(dryRunExecution?.status, 'written');
    assert.equal(typeof dryRunExecution?.outputHashes[outputPath], 'string');

    const generated = runGenerators(core, dir, { generators: ['project-context/architecture'] });
    const generatedExecution = generated.executions.find(e => e.generator === 'project-context/architecture');

    assert.equal(generatedExecution?.status, 'written');
    assert.equal(dryRunExecution?.outputHashes[outputPath], generatedExecution?.outputHashes[outputPath]);
    assert.match(readFileSync(absoluteOutputPath, 'utf8'), /Human architecture note/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('route names with separators produce schema-valid feature ids', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'web/src/app-routing.module.ts'), "const routes = [{ path: 'course--period', component: Page }];\n");
  initializeConsumer(core, dir, 'example');
  const result = runGenerators(core, dir);
  assert.equal(result.errors.length, 0);
  assert.ok(result.executions.find(e => e.generator === 'project-context/feature-map')?.outputs.some(p => p.endsWith('course-period.yaml')));
});

test('discovery excludes nested agent worktrees', () => {
  const dir = fixture();
  mkdirSync(join(dir, '.claude/worktrees/other'), { recursive: true });
  writeFileSync(join(dir, '.claude/worktrees/other/package.json'), '{"name":"duplicate"}');
  assert.ok(discoverSources(dir).every(s => !s.path.startsWith('.claude/')));
});

test('integration context never emits configuration values', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'web/application.properties'), 'service.url=https://example.invalid\napi.key=TOP_SECRET_VALUE\n');
  initializeConsumer(core, dir, 'example');
  assert.equal(runGenerators(core, dir).errors.length, 0);
  const content = readFileSync(join(dir, '.paved/project/integrations/overview.md'), 'utf8');
  assert.doesNotMatch(content, /TOP_SECRET_VALUE|https:\/\/example\.invalid/);
});

test('missing source stops dependent generators and records the failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paved-empty-'));
  initializeConsumer(core, dir, 'empty');
  const result = runGenerators(core, dir);
  assert.ok(result.errors.some(e => e.includes('Required repository source missing')));
  assert.equal(result.executions.find(e => e.generator === 'project-context/domain')?.status, 'failed');
});

test('unmatched technology is recorded without fabricating an adapter', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'web/angular.json'), '{}');
  initializeConsumer(core, dir, 'example');
  const result = runGenerators(core, dir);
  assert.ok(result.selectedAdapters.includes('technology/angular'));
  assert.ok(!result.unmatchedTechnologies.includes('Angular'));
  assert.ok(result.unmatchedTechnologies.includes('Node.js package scripts'));
  const manifest = readFileSync(join(dir, '.paved/manifest.yaml'), 'utf8');
  assert.doesNotMatch(manifest, /frameworks\/angular/);
});

test('human edits to a Feature produce a proposal and preserve the edit', () => {
  const dir = fixture(); initializeConsumer(core, dir, 'example'); runGenerators(core, dir);
  const path = join(dir, '.paved/project/feature-map/web-courses.yaml');
  writeFileSync(path, readFileSync(path, 'utf8').replace('Product purpose is unconfirmed.', 'Human confirmed purpose.'));
  const result = runGenerators(core, dir);
  assert.match(readFileSync(path, 'utf8'), /Human confirmed purpose/);
  assert.equal(result.executions.find(e => e.generator === 'project-context/feature-map')?.status, 'conflict');
});

test('mechanically configured Checkstyle can produce a cited Rule proposal', () => {
  const dir = fixture();
  mkdirSync(join(dir, 'server'), { recursive: true });
  writeFileSync(join(dir, 'server/pom.xml'), '<project><artifactId>server</artifactId><artifactId>maven-checkstyle-plugin</artifactId><phase>validate</phase><goal>check</goal><configLocation>checkstyle.xml</configLocation><failOnViolation>true</failOnViolation></project>');
  writeFileSync(join(dir, 'server/checkstyle.xml'), '<module name="Checker"/>');
  initializeConsumer(core, dir, 'example');
  const result = runGenerators(core, dir);
  assert.equal(result.errors.length, 0);
  const rule = result.executions.find(e => e.generator === 'rules');
  assert.ok(rule?.proposals.some(p => p.endsWith('.yaml')));
  assert.ok(rule?.proposals.every(p => p.startsWith('.paved/generated/proposals/rules/')));
});

test('unavailable selected adapter is reported and generic analysis continues', () => {
  const dir = fixture(); initializeConsumer(core, dir, 'example');
  const path = join(dir, '.paved/manifest.yaml');
  const manifest = parse(readFileSync(path, 'utf8')) as { adapters: { id: string; version: string }[] };
  manifest.adapters.push({ id: 'frameworks/angular', version: '^0.1.0' });
  writeFileSync(path, stringify(manifest));
  const result = runGenerators(core, dir);
  assert.ok(result.adapterWarnings.some(w => w.includes('frameworks/angular')));
  assert.equal(result.errors.length, 0);
  assert.ok(result.executions.some(e => e.generator === 'project-context/architecture' && e.status === 'written'));
});
