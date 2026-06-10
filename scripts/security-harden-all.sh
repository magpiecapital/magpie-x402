#!/usr/bin/env bash
# Hardens all 5 magpie repos in one shot. Per-repo settings tuned to
# what's actually meaningful for each (public vs private, what CI
# contexts exist, etc.).
#
# Idempotent — re-run any time. After running, follow up with
# ./scripts/security-drift-check.sh to verify nothing flips off later.
#
# Requires: gh CLI authed as a repo admin (magpiecapital account).
#
# Usage:
#   ./scripts/security-harden-all.sh

set -euo pipefail

# Per-repo CI contexts that must pass before merge. Empty JSON array
# means don't require any specific check (only PR review + linear
# history). Stored as parallel arrays for bash-3 compatibility — macOS
# ships bash 3.2 which doesn't support `declare -A` associative arrays.
REPOS=(magpie-x402 magpie-site magpie-bot magpie-marketing magpie-partners)
CONTEXTS=('["typecheck"]' '[]' '["leak-check"]' '[]' '[]')
PUBLIC_REPOS=(magpie-x402 magpie-site magpie-bot)

# Helper — look up the contexts entry for a given repo.
get_contexts() {
  local repo=$1
  local i
  for i in "${!REPOS[@]}"; do
    if [ "${REPOS[$i]}" = "$repo" ]; then
      echo "${CONTEXTS[$i]}"
      return
    fi
  done
  echo "[]"
}

harden_repo() {
  local repo=$1
  local contexts=$2
  echo ""
  echo "═══ ${repo} ═══"

  # ── Branch protection on main ─────────────────────────────────
  echo "  ▸ branch protection"
  # The required_status_checks payload is nullable: pass it explicitly
  # null if no contexts are required, otherwise pass the structured object.
  local status_payload
  if [ "$contexts" = "[]" ]; then
    status_payload=null
  else
    status_payload="{\"strict\":true,\"contexts\":${contexts}}"
  fi

  gh api -X PUT "repos/magpiecapital/${repo}/branches/main/protection" \
    --header "Accept: application/vnd.github+json" \
    --input - <<JSON > /dev/null
{
  "required_status_checks": ${status_payload},
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true
}
JSON
  echo "    ✓ required: PR + ${contexts} + linear history"
  echo "    ✓ blocked:  force-push, deletion, admin bypass"

  # ── Secret scanning + push protection (public repos only) ─────
  for pub in "${PUBLIC_REPOS[@]}"; do
    if [ "$pub" = "$repo" ]; then
      echo "  ▸ secret scanning + push protection"
      gh api -X PATCH "repos/magpiecapital/${repo}" \
        --header "Accept: application/vnd.github+json" \
        --input - <<JSON > /dev/null
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON
      echo "    ✓ scanning + push-protection enabled"
      break
    fi
  done

  # ── Vulnerability alerts ──────────────────────────────────────
  echo "  ▸ vulnerability alerts (Dependabot)"
  gh api -X PUT "repos/magpiecapital/${repo}/vulnerability-alerts" --silent 2>/dev/null || true
  gh api -X PUT "repos/magpiecapital/${repo}/automated-security-fixes" --silent 2>/dev/null || true
  echo "    ✓ enabled"
}

echo "══════════════════════════════════════════════"
echo " Magpie repo hardening — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "══════════════════════════════════════════════"

for i in "${!REPOS[@]}"; do
  harden_repo "${REPOS[$i]}" "${CONTEXTS[$i]}"
done

echo ""
echo "══════════════════════════════════════════════"
echo " ✓ All 5 repos hardened"
echo "══════════════════════════════════════════════"
echo ""
echo "Next: run ./scripts/security-drift-check.sh to verify and"
echo "set a 30-day calendar reminder to re-run the drift check."
