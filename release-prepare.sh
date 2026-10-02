#!/usr/bin/env bash
set -Eeuo pipefail

# Prepares a release in the working tree: bumps every version file, ships the
# [Unreleased] changelog entries under the new version and rebuilds the plugins.
# It stages the result and prints the new Core version; it never commits or pushes.
# The release workflow (.github/workflows/release.yml) runs it and opens the PR.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

export GIT_PAGER=cat

BUMP="${1:-}"

case "$BUMP" in
  major|minor|patch) ;;
  *)
    echo "Usage: $0 major|minor|patch" >&2
    exit 1
    ;;
esac

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: the working tree is not clean." >&2
  git status --short >&2
  exit 1
fi

read_json_version() {
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$1"
}

read_manifest_version() {
  sed -n 's/^version:[[:space:]]*//p' manifest.yaml | head -1
}

CURRENT_VERSION="$(tr -d '[:space:]' < VERSION)"
CURRENT_PLUGIN_VERSION="$(read_json_version plugins/plugin-source.json)"

if [[ "$CURRENT_VERSION" != "$(read_json_version package.json)" || \
      "$CURRENT_VERSION" != "$(read_manifest_version)" ]]; then
  echo "ERROR: Core version files are already inconsistent." >&2
  exit 1
fi

read -r NEW_VERSION NEW_PLUGIN_VERSION <<< "$(node release-versions.mjs "$CURRENT_VERSION" "$CURRENT_PLUGIN_VERSION" "$BUMP")"
export NEW_VERSION NEW_PLUGIN_VERSION

echo "==> Core $CURRENT_VERSION -> $NEW_VERSION, plugin $CURRENT_PLUGIN_VERSION -> $NEW_PLUGIN_VERSION" >&2

printf '%s\n' "$NEW_VERSION" > VERSION

node <<'NODE'
const fs = require("fs");

const coreVersion = process.env.NEW_VERSION;
const pluginVersion = process.env.NEW_PLUGIN_VERSION;

// Replace only the top-level version line so the rest of the file keeps its formatting.
function updateVersionLine(path, version) {
  const content = fs.readFileSync(path, "utf8");
  const pattern = /^(  "version": )"[^"]*"/m;
  if (!pattern.test(content)) {
    throw new Error(`No top-level "version" field in ${path}.`);
  }
  fs.writeFileSync(path, content.replace(pattern, `$1"${version}"`));
}

updateVersionLine("package.json", coreVersion);
updateVersionLine("plugins/plugin-source.json", pluginVersion);

const cursorMarketplacePath = ".cursor-plugin/marketplace.json";
const cursorMarketplace = JSON.parse(fs.readFileSync(cursorMarketplacePath, "utf8"));
const pluginName = JSON.parse(fs.readFileSync("plugins/plugin-source.json", "utf8")).name;
const cursorPlugins = cursorMarketplace.plugins.filter((plugin) => plugin.name === pluginName);
if (cursorPlugins.length !== 1) {
  throw new Error(`Expected one ${pluginName} plugin entry in ${cursorMarketplacePath}.`);
}
cursorPlugins[0].version = pluginVersion;
fs.writeFileSync(cursorMarketplacePath, JSON.stringify(cursorMarketplace, null, 2) + "\n");

const manifestPath = "manifest.yaml";
const manifest = fs.readFileSync(manifestPath, "utf8");
if (!/^version: .*$/m.test(manifest)) {
  throw new Error(`No top-level version in ${manifestPath}.`);
}
fs.writeFileSync(manifestPath, manifest.replace(/^version: .*$/m, `version: ${coreVersion}`));

const lockPath = "package-lock.json";
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
lock.version = coreVersion;
lock.packages[""].version = coreVersion;
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
NODE

node release-changelog.mjs CHANGELOG.md "$CURRENT_VERSION" "$NEW_VERSION" "$(date -u +%Y-%m-%d)"

# The CHANGELOG and the version files ship inside the runtime, so the plugins are
# rebuilt after they change.
npm run build >&2
npm run build:plugin >&2
npm run check:plugin >&2

git diff --check

if [[ "$(tr -d '[:space:]' < VERSION)" != "$NEW_VERSION" || \
      "$(read_json_version package.json)" != "$NEW_VERSION" || \
      "$(read_manifest_version)" != "$NEW_VERSION" || \
      "$(read_json_version plugins/plugin-source.json)" != "$NEW_PLUGIN_VERSION" || \
      "$(tr -d '[:space:]' < plugins/paved/VERSION)" != "$NEW_PLUGIN_VERSION" || \
      "$(tr -d '[:space:]' < plugins/claude/paved/VERSION)" != "$NEW_PLUGIN_VERSION" || \
      "$(read_json_version plugins/paved/runtime/paved-core/package.json)" != "$NEW_VERSION" || \
      "$(read_json_version plugins/claude/paved/runtime/paved-core/package.json)" != "$NEW_VERSION" ]]; then
  echo "ERROR: version synchronization failed." >&2
  exit 1
fi

git add \
  VERSION \
  package.json \
  package-lock.json \
  manifest.yaml \
  plugins/plugin-source.json \
  .cursor-plugin/marketplace.json \
  plugins/paved \
  plugins/claude \
  plugins/provenance \
  CHANGELOG.md

if [[ -n "$(git status --porcelain | grep -v '^[MADR] ' || true)" ]]; then
  echo "ERROR: the release changed files outside the release set." >&2
  git status --short >&2
  exit 1
fi

echo "$NEW_VERSION"
