#!/usr/bin/env node
// Standalone launcher copied with the agent integration. It uses Node and npm only.
// It is a transport and bootstrap layer: it locates the consumer, activates the pinned
// runtime under .paved/runtime/ and hands the arguments to the packaged Paved CLI.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const launcherDir = realpathSync(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(launcherDir);
const configPath = join(launcherDir, 'bootstrap.json');
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const scriptPattern = /\.(?:js|mjs|cjs)$/;

function emit(command, status, data, diagnostics = []) {
  process.stdout.write(`${JSON.stringify({ command, status, ...(data === undefined ? {} : { data }), diagnostics })}\n`);
}

function diagnostic(code, message, remediation, severity = 'error') {
  return { severity, category: 'resolution', code, component: 'runtime.bootstrap', message, remediation };
}

function fail(code, message, nextAction) {
  emit('bootstrap', 'failed', undefined, [diagnostic(code, message, nextAction)]);
  process.exit(5);
}

// Notices go to stderr so the CLI's JSON on stdout stays the only structured result.
function notice(code, message, nextAction) {
  process.stderr.write(`${JSON.stringify({ notice: diagnostic(code, message, nextAction, 'info') })}\n`);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('PAVED_RUNTIME_STATE_INVALID', `Cannot read valid JSON at ${path}.`, 'Repair the Paved runtime state from a known-good integration or backup.'); }
}

function inside(path, root) {
  const rel = relative(root, path);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

function assertInside(path, root) {
  if (!inside(path, root)) fail('PAVED_RUNTIME_PATH_ESCAPE', `Runtime path escapes ${root}.`, 'Remove the invalid runtime state.');
}

function noSymlinks(path, root) {
  assertInside(path, root);
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', `Refusing runtime symlink: ${current}.`, 'Remove the symlink and restore a verified runtime.');
  }
}

// The consumer is the explicit --project, else the nearest ancestor holding Paved state or
// a repository root, so a nested repository is never managed by its parent. The plugin
// installation is never the consumer.
function resolveProjectRoot(argv) {
  const flag = argv.findIndex((arg) => arg === '--project' || arg.startsWith('--project='));
  let root;
  if (flag !== -1) {
    const value = argv[flag] === '--project' ? argv[flag + 1] : argv[flag].slice('--project='.length);
    if (!value) fail('PAVED_RUNTIME_PROJECT_INVALID', '--project requires a path.', 'Pass the consumer repository path.');
    root = resolve(value);
  } else {
    const start = resolve(process.cwd());
    for (let current = start; ; current = dirname(current)) {
      if (existsSync(join(current, '.paved', 'manifest.yaml')) || existsSync(join(current, '.git'))) { root = current; break; }
      if (dirname(current) === current) { root = start; break; }
    }
  }
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) fail('PAVED_RUNTIME_PROJECT_INVALID', `Consumer project is not a directory: ${root}.`, 'Run Paved from inside the repository you want to manage.');
  // Compared physically so a symlinked path cannot disguise the plugin or Core checkout.
  root = realpathSync(root);
  if (inside(root, packageRoot)) fail('PAVED_RUNTIME_PROJECT_INVALID', 'The consumer project resolves inside the Paved plugin installation.', 'Open the repository you want to manage and run Paved from there.');
  const manifest = join(root, 'manifest.yaml');
  if (existsSync(manifest) && /^kind: Core$/m.test(readFileSync(manifest, 'utf8')) && /^name: paved-core$/m.test(readFileSync(manifest, 'utf8'))) {
    fail('PAVED_RUNTIME_PROJECT_INVALID', 'The consumer project is the Paved Core source checkout.', 'Paved Core is not a consumer; run the development CLI with --project pointing at another repository.');
  }
  return root;
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function digestFile(path, algorithm) { return createHash(algorithm).update(readFileSync(path)).digest(algorithm === 'sha512' ? 'base64' : 'hex'); }

function checkMode(path, mode, label) {
  if (mode & 0o7000) fail('PAVED_RUNTIME_UNEXPECTED_EXECUTABLE', `${label} has special permission bits: ${path}.`, 'Use an unmodified paved-core release artifact.');
  if (mode & 0o111 && !scriptPattern.test(path)) fail('PAVED_RUNTIME_UNEXPECTED_EXECUTABLE', `${label} contains an unexpected executable: ${path}.`, 'Use an unmodified paved-core release artifact.');
}

function digestTree(root) {
  const entries = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', `Package contains a symlink: ${full}.`, 'Use a package without symbolic links.');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        checkMode(full, statSync(full).mode, 'Runtime');
        entries.push(`${relative(root, full).split(sep).join('/')}\0${digestFile(full, 'sha256')}`);
      } else fail('PAVED_RUNTIME_CONTENT_INVALID', `Unexpected package entry: ${full}.`, 'Use a valid paved-core package.');
    }
  }
  walk(root);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

// Checked before npm sees the archive: only regular files and directories under package/,
// no traversal, links, devices or unexpected executables.
function validateArchive(path) {
  let data;
  try { data = gunzipSync(readFileSync(path)); }
  catch { fail('PAVED_RUNTIME_ARCHIVE_INVALID', 'The runtime artifact is not a readable gzip archive.', 'Remove the corrupt tarball and reacquire the pinned package.'); }
  let offset = 0;
  let files = 0;
  let paxPath;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const mode = Number.parseInt(field(100, 8).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const bodyStart = offset + 512;
    if (!Number.isSafeInteger(size) || size < 0 || bodyStart + size > data.length) fail('PAVED_RUNTIME_ARCHIVE_INVALID', 'The runtime artifact is truncated or malformed.', 'Remove the corrupt tarball and reacquire the pinned package.');
    const body = data.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / 512) * 512;
    if (type === 'x') { paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1]; continue; }
    if (type === 'g') continue;
    const prefix = field(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = undefined;
    const parts = name.replace(/\/$/, '').split('/');
    if (type !== '0' && type !== '5') fail('PAVED_RUNTIME_ARCHIVE_UNSAFE', `Runtime artifact entry ${name} is not a regular file or directory.`, 'Use an unmodified paved-core release artifact.');
    if (name.startsWith('/') || name.includes('\\') || parts[0] !== 'package' || parts.some((part) => part === '' || part === '.' || part === '..')) {
      fail('PAVED_RUNTIME_ARCHIVE_UNSAFE', `Runtime artifact entry escapes the package root: ${name}.`, 'Use an unmodified paved-core release artifact.');
    }
    if (type === '0') { checkMode(name, mode, 'Runtime artifact'); files += 1; }
  }
  if (files === 0) fail('PAVED_RUNTIME_ARCHIVE_INVALID', 'The runtime artifact contains no files.', 'Use a complete paved-core release artifact.');
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', shell: false, timeout: 120000, env: { ...process.env, npm_config_ignore_scripts: 'true' }, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail('PAVED_RUNTIME_ACQUISITION_FAILED', `${executable} ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim().slice(0, 1000)}`, 'Check registry connectivity and package availability, or retry with a valid local cache.');
  return result.stdout;
}

function writeAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

function readConfig() {
  if (lstatSync(configPath, { throwIfNoEntry: false })?.isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', 'Integration bootstrap config is a symbolic link.', 'Reinstall the Paved integration without symbolic links.');
  if (!existsSync(configPath)) fail('PAVED_RUNTIME_CONFIG_INVALID', 'Integration bootstrap config is missing.', 'Reinstall a valid Paved agent integration.');
  const config = readJson(configPath);
  if (config.package !== 'paved-core' || !versionPattern.test(config.version || '') || (config.integrity && !integrityPattern.test(config.integrity)) || (config.tarball !== undefined && typeof config.tarball !== 'string')) {
    fail('PAVED_RUNTIME_CONFIG_INVALID', 'Integration bootstrap config is invalid.', 'Reinstall a valid Paved agent integration.');
  }
  if (config.tarball && !isAbsolute(config.tarball)) {
    // A bundled artifact is addressed relative to the launcher and must stay in its package.
    const bundled = resolve(launcherDir, config.tarball);
    noSymlinks(bundled, packageRoot);
    config.tarball = bundled;
  }
  return config;
}

// The bootstrap reads only the runtime fields written by Paved. Malformed fields never
// select an unverified runtime. Returns undefined without a lock and null for a legacy
// lock written by the direct CLI, which pins no runtime and is adopted by `runtime upgrade`.
function lockedRuntime(ctx) {
  if (!existsSync(ctx.lockPath)) return undefined;
  noSymlinks(ctx.lockPath, ctx.projectRoot);
  const text = readFileSync(ctx.lockPath, 'utf8');
  const entries = [...text.matchAll(/^runtime:/gm)].length;
  if (entries === 0) return null;
  if (entries !== 1) fail('PAVED_RUNTIME_LOCK_INVALID', 'The lock must contain exactly one runtime selection.', 'Restore a valid Paved lock from version control.');
  const block = /^runtime:[ \t]*\n((?:  [^\n]*\n)*)/m.exec(text)?.[1];
  if (!block) fail('PAVED_RUNTIME_LOCK_INVALID', 'The runtime entry in paved.lock is malformed.', 'Restore a valid Paved lock from version control.');
  const fields = Object.fromEntries(block.trimEnd().split('\n').map((line) => {
    const match = /^  ([a-z0-9_]+): ([^\s]+)$/.exec(line);
    if (!match) fail('PAVED_RUNTIME_LOCK_INVALID', 'The runtime entry in paved.lock is malformed.', 'Restore a valid Paved lock from version control.');
    return [match[1], match[2]];
  }));
  if (fields.package !== 'paved-core' || !versionPattern.test(fields.version || '') || !integrityPattern.test(fields.integrity || '') || !digestPattern.test(fields.content_sha256 || '')) {
    fail('PAVED_RUNTIME_LOCK_INVALID', 'The runtime entry in paved.lock is malformed.', 'Restore a valid Paved lock from version control.');
  }
  return fields;
}

// Fields absent on either side (a registry pin has no integrity until acquisition) do not differ.
function sameRuntime(a, b) {
  const same = (field) => !a[field] || !b[field] || a[field] === b[field];
  return a.version === b.version && same('integrity') && same('content_sha256');
}

function validateSelection(ctx, selection, expected, remediation = 'Restore the runtime selected by paved.lock.') {
  if (!selection || selection.package !== 'paved-core' || !versionPattern.test(selection.version || '') || !integrityPattern.test(selection.integrity || '') || !digestPattern.test(selection.content_sha256 || '') || !/^[a-zA-Z0-9.-]+$/.test(selection.directory || '')) {
    fail('PAVED_RUNTIME_STATE_INVALID', 'Runtime selection is malformed.', 'Restore .paved/runtime/selection.json from a known-good backup.');
  }
  if (selection.version !== expected.version || (expected.integrity && selection.integrity !== expected.integrity) || (expected.content_sha256 && selection.content_sha256 !== expected.content_sha256)) {
    fail('PAVED_RUNTIME_LOCK_MISMATCH', 'Runtime selection differs from the authoritative pinned runtime.', remediation);
  }
  const install = join(ctx.runtimeDir, 'versions', selection.directory);
  noSymlinks(install, ctx.runtimeDir);
  if (!existsSync(install) || !lstatSync(install).isDirectory()) fail('PAVED_RUNTIME_MISSING', 'Selected runtime directory is missing.', 'Restore the verified runtime package or bootstrap from its cached tarball.');
  if (digestTree(install) !== selection.content_sha256) fail('PAVED_RUNTIME_CORRUPT', 'Selected runtime content does not match its recorded digest.', 'Restore a known-good runtime; do not execute this installation.');
  const installed = join(install, 'node_modules', 'paved-core');
  const metadata = readJson(join(installed, 'package.json'));
  if (metadata.name !== 'paved-core' || metadata.version !== selection.version) fail('PAVED_RUNTIME_VERSION_MISMATCH', 'Installed package metadata differs from the pinned version.', 'Restore the pinned paved-core package.');
  const executable = join(installed, 'cli', 'build', 'cli', 'index.js');
  noSymlinks(executable, ctx.runtimeDir);
  if (!existsSync(executable)) fail('PAVED_RUNTIME_MISSING', 'Packaged Paved executable is missing.', 'Restore the verified paved-core package.');
  return executable;
}

function cacheArtifact(ctx, config) {
  const cache = join(ctx.runtimeDir, 'cache', `paved-core-${config.version}.tgz`);
  const copyBundled = () => {
    if (!isAbsolute(config.tarball) || !existsSync(config.tarball)) fail('PAVED_RUNTIME_PACKAGE_UNAVAILABLE', 'Configured local runtime tarball is unavailable.', 'Reinstall the Paved plugin, or provide the pinned tarball.');
    writeAtomic(cache, readFileSync(config.tarball));
  };
  if (!existsSync(cache)) {
    if (config.tarball) copyBundled();
    else {
      const output = JSON.parse(run('npm', ['pack', `paved-core@${config.version}`, '--ignore-scripts', '--pack-destination', join(ctx.runtimeDir, 'cache'), '--json'], ctx.projectRoot));
      const produced = join(ctx.runtimeDir, 'cache', output[0]?.filename || '');
      if (produced !== cache || !existsSync(cache)) fail('PAVED_RUNTIME_PACKAGE_UNAVAILABLE', 'npm returned an unexpected package artifact.', 'Check the registry and retry.');
    }
  }
  noSymlinks(cache, ctx.runtimeDir);
  let actual = `sha512-${digestFile(cache, 'sha512')}`;
  if (actual !== config.integrity && config.tarball) {
    // The cache is disposable; an interrupted copy is replaced once from the pinned artifact.
    rmSync(cache, { force: true });
    copyBundled();
    actual = `sha512-${digestFile(cache, 'sha512')}`;
  }
  if (config.integrity && actual !== config.integrity) {
    rmSync(cache, { force: true });
    fail('PAVED_RUNTIME_INTEGRITY_MISMATCH', 'The runtime tarball does not match its pinned integrity.', 'Reacquire the pinned package; do not activate an unverified runtime.');
  }
  return { cache, integrity: actual };
}

// Installs and verifies a runtime version without selecting it. Callers hold the bootstrap lock.
function acquire(ctx, pinned) {
  const config = { ...pinned };
  mkdirSync(join(ctx.runtimeDir, 'cache'), { recursive: true });
  mkdirSync(join(ctx.runtimeDir, 'versions'), { recursive: true });
  if (config.tarball && !config.integrity) fail('PAVED_RUNTIME_INTEGRITY_UNAVAILABLE', 'A local runtime tarball requires an independently pinned SHA-512 integrity.', 'Supply the expected integrity with the integration package.');
  if (!config.integrity) {
    let metadata;
    try { metadata = JSON.parse(run('npm', ['view', `paved-core@${config.version}`, 'dist', '--json'], ctx.projectRoot)); }
    catch { fail('PAVED_RUNTIME_INTEGRITY_UNAVAILABLE', 'Registry metadata could not be parsed.', 'Retry against a registry that provides valid package integrity.'); }
    if (!integrityPattern.test(metadata.integrity || '')) fail('PAVED_RUNTIME_INTEGRITY_UNAVAILABLE', 'Registry metadata lacks valid integrity.', 'Retry against a registry that provides package integrity.');
    config.integrity = metadata.integrity;
  }
  const { cache, integrity } = cacheArtifact(ctx, config);
  validateArchive(cache);
  const staging = join(ctx.runtimeDir, `staging-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    mkdirSync(staging);
    process.once('exit', () => { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); });
    // A verified local artifact bundles its dependencies, so nothing is resolved remotely.
    run('npm', ['install', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund', '--package-lock=false', ...(config.tarball ? ['--offline'] : []), '--prefix', staging, cache], ctx.projectRoot);
    const unexpected = readdirSync(join(staging, 'node_modules')).filter((name) => name !== 'paved-core' && name !== '.package-lock.json');
    if (unexpected.length > 0) fail('PAVED_RUNTIME_UNEXPECTED_DEPENDENCY', `The runtime resolved dependencies outside the pinned artifact: ${unexpected.join(', ')}.`, 'Use a paved-core release artifact with bundled dependencies.');
    const installed = join(staging, 'node_modules', 'paved-core');
    const metadata = readJson(join(installed, 'package.json'));
    if (metadata.name !== 'paved-core' || metadata.version !== config.version) fail('PAVED_RUNTIME_VERSION_MISMATCH', 'Acquired runtime has unexpected package metadata.', 'Check the package source and version pin.');
    if (!existsSync(join(installed, 'cli', 'build', 'cli', 'index.js'))) fail('PAVED_RUNTIME_MISSING', 'Acquired package has no compiled CLI.', 'Use a complete paved-core release artifact.');
    const contentSha = digestTree(staging);
    const directory = `${config.version}-${contentSha.slice(0, 12)}`;
    const destination = join(ctx.runtimeDir, 'versions', directory);
    if (existsSync(destination)) {
      if (digestTree(destination) !== contentSha) fail('PAVED_RUNTIME_CORRUPT', 'Existing runtime directory has a mismatched digest.', 'Restore or remove the corrupt runtime after investigation.');
      rmSync(staging, { recursive: true, force: true });
    } else renameSync(staging, destination);
    return { package: 'paved-core', version: config.version, integrity, content_sha256: contentSha, directory };
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
}

function ownerAlive(owner) {
  const pid = Number.parseInt(owner.split('-')[0], 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Serializes runtime installation. A lock left by a process that no longer exists is
// recovered together with its staging directories; a live or unidentified owner is not.
function withBootstrapLock(ctx, action) {
  mkdirSync(ctx.runtimeDir, { recursive: true });
  const operationLock = join(ctx.runtimeDir, '.bootstrap-lock');
  const ownerPath = join(operationLock, 'owner');
  const owner = `${process.pid}-${randomBytes(8).toString('hex')}`;
  try { mkdirSync(operationLock); }
  catch {
    const previous = existsSync(ownerPath) ? readFileSync(ownerPath, 'utf8') : undefined;
    if (previous === undefined || ownerAlive(previous)) fail('PAVED_RUNTIME_CONCURRENT_BOOTSTRAP', 'Another runtime bootstrap is active.', 'Wait for it to finish and retry. If no Paved process is running, remove .paved/runtime/.bootstrap-lock.');
    rmSync(operationLock, { recursive: true, force: true });
    try { mkdirSync(operationLock); } catch { fail('PAVED_RUNTIME_CONCURRENT_BOOTSTRAP', 'Another runtime bootstrap is active.', 'Wait for it to finish and retry.'); }
  }
  writeFileSync(ownerPath, owner, { flag: 'wx' });
  const release = () => {
    if (existsSync(ownerPath) && readFileSync(ownerPath, 'utf8') === owner) rmSync(operationLock, { recursive: true, force: true });
  };
  process.once('exit', release);
  try {
    for (const entry of readdirSync(ctx.runtimeDir)) {
      if (entry.startsWith('staging-')) rmSync(join(ctx.runtimeDir, entry), { recursive: true, force: true });
    }
    return action();
  } finally { release(); }
}

function prepareRuntimeDir(ctx) {
  if (lstatSync(join(ctx.projectRoot, '.paved'), { throwIfNoEntry: false })?.isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', '.paved is a symbolic link.', 'Use a real project-local .paved directory.');
  if (lstatSync(ctx.runtimeDir, { throwIfNoEntry: false })?.isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', '.paved/runtime is a symbolic link.', 'Use a real project-local runtime directory.');
  noSymlinks(ctx.selectionPath, ctx.projectRoot);
}

function ensureIgnored(ctx) {
  const ignore = join(ctx.runtimeDir, '.gitignore');
  if (!existsSync(ignore)) writeAtomic(ignore, '# Project-local Paved runtime; reacquired from paved.lock.\n*\n');
}

// The plugin pin applies only when the project has no lock. A locked project keeps its
// runtime; the bundled artifact is reused when it is byte-identical to the locked one.
function effectivePin(config, locked) {
  if (!locked) return config;
  return sameRuntime(locked, config) ? { ...config, ...locked } : { package: 'paved-core', version: locked.version, integrity: locked.integrity, content_sha256: locked.content_sha256 };
}

function rollbackRecord(ctx) {
  return existsSync(ctx.rollbackPath) ? readJson(ctx.rollbackPath) : undefined;
}

function launch(ctx, config, argv) {
  const locked = lockedRuntime(ctx);
  if (locked === null) {
    fail('PAVED_RUNTIME_LOCK_MIGRATION_REQUIRED', 'This project was initialized without a pinned project-local runtime.', `Run the launcher with \`runtime upgrade\` to adopt runtime ${config.version} through a transactional Paved update (reversible with \`runtime rollback\`), or keep using the direct Paved CLI.`);
  }
  if (locked && !sameRuntime(locked, config)) {
    notice('PAVED_RUNTIME_UPDATE_AVAILABLE', `This Paved plugin provides runtime ${config.version}; the project stays on runtime ${locked.version} pinned by paved.lock.`, 'Review the change, then run the launcher with `runtime upgrade`. The pinned runtime keeps working until then.');
  }
  const expected = effectivePin(config, locked);
  let selection = existsSync(ctx.selectionPath) ? readJson(ctx.selectionPath) : undefined;
  if (!selection) {
    selection = withBootstrapLock(ctx, () => {
      if (existsSync(ctx.selectionPath)) return readJson(ctx.selectionPath);
      const acquired = acquire(ctx, expected);
      writeAtomic(ctx.selectionPath, acquired);
      return acquired;
    });
    ensureIgnored(ctx);
  }
  const executable = validateSelection(ctx, selection, expected, rollbackRecord(ctx)
    ? 'An interrupted runtime upgrade left a different selection; run the launcher with `runtime rollback`.'
    : 'Restore the runtime selected by paved.lock.');
  // The runtime receives the consumer the launcher resolved, so both always agree on it.
  const project = argv.some((arg) => arg === '--project' || arg.startsWith('--project=')) ? [] : ['--project', ctx.projectRoot];
  const child = spawnSync(process.execPath, [executable, ...project, ...argv], { cwd: ctx.projectRoot, shell: false, stdio: 'inherit', env: process.env });
  if (child.error) fail('PAVED_RUNTIME_EXECUTION_FAILED', child.error.message, 'Inspect the installed runtime and retry.');
  process.exit(child.status ?? 1);
}

function runtimeStatus(ctx, config) {
  const locked = lockedRuntime(ctx);
  const selection = existsSync(ctx.selectionPath) ? readJson(ctx.selectionPath) : undefined;
  const record = rollbackRecord(ctx);
  emit('runtime', 'success', {
    projectRoot: ctx.projectRoot,
    plugin: { package: config.package, version: config.version, integrity: config.integrity ?? null, bundled: Boolean(config.tarball) },
    locked: locked ?? null,
    selection: selection ?? null,
    migrationRequired: locked === null,
    updateAvailable: locked === null || Boolean(locked && !sameRuntime(locked, config)),
    rollbackAvailable: Boolean(record),
  });
  process.exit(0);
}

// Activates the plugin's runtime and lets that runtime move paved.lock through the Core's
// transactional update. The previous runtime and lock bytes are kept for rollback. A legacy
// lock has no previous runtime; adopting one records `previous: null`.
function runtimeUpgrade(ctx, config) {
  const locked = lockedRuntime(ctx);
  if (locked === undefined) fail('PAVED_RUNTIME_UPGRADE_UNAVAILABLE', 'Runtime upgrade requires an initialized project.', 'Run init first.');
  withBootstrapLock(ctx, () => {
    let current = null;
    if (locked !== null) {
      current = readJson(ctx.selectionPath);
      validateSelection(ctx, current, locked);
      if (sameRuntime(locked, config)) { emit('runtime', 'success', { changed: false, runtime: current }); return; }
    }
    if (rollbackRecord(ctx)) fail('PAVED_RUNTIME_UPGRADE_CONFLICT', 'A previous runtime upgrade is still recorded.', 'Run `runtime rollback`, or remove .paved/runtime/rollback.json after confirming the current runtime.');
    // Acquisition fails before anything is recorded, so a rejected artifact leaves no rollback state.
    const next = acquire(ctx, config);
    ensureIgnored(ctx);
    const lockBytes = readFileSync(ctx.lockPath);
    writeAtomic(ctx.rollbackLockPath, lockBytes);
    writeAtomic(ctx.rollbackPath, { previous: current, lock_sha256: sha256(lockBytes), created_at: new Date().toISOString() });
    writeAtomic(ctx.selectionPath, next);
    const executable = validateSelection(ctx, next, next);
    const child = spawnSync(process.execPath, [executable, 'update', '--json', '--project', ctx.projectRoot], { cwd: ctx.projectRoot, shell: false, encoding: 'utf8', env: process.env, maxBuffer: 16 * 1024 * 1024 });
    let result;
    try { result = JSON.parse(child.stdout); } catch { result = undefined; }
    const after = lockedRuntime(ctx);
    if (!child.error && result?.status !== 'failed' && after && sameRuntime(after, next)) {
      emit('runtime', result.status, { changed: true, previous: current, runtime: next, update: result.data ?? null }, result.diagnostics ?? []);
      return;
    }
    // The Core update is transactional; restoring the selection returns to the previous state.
    if (current) writeAtomic(ctx.selectionPath, current);
    else rmSync(ctx.selectionPath, { force: true });
    if (sha256(readFileSync(ctx.lockPath)) === sha256(lockBytes)) {
      rmSync(ctx.rollbackPath, { force: true });
      rmSync(ctx.rollbackLockPath, { force: true });
    }
    emit('runtime', 'failed', { changed: false, runtime: current, update: result?.data ?? null }, [
      ...(result?.diagnostics ?? []),
      diagnostic('PAVED_RUNTIME_UPGRADE_FAILED', `Runtime ${next.version} could not update this project; ${current ? `runtime ${current.version} remains selected` : 'the lock is unchanged'}.`, 'Resolve the reported update diagnostics, then retry the upgrade.'),
    ]);
    process.exitCode = 5;
  });
  process.exit(process.exitCode ?? 0);
}

function runtimeRollback(ctx) {
  withBootstrapLock(ctx, () => {
    const record = rollbackRecord(ctx);
    if (!record) fail('PAVED_RUNTIME_ROLLBACK_UNAVAILABLE', 'No runtime upgrade is recorded for rollback.', 'Nothing to roll back.');
    if (!existsSync(ctx.rollbackLockPath)) fail('PAVED_RUNTIME_ROLLBACK_CORRUPT', 'The recorded lock backup is missing.', 'Restore .paved/paved.lock from version control.');
    const lockBytes = readFileSync(ctx.rollbackLockPath);
    if (sha256(lockBytes) !== record.lock_sha256) fail('PAVED_RUNTIME_ROLLBACK_CORRUPT', 'The recorded lock backup does not match its digest.', 'Restore .paved/paved.lock from version control.');
    if (record.previous) validateSelection(ctx, record.previous, record.previous);
    writeAtomic(ctx.lockPath, lockBytes);
    if (record.previous) writeAtomic(ctx.selectionPath, record.previous);
    else rmSync(ctx.selectionPath, { force: true });
    rmSync(ctx.rollbackPath, { force: true });
    rmSync(ctx.rollbackLockPath, { force: true });
    emit('runtime', 'success', { changed: true, runtime: record.previous });
  });
  process.exit(0);
}

// Every failure leaves the process through fail(); unexpected filesystem errors are reported
// the same way instead of as a stack trace.
try {
  const argv = process.argv.slice(2);
  const projectRoot = resolveProjectRoot(argv);
  const runtimeDir = join(projectRoot, '.paved', 'runtime');
  const ctx = {
    projectRoot,
    runtimeDir,
    lockPath: join(projectRoot, '.paved', 'paved.lock'),
    selectionPath: join(runtimeDir, 'selection.json'),
    rollbackPath: join(runtimeDir, 'rollback.json'),
    rollbackLockPath: join(runtimeDir, 'rollback.lock'),
  };
  prepareRuntimeDir(ctx);
  const config = readConfig();
  if (argv[0] === 'runtime') {
    const [, action = 'status', ...rest] = argv;
    const extra = rest.filter((arg, index) => arg !== '--json' && !arg.startsWith('--project') && rest[index - 1] !== '--project');
    if (extra.length > 0) fail('PAVED_RUNTIME_USAGE', 'runtime accepts only status, upgrade or rollback.', 'Use `runtime status|upgrade|rollback --json`.');
    if (action === 'status') runtimeStatus(ctx, config);
    else if (action === 'upgrade') runtimeUpgrade(ctx, config);
    else if (action === 'rollback') runtimeRollback(ctx);
    else fail('PAVED_RUNTIME_USAGE', `Unknown runtime action: ${action}.`, 'Use `runtime status|upgrade|rollback --json`.');
  } else {
    launch(ctx, config, argv);
  }
} catch (error) {
  fail('PAVED_RUNTIME_IO_FAILED', `Runtime bootstrap failed: ${error instanceof Error ? error.message : String(error)}`, 'Check permissions and free space for .paved/runtime/ in the consumer repository, then retry.');
}
