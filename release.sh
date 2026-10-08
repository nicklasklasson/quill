#!/bin/bash
# Publishes the version in package.json: uploads the code, tags it, waits for GitHub to build
# the installer, then downloads the dmg to ~/Downloads and opens it.
#
# Needs git and the GitHub CLI (gh), both already set up for Loupe. No Node.js or npm.
#   cd ~/Downloads/quill-0.1.4 && ./release.sh

set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
TAG="v$VERSION"
echo "▸ Releasing Quill $VERSION"

git add -A
git commit -m "Quill $VERSION" >/dev/null 2>&1 && echo "▸ Committed" || echo "▸ Nothing new to commit"
git push origin main

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "▸ Tag $TAG already exists"
else
  git tag "$TAG"
fi
git push origin "$TAG"

echo "▸ GitHub is building the installer. This takes about 10 minutes."
RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID=$(gh run list --workflow release.yml --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
  [ -n "$RUN_ID" ] && break
  sleep 5
done
if [ -z "$RUN_ID" ]; then
  echo "✗ Couldn't find the build. Check the Actions tab on GitHub." >&2
  exit 1
fi
gh run watch "$RUN_ID" --exit-status

echo "▸ Downloading the installer"
gh release download "$TAG" --pattern '*.dmg' --dir "$HOME/Downloads" --clobber
DMG="$HOME/Downloads/Quill-$VERSION-universal.dmg"
echo "✓ $DMG"
open "$DMG"
