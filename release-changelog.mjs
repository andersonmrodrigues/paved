import { readFileSync, writeFileSync } from "node:fs";

const [path, currentVersion, nextVersion, releaseDate] = process.argv.slice(2);

if (!path || !currentVersion || !nextVersion || !releaseDate) {
  throw new Error("Usage: release-changelog <path> <current-version> <next-version> <release-date>");
}

const content = readFileSync(path, "utf8");
const lines = content.split(/(?<=\n)/);
// Pending entries live under "## [Unreleased]"; "## [<current>] - Unreleased" is the legacy form.
const pending = new Set(["## [Unreleased]", `## [${currentVersion}] - Unreleased`]);
const pendingIndex = lines.findIndex((line) => pending.has(line.trimEnd()));

if (pendingIndex === -1) {
  throw new Error('CHANGELOG.md has no "## [Unreleased]" section.');
}
if (lines.some((line) => line.trimEnd().startsWith(`## [${nextVersion}]`))) {
  throw new Error(`CHANGELOG.md already has a "## [${nextVersion}]" section.`);
}

// The pending entries ship in the version being released, not the previous one.
lines[pendingIndex] = `## [${nextVersion}] - ${releaseDate}\n`;
lines.splice(pendingIndex, 0, "## [Unreleased]\n", "\n");
writeFileSync(path, lines.join(""));
