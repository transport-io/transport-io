#!/usr/bin/env bash
# Apply branch protection to main. Branch protection cannot be set from a workflow file,
# so it lives here as one command rather than as something someone remembers (D62).
#
#   ./scripts/protect-branch.sh <owner>/<repo>
#
# Requires: gh, authenticated. Idempotent — safe to re-run.
set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
echo "applying branch protection to ${REPO}:main"

# Every hook in lefthook.yml has a CI counterpart, and this is what makes those
# counterparts actually gate the merge button rather than merely exist.
gh api -X PUT "repos/${REPO}/branches/main/protection" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "PR title (the squashed commit subject)",
      "typecheck / lint / dead code / docs",
      "unit tests (bun — never loads the transport)",
      "integration tests (node — loads the transport)",
      "pack validation",
      "changeset present",
      "source changed without documentation"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true
}
JSON

# Squash merge only. The PR title becomes the commit subject, and the PR body must NOT
# become the body, because no commit ever has one (D29).
gh api -X PATCH "repos/${REPO}" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F squash_merge_commit_title=PR_TITLE \
  -F squash_merge_commit_message=BLANK \
  -F delete_branch_on_merge=true \
  > /dev/null

echo "done. verify with:"
echo "  gh api repos/${REPO}/branches/main/protection --jq '.required_status_checks.contexts'"
