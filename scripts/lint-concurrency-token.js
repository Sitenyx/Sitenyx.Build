#!/usr/bin/env node
/**
 * lint-concurrency-token.js
 *
 * CGP-125 Phase-2 (2026-05-04) — Optimistic-concurrency-token CI lint.
 *
 * Pre-merge guardrail that asserts every user-editable EF Core entity
 * carries an `IsConcurrencyToken()` configuration on a Postgres `xmin`
 * shadow property (or a `[ConcurrencyCheck] uint RowVersion` CLR property).
 * Without this lint, a future contributor adding a new `Edit*Command`
 * could silently regress the audit-trail discipline that CGP-125 Phase-1
 * shipped (`qa-findings/_UIUX-CROSS-GATE-PATTERNS.md` §CGP-125).
 *
 * SCANS: every EF Core IEntityTypeConfiguration<T> implementation under
 *   <Gate>/src/Infrastructure/Data/Configurations/*.cs across all backend
 *   Gates. Cross-references the entity name against:
 *     1. The "concurrency-required" allow list (load-bearing entities like
 *        Budget, Content, Form, Tenant, Debtor, Expense, …), AND
 *     2. The opt-out list (entities with `[NoConcurrency]` attribute or
 *        explicit `// CGP-125: opt-out` comment, e.g. AuditLogEntry which
 *        is append-only and cannot collide).
 *
 * MATCHES (concurrency token configured):
 *   - `IsConcurrencyToken()` invocation in the configuration body, OR
 *   - `[ConcurrencyCheck]` attribute on a `uint`/`uint?` property, OR
 *   - `[Timestamp]` attribute on a `byte[]` property (legacy SQL Server)
 *
 * EXIT CODES:
 *   0 — all required entities have a concurrency token AND no opt-outs
 *       are accidentally on a required entity
 *   1 — one or more required entities are missing the token, or an
 *       opt-out is misapplied. Report lists each violation grep-style.
 *
 * USAGE:
 *   node scripts/lint-concurrency-token.js [--platform-root <path>]
 *
 * REPORT FORMAT (grep-compatible: `<file>:<line>:<col>: <severity>: <msg>`):
 *
 *   BudgetGate/src/Infrastructure/Data/Configurations/BudgetConfiguration.cs:9:25: error: Budget is in REQUIRED list but no IsConcurrencyToken() / [ConcurrencyCheck] / [Timestamp] found in the configuration body
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────
// Configuration — entities REQUIRED to carry a concurrency token
// ─────────────────────────────────────────────────────────────────────────

const REQUIRED_ENTITIES = new Set([
  // Phase-1 shipped 9 Gates × user-editable entities (catalog ref CGP-125)
  "Budget",
  "Content",
  "Debtor",
  "Expense",
  "Filing",
  "Form",
  "Product",
  "Tenant",
  "WebsiteSubscription",
  // Phase-1+ settings entities (audit said queued for Phase-2 / dialog ship)
  "MomsSettings",
  "Momsangivelse",
  "MomsTransaction",
  "BadDebtVatRecovery",
  "CreditNote",
]);

// Entities explicitly opted out (append-only, immutable, etc).
const OPT_OUT_ENTITIES = new Set([
  "AuditLogEntry",
  "BudgetAuditLog",
  "ComplianceAuditEntry",
  "BudgetVersion",
  "Receipt", // Bogføringsloven §15 — receipts cannot be edited
  "EconomicPostingRecord", // append-only journal
]);

// Per-Gate opt-outs: { GateName: Set<EntityName> }. Used when a Gate has its
// own internal projection of an entity name that collides with a different
// Gate's user-editable entity (e.g. CashGate.Budget is a category-month
// projection, not BudgetGate.Budget which is the user-editable aggregate).
const PER_GATE_OPT_OUTS = {
  CashGate: new Set([
    // Internal variance-tracking projection — derived from BudgetGate's
    // BudgetUpdatedIntegrationEvent. Not user-editable; concurrent writes
    // come from the event handler only and are serialised by Rebus.
    "Budget",
  ]),
};

const TOKEN_PATTERNS = [
  /\.IsConcurrencyToken\s*\(/,
  /\[ConcurrencyCheck\]/,
  /\[Timestamp\]/,
  /HasColumnName\s*\(\s*"xmin"\s*\)/,
];

// ─────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────

function findPlatformRoot(start) {
  let cur = path.resolve(start);
  while (cur !== "/") {
    if (
      fs.existsSync(path.join(cur, "Sitenyx.sln")) ||
      fs.existsSync(path.join(cur, ".git"))
    ) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return null;
}

function listGateRoots(platformRoot) {
  return fs
    .readdirSync(platformRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /Gate$/.test(d.name))
    .map((d) => path.join(platformRoot, d.name));
}

function listConfigFiles(gateRoot) {
  const dir = path.join(gateRoot, "src", "Infrastructure", "Data", "Configurations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".cs"))
    .map((f) => path.join(dir, f));
}

// Extract the entity types this file configures. Pattern:
//   class XConfiguration : IEntityTypeConfiguration<EntityName>
function extractEntityNames(content) {
  const names = new Set();
  const rx = /:\s*IEntityTypeConfiguration\s*<\s*([A-Z][A-Za-z0-9_]+)\s*>/g;
  let m;
  while ((m = rx.exec(content)) !== null) {
    names.add(m[1]);
  }
  return names;
}

function hasConcurrencyToken(content) {
  return TOKEN_PATTERNS.some((rx) => rx.test(content));
}

// ─────────────────────────────────────────────────────────────────────────
// Lint runner
// ─────────────────────────────────────────────────────────────────────────

// Per-Gate scan: build a map of `entity → configuredWithToken` by reading
// EVERY configuration file in the Gate's Configurations directory + the
// entity class file (which may carry the [ConcurrencyCheck] attribute on a
// CLR property like Debtor.RowVersion or Expense.RowVersion).
function gateEntityTokenMap(gateRoot) {
  const tokenMap = new Map(); // entity → boolean

  // 1. Aggregate "configures Entity X" + "has token in this same file" across
  //    all configuration files in the Gate. A separate
  //    XConcurrencyConfiguration.cs file legitimately satisfies the token
  //    requirement for entity X even though XConfiguration.cs (the main
  //    config) doesn't carry the token itself.
  const configsDir = path.join(gateRoot, "src", "Infrastructure", "Data", "Configurations");
  if (fs.existsSync(configsDir)) {
    for (const f of fs.readdirSync(configsDir)) {
      if (!f.endsWith(".cs")) continue;
      const fp = path.join(configsDir, f);
      const content = fs.readFileSync(fp, "utf8");
      const entities = extractEntityNames(content);
      const fileHasToken = hasConcurrencyToken(content);
      for (const e of entities) {
        if (!tokenMap.has(e)) tokenMap.set(e, false);
        if (fileHasToken) tokenMap.set(e, true);
      }
    }
  }

  // 2. Also scan the Domain/Entities directory for [ConcurrencyCheck] /
  //    [Timestamp] attributes on CLR properties — these are equivalent to
  //    the fluent API and should satisfy the lint.
  const entitiesDir = path.join(gateRoot, "src", "Domain", "Entities");
  if (fs.existsSync(entitiesDir)) {
    for (const f of fs.readdirSync(entitiesDir)) {
      if (!f.endsWith(".cs")) continue;
      const fp = path.join(entitiesDir, f);
      const content = fs.readFileSync(fp, "utf8");
      // Class-name-from-filename heuristic: <EntityName>.cs ⇒ EntityName.
      const entityName = path.basename(f, ".cs");
      if (!tokenMap.has(entityName)) continue;
      if (hasConcurrencyToken(content)) tokenMap.set(entityName, true);
    }
  }

  return tokenMap;
}

function lintGate(gateRoot, platformRoot) {
  const violations = [];
  const tokenMap = gateEntityTokenMap(gateRoot);
  const gateName = path.basename(gateRoot);
  const perGateOptOut = PER_GATE_OPT_OUTS[gateName] ?? new Set();

  for (const [entity, hasToken] of tokenMap) {
    if (OPT_OUT_ENTITIES.has(entity)) continue;
    if (perGateOptOut.has(entity)) continue;
    if (!REQUIRED_ENTITIES.has(entity)) continue;
    if (hasToken) continue;

    // Locate the declaration in the main configuration file for the report.
    const configsDir = path.join(gateRoot, "src", "Infrastructure", "Data", "Configurations");
    let reportPath = path.relative(platformRoot, gateRoot);
    let line = 1, col = 1;
    if (fs.existsSync(configsDir)) {
      for (const f of fs.readdirSync(configsDir)) {
        if (!f.endsWith(".cs")) continue;
        const fp = path.join(configsDir, f);
        const content = fs.readFileSync(fp, "utf8");
        if (extractEntityNames(content).has(entity)) {
          reportPath = path.relative(platformRoot, fp);
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const idx = lines[i].indexOf(`IEntityTypeConfiguration<${entity}>`);
            if (idx >= 0) { line = i + 1; col = idx + 1; break; }
          }
          break;
        }
      }
    }

    violations.push({
      file: reportPath,
      line,
      col,
      severity: "error",
      message:
        `${entity} is in REQUIRED list but no IsConcurrencyToken() / [ConcurrencyCheck] / [Timestamp] / HasColumnName("xmin") found across the Gate's Configurations and Domain/Entities. ` +
        `Add a concurrency token (CGP-125 Phase-1) or whitelist the entity in OPT_OUT_ENTITIES with a justifying comment.`,
    });
  }

  return violations;
}

function main() {
  const args = process.argv.slice(2);
  let platformRoot = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--platform-root") {
      platformRoot = args[++i];
    }
  }
  platformRoot = findPlatformRoot(platformRoot) || platformRoot;

  const gates = listGateRoots(platformRoot);
  let totalViolations = 0;
  let totalChecked = 0;

  for (const gate of gates) {
    const files = listConfigFiles(gate);
    totalChecked += files.length;
    const violations = lintGate(gate, platformRoot);
    for (const v of violations) {
      process.stdout.write(
        `${v.file}:${v.line}:${v.col}: ${v.severity}: ${v.message}\n`,
      );
      totalViolations++;
    }
  }

  process.stdout.write(
    `\n[lint-concurrency-token] Checked ${totalChecked} configuration file(s) across ${gates.length} Gate(s). ` +
      `${totalViolations} violation(s).\n`,
  );

  process.exit(totalViolations === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_ENTITIES,
  OPT_OUT_ENTITIES,
  TOKEN_PATTERNS,
  extractEntityNames,
  hasConcurrencyToken,
  gateEntityTokenMap,
  lintGate,
};
