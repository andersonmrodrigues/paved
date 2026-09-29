import { readFileSync, writeFileSync } from "node:fs";

const [path, currentVersion, nextVersion, releaseDate] = process.argv.slice(2);

if (!path || !currentVersion || !nextVersion || !releaseDate) {
  throw new Error("Usage: release-changelog <path> <current-version> <next-version> <release-date>");
}

const content = readFileSync(path, "utf8");
const lines = content.split(/(?<=\n)/);
const currentHeading = `## [${currentVersion}] - Unreleased`;
const nextHeading = `## [${nextVersion}] - Unreleased`;
const currentIndex = lines.findIndex((line) => line.trimEnd() === currentHeading);

if (currentIndex === -1) {
  throw new Error(`CHANGELOG.md has no "${currentHeading}" section.`);
}
if (lines.some((line) => line.trimEnd() === nextHeading)) {
  throw new Error(`CHANGELOG.md already has a "${nextHeading}" section.`);
}

lines[currentIndex] = `## [${currentVersion}] - ${releaseDate}\n`;
lines.splice(currentIndex, 0, `${nextHeading}\n`, "\n");
writeFileSync(path, lines.join(""));
