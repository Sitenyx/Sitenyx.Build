#!/usr/bin/env node
/**
 * lint-statutory-citations.test.js
 *
 * CG-013 (2026-05-03) — Tests for lint-statutory-citations.js.
 *
 * Vanilla Node tap-style tests so the lint can run inside any CI matrix
 * without pulling Jest/Vitest into Core. Run via:
 *
 *   node scripts/lint-statutory-citations.test.js
 *
 * Exit code is 0 if all assertions pass, 1 if any fail.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const lint = require("./lint-statutory-citations.js");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    process.stdout.write(`  ok ${message}\n`);
  } else {
    failed++;
    failures.push(message);
    process.stdout.write(`  FAIL ${message}\n`);
  }
}

function test(name, fn) {
  process.stdout.write(`# ${name}\n`);
  try {
    fn();
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    process.stdout.write(`  FAIL ${name}: ${e.message}\n${e.stack}\n`);
  }
}

// Set up a fresh tmp dir per run so each fixture is isolated.
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cg013-lint-"));
}

function writeFixture(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

const allowlist = lint.loadAllowlist();
const regex = lint.buildCitationRegex(allowlist);

// ─────────────────────────────────────────────────────────────────────────
// Spec case 1 — Real §-reference passes
// ─────────────────────────────────────────────────────────────────────────

test("spec-1: real §-reference passes", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Foo.cs",
    `// Test file
public class Foo {
    // Bogføringsloven §10 — 5-yr retention.
    public const string Citation = "Bogføringsloven §10";
}
`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(
    findings.length === 0,
    `Bogføringsloven §10 should pass, got: ${JSON.stringify(findings)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Spec case 2 — Invented §-reference fails
// ─────────────────────────────────────────────────────────────────────────

test("spec-2: invented §-reference fails (Forældelsesloven §210)", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Bar.cs",
    `public class Bar {
    public const string Wrong = "Forældelsesloven §210";
}
`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(findings.length === 1, `expected 1 error, got ${findings.length}`);
  assert(findings[0]?.severity === "error", "severity should be error");
  assert(
    /hallucination|outside valid|explicitly invalid/i.test(findings[0]?.message ?? ""),
    `message should describe the failure mode: '${findings[0]?.message}'`
  );
});

test("spec-2b: invented §-reference fails (Bogføringsloven §99 — out of range)", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Bar.cs",
    `public class Bar {
    public const string Wrong = "Bogføringsloven §99";
}
`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(findings.length === 1, `expected 1 error, got ${findings.length}`);
  assert(findings[0]?.severity === "error", "severity should be error");
});

// ─────────────────────────────────────────────────────────────────────────
// Spec case 3 — Statute typo fails (Bogforingsloven missing diacritic)
// ─────────────────────────────────────────────────────────────────────────

test("spec-3: statute typo fails (Bogforingsloven missing diacritic)", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Baz.cs",
    `public class Baz {
    public const string Typo = "Bogforingsloven §10";
}
`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(findings.length === 1, `expected 1 error, got ${findings.length}`);
  assert(
    /diacritic|missing/i.test(findings[0]?.message ?? ""),
    `message should mention diacritic: '${findings[0]?.message}'`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Spec case 4 — Range reference (§§ 1-5) handled
// ─────────────────────────────────────────────────────────────────────────

test("spec-4: range reference §§ 1-5 individual §s validated", () => {
  // The lint inspects each §-reference individually. A range like
  // "§§ 1-5" should produce no findings if both endpoints are valid;
  // each numeric §-reference inside is checked separately when it appears
  // as a standalone §<N>. The lint's regex matches `Statute §<N>`, so
  // a doubled-§§ pattern with a hyphenated range "§§ 1-5" only the first
  // §1 matches (which is valid). Test both forms.
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Range.cs",
    `// Bogføringsloven §§ 1-5 (range — first § is captured).
public const string A = "Renteloven §3";
public const string B = "Renteloven §5";
`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(
    findings.length === 0,
    `range references with valid §s should pass, got: ${JSON.stringify(findings)}`
  );
});

test("spec-4b: range reference with invalid endpoint fails on the bad §", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Range.cs",
    `// Two refs, one valid one invalid.
public const string A = "Renteloven §3";
public const string B = "Renteloven §99";
`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(
    findings.length === 1,
    `expected 1 error (the §99), got ${findings.length}: ${JSON.stringify(findings)}`
  );
  assert(
    findings[0]?.match.includes("§99"),
    `error should be on §99: '${findings[0]?.match}'`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Spec case 5 — Allowlist update propagates
// ─────────────────────────────────────────────────────────────────────────

test("spec-5: allowlist update propagates (mutating range invalidates citation)", () => {
  // Build a custom allowlist that shrinks Bogføringsloven to §§ 1-5 and
  // verify §10 now fails. Mirrors the real-world flow of a developer
  // narrowing the range to catch a regression.
  const tmpAllowlist = makeTmpDir();
  const allowlistPath = path.join(tmpAllowlist, "allowlist.json");
  fs.writeFileSync(
    allowlistPath,
    JSON.stringify({
      statutes: {
        Bogføringsloven: {
          fullName: "test",
          validParagraphs: "1-5",
          diacriticVariants: ["Bogforingsloven"],
        },
      },
      rejectedStatutes: {},
      knownHallucinations: [],
      scanGlobs: { include: [], exclude: [] },
    }),
    "utf8"
  );
  const customAllowlist = lint.loadAllowlist(allowlistPath);
  const customRegex = lint.buildCitationRegex(customAllowlist);

  const fixturesDir = makeTmpDir();
  const file = writeFixture(
    fixturesDir,
    "src/Test.cs",
    `public const string A = "Bogføringsloven §10";`
  );
  const findings = lint.scanFile(file, customRegex, customAllowlist);
  assert(
    findings.length === 1 && findings[0].severity === "error",
    `with shrunk range §1-5, citing §10 should fail; got: ${JSON.stringify(findings)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Bonus tests — extension coverage for known hazards
// ─────────────────────────────────────────────────────────────────────────

test("bonus: rejectedStatute Persondataloven hard-fails", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Persondata.cs",
    `public const string Wrong = "Persondataloven §1";`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(findings.length === 1, `expected 1 error, got ${findings.length}`);
  assert(
    /GDPR|Databeskyttelsesloven|rejected/i.test(findings[0]?.message ?? ""),
    `message should suggest GDPR replacement: '${findings[0]?.message}'`
  );
});

test("bonus: historical-context comment is skipped", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Hist.cs",
    `public const string A = "Bogføringsloven §11"; // historical: pre-2022 lov reference\n`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(
    findings.length === 0,
    `historical-context line should be skipped, got: ${JSON.stringify(findings)}`
  );
});

test("bonus: ÅRL short-form is recognised", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Aarl.cs",
    `public const string A = "ÅRL §46 stk. 1";\npublic const string B = "ÅRL §400";`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(
    findings.length === 1,
    `ÅRL §46 should pass, ÅRL §400 should fail; got ${findings.length} findings: ${JSON.stringify(findings)}`
  );
  assert(
    findings[0]?.match.includes("§400"),
    `error should be on §400, got '${findings[0]?.match}'`
  );
});

test("bonus: letter-suffix § (e.g. §9b, §31A) accepted in valid range", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "src/Letters.cs",
    `public const string A = "Renteloven §9b stk. 2";
public const string B = "Selskabsskatteloven §31A";
`
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(
    findings.length === 0,
    `letter-suffix §s should be accepted; got: ${JSON.stringify(findings)}`
  );
});

test("bonus: scan respects messages/{locale}/index.json bundles", () => {
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "messages/da/index.json",
    JSON.stringify({
      // §12 is the retention duty; §10 is the currency of registrations.
      ok: "Per Bogføringsloven §12 skal materiale opbevares 5 år.",
      bad: "Per Bogføringsloven §99 — invented.",
    })
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(
    findings.length === 1,
    `expected 1 finding (§99); got: ${JSON.stringify(findings)}`
  );
  assert(
    findings[0]?.match.includes("§99"),
    `error should be on §99: '${findings[0]?.match}'`
  );
});

test("misuse-prone citations WARN rather than block", () => {
  // §11 sat in knownHallucinations as a hard error on the false claim that it
  // is repealed, with the remedy "Use §4 + §10" — which is the repealed
  // pre-2022 numbering this lint exists to stop. §11 of LOV nr 700 af
  // 24/05/2022 is afstemninger, and ComplianceGate's bank-reconciliation gap
  // mapper cites it correctly, so a hard error blocked correct law.
  //
  // The risk it guarded is still real: every §11 written here before
  // 2026-08-27 meant the PRE-2022 §11, and a string match cannot tell those
  // apart. So it warns, and the message carries the question to ask.
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "Reconcile.cs",
    'var note = "Bogføringsloven §11 kræver de nødvendige afstemninger.";\n'
  );
  const findings = lint.scanFile(file, regex, allowlist);
  assert(
    findings.length === 1,
    `expected 1 finding for §11; got: ${JSON.stringify(findings)}`
  );
  assert(
    findings[0]?.severity === "warning",
    `§11 must WARN, not error — a hard error blocks a correct citation of ` +
      `afstemninger. got severity: '${findings[0]?.severity}'`
  );
  assert(
    /afstemninger/i.test(findings[0]?.message ?? ""),
    `the warning must say what §11 actually is, so the reader can decide; ` +
      `got: '${findings[0]?.message}'`
  );
});

test("a warning does not fail the run; an error does", () => {
  // The whole point of the tier: §11 alone must exit 0, so a correct citation
  // cannot break a build, while a real hallucination still must not ship.
  const tmp = makeTmpDir();
  writeFixture(tmp, "Warn.cs", 'var a = "Bogføringsloven §11 afstemninger";\n');
  const warnOnly = lint.scanFile(
    path.join(tmp, "Warn.cs"),
    regex,
    allowlist
  );
  assert(
    warnOnly.every((f) => f.severity === "warning"),
    `§11 alone must produce no errors; got: ${JSON.stringify(warnOnly)}`
  );

  writeFixture(tmp, "Err.cs", 'var b = "Bogføringsloven §99 invented";\n');
  const errFindings = lint.scanFile(path.join(tmp, "Err.cs"), regex, allowlist);
  assert(
    errFindings.some((f) => f.severity === "error"),
    `a genuine hallucination must still ERROR; got: ${JSON.stringify(errFindings)}`
  );
});

test("a quoted retraction is exempt; a bare assertion and a live string are not", () => {
  // Use versus mention. A correction has to be able to quote the citation it
  // is removing, or the next reader loses the reason — but the exemption must
  // not become a way to smuggle a claim past the lint. Three shapes, one file:
  //   line 2  bare assertion in a comment      -> ERROR
  //   line 5  quoted retraction in a comment   -> exempt
  //   line 7  live string literal (has quotes) -> ERROR, quotes notwithstanding
  const tmp = makeTmpDir();
  const file = writeFixture(
    tmp,
    "Probe.cs",
    "// header\n" +
      "// Retained per Persondatalov §22.\n" +
      "public class Probe {\n" +
      "    /// This said \"Persondatalov §22\"; that act was repealed in 2018.\n" +
      "    public const string Bad = \"Retained per Persondatalov §22.\";\n" +
      "}\n"
  );
  const findings = lint.scanFile(file, regex, allowlist);
  const errorLines = findings.filter((f) => f.severity === "error").map((f) => f.line).sort();
  assert(
    errorLines.length === 2,
    `expected exactly 2 errors (bare comment + live string), got ${JSON.stringify(findings)}`
  );
  assert(
    errorLines.includes(2),
    `the bare comment assertion on line 2 must ERROR — a comment is not a licence to state a repealed act as current. got lines ${errorLines}`
  );
  assert(
    errorLines.includes(5),
    `the live string on line 5 must ERROR: quotes there are C# delimiters, not quotation marks, so the use/mention exemption must not reach it. got lines ${errorLines}`
  );
  assert(
    !errorLines.includes(4),
    `the quoted retraction on line 4 must be exempt, or corrections cannot name what they correct. got lines ${errorLines}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`\nFailures:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.exit(0);
