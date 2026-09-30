// Every way the installed plugin launcher can be handed bad input or bad state must end in
// a structured diagnostic, never an activated unverified runtime or a touched application.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { PLUGIN_DIRECTORY, runtimeFileName } from "../../plugins/build.ts";
import { CORE_VERSION, NEXT_PATCH_VERSION, ROOT } from "../helpers.ts";
import { applicationDigest, codeOf, consumer, launcher, pluginVariant, repackRuntime, workspace, type Invocation } from "./support.ts";

interface TarEntry { readonly name: string; readonly type?: "0" | "2" | "5"; readonly content?: string; readonly mode?: number; readonly link?: string }

function tar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(entry.type ?? "0", 156);
    header.write(entry.link ?? "", 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const packageJson = JSON.stringify({ name: "paved-core", version: "1.0.0" });
const RUNTIME = runtimeFileName(CORE_VERSION);
const integrityOf = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

describe("plugin launcher failure modes", () => {
  let root = "";
  let plugin = "";
  let npmCache = "";
  let tarball = "";

  before(() => {
    root = workspace("failure-modes");
    plugin = join(root, "installed", "paved");
    cpSync(join(ROOT, PLUGIN_DIRECTORY), plugin, { recursive: true });
    tarball = join(plugin, RUNTIME);
    npmCache = join(root, "npm-cache");
    mkdirSync(npmCache);
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  let counter = 0;
  const project = (files: Record<string, string> = {}) => consumer(root, `consumer-${++counter}`, files);
  const variant = (config: Record<string, unknown> | string, extra: (dir: string) => void = () => {}) => {
    const dir = join(root, `plugin-${++counter}`, "paved");
    cpSync(plugin, dir, { recursive: true });
    writeFileSync(join(dir, "bin", "bootstrap.json"), typeof config === "string" ? config : JSON.stringify(config));
    extra(dir);
    return launcher(dir, npmCache);
  };
  const expectFailure = (invocation: Invocation, code: string) => {
    assert.equal(invocation.status, 5, invocation.stdout + invocation.stderr);
    assert.equal(invocation.json.status, "failed");
    assert.equal(codeOf(invocation), code, invocation.stdout);
  };
  const bundledConfig = () => JSON.parse(readFileSync(join(plugin, "bin", "bootstrap.json"), "utf8")) as Record<string, unknown>;
  const paved = () => launcher(plugin, npmCache);
  const withArchive = (bytes: Buffer) => variant({ ...bundledConfig(), integrity: integrityOf(bytes) }, (dir) => writeFileSync(join(dir, RUNTIME), bytes));
  const notActivated = (dir: string) => assert.ok(!existsSync(join(dir, ".paved", "runtime", "selection.json")), "no runtime was selected");

  it("rejects a missing, malformed or unsafe launcher configuration", () => {
    const target = project();
    expectFailure(variant("", (dir) => rmSync(join(dir, "bin", "bootstrap.json")))(target, "status", "--json"), "PAVED_RUNTIME_CONFIG_INVALID");
    expectFailure(variant("{ not json")(target, "status", "--json"), "PAVED_RUNTIME_STATE_INVALID");
    expectFailure(variant({ ...bundledConfig(), package: "left-pad" })(target, "status", "--json"), "PAVED_RUNTIME_CONFIG_INVALID");
    expectFailure(variant({ ...bundledConfig(), integrity: "md5-abc" })(target, "status", "--json"), "PAVED_RUNTIME_CONFIG_INVALID");
    expectFailure(variant({ ...bundledConfig(), tarball: "../../../outside.tgz" })(target, "status", "--json"), "PAVED_RUNTIME_PATH_ESCAPE");
    expectFailure(variant({ ...bundledConfig(), tarball: "../runtime/linked.tgz" }, (dir) => symlinkSync(tarball, join(dir, "runtime", "linked.tgz")))(target, "status", "--json"), "PAVED_RUNTIME_SYMLINK");
    expectFailure(variant({ ...bundledConfig(), integrity: undefined })(target, "status", "--json"), "PAVED_RUNTIME_INTEGRITY_UNAVAILABLE");
    notActivated(target);
  });

  it("rejects a missing or corrupt runtime artifact before extraction", () => {
    const target = project();
    expectFailure(variant(bundledConfig(), (dir) => rmSync(join(dir, RUNTIME)))(target, "status", "--json"), "PAVED_RUNTIME_PACKAGE_UNAVAILABLE");
    const corrupt = Buffer.from(readFileSync(tarball));
    corrupt[corrupt.length - 100] = (corrupt[corrupt.length - 100]! + 1) % 256;
    expectFailure(variant(bundledConfig(), (dir) => writeFileSync(join(dir, RUNTIME), corrupt))(target, "status", "--json"), "PAVED_RUNTIME_INTEGRITY_MISMATCH");
    assert.ok(!existsSync(join(target, ".paved", "runtime", "cache", basename(RUNTIME))), "a rejected artifact is not cached");
    notActivated(target);
  });

  it("refuses crafted archives even when their integrity is pinned", () => {
    const target = project();
    const outside = join(root, "escaped.txt");
    const unsafe: [string, Buffer][] = [
      ["PAVED_RUNTIME_ARCHIVE_UNSAFE", tar([{ name: "package/package.json", content: packageJson }, { name: "package/../../escaped.txt", content: "x" }])],
      ["PAVED_RUNTIME_ARCHIVE_UNSAFE", tar([{ name: "/etc/paved.txt", content: "x" }])],
      ["PAVED_RUNTIME_ARCHIVE_UNSAFE", tar([{ name: "package/package.json", content: packageJson }, { name: "package/link", type: "2", link: "/etc/passwd" }])],
      ["PAVED_RUNTIME_ARCHIVE_UNSAFE", tar([{ name: "outside/package.json", content: packageJson }])],
      ["PAVED_RUNTIME_ARCHIVE_INVALID", tar([]).subarray(0, 10)],
      ["PAVED_RUNTIME_ARCHIVE_INVALID", Buffer.from("not an archive")],
      ["PAVED_RUNTIME_ARCHIVE_INVALID", tar([])],
    ];
    for (const [code, bytes] of unsafe) expectFailure(withArchive(bytes)(target, "status", "--json"), code);
    const truncated = readFileSync(tarball).subarray(0, 4096);
    expectFailure(withArchive(truncated)(target, "status", "--json"), "PAVED_RUNTIME_ARCHIVE_INVALID");
    const executable = tar([
      { name: "package/package.json", content: packageJson },
      { name: "package/install.sh", content: "#!/bin/sh\necho owned\n", mode: 0o755 },
    ]);
    expectFailure(withArchive(executable)(target, "status", "--json"), "PAVED_RUNTIME_UNEXPECTED_EXECUTABLE");
    assert.ok(!existsSync(outside));
    notActivated(target);
  });

  it("does not reach a registry for a first activation without a bundled artifact", () => {
    const target = project();
    const registryOnly = variant({ package: "paved-core", version: "1.0.0" });
    const result = registryOnly(target, "status", "--json");
    assert.equal(result.status, 5, result.stdout);
    assert.ok(["PAVED_RUNTIME_ACQUISITION_FAILED", "PAVED_RUNTIME_INTEGRITY_UNAVAILABLE"].includes(codeOf(result) ?? ""), result.stdout);
    notActivated(target);
  });

  it("rejects invalid locks and runtimes the plugin cannot verify offline", () => {
    const target = project();
    const init = paved()(target, "init", "--json");
    assert.ok(init.status === 0 || init.status === 1, init.stdout + init.stderr);
    const lockPath = join(target, ".paved", "paved.lock");
    const good = readFileSync(lockPath, "utf8");
    writeFileSync(lockPath, `${good}runtime:\n  package: paved-core\n`);
    expectFailure(paved()(target, "status", "--json"), "PAVED_RUNTIME_LOCK_INVALID");
    writeFileSync(lockPath, good.replace(/^  integrity: .*$/m, "  integrity: not-a-digest"));
    expectFailure(paved()(target, "status", "--json"), "PAVED_RUNTIME_LOCK_INVALID");
    writeFileSync(lockPath, good.replace(/^(runtime:\n  package: paved-core\n  version: ).*$/m, "$19.9.9"));
    expectFailure(paved()(target, "status", "--json"), "PAVED_RUNTIME_LOCK_MISMATCH");
    rmSync(join(target, ".paved", "runtime"), { recursive: true, force: true });
    const unavailable = paved()(target, "status", "--json");
    assert.match(unavailable.stderr, /PAVED_RUNTIME_UPDATE_AVAILABLE/);
    expectFailure(unavailable, "PAVED_RUNTIME_ACQUISITION_FAILED");
    notActivated(target);
    writeFileSync(lockPath, good);
  });

  it("only manages a real consumer repository", () => {
    expectFailure(paved()(root, "status", "--project", join(root, "missing"), "--json"), "PAVED_RUNTIME_PROJECT_INVALID");
    expectFailure(paved()(join(plugin, "skills"), "status", "--json"), "PAVED_RUNTIME_PROJECT_INVALID");
    expectFailure(paved()(root, "status", "--project", plugin, "--json"), "PAVED_RUNTIME_PROJECT_INVALID");
    expectFailure(paved()(ROOT, "status", "--json"), "PAVED_RUNTIME_PROJECT_INVALID");
    expectFailure(paved()(root, "status", "--project", "--json"), "PAVED_RUNTIME_PROJECT_INVALID");
    assert.ok(!existsSync(join(ROOT, ".paved")), "the Core checkout never receives consumer state");
    assert.ok(!existsSync(join(plugin, ".paved")), "the plugin installation never receives consumer state");
  });

  it("reports an unwritable runtime directory as a structured failure", { skip: process.getuid?.() === 0 ? "permissions are not enforced for root" : false }, () => {
    const target = project();
    mkdirSync(join(target, ".paved"));
    chmodSync(join(target, ".paved"), 0o555);
    try {
      expectFailure(paved()(target, "status", "--json"), "PAVED_RUNTIME_IO_FAILED");
    } finally {
      chmodSync(join(target, ".paved"), 0o755);
    }
  });

  it("recovers stale bootstrap state and refuses a live concurrent bootstrap", () => {
    const target = project();
    const lock = join(target, ".paved", "runtime", ".bootstrap-lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), `${process.pid}-live`);
    expectFailure(paved()(target, "status", "--json"), "PAVED_RUNTIME_CONCURRENT_BOOTSTRAP");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    writeFileSync(join(lock, "owner"), `${dead}-stale`);
    mkdirSync(join(target, ".paved", "runtime", "staging-1-abandoned", "node_modules"), { recursive: true });
    const recovered = paved()(target, "init", "--json");
    assert.ok(recovered.status === 0 || recovered.status === 1, recovered.stdout + recovered.stderr);
    assert.ok(!existsSync(lock), "the recovered lock is released");
    assert.ok(!existsSync(join(target, ".paved", "runtime", "staging-1-abandoned")), "abandoned staging is removed");

    const cached = join(target, ".paved", "runtime", "cache", basename(RUNTIME));
    truncateSync(cached, 1024);
    rmSync(join(target, ".paved", "runtime", "versions"), { recursive: true });
    rmSync(join(target, ".paved", "runtime", "selection.json"));
    const reacquired = paved()(target, "status", "--json");
    assert.ok(reacquired.status === 0 || reacquired.status === 1, reacquired.stdout + reacquired.stderr);
    assert.deepEqual(readFileSync(cached), readFileSync(tarball), "a truncated cache is replaced from the bundled artifact");
  });

  it("refuses rollback without a trustworthy record and replaces a leftover record on the next upgrade", () => {
    const target = project();
    const init = paved()(target, "init", "--json");
    assert.ok(init.status === 0 || init.status === 1, init.stdout + init.stderr);
    const initialLock = readFileSync(join(target, ".paved", "paved.lock"));
    expectFailure(paved()(target, "runtime", "rollback", "--json"), "PAVED_RUNTIME_ROLLBACK_UNAVAILABLE");
    expectFailure(paved()(target, "runtime", "explode", "--json"), "PAVED_RUNTIME_USAGE");
    const runtime = join(target, ".paved", "runtime");
    const selection = JSON.parse(readFileSync(join(runtime, "selection.json"), "utf8")) as unknown;
    writeFileSync(join(runtime, "rollback.lock"), "tampered\n");
    writeFileSync(join(runtime, "rollback.json"), JSON.stringify({ previous: selection, lock_sha256: "0".repeat(64), created_at: new Date().toISOString() }));
    expectFailure(paved()(target, "runtime", "rollback", "--json"), "PAVED_RUNTIME_ROLLBACK_CORRUPT");
    const patch = repackRuntime(tarball, NEXT_PATCH_VERSION, root);
    const newer = launcher(pluginVariant(plugin, root, "plugin-leftover", { ...patch, version: NEXT_PATCH_VERSION }), npmCache);
    const upgraded = newer(target, "runtime", "upgrade", "--json");
    assert.ok(upgraded.status === 0 || upgraded.status === 1, upgraded.stdout + upgraded.stderr);
    assert.equal((upgraded.json.data as { changed: boolean }).changed, true, upgraded.stdout);
    const rolledBack = newer(target, "runtime", "rollback", "--json");
    assert.equal(rolledBack.status, 0, rolledBack.stdout + rolledBack.stderr);
    assert.deepEqual(readFileSync(join(target, ".paved", "paved.lock")), initialLock, "the replaced record rolls back to the state before the upgrade");
    expectFailure(paved()(project(), "runtime", "upgrade", "--json"), "PAVED_RUNTIME_UPGRADE_UNAVAILABLE");
  });

  it("adopts a newer plugin runtime through update, repeatedly, and never downgrades", () => {
    const target = project();
    const init = paved()(target, "init", "--json");
    assert.ok(init.status === 0 || init.status === 1, init.stdout + init.stderr);
    const lockPath = join(target, ".paved", "paved.lock");
    const initialLock = readFileSync(lockPath);
    const lockedVersion = () => /^runtime:\n  package: paved-core\n  version: (.+)$/m.exec(readFileSync(lockPath, "utf8"))?.[1];
    const [major, minor, patchLevel] = CORE_VERSION.split(".").map(Number) as [number, number, number];
    const nextNext = `${major}.${minor}.${patchLevel + 2}`;
    const newer = launcher(pluginVariant(plugin, root, "plugin-update-1", { ...repackRuntime(tarball, NEXT_PATCH_VERSION, root), version: NEXT_PATCH_VERSION }), npmCache);
    const newest = launcher(pluginVariant(plugin, root, "plugin-update-2", { ...repackRuntime(tarball, nextNext, root), version: nextNext }), npmCache);

    const planned = newer(target, "update", "--dry-run", "--json");
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    assert.deepEqual((planned.json.data as { runtime: unknown }).runtime, { from: CORE_VERSION, to: NEXT_PATCH_VERSION });
    assert.deepEqual(readFileSync(lockPath), initialLock, "a dry run adopts nothing");

    const first = newer(target, "update", "--json");
    assert.ok(first.status === 0 || first.status === 1, first.stdout + first.stderr);
    assert.equal(first.json.command, "update");
    assert.equal((first.json.data as { changed: boolean }).changed, true, first.stdout);
    assert.equal(lockedVersion(), NEXT_PATCH_VERSION);

    const second = newest(target, "update", "--json");
    assert.ok(second.status === 0 || second.status === 1, second.stdout + second.stderr);
    assert.equal(lockedVersion(), nextNext, "a second consecutive update is not blocked by the first one's rollback record");

    const older = newer(target, "update", "--json");
    assert.ok(older.status === 0 || older.status === 1, older.stdout + older.stderr);
    assert.match(older.stderr, /PAVED_RUNTIME_UPDATE_AVAILABLE/);
    assert.equal(lockedVersion(), nextNext, "an older plugin never downgrades the project");

    const fresh = project();
    const freshInit = paved()(fresh, "init", "--json");
    assert.ok(freshInit.status === 0 || freshInit.status === 1, freshInit.stdout + freshInit.stderr);
    const freshLock = readFileSync(join(fresh, ".paved", "paved.lock"));
    rmSync(join(fresh, ".paved", "runtime"), { recursive: true, force: true });
    const cloned = newer(fresh, "update", "--json");
    assert.ok(cloned.status === 0 || cloned.status === 1, cloned.stdout + cloned.stderr);
    assert.match(readFileSync(join(fresh, ".paved", "paved.lock"), "utf8"), new RegExp(`^  version: ${NEXT_PATCH_VERSION.replaceAll(".", "\\.")}$`, "m"), "a fresh clone without runtime state is updated too");
    const freshRollback = newer(fresh, "runtime", "rollback", "--json");
    assert.equal(freshRollback.status, 0, freshRollback.stdout + freshRollback.stderr);
    assert.deepEqual(readFileSync(join(fresh, ".paved", "paved.lock")), freshLock);

    const same = newest(target, "update", "--json");
    assert.ok(same.status === 0 || same.status === 1, same.stdout + same.stderr);
    assert.equal(same.json.command, "update");
    assert.equal((same.json.data as { changed: boolean }).changed, false, "the same runtime keeps the ordinary update");
  });

  it("adopts a lock written by the direct CLI only through an explicit, reversible upgrade", () => {
    const target = project();
    const direct = spawnSync(process.execPath, [join(ROOT, "cli", "build", "cli", "index.js"), "init", "--project", target, "--json"], { encoding: "utf8" });
    assert.ok(direct.status === 0 || direct.status === 1, direct.stdout + direct.stderr);
    const lockPath = join(target, ".paved", "paved.lock");
    const legacy = readFileSync(lockPath);
    assert.ok(!/^runtime:/m.test(legacy.toString()), "the direct CLI pins no project-local runtime");
    expectFailure(paved()(target, "status", "--json"), "PAVED_RUNTIME_LOCK_MIGRATION_REQUIRED");
    assert.deepEqual(readFileSync(lockPath), legacy);
    const inspected = paved()(target, "runtime", "status", "--json");
    assert.equal((inspected.json.data as { migrationRequired: boolean }).migrationRequired, true);

    const adopted = paved()(target, "runtime", "upgrade", "--json");
    assert.ok(adopted.status === 0 || adopted.status === 1, adopted.stdout + adopted.stderr);
    assert.match(readFileSync(lockPath, "utf8"), new RegExp(`^runtime:\\n  package: paved-core\\n  version: ${CORE_VERSION.replaceAll(".", "\\.")}\\n`, "m"));
    const status = paved()(target, "status", "--json");
    assert.ok(status.status === 0 || status.status === 1, status.stdout + status.stderr);
    assert.ok((status.json.data as { coreRoot: string }).coreRoot.startsWith(realpathSync(join(target, ".paved", "runtime"))));

    const rolledBack = paved()(target, "runtime", "rollback", "--json");
    assert.equal(rolledBack.status, 0, rolledBack.stdout + rolledBack.stderr);
    assert.deepEqual(readFileSync(lockPath), legacy);
    assert.ok(!existsSync(join(target, ".paved", "runtime", "selection.json")));
  });

  it("keeps repositories isolated and application files untouched", () => {
    const outer = project({ "src/app.ts": "export const app = 1;\n", "db/schema.sql": "create table t (id int);\n" });
    const inner = join(outer, "vendor", "nested");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "README.md"), "# nested\n");
    spawnSync("git", ["init", "-q"], { cwd: inner });
    const outerBefore = applicationDigest(outer, ["vendor"]);
    const outerInit = paved()(join(outer, "src"), "init", "--json");
    assert.ok(outerInit.status === 0 || outerInit.status === 1, outerInit.stdout + outerInit.stderr);
    assert.ok(existsSync(join(outer, ".paved", "manifest.yaml")));
    assert.ok(!existsSync(join(inner, ".paved")), "a nested repository is not initialized by its parent");
    const innerInit = paved()(inner, "init", "--json");
    assert.ok(innerInit.status === 0 || innerInit.status === 1, innerInit.stdout + innerInit.stderr);
    const outerCore = (paved()(join(outer, "src"), "status", "--json").json.data as { coreRoot: string }).coreRoot;
    const innerCore = (paved()(inner, "status", "--json").json.data as { coreRoot: string }).coreRoot;
    assert.ok(outerCore.startsWith(realpathSync(join(outer, ".paved", "runtime"))));
    assert.ok(innerCore.startsWith(realpathSync(join(inner, ".paved", "runtime"))));
    assert.equal(applicationDigest(outer, ["vendor"]), outerBefore, "initializing either repository leaves application files untouched");
    assert.equal(readFileSync(join(outer, "src", "app.ts"), "utf8"), "export const app = 1;\n");
    assert.equal(readFileSync(join(outer, "db", "schema.sql"), "utf8"), "create table t (id int);\n");
    const changed = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: outer, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    assert.deepEqual(changed.filter((line) => !/ (\.paved\/|AGENTS\.md|vendor\/)/.test(line)), [], "only Paved-owned paths changed");
  });
});
