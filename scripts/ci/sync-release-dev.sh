#!/usr/bin/env bash
set -euo pipefail

git fetch origin refs/heads/master:refs/remotes/origin/master refs/heads/dev:refs/remotes/origin/dev
# master may have advanced during publication. Only sync this batch's writeback,
# including on a full rerun where publish was skipped because it already succeeded.
release=$(git log --first-parent --format=%H --fixed-strings --grep="Arkme-CI-Batch: ${RELEASE_BATCH:?}" "${GITHUB_SHA:?}..origin/master")
if [[ ! $release =~ ^[0-9a-f]{40}$ ]] ||
   [[ $(git show -s --format=%P "$release") != "$GITHUB_SHA" ]] ||
   ! git show -s --format=%B "$release" | grep -Fxq "Arkme-CI-Batch: $RELEASE_BATCH"; then
  echo "Cannot identify the published batch's version writeback on master." >&2
  exit 1
fi
if git merge-base --is-ancestor "$release" origin/dev; then
  echo "dev already contains release $release."
  exit 0
fi

branch="sync/master-to-dev/$release"
pr=$(gh pr list --repo "$GH_REPO" --base dev --head "$branch" --state all --limit 1 --json number,state --jq '.[0] | select(. != null) | [.number,.state] | @tsv')
if [[ -z $pr ]]; then
  ref="refs/heads/$branch"
  existing=$(git ls-remote --heads origin "$ref")
  if [[ -z $existing ]]; then
    git push origin "$release:$ref"
  elif [[ ${existing%%[[:space:]]*} != "$release" ]]; then
    echo "Sync branch points to a different commit; refusing to overwrite it." >&2
    exit 1
  fi
  pr_url=$(gh pr create --repo "$GH_REPO" --base dev --head "$branch" \
    --title "chore(sync): 同步客户端正式发布 ${release:0:12} 到 dev" \
    --body "功能点: 将已发布的版本回写提交 $release 合并回 dev，保留双方提交历史。")
  state=OPEN
else
  IFS=$'\t' read -r pr_url state <<< "$pr"
fi
case $state in
  OPEN) gh pr merge "$pr_url" --repo "$GH_REPO" --match-head-commit "$release" --merge --delete-branch ;;
  MERGED) ;;
  *) echo "Sync PR $pr_url was closed without merging; inspect before retrying." >&2; exit 1 ;;
esac
git fetch origin refs/heads/dev:refs/remotes/origin/dev
git merge-base --is-ancestor "$release" origin/dev || { echo "Release $release is still missing from dev." >&2; exit 1; }
