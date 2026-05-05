#!/usr/bin/env node
/**
 * Tests for lint-concurrency-token.js — CGP-125 Phase-2 (2026-05-04).
 *
 * Pure-function unit tests for the lint utilities. Run with:
 *   node scripts/lint-concurrency-token.test.js
 *
 * Exit code 0 → all pass, 1 → at least one fail.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const lint = require("./lint-concurrency-token.js");

let passed = 0;
let failed = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`✗ ${name}\n  ${err.message}\n`);
    failed++;
    fails.push({ name, err });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// extractEntityNames
// ─────────────────────────────────────────────────────────────────────────

test("extractEntityNames parses single IEntityTypeConfiguration<T>", () => {
  const src = `
    public class BudgetConfiguration : IEntityTypeConfiguration<Budget> {
      public void Configure(EntityTypeBuilder<Budget> builder) { }
    }
  `;
  const names = lint.extractEntityNames(src);
  assert.deepEqual([...names], ["Budget"]);
});

test("extractEntityNames parses multiple sibling configurations in one file", () => {
  const src = `
    public class A : IEntityTypeConfiguration<MomsAngivelse> { }
    public class B : IEntityTypeConfiguration<MomsTransaction> { }
    public class C : IEntityTypeConfiguration<Filing> { }
  `;
  const names = [...lint.extractEntityNames(src)];
  assert.ok(names.includes("MomsAngivelse"));
  assert.ok(names.includes("MomsTransaction"));
  assert.ok(names.includes("Filing"));
});

test("extractEntityNames handles whitespace variations", () => {
  const src = `:    IEntityTypeConfiguration  <  Form  >`;
  const names = lint.extractEntityNames(src);
  assert.deepEqual([...names], ["Form"]);
});

test("extractEntityNames returns empty for non-EF classes", () => {
  const src = `public class Foo : IDisposable { }`;
  const names = lint.extractEntityNames(src);
  assert.equal(names.size, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// hasConcurrencyToken
// ─────────────────────────────────────────────────────────────────────────

test("hasConcurrencyToken matches IsConcurrencyToken() invocation", () => {
  assert.equal(lint.hasConcurrencyToken("builder.Property(x => x.Rv).IsConcurrencyToken();"), true);
});

test("hasConcurrencyToken matches [ConcurrencyCheck] attribute", () => {
  assert.equal(lint.hasConcurrencyToken("[ConcurrencyCheck] public uint Xmin { get; set; }"), true);
});

test("hasConcurrencyToken matches [Timestamp] attribute (legacy SQL Server)", () => {
  assert.equal(lint.hasConcurrencyToken("[Timestamp] public byte[] RowVersion { get; set; }"), true);
});

test("hasConcurrencyToken matches HasColumnName(\"xmin\")", () => {
  assert.equal(lint.hasConcurrencyToken('builder.Property<uint>("xmin").HasColumnName("xmin")'), true);
});

test("hasConcurrencyToken returns false for unrelated config", () => {
  assert.equal(lint.hasConcurrencyToken("builder.Property(x => x.Name).IsRequired();"), false);
});

// ─────────────────────────────────────────────────────────────────────────
// lintGate (integration with on-disk fixtures)
// ─────────────────────────────────────────────────────────────────────────

function makeFixtureGate(name, configFiles, entityFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lintgate-"));
  const gateRoot = path.join(root, name);
  const configsDir = path.join(gateRoot, "src", "Infrastructure", "Data", "Configurations");
  fs.mkdirSync(configsDir, { recursive: true });

  for (const [filename, body] of Object.entries(configFiles)) {
    fs.writeFileSync(path.join(configsDir, filename), body);
  }

  if (Object.keys(entityFiles).length > 0) {
    const entitiesDir = path.join(gateRoot, "src", "Domain", "Entities");
    fs.mkdirSync(entitiesDir, { recursive: true });
    for (const [filename, body] of Object.entries(entityFiles)) {
      fs.writeFileSync(path.join(entitiesDir, filename), body);
    }
  }

  return { root, gateRoot };
}

test("lintGate returns no violations when all required entities have tokens", () => {
  const { root, gateRoot } = makeFixtureGate("BudgetGate", {
    "BudgetConfiguration.cs": `
      public class BudgetConfiguration : IEntityTypeConfiguration<Budget> {
        public void Configure(EntityTypeBuilder<Budget> b) {
          b.Property(x => x.RowVersion).IsConcurrencyToken();
        }
      }
    `,
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0);
});

test("lintGate flags missing token on REQUIRED entity", () => {
  const { root, gateRoot } = makeFixtureGate("BudgetGate", {
    "BudgetConfiguration.cs": `
      public class BudgetConfiguration : IEntityTypeConfiguration<Budget> {
        public void Configure(EntityTypeBuilder<Budget> b) {
          b.Property(x => x.Name).IsRequired();
        }
      }
    `,
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /Budget is in REQUIRED list/);
});

test("lintGate accepts a [ConcurrencyCheck] attribute on the entity class", () => {
  const { root, gateRoot } = makeFixtureGate(
    "BudgetGate",
    {
      "BudgetConfiguration.cs": `
        public class BudgetConfiguration : IEntityTypeConfiguration<Budget> {
          public void Configure(EntityTypeBuilder<Budget> b) {
            b.ToTable("Budgets");
          }
        }
      `,
    },
    {
      "Budget.cs": `
        public class Budget {
          [ConcurrencyCheck] public uint RowVersion { get; set; }
        }
      `,
    }
  );
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0);
});

test("lintGate accepts split configurations (e.g. ConcurrencyConfiguration.cs sibling file)", () => {
  const { root, gateRoot } = makeFixtureGate("MomsGate", {
    "FilingConfiguration.cs": `
      public class FilingConfiguration : IEntityTypeConfiguration<Filing> {
        public void Configure(EntityTypeBuilder<Filing> b) { b.ToTable("Filings"); }
      }
    `,
    "ConcurrencyConfiguration.cs": `
      public class FilingConcurrencyConfiguration : IEntityTypeConfiguration<Filing> {
        public void Configure(EntityTypeBuilder<Filing> b) {
          b.Property(x => x.RowVersion).IsConcurrencyToken();
        }
      }
    `,
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0, "split configs across two files should still satisfy the lint");
});

test("lintGate ignores non-required entities", () => {
  const { root, gateRoot } = makeFixtureGate("BudgetGate", {
    "DriverConfiguration.cs": `
      public class DriverConfiguration : IEntityTypeConfiguration<BudgetDriver> {
        public void Configure(EntityTypeBuilder<BudgetDriver> b) { }
      }
    `,
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0, "BudgetDriver is not in REQUIRED_ENTITIES");
});

test("lintGate respects OPT_OUT_ENTITIES (BudgetVersion is opt-out)", () => {
  const { root, gateRoot } = makeFixtureGate("BudgetGate", {
    "VersionConfiguration.cs": `
      public class VersionConfiguration : IEntityTypeConfiguration<BudgetVersion> {
        public void Configure(EntityTypeBuilder<BudgetVersion> b) { }
      }
    `,
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0, "BudgetVersion is in OPT_OUT_ENTITIES (immutable snapshot)");
});

test("REQUIRED_ENTITIES set contains all 9 Phase-1 entities", () => {
  const phase1 = ["Budget", "Content", "Debtor", "Expense", "Form", "Tenant", "WebsiteSubscription", "Product", "Filing"];
  for (const e of phase1) {
    assert.ok(lint.REQUIRED_ENTITIES.has(e), `REQUIRED_ENTITIES must include ${e} (Phase-1)`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
