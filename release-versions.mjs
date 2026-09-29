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

if (bump === "major") {
  core[0] += 1;
  core[1] = 0;
  core[2] = 0;
} else if (bump === "minor") {
  core[1] += 1;
  core[2] = 0;
} else {
  core[2] += 1;
}

plugin[2] += 1;
if (!Number.isSafeInteger(plugin[2])) {
  throw new Error("Plugin patch version exceeds the safe integer range.");
}

process.stdout.write(`${formatVersion(core)} ${formatVersion(plugin)}\n`);
