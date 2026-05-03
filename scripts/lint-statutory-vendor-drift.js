#!/usr/bin/env node
/**
 * lint-statutory-vendor-drift.js
 *
 * CG-013 (2026-05-03) — In-FE drift check for the vendored statutory
 * citation lint.
 *
 * AdminGate + ClientGate vendor `lint-statutory-citations.{js,test.js}` and
 * `statutory-citation-allowlist.json` from `Sitenyx.Build/scripts/`. The
 * vendored copies must stay byte-equivalent to the canonical source.
 *
 * This script catches **local drift** — i.e. a dev manually edited the
 * vendored copy without re-syncing. It compares the on-disk body-hash of
 * the 3 vendored files to the fingerprint recorded at sync time in
 * `.statutory-lint-vendor.sha`. It does NOT compare to the canonical
 * Sitenyx.Build copy (that's the sync-script's job, which runs from a
 * checkout of the full Sitenyx platform tree).
 *
 * Body-hash algorithm matches `Sitenyx.Build/scripts/sync-statutory-lint-to-fe.sh`:
 *   - For .js files: skip line 1 if shebang, skip the leading vendor-header
 *     `/** ... VENDORED FROM ... *\/` block, hash the rest.
 *   - For .json files: hash the file verbatim.
 *   - Combine the 3 hashes line-by-line and re-hash to produce the
 *     fingerprint.
 *
 * Usage:
 *   node scripts/lint-statutory-vendor-drift.js
 *
 * Exit codes:
 *   0 — vendored fingerprint matches the recorded `.statutory-lint-vendor.sha`
 *   1 — drift detected, or sidecar / vendored files missing
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCRIPT_DIR = __dirname;

const VENDORED_SCRIPT = path.join(SCRIPT_DIR, 'lint-statutory-citations.js');
const VENDORED_TEST = path.join(SCRIPT_DIR, 'lint-statutory-citations.test.js');
const VENDORED_ALLOWLIST = path.join(SCRIPT_DIR, 'statutory-citation-allowlist.json');
const SIDECAR = path.join(SCRIPT_DIR, '.statutory-lint-vendor.sha');

const ERR_PREFIX = '::error::';
const SYNC_HINT = 'Re-sync via: ./Sitenyx.Build/scripts/sync-statutory-lint-to-fe.sh';

function fail(msg) {
  console.error(`${ERR_PREFIX}${msg}`);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Body-hash a JS file: skip the leading shebang (line 1 if `#!`) and the
 * leading vendor-header `/** ... VENDORED FROM ... *\/` block, then hash the
 * rest. Mirrors the awk implementation in sync-statutory-lint-to-fe.sh so
 * canonical and vendored copies hash to the same value.
 */
function jsBodyHash(file) {
  if (!fs.existsSync(file)) {
    fail(`Missing vendored file: ${file}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  let i = 0;

  if (i < lines.length && lines[i].startsWith('#!')) {
    i++;
  }

  if (i < lines.length && lines[i] === '/**') {
    // Buffer the block — only drop it if it carries the VENDORED FROM marker.
    const buffered = [];
    let seenMarker = false;
    let closed = false;

    while (i < lines.length) {
      const line = lines[i];
      buffered.push(line);
      if (line.includes('VENDORED FROM')) {
        seenMarker = true;
      }
      if (line === ' */') {
        closed = true;
        i++;
        break;
      }
      i++;
    }

    if (!closed || !seenMarker) {
      // Not a vendor header; flush buffered lines as content.
      for (const buf of buffered) out.push(buf);
    }
  }

  for (; i < lines.length; i++) {
    out.push(lines[i]);
  }

  return sha256(out.join('\n'));
}

function fileHash(file) {
  if (!fs.existsSync(file)) {
    fail(`Missing vendored file: ${file}`);
    process.exit(1);
  }
  // Match `sha256sum file | awk '{print $1}'` semantics — hash the raw bytes.
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function vendoredFingerprint() {
  // Match the bash recipe:
  //   { jsBodyHash script; jsBodyHash test; sha256sum allowlist | awk; } | sha256sum | awk
  // Each component is followed by a newline (printed via printf \n).
  const composite = `${jsBodyHash(VENDORED_SCRIPT)}\n${jsBodyHash(VENDORED_TEST)}\n${fileHash(VENDORED_ALLOWLIST)}\n`;
  return sha256(composite);
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    fail(`Missing ${SIDECAR}. ${SYNC_HINT}`);
    process.exit(1);
  }

  const recorded = fs.readFileSync(SIDECAR, 'utf8').trim();
  const onDisk = vendoredFingerprint();

  if (recorded !== onDisk) {
    fail('Vendored statutory-citation lint has drifted from the recorded fingerprint.');
    fail(`  recorded fingerprint: ${recorded}`);
    fail(`  on-disk fingerprint:  ${onDisk}`);
    fail('A local edit was made to one of:');
    fail('  - scripts/lint-statutory-citations.js');
    fail('  - scripts/lint-statutory-citations.test.js');
    fail('  - scripts/statutory-citation-allowlist.json');
    fail(SYNC_HINT);
    process.exit(1);
  }

  console.log(`OK: vendored statutory-citation lint matches recorded fingerprint (${recorded.slice(0, 12)}...).`);
  process.exit(0);
}

main();
