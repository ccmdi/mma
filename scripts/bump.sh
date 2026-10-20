#!/bin/bash
# Usage: ./scripts/bump.sh [major|minor|patch]
# Default: patch
set -euo pipefail

TYPE="${1:-patch}"

# Read current version from package.json
CURRENT=$(node -p "require('./app/package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [major|minor|patch]"; exit 1 ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"
TAG="v$NEW"

echo "$CURRENT -> $NEW ($TYPE)"

# Bump package.json
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('app/package.json', 'utf8'));
p.version = '$NEW';
fs.writeFileSync('app/package.json', JSON.stringify(p, null, '\t') + '\n');
"

# Bump package-lock.json (top-level + packages[""] entry)
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('app/package-lock.json', 'utf8'));
p.version = '$NEW';
if (p.packages && p.packages['']) p.packages[''].version = '$NEW';
fs.writeFileSync('app/package-lock.json', JSON.stringify(p, null, '\t') + '\n');
"

# Bump Cargo.toml
sed -i "s/^version = \"$CURRENT\"/version = \"$NEW\"/" app/src-tauri/Cargo.toml

# Bump tauri.conf.json
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('app/src-tauri/tauri.conf.json', 'utf8'));
p.version = '$NEW';
fs.writeFileSync('app/src-tauri/tauri.conf.json', JSON.stringify(p, null, '\t') + '\n');
"

# Update Cargo.lock (cargo will pick up the new version from Cargo.toml)
(cd app/src-tauri && cargo check --quiet 2>/dev/null) || true

# API.md stamps members new in this release with its version
(cd app && npm run -s gen:plugin-types)

# Rebuild plugins — committed artifacts must match source by release time.
echo ""
echo "Building plugins..."
node plugins/build-plugin.mjs
node plugins/generate-registry.js
artifacts="plugins/*/index.js plugins/*/manifest.json plugins/registry.json"
if ! git diff --quiet -- $artifacts; then
  git add -f $artifacts
  git commit -m "chore: rebuild plugins"
  echo "Plugin artifacts updated"
else
  echo "Plugin artifacts unchanged"
fi

echo ""
echo "Bumped to $NEW in:"
echo "  app/package.json"
echo "  app/package-lock.json"
echo "  app/src-tauri/Cargo.toml"
echo "  app/src-tauri/tauri.conf.json"
echo "  app/src-tauri/Cargo.lock"
echo "  plugins/types/API.md"

git add app/package.json app/package-lock.json app/src-tauri/Cargo.toml app/src-tauri/tauri.conf.json app/src-tauri/Cargo.lock plugins/types/API.md
git commit -m "chore: $TAG"
git tag "$TAG"

echo ""
echo "Committed and tagged $TAG"
echo "Run 'git push --atomic origin master $TAG' to publish"
