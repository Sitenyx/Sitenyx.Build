#!/usr/bin/env node
/**
 * Tests for lint-orphan-events.js — SX0007 (Sitenyx orphan-event marker
 * validation, shipped 2026-06-02).
 *
 * Pure-function unit tests + integration tests over on-disk fixtures.
 *
 *   node Sitenyx.Build/scripts/lint-orphan-events.test.js
 *
 * Exit code 0 → all pass, 1 → at least one fail.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const lint = require("./lint-orphan-events.js");

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
// Fixture helpers — build a tiny on-disk platform tree we can lint against.
// ─────────────────────────────────────────────────────────────────────────

function makeFixturePlatform(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-orphan-"));
  // Mark this dir as a platform root so findPlatformRoot would resolve to
  // it (the lint also accepts an explicit --platform-root, which the unit
  // tests below use directly; this marker is belt-and-suspenders).
  fs.writeFileSync(path.join(root, "Sitenyx.sln"), "");
  for (const [relPath, body] of Object.entries(files)) {
    const fp = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, body);
  }
  return root;
}

// ─────────────────────────────────────────────────────────────────────────
// normalizeEventName — kept symmetric with lint-subscribe-matrix.js
// ─────────────────────────────────────────────────────────────────────────

test("normalizeEventName strips global:: prefix", () => {
  assert.equal(
    lint.normalizeEventName(
      "global::Shared.Contracts.Events.MomsGate.MomsRefundIssuedIntegrationEvent",
    ),
    "MomsRefundIssuedIntegrationEvent",
  );
});

test("normalizeEventName leaves bare names unchanged", () => {
  assert.equal(
    lint.normalizeEventName("DomainDeletedEvent"),
    "DomainDeletedEvent",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Test 1 — happy path: marker present → silent.
// ─────────────────────────────────────────────────────────────────────────

test("lintOrphans: SX-ORPHAN-OK marker suppresses violation (no consumer needed)", () => {
  const root = makeFixturePlatform({
    "Core/Shared.Contracts/Events/FooIntegrationEvent.cs": `
namespace Shared.Contracts.Events;

// SX-ORPHAN-OK: fan-and-forget (intentional — no current consumer)
public record FooIntegrationEvent(Guid TenantId);
`,
    // A Gate skeleton so findConsumedEvents has somewhere to walk.
    "BarGate/src/Application/Placeholder.cs": "// no consumers here\n",
  });

  const { violations } = lint.lintOrphans(root);
  assert.equal(
    violations.length,
    0,
    `expected 0 violations but got ${violations.length}: ` +
      JSON.stringify(violations, null, 2),
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Test 2 — happy path: consumer present → silent (marker NOT required).
// ─────────────────────────────────────────────────────────────────────────

test("lintOrphans: handler present suppresses violation (marker not required)", () => {
  const root = makeFixturePlatform({
    "Core/Shared.Contracts/Events/BarIntegrationEvent.cs": `
namespace Shared.Contracts.Events;

public record BarIntegrationEvent(Guid TenantId);
`,
    "BazGate/src/Application/Messaging/BarHandler.cs": `
using Rebus.Handlers;
using Shared.Contracts.Events;

public sealed class BarHandler : IHandleMessages<BarIntegrationEvent>
{
    public Task Handle(BarIntegrationEvent message) => Task.CompletedTask;
}
`,
  });

  const { violations } = lint.lintOrphans(root);
  assert.equal(
    violations.length,
    0,
    `expected 0 violations but got ${violations.length}: ` +
      JSON.stringify(violations, null, 2),
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Test 3 — regression: no marker AND no consumer → violation raised.
// ─────────────────────────────────────────────────────────────────────────

test("lintOrphans: unmarked + unconsumed event raises violation", () => {
  const root = makeFixturePlatform({
    "Core/Shared.Contracts/Events/QuxIntegrationEvent.cs": `
namespace Shared.Contracts.Events;

public record QuxIntegrationEvent(Guid TenantId);
`,
    "BarGate/src/Application/Placeholder.cs": "// no consumers here\n",
  });

  const { violations } = lint.lintOrphans(root);
  assert.equal(violations.length, 1, "expected exactly 1 violation");
  assert.equal(violations[0].eventName, "QuxIntegrationEvent");
  assert.match(
    violations[0].file,
    /Core\/Shared\.Contracts\/Events\/QuxIntegrationEvent\.cs$/,
    "violation should cite the declaring file (relative path)",
  );
  assert.ok(
    violations[0].line >= 1 && violations[0].col >= 1,
    "violation should carry a 1-based line/col",
  );
  assert.match(
    violations[0].message,
    /SX-ORPHAN-OK/,
    "message should reference the marker name to guide the fix",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Test 4 — sub-folder events (e.g. Events/MomsGate/) are scanned, the
// SX-ORPHAN-OK marker can sit on a line BELOW the namespace declaration,
// and the consumer-discovery skips the Core HandleMessages.cs base class
// (its `TMessage` generic param must not register as a fake consumer).
// ─────────────────────────────────────────────────────────────────────────

test("lintOrphans: scans sub-folders + tolerates body-placed markers + skips base classes", () => {
  const root = makeFixturePlatform({
    // Sub-folder declaration with the marker placed in the body (not the
    // file head) — matches the orphan-audit convention seen on several
    // 2026-05-25 marked events.
    "Core/Shared.Contracts/Events/MomsGate/MomsRefundIssuedIntegrationEvent.cs": `
namespace Shared.Contracts.Events.MomsGate;

/// <summary>
/// Published when a SKAT moms refund is issued to a tenant.
/// </summary>
// SX-ORPHAN-OK: future / cross-cutting signal — VAT recovery wiring planned for Q3 2026
public record MomsRefundIssuedIntegrationEvent(Guid TenantId, decimal Amount);
`,
    // A second sub-folder event WITHOUT the marker AND without a consumer
    // — this must fire.
    "Core/Shared.Contracts/Events/CashGate/CashGateUnmarkedEvent.cs": `
namespace Shared.Contracts.Events.CashGate;

public record CashGateUnmarkedEvent(Guid TenantId);
`,
    // A fake Core HandleMessages.cs base class — its `TMessage` generic
    // param would register as a phantom consumer if the skip logic broke.
    // (Path keeps the file's basename "HandleMessages.cs" — the lint matches
    // the basename, not the full path.)
    "DummyGate/src/Common/HandleMessages.cs": `
public abstract class HandleMessages<TMessage> : IHandleMessages<TMessage>
{
    public abstract Task Handle(TMessage message);
}
`,
  });

  const { violations, totalDeclarations } = lint.lintOrphans(root);

  // Should detect exactly 2 event declarations.
  assert.equal(
    totalDeclarations,
    2,
    `expected 2 declarations scanned but got ${totalDeclarations}`,
  );

  // Should flag exactly the unmarked one.
  assert.equal(violations.length, 1, "expected exactly 1 violation");
  assert.equal(violations[0].eventName, "CashGateUnmarkedEvent");

  // The marked event MUST NOT appear in the violations.
  const markedFlagged = violations.some(
    (v) => v.eventName === "MomsRefundIssuedIntegrationEvent",
  );
  assert.ok(
    !markedFlagged,
    "marked event must not be flagged even when consumer is absent",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────

if (failed > 0) {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(1);
} else {
  process.stdout.write(`\n${passed} passed, 0 failed\n`);
  process.exit(0);
}
