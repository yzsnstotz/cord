#!/usr/bin/env bash
# list_git_refs.sh
# Usage: bash list_git_refs.sh <repo_path>
# Prints branch/tag refs (short names), one per line.

set -euo pipefail

repo_path="${1:-}"
if [ -z "$repo_path" ]; then
  echo "repo_path is required" >&2
  exit 1
fi

if ! git -C "$repo_path" rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repository: $repo_path" >&2
  exit 1
fi

git -C "$repo_path" for-each-ref --format='%(refname:short)' refs/heads refs/tags
