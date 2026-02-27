#!/usr/bin/env bash
# ensure_git_repo.sh
# Usage: bash ensure_git_repo.sh <repo_path> [base_ref]
# Ensures repo_path exists, is a git repo, has at least one commit, and has base_ref branch.

set -euo pipefail

repo_path="${1:-}"
base_ref="${2:-main}"

if [ -z "$repo_path" ]; then
  echo "repo_path is required" >&2
  exit 1
fi

mkdir -p "$repo_path"

if ! git -C "$repo_path" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$repo_path" init >/dev/null 2>&1
fi

# Create an initial commit when repository has no commits yet.
if ! git -C "$repo_path" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$repo_path" checkout -B "$base_ref" >/dev/null 2>&1 || true
  git -C "$repo_path" -c user.name=rdloop -c user.email=rdloop@local \
    commit --allow-empty -m "Initialize repository for rdloop" >/dev/null 2>&1
fi

if ! git -C "$repo_path" show-ref --verify --quiet "refs/heads/${base_ref}"; then
  git -C "$repo_path" branch "$base_ref" HEAD >/dev/null 2>&1 || true
fi

if ! git -C "$repo_path" show-ref --verify --quiet "refs/heads/${base_ref}"; then
  echo "failed to ensure base_ref '${base_ref}' at '${repo_path}'" >&2
  exit 1
fi

echo "$repo_path"
