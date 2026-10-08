#!/bin/bash
# Publishes the version in package.json: uploads the code, tags it, waits for GitHub to build
# the installer, then downloads the dmg to ~/Downloads and opens it.
#
# Safe to run again for the same version as long as it hasn't been released yet (for example
# after a failed build): the tag is moved to the latest code and the build starts over.
#
# Needs git and the GitHub CLI (gh). No Node.js or npm.

set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
TAG="v$VERSION"
echo "▸ Releasing Quill $VERSION"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "✗ Quill $VERSION is already released. Raise \"version\" in package.json for a new release." >&2
  exit 1
fi

git add -A
git commit -m "Quill $VERSION" >/dev/null 2>&1 && echo "▸ Committed" || echo "▸ Nothing new to commit"
git push origin main

START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if git rev-parse "$TAG" >/dev/null 2>&1 && [ "$(git rev-list -n 1 "$TAG")" != "$(git rev-parse HEAD)" ]; then
  echo "▸ Moving tag $TAG to the latest code (that version was never released)"
  git tag -f "$TAG" >/dev/null
  git push -f origin "$TAG"
elif git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "▸ Tag $TAG is already on the latest code; starting the build again"
  gh workflow run release.yml --ref "$TAG"
else
  git tag "$TAG"
  git push origin "$TAG"
fi

echo "▸ GitHub is building the installer. This takes about 10 minutes."
find_run() {
  gh run list --workflow release.yml --limit 10 --json databaseId,createdAt,headBranch \
    --jq "[.[] | select(.headBranch == \"$TAG\" and .createdAt >= \"$START\")][0].databaseId // empty" 2>/dev/null || true
}
RUN_ID=""
for i in $(seq 1 36); do
  RUN_ID=$(find_run)
  [ -n "$RUN_ID" ] && break
  # If pushing the tag didn't start a build within a minute, start one by hand.
  if [ "$i" -eq 12 ]; then gh workflow run release.yml --ref "$TAG" || true; fi
  sleep 5
done
if [ -z "$RUN_ID" ]; then
  echo "✗ Couldn't find the build. Check the Actions tab on GitHub." >&2
  exit 1
fi

if ! gh run watch "$RUN_ID" --exit-status; then
  echo "✗ The build failed. To see why, run:" >&2
  echo "    gh run view $RUN_ID --log-failed | tail -80" >&2
  exit 1
fi

echo "▸ Downloading the installer"
gh release download "$TAG" --pattern '*.dmg' --dir "$HOME/Downloads" --clobber
DMG="$HOME/Downloads/Quill-$VERSION-universal.dmg"
echo "✓ $DMG"
open "$DMG"
