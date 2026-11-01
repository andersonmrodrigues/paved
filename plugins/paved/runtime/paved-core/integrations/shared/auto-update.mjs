import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const hosts = ['claude-code', 'codex', 'cursor'];
const modes = ['off', 'notify', 'auto'];
const hour = 3600000;
const timeout = 30000;
const configDefaults = { apiVersion: 'paved/v1', kind: 'AutoUpdateConfig', mode: 'off', intervalHours: 24 };

function inside(path, root) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safePath(path) {
  if (!isAbsolute(path)) throw new Error('Expected an absolute path.');
  for (let current = path; ; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${current}`);
    if (dirname(current) === current) break;
  }
  return path;
}

function read(path, kind) {
  safePath(path);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || value.apiVersion !== 'paved/v1' || value.kind !== kind) throw new Error(`Invalid ${kind} at ${path}`);
  if (kind === 'AutoUpdateConfig') {
    if (Object.keys(value).some(key => !['apiVersion', 'kind', 'mode', 'intervalHours', 'host'].includes(key)) ||
        !modes.includes(value.mode) || !Number.isInteger(value.intervalHours) || value.intervalHours < 1 || value.intervalHours > 8760 ||
        (value.host !== undefined && !hosts.includes(value.host)) || (value.mode !== 'off' && value.host === undefined)) {
      throw new Error('Invalid automatic update authorization.');
    }
  } else {
    const allowed = ['apiVersion', 'kind', 'lastSuccess', 'nextAttempt', 'failures', 'completed'];
    if (Object.keys(value).some(key => !allowed.includes(key)) ||
        !['failures', 'nextAttempt', 'completed'].every(key => key in value) || value.failures > 20 ||
        ['lastSuccess', 'nextAttempt', 'failures'].some(key => value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) ||
        (value.completed !== undefined && (!Array.isArray(value.completed) || value.completed.some(stage => !['inventory', 'marketplace', 'plugin', 'adoption'].includes(stage))))) {
      throw new Error('Invalid automatic update state.');
    }
  }
  return value;
}

function write(path, value) {
  safePath(path);
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}-${randomBytes(8).toString('hex')}`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { renameSync(staging, path); } finally { rmSync(staging, { force: true }); }
}

function options(argv) {
  const [action = 'status', ...rest] = argv;
  if (!['configure', 'status', 'check', 'adopt'].includes(action)) throw new Error('Use auto-update configure|status|check.');
  const result = { action };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json' || flag === '--dry-run') { result[flag.slice(2)] = true; continue; }
    if (!['--mode', '--interval-hours', '--host', '--project'].includes(flag) || !rest[i + 1]) throw new Error(`Unknown or incomplete option: ${flag}`);
    if (flag === '--mode' && action !== 'configure' || flag === '--interval-hours' && action !== 'configure') throw new Error(`${flag} is configure-only.`);
    result[flag.slice(2)] = rest[++i];
  }
  if (result.host !== undefined && !hosts.includes(result.host)) throw new Error('Host must be claude-code, codex or cursor.');
  return result;
}

function suppressed(opts) {
  return opts['dry-run'] || ['CI', 'GITHUB_ACTIONS', 'PAVED_DRY_RUN'].some(key => process.env[key] && !['0', 'false'].includes(process.env[key].toLowerCase()));
}

const runValidators = new Map();
function runValidator(pluginRoot) {
  if (runValidators.has(pluginRoot)) return runValidators.get(pluginRoot);
  // Reuse the shipped dependencies and schemas, never modules from .paved state.
  const runtime = safePath(join(pluginRoot, 'runtime/paved-core'));
  const require = createRequire(join(runtime, 'package.json'));
  const { parse } = require('yaml');
  const { Ajv2020 } = require('ajv/dist/2020.js');
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
  const directory = safePath(join(runtime, 'schemas'));
  for (const entry of readdirSync(directory).filter(name => name.endsWith('.schema.yaml'))) {
    ajv.addSchema(parse(readFileSync(safePath(join(directory, entry)), 'utf8')));
  }
  const validate = ajv.getSchema('urn:paved:schema:workflow-run:v1');
  const terminal = text => {
    const document = parse(text);
    return document?.apiVersion === 'paved/v1' && document?.kind === 'WorkflowRun' &&
      ['completed', 'completed-with-warnings', 'cancelled'].includes(document.status) && validate(document) &&
      (document.status === 'cancelled' || document.phases.every(phase => ['completed', 'skipped'].includes(phase.status)));
  };
  runValidators.set(pluginRoot, terminal);
  return terminal;
}

function activeRuns(projectRoot, pluginRoot) {
  const directory = safePath(join(projectRoot, '.paved/generated/runs'));
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.yaml')) return true;
    const path = safePath(join(directory, entry));
    if (!lstatSync(path).isFile()) return true;
    const text = readFileSync(path, 'utf8');
    // Unknown/malformed/resumable records defer. Only explicitly terminal runs are safe.
    const status = /^status:\s*(?:["']?)([a-z-]+)(?:["']?)\s*$/gm;
    const matches = [...text.matchAll(status)];
    if (!/^kind: WorkflowRun\s*$/m.test(text) || matches.length !== 1 ||
        !['completed', 'completed-with-warnings', 'cancelled'].includes(matches[0][1])) return true;
    try { if (!runValidator(pluginRoot)(text)) return true; } catch { return true; }
  }
  return false;
}

function busy(root, pluginRoot) {
  return existsSync(join(root, '.paved-operation-lock')) || existsSync(join(root, '.paved/runtime/.bootstrap-lock')) || activeRuns(root, pluginRoot);
}

function lock(path, operation) {
  safePath(path);
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path); } catch (error) { if (error.code === 'EEXIST') return undefined; throw error; }
  const token = randomBytes(24).toString('hex');
  const ownerPath = join(path, 'owner.json');
  writeFileSync(ownerPath, JSON.stringify({ operation, pid: process.pid, token, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  let released = false;
  const release = () => {
    if (released) return;
    try {
      safePath(ownerPath);
      const entries = readdirSync(path);
      if (entries.length === 1 && entries[0] === 'owner.json' && JSON.parse(readFileSync(ownerPath, 'utf8')).token === token) rmSync(path, { recursive: true });
    } catch { /* Unknown ownership or contents are preserved for explicit recovery. */ }
    released = true;
  };
  process.once('exit', release);
  return { token, release, preserve: () => { released = true; } };
}

function executable(host, projectRoot, sourceRoot) {
  const name = host === 'claude-code' ? 'claude' : 'codex';
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(directory || '.', process.platform === 'win32' ? `${name}.exe` : name);
    if (!existsSync(path)) continue;
    const physical = realpathSync(path);
    if ([projectRoot, sourceRoot].some(root => inside(physical, root) || inside(path, root))) throw new Error('Refusing a host executable supplied by the consumer repository.');
    return path;
  }
  throw new Error(`${name} is unavailable.`);
}

function run(command, args, projectRoot, stages) {
  const result = spawnSync(command, args, { cwd: projectRoot, shell: false, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env: process.env });
  if (result.error || result.status !== 0) {
    const error = new Error(`Host stage failed after [${stages.join(', ')}]: ${result.error?.message ?? result.stderr.slice(0, 1024)}`);
    error.uncertainCompletion = result.error?.code === 'ETIMEDOUT';
    throw error;
  }
  return result.stdout;
}

function launcher(root, projectRoot, sourceRoot = projectRoot) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Host inventory did not provide an absolute installed plugin path.');
  safePath(root);
  if ([projectRoot, sourceRoot].some(project => inside(root, project))) throw new Error('Refusing a plugin installed inside the consumer repository.');
  const path = safePath(join(root, 'scripts/paved.mjs'));
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error('The refreshed plugin launcher is unavailable.');
  return path;
}

function family(path) {
  return /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(path.split(sep).at(-1)) ? dirname(path) : path;
}

function inventory(command, host, projectRoot, pluginRoot, scope, sourceRoot) {
  const document = JSON.parse(run(command, ['plugin', 'list', '--json'], sourceRoot, []));
  // Claude lists an array; Codex versions expose an array or a plugins collection.
  const entries = Array.isArray(document) ? document : document?.installed ?? document?.plugins;
  if (!Array.isArray(entries)) throw new Error('Unrecognized host plugin inventory.');
  const hostHome = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const installed = entries.filter(entry => (entry.id === 'paved@paved' || entry.pluginId === 'paved@paved' || (entry.name === 'paved' && entry.marketplaceName === 'paved')) && entry.enabled !== false && entry.installed !== false)
    .map(entry => host === 'codex' && !entry.installPath && !entry.installedPath
      ? { ...entry, installedPath: typeof entry.version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.version) ? join(hostHome, 'plugins/cache/paved/paved', entry.version) : undefined }
      : entry)
    .filter(entry => host !== 'claude-code' || (['user', 'project', 'local'].includes(entry.scope) &&
      (entry.scope === 'user' || typeof entry.projectPath === 'string' && resolve(entry.projectPath) === sourceRoot)))
    .filter(entry => scope === undefined || entry.scope === scope);
  const matches = installed.filter(entry => family(entry.installPath ?? entry.installedPath ?? '') === family(pluginRoot));
  const selected = matches.length === 1 ? matches[0] : installed.length === 1 ? installed[0] : undefined;
  if (!selected && installed.length > 0) throw new Error('Cannot unambiguously identify the initiating Paved installation and scope.');
  if (selected) launcher(selected.installPath ?? selected.installedPath, projectRoot, sourceRoot);
  return selected;
}

function state(lastSuccess, failures = 0, nextAttempt = 0, completed = []) {
  return { apiVersion: 'paved/v1', kind: 'AutoUpdateState', ...(lastSuccess === undefined ? {} : { lastSuccess }), failures, nextAttempt, completed };
}

function failedState(previous, now, completed) {
  const failures = Math.min((previous?.failures ?? 0) + 1, 20);
  return state(previous?.lastSuccess, failures, now + Math.min(24, 2 ** (failures - 1)) * hour, completed);
}

export function autoUpdate({ projectRoot, sourceRoot = projectRoot, pluginRoot, argv, adopt }) {
  let opts;
  const completed = [];
  const response = (reason, extra = {}, status = 'success') => ({ command: 'auto-update', status, data: { reason, completed: [...completed], ...extra }, diagnostics: [] });
  try {
    opts = options(argv);
    const configPath = safePath(join(projectRoot, '.paved/auto-update.json'));
    const config = read(configPath, 'AutoUpdateConfig') ?? configDefaults;
    const projectStatePath = safePath(join(projectRoot, '.paved/auto-update-state.json'));
    if (opts.action === 'configure') {
      if (suppressed(opts)) return response('suppressed');
      const next = { ...configDefaults, ...config, ...(opts.mode === undefined ? {} : { mode: opts.mode }), ...(opts.host === undefined ? {} : { host: opts.host }), intervalHours: opts['interval-hours'] === undefined ? config.intervalHours : Number(opts['interval-hours']) };
      if (!modes.includes(next.mode) || !Number.isInteger(next.intervalHours) || next.intervalHours < 1 || next.intervalHours > 8760 || (next.mode !== 'off' && !hosts.includes(next.host))) throw new Error('Specify --mode off|notify|auto, --host and an interval from 1 to 8760 hours.');
      if (!existsSync(join(projectRoot, '.paved/paved.lock'))) throw new Error('Initialize this repository before configuring automatic updates.');
      const held = lock(join(projectRoot, '.paved-operation-lock'), 'auto-update-configure');
      if (!held) return response('project-busy');
      try {
        write(configPath, next);
        // Explicit reconfiguration grants a new check opportunity.
        rmSync(projectStatePath, { force: true });
      } finally { held.release(); }
      return response('configured', { config: next });
    }
    const previous = read(projectStatePath, 'AutoUpdateState');
    if (opts.action === 'status') return response('status', { config, state: previous ?? null, supportedAutomaticHosts: ['claude-code', 'codex'] });
    if (config.mode === 'off') return response('disabled');
    if (suppressed(opts)) return response('suppressed');
    if (!opts.host) return response('host-required');
    if (opts.host === 'cursor') return response('unsupported-host', { restartRequired: false });
    if (opts.host !== config.host) return response('host-mismatch');
    const now = Date.now();
    if (previous?.nextAttempt > now) return response('backoff', { nextAttempt: previous.nextAttempt, completed: previous.completed });
    if (opts.action !== 'adopt' && previous?.lastSuccess !== undefined && now - previous.lastSuccess < config.intervalHours * hour) return response('not-due');
    if (busy(projectRoot, pluginRoot)) return response('project-busy');
    if (opts.action === 'adopt') {
      if (config.mode !== 'auto' || typeof adopt !== 'function') throw new Error('Automatic adoption is not authorized.');
      const held = lock(join(projectRoot, '.paved-operation-lock'), 'auto-update');
      if (!held) return response('project-busy');
      try {
        if (activeRuns(projectRoot, pluginRoot)) return response('project-busy');
        return adopt(held.token);
      } finally { held.release(); }
    }
    const command = executable(opts.host, projectRoot, sourceRoot);
    const installed = inventory(command, opts.host, projectRoot, pluginRoot, undefined, sourceRoot);
    completed.push('inventory');
    if (!installed) {
      write(projectStatePath, failedState(previous, now, completed));
      return response('not-installed');
    }
    if (config.mode === 'notify') {
      write(projectStatePath, state(now, 0, 0, completed));
      return response('notification', { upstream: 'unknown', installedPath: installed.installPath ?? installed.installedPath, message: 'Inventory describes the installed plugin, not the latest marketplace release. No host supports a verified read-only upstream freshness query here.' });
    }
    const hostHome = resolve(opts.host === 'claude-code' ? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude') : process.env.CODEX_HOME ?? join(homedir(), '.codex'));
    const identity = [opts.host, hostHome, 'paved@paved', installed.scope ?? 'user', installed.scope === 'user' || installed.scope === undefined ? '' : installed.projectPath ?? ''].join('\0');
    // The host registry has one installation per id, home, scope and project tuple.
    // Version/cache path changes must not reset the cross-project throttle.
    const key = createHash('sha256').update(identity).digest('hex');
    const sharedPath = safePath(join(homedir(), '.cache/paved/auto-update', `${key}.json`));
    const held = lock(`${sharedPath}.lock`, 'host-refresh');
    if (!held) return response('host-busy', { remediation: 'An existing host refresh lock is preserved, even if old. Confirm no updater is active before removing it.' });
    let latest;
    try {
      const shared = read(sharedPath, 'AutoUpdateState');
      if (shared?.nextAttempt > now) {
        write(projectStatePath, state(previous?.lastSuccess, shared.failures, shared.nextAttempt, shared.completed));
        return response('backoff', { nextAttempt: shared.nextAttempt, completed: shared.completed });
      }
      latest = installed.installPath ?? installed.installedPath;
      if (shared?.lastSuccess === undefined || now - shared.lastSuccess >= config.intervalHours * hour) {
        try {
          run(command, opts.host === 'claude-code' ? ['plugin', 'marketplace', 'update', 'paved'] : ['plugin', 'marketplace', 'upgrade', 'paved'], sourceRoot, completed);
          completed.push('marketplace');
          const output = run(command, opts.host === 'claude-code' ? ['plugin', 'update', 'paved@paved', '--scope', installed.scope] : ['plugin', 'add', 'paved@paved', '--json'], sourceRoot, completed);
          completed.push('plugin');
          if (opts.host === 'codex') latest = JSON.parse(output).installedPath;
          else {
            const refreshed = inventory(command, opts.host, projectRoot, pluginRoot, installed.scope, sourceRoot);
            if (!refreshed) throw new Error('Refreshed plugin was not found in inventory.');
            latest = refreshed.installPath;
          }
          launcher(latest, projectRoot, sourceRoot);
          write(sharedPath, state(now, 0, 0, completed));
        } catch (error) {
          write(sharedPath, failedState(shared, now, completed));
          // A timed-out host may have descendants still finishing a refresh.
          // Preserve exclusion until the owner explicitly inspects and recovers it.
          if (error.uncertainCompletion) held.preserve();
          throw error;
        }
      } else {
        // Inventory read before acquiring this lock may predate another project's
        // refresh. Rediscover under the lock instead of adopting that stale path.
        const refreshed = inventory(command, opts.host, projectRoot, pluginRoot, installed.scope, sourceRoot);
        if (!refreshed) throw new Error('The previously refreshed plugin is no longer installed.');
        latest = refreshed.installPath ?? refreshed.installedPath;
      }
    } finally { held.release(); }
    // Host refresh is independent of project adoption: a busy project has no success timestamp.
    if (busy(projectRoot, pluginRoot)) return response('project-busy', { restartRequired: completed.includes('plugin') });
    const adopted = spawnSync(process.execPath, [launcher(latest, projectRoot, sourceRoot), 'auto-update', 'adopt', '--host', opts.host, '--project', sourceRoot, '--json'], {
      cwd: sourceRoot, shell: false, encoding: 'utf8', env: process.env, timeout: 300000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    });
    let result;
    try { result = JSON.parse(adopted.stdout); } catch { /* Report invalid child output as failure below. */ }
    if (result?.command === 'auto-update' && ['disabled', 'suppressed', 'host-mismatch', 'host-required', 'unsupported-host', 'backoff'].includes(result.data?.reason)) {
      return response(result.data.reason, { restartRequired: completed.includes('plugin') });
    }
    if (result?.data?.reason === 'project-busy' || result?.diagnostics?.some(item => item.code === 'PAVED_OPERATION_IN_PROGRESS' || item.code === 'PAVED_RUNTIME_CONCURRENT_BOOTSTRAP')) return response('project-busy', { restartRequired: true });
    if (adopted.error || adopted.status !== 0 || !result || result.status === 'failed') {
      write(projectStatePath, failedState(previous, now, completed));
      return response('adoption-failed', { restartRequired: true, update: result ?? null, message: adopted.error?.message ?? 'Project adoption failed; the previously pinned runtime remains authoritative.' }, 'failed');
    }
    completed.push('adoption');
    write(projectStatePath, state(now, 0, 0, completed));
    return response('updated', { restartRequired: true, update: result });
  } catch (error) {
    // Do not consume busy deferrals. Failures otherwise have bounded project backoff, including discovery.
    if (opts?.action === 'check' && !suppressed(opts)) {
      try {
        const config = read(join(projectRoot, '.paved/auto-update.json'), 'AutoUpdateConfig');
        if (config && config.mode !== 'off') {
          const path = join(projectRoot, '.paved/auto-update-state.json');
          write(path, failedState(read(path, 'AutoUpdateState'), Date.now(), completed));
        }
      } catch { /* Invalid authorization is never repaired or enabled implicitly. */ }
    }
    return response('failed', {
      message: error.message, restartRequired: completed.includes('plugin'),
      ...(error.uncertainCompletion ? { remediation: 'The refresh lock was preserved because timed-out host descendants may still be active. Inspect the host processes and ~/.cache/paved/auto-update/ before explicitly removing its lock.' } : {}),
    }, 'failed');
  }
}
