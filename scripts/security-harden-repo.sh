#!/usr/bin/env bash
# One-shot CI/CD hardening for this repo. Operator runs this once after
# the GitHub Actions secrets are wired up. Idempotent — re-running it
# is safe (state-converging API calls).
#
# What it does:
#   1. Enables branch protection on main (requires CI pass + PR review,
#      blocks force pushes + deletions, enforces for admins).
#   2. Enables secret-scanning push protection on the repo so a
#      committed secret is rejected at push time, not after merge.
#   3. Enables vulnerability alerts + automated security fixes.
#   4. Lists current collaborators + GitHub Apps with write scope so
#      the operator can review who can theoretically modify the
#      deploy workflow.
#
# Requires: gh CLI authed as a repo admin (the magpiecapital account).
#
# Usage:
#   ./scripts/security-harden-repo.sh
set -euo pipefail

REPO="${REPO:-magpiecapital/magpie-x402}"

echo "═══ Hardening ${REPO} ═══"
echo ""

# ── 1. Branch protection on main ───────────────────────────────────
echo "─── Step 1/4: Branch protection on main ───"
gh api -X PUT "repos/${REPO}/branches/main/protection" \
  --header "Accept: application/vnd.github+json" \
  -F required_status_checks='{"strict":true,"contexts":["typecheck"]}' \
  -F enforce_admins=true \
  -F required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true,"require_code_owner_reviews":false}' \
  -F restrictions= \
  -F required_linear_history=true \
  -F allow_force_pushes=false \
  -F allow_deletions=false \
  -F block_creations=false \
  -F required_conversation_resolution=true \
  > /dev/null
echo "  ✓ main now requires:"
echo "    - PR with at least 1 approving review"
echo "    - 'typecheck' CI status to pass before merge"
echo "    - Linear history (no merge commits without --no-ff)"
echo "    - Stale reviews dismissed on new push"
echo "    - All review threads resolved before merge"
echo "  ✓ blocked:"
echo "    - Force pushes"
echo "    - Branch deletion"
echo "    - Admin bypass (enforce_admins=true)"
echo ""

# ── 2. Secret-scanning push protection ─────────────────────────────
echo "─── Step 2/4: Secret-scanning push protection ───"
gh api -X PATCH "repos/${REPO}" \
  --header "Accept: application/vnd.github+json" \
  -F 'security_and_analysis[secret_scanning][status]=enabled' \
  -F 'security_and_analysis[secret_scanning_push_protection][status]=enabled' \
  > /dev/null
echo "  ✓ secret patterns blocked at push time (before they hit the repo)"
echo ""

# ── 3. Vulnerability alerts + automated security fixes ─────────────
echo "─── Step 3/4: Vulnerability alerts + Dependabot ───"
gh api -X PUT "repos/${REPO}/vulnerability-alerts" --silent || echo "  (already enabled or not available — non-fatal)"
gh api -X PUT "repos/${REPO}/automated-security-fixes" --silent || echo "  (already enabled or not available — non-fatal)"
echo "  ✓ Dependabot scanning enabled"
echo ""

# ── 4. Audit who can modify the workflow ───────────────────────────
echo "─── Step 4/4: Who has write/admin access? ───"
echo "  Collaborators (humans):"
gh api "repos/${REPO}/collaborators" --jq '.[] | "    - \(.login)  (\(.role_name))"' || echo "    (none beyond owner)"
echo ""
echo "  Apps installed on the repo with write+ scope:"
gh api "repos/${REPO}/installations" --jq '.installations[]? | "    - \(.app_slug)  (permissions: \(.permissions | to_entries | map(select(.value=="write" or .value=="admin")) | from_entries))"' 2>/dev/null || echo "    (none or restricted access — typical)"
echo ""
echo "  Review the lists above. ANYONE on these lists can theoretically"
echo "  push a malicious workflow change and exfiltrate the Vercel token."
echo "  Remove anyone who shouldn't have write access:"
echo "    gh api -X DELETE repos/${REPO}/collaborators/<username>"
echo ""

echo "═══ Hardening complete ═══"
echo ""
echo "Recommended manual follow-ups:"
echo "  1. Vercel token rotation — calendar reminder for 2026-09-10 (~90d)"
echo "     Generate new at vercel.com/account/tokens (Magpie Capital scope)"
echo "     Then: gh secret set VERCEL_TOKEN --repo ${REPO} --body \"<new>\""
echo "     Then revoke old at vercel.com/account/tokens"
echo ""
echo "  2. Re-run this script periodically — it's idempotent and surfaces"
echo "     any drift if someone manually disables a setting."
