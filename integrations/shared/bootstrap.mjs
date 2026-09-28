#!/usr/bin/env node
// Standalone launcher copied with the agent integration. It uses Node and npm only.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(process.cwd());
const runtimeDir = join(projectRoot, '.paved', 'runtime');
const selectionPath = join(runtimeDir, 'selection.json');
const configPath = join(launcherDir, 'bootstrap.json');
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const digestPattern = /^[a-f0-9]{64}$/;

function fail(code, message, nextAction) {
  process.stdout.write(`${JSON.stringify({ command: 'bootstrap', status: 'failed', diagnostics: [{ severity: 'error', category: 'resolution', code, component: 'runtime.bootstrap', message, remediation: nextAction }] })}\n`);
  process.exit(5);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('PAVED_RUNTIME_STATE_INVALID', `Cannot read valid JSON at ${path}.`, 'Repair the Paved runtime state from a known-good integration or backup.'); }
}

function assertInside(path, root) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('PAVED_RUNTIME_PATH_ESCAPE', `Runtime path escapes ${root}.`, 'Remove the invalid runtime state.');
}

function noSymlinks(path, root) {
  assertInside(path, root);
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', `Refusing runtime symlink: ${current}.`, 'Remove the symlink and restore a verified runtime.');
  }
}

function digestFile(path, algorithm) { return createHash(algorithm).update(readFileSync(path)).digest(algorithm === 'sha512' ? 'base64' : 'hex'); }

function digestTree(root) {
  const entries = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', `Package contains a symlink: ${full}.`, 'Use a package without symbolic links.');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) entries.push(`${relative(root, full).split(sep).join('/')}\0${digestFile(full, 'sha256')}`);
      else fail('PAVED_RUNTIME_CONTENT_INVALID', `Unexpected package entry: ${full}.`, 'Use a valid paved-core package.');
    }
  }
  walk(root);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', shell: false, timeout: 120000, env: { ...process.env, npm_config_ignore_scripts: 'true' }, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail('PAVED_RUNTIME_ACQUISITION_FAILED', `${executable} ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim().slice(0, 1000)}`, 'Check registry connectivity and package availability, or retry with a valid local cache.');
  return result.stdout;
}

function writeAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

// The bootstrap reads only the runtime fields written by Paved. An old lock has an
// explicit migration path; malformed fields never select an unverified runtime.
function lockedRuntime() {
  const path = join(projectRoot, '.paved', 'paved.lock');
  if (!existsSync(path)) return undefined;
  noSymlinks(path, projectRoot);
  const text = readFileSync(path, 'utf8');
  if ([...text.matchAll(/^runtime:/gm)].length !== 1) fail('PAVED_RUNTIME_LOCK_INVALID', 'The lock must contain exactly one runtime selection.', 'Restore a valid Paved lock from version control.');
  const block = /^runtime:[ \t]*\n((?:  [^\n]*\n)*)/m.exec(text)?.[1];
  if (!block) fail('PAVED_RUNTIME_LOCK_MIGRATION_REQUIRED', 'The existing Paved lock does not pin a runtime.', 'Continue using the direct packaged CLI for this legacy lock. Project-local launcher migration is not yet available; do not edit the lock by hand.');
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

function validateSelection(selection, expected) {
  if (!selection || selection.package !== 'paved-core' || !versionPattern.test(selection.version || '') || !integrityPattern.test(selection.integrity || '') || !digestPattern.test(selection.content_sha256 || '') || !/^[a-zA-Z0-9.-]+$/.test(selection.directory || '')) {
    fail('PAVED_RUNTIME_STATE_INVALID', 'Runtime selection is malformed.', 'Restore .paved/runtime/selection.json from a known-good backup.');
  }
  if (selection.version !== expected.version || (expected.integrity && selection.integrity !== expected.integrity) || (expected.content_sha256 && selection.content_sha256 !== expected.content_sha256)) {
    fail('PAVED_RUNTIME_LOCK_MISMATCH', 'Runtime selection differs from the authoritative pinned runtime.', 'Restore the runtime selected by paved.lock.');
  }
  const install = join(runtimeDir, 'versions', selection.directory);
  noSymlinks(install, runtimeDir);
  if (!existsSync(install) || !lstatSync(install).isDirectory()) fail('PAVED_RUNTIME_MISSING', 'Selected runtime directory is missing.', 'Restore the verified runtime package or bootstrap from its cached tarball.');
  if (digestTree(install) !== selection.content_sha256) fail('PAVED_RUNTIME_CORRUPT', 'Selected runtime content does not match its recorded digest.', 'Restore a known-good runtime; do not execute this installation.');
  const packageRoot = join(install, 'node_modules', 'paved-core');
  const metadata = readJson(join(packageRoot, 'package.json'));
  if (metadata.name !== 'paved-core' || metadata.version !== selection.version) fail('PAVED_RUNTIME_VERSION_MISMATCH', 'Installed package metadata differs from the pinned version.', 'Restore the pinned paved-core package.');
  const executable = join(packageRoot, 'cli', 'build', 'cli', 'index.js');
  noSymlinks(executable, runtimeDir);
  if (!existsSync(executable)) fail('PAVED_RUNTIME_MISSING', 'Packaged Paved executable is missing.', 'Restore the verified paved-core package.');
  return executable;
}

function acquire(config) {
  mkdirSync(join(runtimeDir, 'cache'), { recursive: true });
  mkdirSync(join(runtimeDir, 'versions'), { recursive: true });
  const cache = join(runtimeDir, 'cache', `paved-core-${config.version}.tgz`);
  if (config.tarball && !config.integrity) fail('PAVED_RUNTIME_INTEGRITY_UNAVAILABLE', 'A local runtime tarball requires an independently pinned SHA-512 integrity.', 'Supply the expected integrity with the integration package.');
  if (!config.integrity) {
    let metadata;
    try { metadata = JSON.parse(run('npm', ['view', `paved-core@${config.version}`, 'dist', '--json'], projectRoot)); }
    catch { fail('PAVED_RUNTIME_INTEGRITY_UNAVAILABLE', 'Registry metadata could not be parsed.', 'Retry against a registry that provides valid package integrity.'); }
    if (!integrityPattern.test(metadata.integrity || '')) fail('PAVED_RUNTIME_INTEGRITY_UNAVAILABLE', 'Registry metadata lacks valid integrity.', 'Retry against a registry that provides package integrity.');
    config.integrity = metadata.integrity;
  }
  if (!existsSync(cache)) {
    if (config.tarball) {
      if (!isAbsolute(config.tarball) || !existsSync(config.tarball)) fail('PAVED_RUNTIME_PACKAGE_UNAVAILABLE', 'Configured local runtime tarball is unavailable.', 'Provide the pinned tarball or enable registry access.');
      writeFileSync(cache, readFileSync(config.tarball), { flag: 'wx' });
    } else {
      const output = JSON.parse(run('npm', ['pack', `paved-core@${config.version}`, '--ignore-scripts', '--pack-destination', join(runtimeDir, 'cache'), '--json'], projectRoot));
      const produced = join(runtimeDir, 'cache', output[0]?.filename || '');
      if (produced !== cache || !existsSync(cache)) fail('PAVED_RUNTIME_PACKAGE_UNAVAILABLE', 'npm returned an unexpected package artifact.', 'Check the registry and retry.');
    }
  }
  const actualIntegrity = `sha512-${digestFile(cache, 'sha512')}`;
  if (config.integrity && actualIntegrity !== config.integrity) fail('PAVED_RUNTIME_INTEGRITY_MISMATCH', 'Cached runtime tarball does not match its pinned integrity.', 'Remove the corrupt tarball and reacquire the pinned package.');
  config.integrity = actualIntegrity;
  const staging = join(runtimeDir, `staging-${process.pid}`);
  if (existsSync(staging)) fail('PAVED_RUNTIME_PARTIAL_BOOTSTRAP', 'A staging directory already exists.', 'Inspect and remove stale staging state after confirming no bootstrap is active.');
  try {
    mkdirSync(staging);
    process.once('exit', () => { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); });
    run('npm', ['install', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund', '--package-lock=false', '--prefix', staging, cache], projectRoot);
    const packageRoot = join(staging, 'node_modules', 'paved-core');
    const metadata = readJson(join(packageRoot, 'package.json'));
    if (metadata.name !== 'paved-core' || metadata.version !== config.version) fail('PAVED_RUNTIME_VERSION_MISMATCH', 'Acquired runtime has unexpected package metadata.', 'Check the package source and version pin.');
    if (!existsSync(join(packageRoot, 'cli', 'build', 'cli', 'index.js'))) fail('PAVED_RUNTIME_MISSING', 'Acquired package has no compiled CLI.', 'Use a complete paved-core release artifact.');
    const contentSha = digestTree(staging);
    const directory = `${config.version}-${contentSha.slice(0, 12)}`;
    const destination = join(runtimeDir, 'versions', directory);
    if (existsSync(destination)) {
      if (digestTree(destination) !== contentSha) fail('PAVED_RUNTIME_CORRUPT', 'Existing runtime directory has a mismatched digest.', 'Restore or remove the corrupt runtime after investigation.');
      rmSync(staging, { recursive: true, force: true });
    } else renameSync(staging, destination);
    const selection = { package: 'paved-core', version: config.version, integrity: config.integrity, content_sha256: contentSha, directory };
    writeAtomic(selectionPath, selection);
    return selection;
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
}

if (lstatSync(join(projectRoot, '.paved'), { throwIfNoEntry: false })?.isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', '.paved is a symbolic link.', 'Use a real project-local .paved directory.');
if (lstatSync(runtimeDir, { throwIfNoEntry: false })?.isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', '.paved/runtime is a symbolic link.', 'Use a real project-local runtime directory.');
noSymlinks(selectionPath, projectRoot);
if (lstatSync(configPath).isSymbolicLink()) fail('PAVED_RUNTIME_SYMLINK', 'Integration bootstrap config is a symbolic link.', 'Reinstall the Paved integration without symbolic links.');
const config = readJson(configPath);
if (config.package !== 'paved-core' || !versionPattern.test(config.version || '') || (config.integrity && !integrityPattern.test(config.integrity))) fail('PAVED_RUNTIME_CONFIG_INVALID', 'Integration bootstrap config is invalid.', 'Reinstall a valid Paved agent integration.');
const locked = lockedRuntime();
const expected = locked || config;
let selection = existsSync(selectionPath) ? readJson(selectionPath) : undefined;
if (!selection) {
  mkdirSync(runtimeDir, { recursive: true });
  const operationLock = join(runtimeDir, '.bootstrap-lock');
  try { mkdirSync(operationLock); } catch { fail('PAVED_RUNTIME_CONCURRENT_BOOTSTRAP', 'Another runtime bootstrap is active.', 'Wait for it to finish and retry.'); }
  const owner = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const ownerPath = join(operationLock, 'owner');
  writeFileSync(ownerPath, owner, { flag: 'wx' });
  const release = () => {
    if (existsSync(ownerPath) && readFileSync(ownerPath, 'utf8') === owner) rmSync(operationLock, { recursive: true, force: true });
  };
  process.once('exit', release);
  try { selection = acquire({ ...expected }); }
  finally { release(); }
}
const executable = validateSelection(selection, expected);
const child = spawnSync(process.execPath, [executable, ...process.argv.slice(2)], { cwd: projectRoot, shell: false, stdio: 'inherit', env: process.env });
if (child.error) fail('PAVED_RUNTIME_EXECUTION_FAILED', child.error.message, 'Inspect the installed runtime and retry.');
process.exit(child.status ?? 1);
