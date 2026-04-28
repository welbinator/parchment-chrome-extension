#!/usr/bin/env bash
# build.sh — Build a zip for either production or staging
# Usage: ./build.sh [prod|staging]

set -e

TARGET=${1:-prod}
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
TMP_DIR=$(mktemp -d)
DIST_DIR="$REPO_ROOT/dist"
mkdir -p "$DIST_DIR"

echo "📦 Building Parchment extension ($TARGET)..."

# Copy all extension files to temp dir
cp -r \
  "$REPO_ROOT/background" \
  "$REPO_ROOT/content" \
  "$REPO_ROOT/popup" \
  "$REPO_ROOT/settings" \
  "$REPO_ROOT/icons" \
  "$REPO_ROOT/manifest.json" \
  "$TMP_DIR/"

if [ "$TARGET" = "staging" ]; then
  echo "🔀 Switching URLs to staging..."
  find "$TMP_DIR" -name "*.js" -o -name "*.json" -o -name "*.html" | while read -r f; do
    sed -i 's|https://theparchment.app|https://staging.theparchment.app|g' "$f"
  done
  # Update extension name so it's distinguishable in chrome://extensions
  sed -i 's|"Parchment"|"Parchment (Staging)"|g' "$TMP_DIR/manifest.json"
  ZIP_NAME="parchment-extension-staging.zip"
else
  ZIP_NAME="parchment-extension.zip"
fi

# Build zip
cd "$TMP_DIR"
zip -r "$DIST_DIR/$ZIP_NAME" . --exclude "*.git*" --exclude "__MACOSX*"
rm -rf "$TMP_DIR"

echo "✅ Built: dist/$ZIP_NAME ($(du -h "$DIST_DIR/$ZIP_NAME" | cut -f1))"
