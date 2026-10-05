#!/usr/bin/env node

const [coreVersion, pluginVersion, bump] = process.argv.slice(2);

if (!coreVersion || !pluginVersion || !["major", "minor", "patch"].includes(bump)) {
  throw new Error("Usage: release-versions <core-version> <plugin-version> <major|minor|patch>");
}

function parseVersion(version, label) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`${label} must be a semantic version in MAJOR.MINOR.PATCH format.`);
  }
  const parts = version.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`${label} components must be safe integers.`);
  }
  return parts;
}

function formatVersion(parts) {
  return parts.join(".");
}

const core = parseVersion(coreVersion, "Core version");
const plugin = parseVersion(pluginVersion, "Plugin version");

function bumped(parts, kind) {
  if (kind === "major") return [parts[0] + 1, 0, 0];
  if (kind === "minor") return [parts[0], parts[1] + 1, 0];
  return [parts[0], parts[1], parts[2] + 1];
}

const nextCore = bumped(core, bump);
// The plugin moves by the same kind of bump, and its major never trails the runtime it bundles.
let nextPlugin = bumped(plugin, bump);
if (nextPlugin[0] < nextCore[0]) nextPlugin = [nextCore[0], 0, 0];
if ([...nextCore, ...nextPlugin].some((part) => !Number.isSafeInteger(part))) {
  throw new Error("A version component exceeds the safe integer range.");
}

process.stdout.write(`${formatVersion(nextCore)} ${formatVersion(nextPlugin)}\n`);
