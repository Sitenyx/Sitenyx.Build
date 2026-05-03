#!/usr/bin/env bash
# sync-statutory-lint-to-fe.sh
#
# CG-013 (2026-05-03) — Sync the canonical statutory-citation lint into the
# two Next.js front-ends (AdminGate, ClientGate) that don't mount the
# `build/` submodule.
#
# AdminGate + ClientGate run their own custom `ci-guardrails.yml` /
# `ci.yml` workflows (no shared `test-dotnet.yml`), so the lint is vendored
# rather than wired through a submodule. This script keeps the vendored
# copies in lock-step with the canonical Sitenyx.Build/scripts/ source.
#
# What it does:
#   1. Copies 3 files into <FE>/scripts/:
#        - lint-statutory-citations.js
#        - lint-statutory-citations.test.js
#        - statutory-citation-allowlist.json
#   2. Prepends a vendor header to each .js file pointing at the
#      canonical source (so devs don't accidentally edit the vendored copy).
#   3. Computes a SHA256 fingerprint of the 3 files (body-hashed for .js,
#      raw-hashed for the JSON allowlist) and writes it into
#      <FE>/scripts/.statutory-lint-vendor.sha so CI drift-detection can
#      assert that the vendored copies are byte-equivalent to the canonical
#      source.
#   4. Also copies `lint-statutory-vendor-drift.js` into <FE>/scripts/ so
#      each FE has a self-contained Node script that can verify its own
#      vendored copies against the recorded fingerprint (used by per-FE CI
#      where the canonical Sitenyx.Build tree isn't checked out).
#
# CI drift-detection:
#   AdminGate `ci-guardrails.yml` + ClientGate `ci.yml` each run this
#   script in `--check` mode. If the fingerprint differs from canonical,
#   CI fails with a "vendor drift" error and points the dev at this script
#   to re-sync.
#
# Usage:
#   ./Sitenyx.Build/scripts/sync-statutory-lint-to-fe.sh           # sync
#   ./Sitenyx.Build/scripts/sync-statutory-lint-to-fe.sh --check   # verify
#
# Exit codes:
#   0 — sync (or check) succeeded
#   1 — drift detected in --check mode, or copy failed in sync mode

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CANONICAL_SCRIPT="${SCRIPT_DIR}/lint-statutory-citations.js"
CANONICAL_TEST="${SCRIPT_DIR}/lint-statutory-citations.test.js"
CANONICAL_ALLOWLIST="${SCRIPT_DIR}/statutory-citation-allowlist.json"
CANONICAL_DRIFT_CHECK="${SCRIPT_DIR}/lint-statutory-vendor-drift.js"

FE_TARGETS=("AdminGate" "ClientGate")

MODE="${1:-sync}"

if [[ "${MODE}" != "sync" && "${MODE}" != "--check" ]]; then
  echo "usage: $0 [sync|--check]" >&2
  exit 2
fi

# ─────────────────────────────────────────────────────────────────────────
# Vendor header — prepended to .js files so the vendored copy carries an
# explicit pointer back to the canonical source. JSON cannot host a
# comment, so the allowlist is copied verbatim and a $comment field at
# the top already documents its provenance.
# ─────────────────────────────────────────────────────────────────────────

read -r -d '' VENDOR_HEADER <<'HEADER' || true
/**
 * VENDORED FROM Sitenyx.Build/scripts/ — DO NOT EDIT IN PLACE.
 *
 * Canonical source: <platform>/Sitenyx.Build/scripts/lint-statutory-citations.{js,test.js}
 *                   <platform>/Sitenyx.Build/scripts/statutory-citation-allowlist.json
 *
 * Re-sync via:    ./Sitenyx.Build/scripts/sync-statutory-lint-to-fe.sh
 * CI drift check: ./Sitenyx.Build/scripts/sync-statutory-lint-to-fe.sh --check
 *
 * Why vendored, not submoduled:
 *   AdminGate + ClientGate are Next.js repos and don't mount the
 *   `build/` submodule that the .NET service repos do. Vendoring keeps
 *   the FE CI matrix self-contained while CI drift-detection enforces
 *   lock-step parity with the canonical source.
 */
HEADER

# Hash the "canonical body" of a .js file — the content excluding any
# leading shebang line and any leading vendor-header block. This makes
# canonical and vendored files hash-equivalent regardless of which
# wrapper layers they carry.
#
# Body extraction rules:
#   1. If line 1 is `#!...`, skip it.
#   2. If the next line opens a vendor-header block (`/**`) AND the block
#      contains the marker "VENDORED FROM", skip lines through the
#      closing ` */`.
#   3. Hash everything else.
js_body_hash() {
  awk '
    BEGIN { line = 0; in_vendor = 0; vendor_seen_marker = 0 }
    {
      line++
      if (line == 1 && $0 ~ /^#!/) { next }
      if (!in_vendor && $0 ~ /^\/\*\*$/) {
        in_vendor = 1
        vendor_seen_marker = 0
        buffer[1] = $0
        buf_len = 1
        next
      }
      if (in_vendor) {
        buf_len++
        buffer[buf_len] = $0
        if ($0 ~ /VENDORED FROM/) { vendor_seen_marker = 1 }
        if ($0 ~ /^ \*\/$/) {
          # Header closed.
          if (vendor_seen_marker) {
            # Drop the vendor header — do not print buffered lines.
          } else {
            # Not a vendor header; flush all buffered lines as content.
            for (i = 1; i <= buf_len; i++) print buffer[i]
          }
          in_vendor = 0
          buf_len = 0
          next
        }
        next
      }
      print
    }
  ' "$1" | sha256sum | awk '{print $1}'
}

# Compute a stable fingerprint over the 3 canonical files + their order.
# Uses js_body_hash for .js files so the hash is stable across
# canonical/vendored copies.
canonical_fingerprint() {
  {
    js_body_hash "${CANONICAL_SCRIPT}"
    js_body_hash "${CANONICAL_TEST}"
    sha256sum "${CANONICAL_ALLOWLIST}" | awk '{print $1}'
  } | sha256sum | awk '{print $1}'
}

# Compute a fingerprint over the vendored files in a target. Same body-hash
# strategy — vendored files have a shebang AND a vendor header; canonical
# has only a shebang. Both reduce to the same body-hash.
vendored_fingerprint() {
  local fe="$1"
  local target_dir="${PLATFORM_ROOT}/${fe}/scripts"
  local script="${target_dir}/lint-statutory-citations.js"
  local test_file="${target_dir}/lint-statutory-citations.test.js"
  local allowlist="${target_dir}/statutory-citation-allowlist.json"

  if [[ ! -f "${script}" || ! -f "${test_file}" || ! -f "${allowlist}" ]]; then
    echo "MISSING"
    return
  fi

  {
    js_body_hash "${script}"
    js_body_hash "${test_file}"
    sha256sum "${allowlist}" | awk '{print $1}'
  } | sha256sum | awk '{print $1}'
}

# Vendor-write: emit shebang first, then vendor header, then canonical
# content with its original shebang stripped. This preserves Node's
# `#!/usr/bin/env node` semantics for direct execution while keeping the
# vendor-header pointer at the top of the file (visible to humans + IDEs).
write_vendored_js() {
  local src="$1"
  local dest="$2"
  local first_line
  first_line="$(head -n 1 "${src}")"
  {
    if [[ "${first_line}" == "#!"* ]]; then
      printf "%s\n" "${first_line}"
      printf "%s\n" "${VENDOR_HEADER}"
      tail -n +2 "${src}"
    else
      printf "%s\n" "${VENDOR_HEADER}"
      cat "${src}"
    fi
  } > "${dest}"
}

# ─────────────────────────────────────────────────────────────────────────
# Sync mode — copy canonical → vendored and write fingerprint sidecar.
# ─────────────────────────────────────────────────────────────────────────

sync_one() {
  local fe="$1"
  local target_dir="${PLATFORM_ROOT}/${fe}/scripts"

  if [[ ! -d "${target_dir}" ]]; then
    echo "  skip ${fe}: no scripts/ directory at ${target_dir}" >&2
    return
  fi

  echo "  sync ${fe}/scripts/ ←  Sitenyx.Build/scripts/"
  write_vendored_js "${CANONICAL_SCRIPT}" "${target_dir}/lint-statutory-citations.js"
  write_vendored_js "${CANONICAL_TEST}"   "${target_dir}/lint-statutory-citations.test.js"
  cp "${CANONICAL_ALLOWLIST}" "${target_dir}/statutory-citation-allowlist.json"
  # Drift-check script — runs in-FE against the sidecar fingerprint; not
  # body-hashed because the FE doesn't depend on its content matching
  # canonical (only on it producing a stable fingerprint of the 3 lint files
  # above). Still vendored from Sitenyx.Build/scripts/ so all 4 stay in lock-step.
  write_vendored_js "${CANONICAL_DRIFT_CHECK}" "${target_dir}/lint-statutory-vendor-drift.js"
  chmod +x "${target_dir}/lint-statutory-vendor-drift.js"
  canonical_fingerprint > "${target_dir}/.statutory-lint-vendor.sha"
}

# ─────────────────────────────────────────────────────────────────────────
# Check mode — verify fingerprints match canonical.
# ─────────────────────────────────────────────────────────────────────────

check_one() {
  local fe="$1"
  local target_dir="${PLATFORM_ROOT}/${fe}/scripts"
  local sha_file="${target_dir}/.statutory-lint-vendor.sha"

  if [[ ! -f "${sha_file}" ]]; then
    echo "::error::${fe} is missing ${sha_file}. Run ./Sitenyx.Build/scripts/sync-statutory-lint-to-fe.sh."
    return 1
  fi

  local recorded
  recorded="$(cat "${sha_file}")"
  local canonical
  canonical="$(canonical_fingerprint)"

  if [[ "${recorded}" != "${canonical}" ]]; then
    echo "::error::${fe} vendored statutory lint is out of sync."
    echo "::error::  recorded fingerprint: ${recorded}"
    echo "::error::  canonical fingerprint: ${canonical}"
    echo "::error::Re-sync via: ./Sitenyx.Build/scripts/sync-statutory-lint-to-fe.sh"
    return 1
  fi

  # Also verify on-disk content matches the recorded fingerprint (catches
  # post-sync edits that didn't touch the .sha file).
  local on_disk
  on_disk="$(vendored_fingerprint "${fe}")"
  if [[ "${on_disk}" != "${canonical}" ]]; then
    echo "::error::${fe} vendored files have been edited since the last sync."
    echo "::error::  on-disk fingerprint: ${on_disk}"
    echo "::error::  canonical fingerprint: ${canonical}"
    echo "::error::Re-sync via: ./Sitenyx.Build/scripts/sync-statutory-lint-to-fe.sh"
    return 1
  fi

  echo "  ok ${fe}: vendored statutory lint matches canonical (${canonical:0:12}...)"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────

if [[ "${MODE}" == "sync" ]]; then
  echo "sync-statutory-lint-to-fe: copying canonical → vendored"
  for fe in "${FE_TARGETS[@]}"; do
    sync_one "${fe}"
  done
  echo "Done. Fingerprint: $(canonical_fingerprint)"
  exit 0
fi

# --check mode
echo "sync-statutory-lint-to-fe: verifying vendored ↔ canonical parity"
fail=0
for fe in "${FE_TARGETS[@]}"; do
  if ! check_one "${fe}"; then
    fail=1
  fi
done
exit "${fail}"
