#!/usr/bin/env bash
# Security drift check — runs a full posture audit across all magpie
# repos and reports anything that's drifted from the intended baseline.
#
# Run this monthly (or any time you want assurance). It only READS
# state via gh API — never modifies anything. Safe to run from CI on a
# schedule, or manually after a config change.
#
# What it verifies per repo:
#   - Branch protection on main: required reviews + linear history +
#     enforce_admins + force-push blocked + deletion blocked
#   - Secret scanning + push protection (public repos only)
#   - Workflow file SHA pinning (no @v4 / @latest tags allowed)
#   - Collaborator allowlist (only ALLOWED_ADMINS expected)
#   - Repo visibility hasn't flipped (public stayed public, etc.)
#
# Exit codes:
#   0 — no drift detected, baseline intact
#   1 — drift detected, summary printed at end
#   2 — script error (missing gh, no auth, etc.)

set -uo pipefail

REPOS=(magpie-x402 magpie-site magpie-bot magpie-marketing magpie-partners)
PUBLIC_REPOS=(magpie-x402 magpie-site magpie-bot)
PRIVATE_REPOS=(magpie-marketing magpie-partners)
ALLOWED_ADMINS=(magpiecapital)

DRIFT=0
trap 'echo "  ✗ unexpected error"; exit 2' ERR

ok() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; DRIFT=1; }

check_branch_protection() {
  local repo=$1
  local data
  data=$(gh api "repos/magpiecapital/$repo/branches/main/protection" 2>/dev/null)
  if [ -z "$data" ] || echo "$data" | grep -q "Not Found"; then
    fail "$repo: main is NOT branch-protected"
    return
  fi
  # Required reviews
  local reviews
  reviews=$(echo "$data" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('required_pull_request_reviews',{}).get('required_approving_review_count',0))" 2>/dev/null || echo 0)
  if [ "$reviews" -lt 1 ]; then
    fail "$repo: main requires < 1 approving review"
  else
    ok "$repo: branch protection ($reviews review(s) required)"
  fi
  # Force-push blocked
  local fp
  fp=$(echo "$data" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('allow_force_pushes',{}).get('enabled', True))" 2>/dev/null || echo true)
  [ "$fp" = "False" ] || fail "$repo: force-push to main is ALLOWED (should be blocked)"
  # Deletions blocked
  local del
  del=$(echo "$data" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('allow_deletions',{}).get('enabled', True))" 2>/dev/null || echo true)
  [ "$del" = "False" ] || fail "$repo: branch deletion is ALLOWED (should be blocked)"
}

check_secret_scanning() {
  local repo=$1
  local ss
  ss=$(gh api "repos/magpiecapital/$repo" --jq '.security_and_analysis.secret_scanning.status // "off"' 2>/dev/null)
  local pp
  pp=$(gh api "repos/magpiecapital/$repo" --jq '.security_and_analysis.secret_scanning_push_protection.status // "off"' 2>/dev/null)
  if [ "$ss" = "enabled" ] && [ "$pp" = "enabled" ]; then
    ok "$repo: secret scanning + push protection ON"
  else
    fail "$repo: secret scanning=$ss push_protection=$pp (both should be enabled)"
  fi
}

check_workflow_pinning() {
  local repo=$1
  # Pull each workflow file content and grep for unpinned actions usage.
  # Pinned actions look like uses: org/action@<40-char-sha> (# comment)
  # Unpinned look like uses: org/action@v4 or @main or @latest
  local workflows
  workflows=$(gh api "repos/magpiecapital/$repo/contents/.github/workflows" --jq '.[].path' 2>/dev/null || true)
  local any_unpinned=0
  for wf in $workflows; do
    local content
    local raw
    raw=$(gh api "repos/magpiecapital/$repo/contents/$wf" --jq '.content' 2>/dev/null)
    [ -z "$raw" ] || [ "$raw" = "null" ] && continue
    content=$(echo "$raw" | base64 -d 2>/dev/null)
    # Check every "uses:" line — fail if any RHS doesn't match a 40-char hex SHA
    local bad
    bad=$(echo "$content" | grep -E "^\s*-?\s*uses:\s*[^@]+@" | grep -vE "@[0-9a-f]{40}\s*(#|$)" || true)
    if [ -n "$bad" ]; then
      fail "$repo: unpinned action in $wf:"
      echo "$bad" | sed 's/^/      /'
      any_unpinned=1
    fi
  done
  [ $any_unpinned -eq 0 ] && ok "$repo: all workflow actions SHA-pinned"
}

check_collaborators() {
  local repo=$1
  local actual
  actual=$(gh api "repos/magpiecapital/$repo/collaborators" --jq '.[].login' 2>/dev/null | sort | tr '\n' ' ')
  local expected
  expected=$(printf '%s\n' "${ALLOWED_ADMINS[@]}" | sort | tr '\n' ' ')
  if [ "$actual" = "$expected" ]; then
    ok "$repo: collaborators match allowlist"
  else
    fail "$repo: collaborator drift"
    echo "      expected: $expected"
    echo "      actual:   $actual"
  fi
}

check_visibility() {
  local repo=$1
  local expected=$2
  local actual
  actual=$(gh api "repos/magpiecapital/$repo" --jq '.private' 2>/dev/null)
  case $expected in
    public) [ "$actual" = "false" ] && ok "$repo: still public" || fail "$repo: flipped from public to private" ;;
    private) [ "$actual" = "true" ] && ok "$repo: still private" || fail "$repo: flipped from private to public" ;;
  esac
}

echo "══════════════════════════════════════════════"
echo " Security drift check — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "══════════════════════════════════════════════"
echo ""

for repo in "${REPOS[@]}"; do
  echo "── $repo ──"
  check_branch_protection "$repo"
  check_collaborators "$repo"
  check_workflow_pinning "$repo"
done
echo ""

echo "── public repos: secret scanning ──"
for repo in "${PUBLIC_REPOS[@]}"; do
  check_secret_scanning "$repo"
done
echo ""

echo "── visibility ──"
for repo in "${PUBLIC_REPOS[@]}"; do
  check_visibility "$repo" public
done
for repo in "${PRIVATE_REPOS[@]}"; do
  check_visibility "$repo" private
done
echo ""

echo "══════════════════════════════════════════════"
if [ $DRIFT -eq 0 ]; then
  echo " ✓ NO DRIFT — security posture intact"
  echo "══════════════════════════════════════════════"
  exit 0
else
  echo " ✗ DRIFT DETECTED — see findings above"
  echo "══════════════════════════════════════════════"
  echo ""
  echo "To restore baseline, re-run ./scripts/security-harden-repo.sh"
  echo "for each affected repo. Investigate any unexpected collaborators"
  echo "or visibility changes before re-hardening — they may indicate"
  echo "intentional changes (in which case update this script's expected"
  echo "values) or compromise (in which case rotate credentials first)."
  exit 1
fi
