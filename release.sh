#!/usr/bin/env bash
set -Eeuo pipefail

# The whole script is one compound command so bash parses it before running it.
# The cleanup and pull below may rewrite this file on disk; the running copy stays intact.
{

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BUMP="${1:-minor}"

case "$BUMP" in
  major|minor|patch) ;;
  *)
    echo "Usage: $0 [major|minor|patch]"
    exit 1
    ;;
esac

echo "==> Paved release script"
echo "    root : $ROOT"
echo "    bump : $BUMP"
echo

# ------------------------------------------------------------
# 1. Preconditions
# ------------------------------------------------------------

command -v git >/dev/null || { echo "git not found"; exit 1; }
command -v node >/dev/null || { echo "node not found"; exit 1; }
command -v npm >/dev/null || { echo "npm not found"; exit 1; }

BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  echo "ERROR: current branch is '$BRANCH', expected 'main'."
  exit 1
fi

echo "==> Cleaning working tree..."

# Discards leftovers from an aborted release (uncommitted edits and untracked
# files). Ignored files such as node_modules/ are kept.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Discarding:"
  git status --short
  git reset --hard HEAD
  git clean -fd
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is still not clean after cleanup."
  git status --short
  exit 1
fi

echo "==> Pulling latest main..."
git pull --ff-only origin main

# ------------------------------------------------------------
# 2. Read current versions
# ------------------------------------------------------------

CURRENT_VERSION="$(tr -d '[:space:]' < VERSION)"

PACKAGE_VERSION="$(
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
    process.stdout.write(p.version);
  '
)"

PLUGIN_VERSION="$(
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("plugins/plugin-source.json", "utf8"));
    process.stdout.write(p.version);
  '
)"

MANIFEST_VERSION="$(sed -n 's/^version:[[:space:]]*//p' manifest.yaml | head -1)"

echo
echo "Current versions:"
echo "  VERSION                   = $CURRENT_VERSION"
echo "  package.json              = $PACKAGE_VERSION"
echo "  plugins/plugin-source.json = $PLUGIN_VERSION"
echo "  manifest.yaml             = $MANIFEST_VERSION"

if [[ "$CURRENT_VERSION" != "$PACKAGE_VERSION" || \
      "$CURRENT_VERSION" != "$PLUGIN_VERSION" || \
      "$CURRENT_VERSION" != "$MANIFEST_VERSION" ]]; then
  echo "ERROR: version files are already inconsistent."
  exit 1
fi

# ------------------------------------------------------------
# 3. Calculate new version
# ------------------------------------------------------------

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP" in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
export NEW_VERSION

echo
echo "Version bump:"
echo "  $CURRENT_VERSION -> $NEW_VERSION"

# ------------------------------------------------------------
# 4. Run dependency install first
# ------------------------------------------------------------

echo
echo "==> npm ci"
npm ci

# ------------------------------------------------------------
# 5. Update versions
# ------------------------------------------------------------

echo
echo "==> Updating VERSION files..."

printf '%s\n' "$NEW_VERSION" > VERSION

node <<'NODE'
const fs = require("fs");

const version = process.env.NEW_VERSION;

// Replace only the top-level version line so the rest of the file keeps its formatting.
function updateVersionLine(path) {
  const content = fs.readFileSync(path, "utf8");
  const pattern = /^(  "version": )"[^"]*"/m;
  if (!pattern.test(content)) {
    throw new Error(`No top-level "version" field in ${path}.`);
  }
  fs.writeFileSync(path, content.replace(pattern, `$1"${version}"`));
}

updateVersionLine("package.json");
updateVersionLine("plugins/plugin-source.json");

const manifestPath = "manifest.yaml";
const manifest = fs.readFileSync(manifestPath, "utf8");
if (!/^version: .*$/m.test(manifest)) {
  throw new Error(`No top-level version in ${manifestPath}.`);
}
fs.writeFileSync(manifestPath, manifest.replace(/^version: .*$/m, `version: ${version}`));

const lockPath = "package-lock.json";
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
lock.version = version;
lock.packages[""].version = version;
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
NODE

# ------------------------------------------------------------
# 6. Update changelog
# ------------------------------------------------------------

echo
echo "==> Updating CHANGELOG.md..."

node release-changelog.mjs \
  CHANGELOG.md "$CURRENT_VERSION" "$NEW_VERSION" "$(date +%Y-%m-%d)"

# ------------------------------------------------------------
# 7. Rebuild plugin
# ------------------------------------------------------------

echo
echo "==> Building runtime and plugin..."

npm run build
npm run build:plugin

# ------------------------------------------------------------
# 8. Validate generated plugin
# ------------------------------------------------------------

echo
echo "==> Checking plugin drift..."

npm run check:plugin

# ------------------------------------------------------------
# 9. Run full checks
# ------------------------------------------------------------

echo
echo "==> Running full check..."

npm run check

# ------------------------------------------------------------
# 10. Run git diff validation
# ------------------------------------------------------------

echo
echo "==> Checking git diff..."

git diff --check

# ------------------------------------------------------------
# 11. Verify versions after plugin generation
# ------------------------------------------------------------

FINAL_VERSION="$(tr -d '[:space:]' < VERSION)"

PACKAGE_VERSION="$(
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
    process.stdout.write(p.version);
  '
)"

PLUGIN_VERSION="$(
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("plugins/plugin-source.json", "utf8"));
    process.stdout.write(p.version);
  '
)"

MANIFEST_VERSION="$(sed -n 's/^version:[[:space:]]*//p' manifest.yaml | head -1)"

GENERATED_PLUGIN_VERSION="$(tr -d '[:space:]' < plugins/paved/VERSION)"

echo
echo "Final versions:"
echo "  VERSION                     = $FINAL_VERSION"
echo "  package.json                = $PACKAGE_VERSION"
echo "  plugins/plugin-source.json  = $PLUGIN_VERSION"
echo "  manifest.yaml               = $MANIFEST_VERSION"
echo "  plugins/paved/VERSION       = $GENERATED_PLUGIN_VERSION"

if [[ "$FINAL_VERSION" != "$NEW_VERSION" || \
      "$PACKAGE_VERSION" != "$NEW_VERSION" || \
      "$PLUGIN_VERSION" != "$NEW_VERSION" || \
      "$MANIFEST_VERSION" != "$NEW_VERSION" || \
      "$GENERATED_PLUGIN_VERSION" != "$NEW_VERSION" ]]; then
  echo "ERROR: version synchronization failed."
  exit 1
fi

# ------------------------------------------------------------
# 12. Show resulting changes
# ------------------------------------------------------------

echo
echo "==> Release diff:"
git status --short
echo

git diff --stat
echo

# ------------------------------------------------------------
# 13. Ensure the generated TGZ exists
# ------------------------------------------------------------

TGZ="plugins/paved/runtime/paved-core-${NEW_VERSION}.tgz"

if [[ ! -f "$TGZ" ]]; then
  echo "ERROR: expected runtime artifact not found:"
  echo "  $TGZ"
  exit 1
fi

echo "Runtime artifact:"
echo "  $TGZ"
echo "  $(du -h "$TGZ" | cut -f1)"

# ------------------------------------------------------------
# 14. Final safety review
# ------------------------------------------------------------

echo
echo "==> Files changed:"
git status --short

echo
echo "============================================================"
echo "READY TO COMMIT"
echo "============================================================"
echo
echo "Version: $NEW_VERSION"
echo
echo "The script will now commit and push to main."
echo

read -r -p "Continue with commit + push? [y/N] " CONFIRM

if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
  echo "Aborted before commit."
  exit 0
fi

# ------------------------------------------------------------
# 15. Commit
# ------------------------------------------------------------

git add \
  VERSION \
  package.json \
  package-lock.json \
  manifest.yaml \
  plugins/plugin-source.json \
  plugins/paved \
  CHANGELOG.md

git diff --cached --check

git commit -m "feat: release v${NEW_VERSION}"

# ------------------------------------------------------------
# 16. Push
# ------------------------------------------------------------

git push origin main

# ------------------------------------------------------------
# 17. Final verification
# ------------------------------------------------------------

echo
echo "==> Final repository state:"
git status --short

echo
echo "==> Latest commit:"
git log -1 --oneline --decorate

echo
echo "============================================================"
echo "RELEASE PUSH COMPLETE"
echo "============================================================"
echo
echo "Version: v${NEW_VERSION}"
echo "Branch : main"
echo
echo "Plugin runtime:"
echo "  plugins/paved/runtime/paved-core-${NEW_VERSION}.tgz"
echo
echo "Next step:"
echo "  update the plugin in Codex/Claude and test the consumer repository."

exit
}
