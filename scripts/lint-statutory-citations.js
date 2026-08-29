#!/usr/bin/env node
/**
 * lint-statutory-citations.js
 *
 * CG-013 (2026-05-03) — Statutory-citation allow-list CI lint.
 *
 * Sitenyx's compliance services cite Danish statutes by §-reference
 * (e.g. "Bogføringsloven §15", "Selskabsloven §119"). Without this lint,
 * agents/devs can fabricate citations to non-existent §s — the cross-Gate
 * citation audit on 2026-05-01 corrected 364+ wrong citations across
 * 10 backend repos and 40 i18n files (closed CG-009 + CG-011). This lint
 * keeps the gap closed.
 *
 * SCANS: .cs, .tsx, .ts files + messages/{locale}/index.json bundles.
 * MATCHES: `\b<StatuteName>\s*§\s*<N>(?:[a-zA-Z])?(?:\s+stk\.\s+\d+)?`
 *
 * EXIT CODES:
 *   0 — all citations are valid (canonical statute + valid §-number)
 *   1 — at least one INVALID citation found:
 *       a) §-number outside the statute's valid range
 *       b) §-number is in the explicitlyInvalid set (hallucination)
 *       c) statute name is in rejectedStatutes (e.g. Persondataloven)
 *       d) statute name uses an ASCII-fallback diacritic spelling that
 *          falls back to a rejectedStatutes kind=diacritic-typo entry
 *       e) citation matches a knownHallucinations entry
 *
 * USAGE:
 *   node scripts/lint-statutory-citations.js [path1] [path2] ...
 *
 *   With no args, scans the platform root (auto-detected via PWD parent
 *   that contains a Sitenyx.sln or .git directory). Each file is scanned
 *   with the regex; matches are validated against the allowlist; an
 *   exit code + grep-style report is emitted.
 *
 * REPORT FORMAT (grep-compatible: `<file>:<line>:<col>: <severity>: <message>`):
 *
 *   ComplianceGate/src/X.cs:42:18: error: Bogføringsloven §11 is Ophævet (repealed)
 *
 * Allowlist source: ./statutory-citation-allowlist.json
 * Tests: ./lint-statutory-citations.test.js (run with `node scripts/lint-statutory-citations.test.js`)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ALLOWLIST_PATH = path.resolve(__dirname, "statutory-citation-allowlist.json");

// ─────────────────────────────────────────────────────────────────────────
// Allowlist loading + normalisation
// ─────────────────────────────────────────────────────────────────────────

function loadAllowlist(allowlistPath = ALLOWLIST_PATH) {
  const raw = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  const statutes = {};

  // Index every canonical statute name AND every diacritic variant under
  // the canonical key, so the lint can resolve "Bogforingsloven" →
  // "Bogføringsloven" and emit a typo error for the ASCII fallback.
  for (const [canonicalName, def] of Object.entries(raw.statutes)) {
    const validRange = parseRange(def.validParagraphs);
    const explicitlyInvalid = def.explicitlyInvalid || {};
    const fullName = def.fullName;
    const shortForm = def.shortForm || null;

    statutes[canonicalName.toLowerCase()] = {
      canonicalName,
      fullName,
      shortForm,
      validRange,
      explicitlyInvalid,
      isDiacriticTypo: false,
    };

    if (shortForm) {
      statutes[shortForm.toLowerCase()] = {
        canonicalName,
        fullName,
        shortForm,
        validRange,
        explicitlyInvalid,
        isDiacriticTypo: false,
      };
    }

    // alternateForms = grammatical variants like the Danish genitive
    // ("Arbejdsmarkedsbidragslovens" = "of the Arbejdsmarkedsbidragsloven")
    // — fully valid; lint must NOT flag these as typos.
    for (const altForm of def.alternateForms || []) {
      statutes[altForm.toLowerCase()] = {
        canonicalName,
        fullName,
        shortForm,
        validRange,
        explicitlyInvalid,
        isDiacriticTypo: false,
        alternateFormUsed: altForm,
      };
    }

    // diacriticVariants = ASCII fallback (missing ø/å/æ) — flagged as
    // typo; the canonical form must be used.
    for (const variant of def.diacriticVariants || []) {
      statutes[variant.toLowerCase()] = {
        canonicalName,
        fullName,
        shortForm,
        validRange,
        explicitlyInvalid,
        isDiacriticTypo: variant !== canonicalName,
        typoVariantUsed: variant,
      };
    }
  }

  // rejectedStatutes (Persondataloven, plain-ASCII Bogforingsloven, etc.)
  // are layered on top so they take precedence over a bland diacritic
  // mapping — e.g. "Bogforingsloven" maps to canonical Bogføringsloven
  // *and* registers a diacritic-typo error.
  const rejected = {};
  for (const [name, def] of Object.entries(raw.rejectedStatutes || {})) {
    rejected[name.toLowerCase()] = {
      name,
      reason: def.reason,
      replacement: def.replacement,
      kind: def.kind || "deprecated",
    };
  }

  // Citations that EXIST and are sometimes right, but whose historical uses in
  // this estate were overwhelmingly the drifted meaning. A string-matching lint
  // cannot tell an honest use from a drifted one, so these WARN with the
  // question to ask, rather than blocking correct law. Mirrors Core's
  // DanishLegalCitations.Wrong.MisusePronePatterns.
  const misuseProne = new Map(
    Object.entries(raw.misuseProne || {}).map(([k, v]) => [
      normaliseWhitespace(k).toLowerCase(),
      v,
    ]),
  );

  const knownHallucinations = new Set(
    (raw.knownHallucinations || []).map(normaliseWhitespace).map((s) =>
      s.toLowerCase()
    )
  );

  return {
    statutes,
    rejected,
    knownHallucinations,
    misuseProne,
    scanGlobs: raw.scanGlobs || { include: [], exclude: [] },
    historicalCommentMarker: raw.historicalCommentMarker || "// historical:",
  };
}

/** Parse "1-167" or array of strings into { kind, ... } range descriptor. */
function parseRange(spec) {
  if (Array.isArray(spec)) {
    return {
      kind: "set",
      members: new Set(spec.map((s) => String(s).toLowerCase())),
    };
  }
  if (typeof spec === "string" && /^\d+-\d+$/.test(spec)) {
    const [lo, hi] = spec.split("-").map(Number);
    return { kind: "range", lo, hi };
  }
  throw new Error(
    `validParagraphs must be an array or 'lo-hi' string, got: ${JSON.stringify(spec)}`
  );
}

function normaliseWhitespace(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/**
 * Validate a §-number against a statute's range descriptor.
 * Letter suffixes (a/b/c/A/B/C, e.g. §9b, §31A) are accepted as long as
 * the numeric part is in range — except when the full §+suffix appears
 * in explicitlyInvalid.
 */
function isParagraphInRange(rangeDescriptor, paragraph) {
  const lower = paragraph.toLowerCase();

  if (rangeDescriptor.kind === "set") {
    return rangeDescriptor.members.has(lower);
  }
  if (rangeDescriptor.kind === "range") {
    // Strip the letter suffix to check numeric range.
    const numeric = parseInt(paragraph.match(/^\d+/)?.[0] ?? "", 10);
    if (Number.isNaN(numeric)) return false;
    return numeric >= rangeDescriptor.lo && numeric <= rangeDescriptor.hi;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Citation regex
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a regex that matches `<StatuteName> §<N>` — case-insensitive on the
 * statute name, allowing optional whitespace, optional letter suffix,
 * optional `stk. N`. The statute alternation is built from the allowlist
 * so the regex matches ONLY known statute names (canonical + diacritic
 * variants + short-forms + rejected).
 *
 * Why a closed alternation rather than a generic word? Because a generic
 * `\w+\s*§\s*\d+` matches false positives like `kr. § 5` or random
 * comments. Restricting to known statute names eliminates noise and
 * focuses the lint on actual statutory citations.
 */
function buildCitationRegex(allowlist) {
  const names = new Set();
  for (const key of Object.keys(allowlist.statutes)) {
    const entry = allowlist.statutes[key];
    names.add(entry.canonicalName);
    if (entry.shortForm) names.add(entry.shortForm);
    if (entry.typoVariantUsed) names.add(entry.typoVariantUsed);
    if (entry.alternateFormUsed) names.add(entry.alternateFormUsed);
  }
  for (const key of Object.keys(allowlist.rejected)) {
    names.add(allowlist.rejected[key].name);
  }

  // Sort by length descending so "Lønsumsafgiftslovens" matches before
  // "Lønsumsafgiftsloven" (genitive form is longer).
  const sortedNames = [...names].sort((a, b) => b.length - a.length);

  const escaped = sortedNames.map(escapeRegex).join("|");

  // Capture groups:
  //   1: statute name (any of the alternation; case-insensitive)
  //   2: §-number including optional letter suffix (e.g. "9b", "31A", "10")
  //   3: optional stk. (e.g. " stk. 2") — NOT included in the citation key
  //
  // Unicode-aware leading boundary: JS's default `\b` treats Å/Æ/Ø as
  // non-word chars, so `\bÅRL` would not match `"ÅRL"` at position 0.
  // Use `(?<![\p{L}\p{N}])` + `u` flag to assert a non-letter/digit
  // precedes the statute name (or it's at the start of input).
  return new RegExp(
    `(?<![\\p{L}\\p{N}])(${escaped})\\s*§\\s*(\\d+[a-zA-Z]?)((?:\\s+stk\\.\\s+\\d+)?)`,
    "giu"
  );
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────
// File scanning
// ─────────────────────────────────────────────────────────────────────────

function* walkFiles(roots, exclude) {
  // Convert glob-ish exclude patterns into a substring matcher. This is
  // good enough for our purposes (no need for full glob semantics).
  const excludeFragments = exclude.map(globToFragment);
  for (const root of roots) {
    yield* walk(root, excludeFragments);
  }
}

function globToFragment(glob) {
  // Strip leading **/ and trailing /** for substring matching.
  return glob.replace(/^\*\*\//, "").replace(/\/\*\*$/, "").replace(/\*\*/g, "");
}

function* walk(dir, excludeFragments) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (excludeFragments.some((frag) => full.includes(frag))) continue;
    if (entry.isDirectory()) {
      yield* walk(full, excludeFragments);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function shouldScanFile(filePath, includeGlobs) {
  // Match file extensions and i18n message bundles.
  if (filePath.endsWith(".cs")) return true;
  if (filePath.endsWith(".tsx")) return true;
  if (filePath.endsWith(".ts")) return true;
  if (
    filePath.includes(`${path.sep}messages${path.sep}`) &&
    filePath.endsWith(".json")
  ) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Validate a single citation match.
 * @returns {null | { severity, message }} — null if valid, otherwise an
 *   error/warning object.
 */
function validateMatch(allowlist, statuteRaw, paragraph, stkSuffix) {
  const statuteKey = statuteRaw.toLowerCase();

  // 1. Hard-rejected statute (e.g. Persondataloven).
  const rejection = allowlist.rejected[statuteKey];
  if (rejection) {
    if (rejection.kind === "diacritic-typo") {
      // Treat as typo error; citation is rejected outright.
      return {
        severity: "error",
        message: `${statuteRaw} is a diacritic-typo for ${rejection.replacement}. ${rejection.reason}`,
      };
    }
    return {
      severity: "error",
      message: `${statuteRaw} is rejected: ${rejection.reason} Use ${rejection.replacement} instead.`,
    };
  }

  // 2. Known statute (canonical or diacritic variant or short-form).
  const statute = allowlist.statutes[statuteKey];
  if (!statute) {
    // Unknown statute name. Do not error here — the regex alternation only
    // matches known statutes anyway, so this branch is unreachable in
    // practice. Defensive return.
    return null;
  }

  const canonical = statute.canonicalName;
  const fullCitation = normaliseWhitespace(`${canonical} §${paragraph}${stkSuffix || ""}`);
  const fullCitationKey = fullCitation.toLowerCase();

  // 3. Known hallucination — even if §-number is in range, this exact
  //    "Statute §N" is forbidden. Hallucinations take precedence over
  //    range-checks (e.g. Forældelsesloven §210 is a real §-number, but it
  //    lives in Selskabsloven, not there).
  //
  //    This comment used to cite "Bogføringsloven §11 … is Ophævet" as the
  //    worked example. It is not: §11 of LOV nr 700 af 24/05/2022 is
  //    afstemninger. It has moved to misuseProne below — see that entry.
  const hallucinationKey = `${canonical} §${paragraph}`.toLowerCase();
  if (allowlist.knownHallucinations.has(hallucinationKey)) {
    return {
      severity: "error",
      message: `${canonical} §${paragraph} is a known hallucination — invented citation never valid.`,
    };
  }

  // 3b. Misuse-prone: real provision, historically drifted meaning. WARNS.
  const misuseReason = allowlist.misuseProne.get(hallucinationKey);
  if (misuseReason) {
    return {
      severity: "warning",
      message: `${canonical} §${paragraph}: ${misuseReason}`,
    };
  }

  // 4. Explicitly-invalid §-number for this statute.
  const explicitlyInvalid = statute.explicitlyInvalid;
  const paragraphLower = paragraph.toLowerCase();
  for (const [bannedPara, reason] of Object.entries(explicitlyInvalid)) {
    if (bannedPara.toLowerCase() === paragraphLower) {
      return {
        severity: "error",
        message: `${canonical} §${paragraph} is explicitly invalid: ${reason}`,
      };
    }
  }

  // 5. Diacritic-typo statute (e.g. "Bogforingsloven" mapped to canonical).
  if (statute.isDiacriticTypo) {
    return {
      severity: "error",
      message: `'${statuteRaw}' is missing diacritic — use canonical '${canonical}' (with ø/å/æ).`,
    };
  }

  // 6. §-number out of valid range.
  if (!isParagraphInRange(statute.validRange, paragraph)) {
    return {
      severity: "error",
      message: `${canonical} §${paragraph} is outside valid §-range. ${describeRange(statute.validRange)}`,
    };
  }

  return null;
}

function describeRange(rangeDescriptor) {
  if (rangeDescriptor.kind === "set") {
    return `Valid §s: ${[...rangeDescriptor.members].sort().join(", ")}.`;
  }
  if (rangeDescriptor.kind === "range") {
    return `Valid §-range: §${rangeDescriptor.lo}-§${rangeDescriptor.hi}.`;
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────────
// Historical-comment carve-out
// ─────────────────────────────────────────────────────────────────────────

function isHistoricalContext(line, marker) {
  return line.includes(marker);
}

// ─────────────────────────────────────────────────────────────────────────
// Main scan loop
// ─────────────────────────────────────────────────────────────────────────

function scanFile(filePath, regex, allowlist) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return [];
  }

  const findings = [];
  const lines = content.split(/\r?\n/);
  // Reset regex global state across files.
  regex.lastIndex = 0;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (isHistoricalContext(line, allowlist.historicalCommentMarker)) {
      continue;
    }
    let match;
    const lineRegex = new RegExp(regex.source, regex.flags);
    while ((match = lineRegex.exec(line)) !== null) {
      const [whole, statuteRaw, paragraph, stkSuffix] = match;
      const result = validateMatch(allowlist, statuteRaw, paragraph, stkSuffix);
      if (result) {
        findings.push({
          file: filePath,
          line: lineNum + 1,
          col: match.index + 1,
          match: whole,
          severity: result.severity,
          message: result.message,
        });
      }
      // Avoid zero-width infinite loop.
      if (match.index === lineRegex.lastIndex) lineRegex.lastIndex++;
    }
  }

  return findings;
}

function findScanRoots(args) {
  if (args.length > 0) {
    return args.map((a) => path.resolve(a));
  }
  // Walk up from the script dir to find the platform root (contains
  // Sitenyx.sln or a .git that's the platform repo).
  let dir = path.resolve(__dirname, "..", "..");
  for (let i = 0; i < 5; i++) {
    if (
      fs.existsSync(path.join(dir, "Sitenyx.sln")) ||
      fs.existsSync(path.join(dir, "CLAUDE.md")) ||
      fs.existsSync(path.join(dir, ".git"))
    ) {
      return [dir];
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [process.cwd()];
}

function main(argv) {
  const args = argv.slice(2);
  const allowlist = loadAllowlist();
  const regex = buildCitationRegex(allowlist);
  const roots = findScanRoots(args);

  const allFindings = [];
  let filesScanned = 0;

  for (const filePath of walkFiles(roots, allowlist.scanGlobs.exclude)) {
    if (!shouldScanFile(filePath, allowlist.scanGlobs.include)) continue;
    filesScanned++;
    const findings = scanFile(filePath, regex, allowlist);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    process.stdout.write(
      `lint-statutory-citations: ${filesScanned} files scanned, no invalid citations found.\n`
    );
    return 0;
  }

  // Group by severity for the summary line.
  const errors = allFindings.filter((f) => f.severity === "error");
  const warnings = allFindings.filter((f) => f.severity === "warning");

  // Grep-compatible report so editors can jump to the offending line.
  for (const f of allFindings) {
    process.stdout.write(
      `${f.file}:${f.line}:${f.col}: ${f.severity}: ${f.message} [match: '${f.match}']\n`
    );
  }
  process.stdout.write(
    `\nlint-statutory-citations: ${errors.length} error(s), ${warnings.length} warning(s) across ${filesScanned} files.\n`
  );

  return errors.length > 0 ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Module exports (for tests) + CLI entry
// ─────────────────────────────────────────────────────────────────────────

module.exports = {
  loadAllowlist,
  parseRange,
  buildCitationRegex,
  validateMatch,
  scanFile,
  isParagraphInRange,
  normaliseWhitespace,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv));
}
