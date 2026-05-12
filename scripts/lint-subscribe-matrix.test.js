#!/usr/bin/env node
/**
 * Tests for lint-subscribe-matrix.js — SX0005 (DEV-012 V3 USER APPROVED
 * 2026-05-12, Core subscribe-matrix linter ship).
 *
 * Pure-function unit tests + integration tests over on-disk fixtures.
 *
 *   node scripts/lint-subscribe-matrix.test.js
 *
 * Exit code 0 → all pass, 1 → at least one fail.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const lint = require("./lint-subscribe-matrix.js");

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
// normalizeEventName
// ─────────────────────────────────────────────────────────────────────────

test("normalizeEventName strips global:: prefix", () => {
  assert.equal(
    lint.normalizeEventName("global::Shared.Contracts.Events.PaymentGate.PaywallUpgradeRequestedIntegrationEvent"),
    "PaywallUpgradeRequestedIntegrationEvent",
  );
});

test("normalizeEventName strips namespace dot prefix", () => {
  assert.equal(
    lint.normalizeEventName("Shared.Contracts.Events.AuditEntryWrittenIntegrationEvent"),
    "AuditEntryWrittenIntegrationEvent",
  );
});

test("normalizeEventName leaves bare type names unchanged", () => {
  assert.equal(lint.normalizeEventName("AuditEntryWrittenIntegrationEvent"), "AuditEntryWrittenIntegrationEvent");
});

test("normalizeEventName strips trailing whitespace + commas (defensive)", () => {
  assert.equal(lint.normalizeEventName("Foo, IDbContext"), "Foo");
});

test("normalizeEventName strips trailing generic args (defensive)", () => {
  assert.equal(lint.normalizeEventName("Generic<TArg>"), "Generic");
});

// ─────────────────────────────────────────────────────────────────────────
// On-disk fixtures — full handler/subscribe matrix
// ─────────────────────────────────────────────────────────────────────────

function makeFixtureGate(name, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-subscribe-"));
  const gateRoot = path.join(root, name);
  fs.mkdirSync(gateRoot, { recursive: true });
  for (const [relPath, body] of Object.entries(files)) {
    const fp = path.join(gateRoot, relPath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, body);
  }
  return { root, gateRoot };
}

const DI_TEMPLATE = (subscribes) => `
namespace Microsoft.Extensions.DependencyInjection {
  public static class DependencyInjection {
    public static IServiceCollection AddAll(this IServiceCollection s) {
      s.AddRebusAndRabbitMq(onCreated: async bus => {
${subscribes.map((e) => `        await bus.Subscribe<${e}>();`).join("\n")}
      });
      return s;
    }
  }
}
`;

const HANDLER_TEMPLATE = (className, eventName, baseClass = "IHandleMessages") => {
  // Note: `HandleMessages<TEvent, TDbContext>` is the Core 2-arg base class.
  // `BaseHandleMessages<TEvent>` is each service's 1-arg convenience wrapper.
  // `IHandleMessages<TEvent>` is the raw Rebus interface.
  let inherits;
  if (baseClass === "HandleMessages") {
    inherits = `${baseClass}<${eventName}, IApplicationDbContext>(lazyContext)`;
  } else if (baseClass === "BaseHandleMessages") {
    inherits = `${baseClass}<${eventName}>(lazyContext)`;
  } else {
    inherits = `${baseClass}<${eventName}>`;
  }
  return `
using Rebus.Handlers;
using Shared.Contracts.Events.X;

namespace Application.Messaging.Handlers;

public class ${className}(
    Lazy<IApplicationDbContext> lazyContext
) : ${inherits}
{
    public async Task Handle(${eventName} message) {
        await Task.CompletedTask;
    }
}
`;
};

// ─────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: happy path — handler + matching Subscribe → no violations", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs": HANDLER_TEMPLATE("FooHandler", "FooEvent"),
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE(["FooEvent"]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// The regression class (DEV-012 V3 ComplianceGate `7c40dde`)
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: handler present, Subscribe MISSING → 1 violation (THE regression class)", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs": HANDLER_TEMPLATE("FooHandler", "AuditEntryWrittenIntegrationEvent"),
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 1, "exactly one violation expected");
  assert.match(violations[0].message, /AuditEntryWrittenIntegrationEvent/);
  assert.match(violations[0].message, /no `bus\.Subscribe</);
});

// ─────────────────────────────────────────────────────────────────────────
// BaseHandleMessages variant (service-local wrapper)
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: BaseHandleMessages<TEvent> handler MISSING Subscribe → flagged", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs": HANDLER_TEMPLATE("FooHandler", "MyEvent", "BaseHandleMessages"),
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /MyEvent/);
});

test("lintGate: BaseHandleMessages<TEvent> handler WITH Subscribe → not flagged", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs": HANDLER_TEMPLATE("FooHandler", "MyEvent", "BaseHandleMessages"),
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE(["MyEvent"]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// HandleMessages<TEvent, TDbContext> variant (Core's generic base)
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: HandleMessages<TEvent, TDbContext> MISSING Subscribe → flagged", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs": HANDLER_TEMPLATE("FooHandler", "OtherEvent", "HandleMessages"),
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /OtherEvent/);
});

// ─────────────────────────────────────────────────────────────────────────
// Common events handled by Core's SubscribeToCommonEvents
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: InvalidateTenantCacheEvent handler doesn't need local Subscribe (wired via Core)", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs": HANDLER_TEMPLATE("FooHandler", "InvalidateTenantCacheEvent"),
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0, "InvalidateTenantCacheEvent is in COMMON_EVENTS exemption");
});

// ─────────────────────────────────────────────────────────────────────────
// SX0005-IGNORE marker
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: SX0005-IGNORE marker suppresses violation", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs":
      "// SX0005-IGNORE: local-send-only, runs via bus.SendLocal\n" +
      HANDLER_TEMPLATE("FooHandler", "OnlyLocalEvent"),
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// global:: prefix tolerance
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: matches global::Namespace.Event prefix in Subscribe (AccountantGate pattern)", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs": HANDLER_TEMPLATE("FooHandler", "MomsopgorelseGeneratedIntegrationEvent"),
    "src/Infrastructure/DependencyInjection.cs": `
namespace Microsoft.Extensions.DependencyInjection {
  public static class DI {
    public static void X() {
      bus.Subscribe<global::Shared.Contracts.Events.MomsGate.MomsopgorelseGeneratedIntegrationEvent>();
    }
  }
}
`,
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0, "global:: prefix on Subscribe should normalize to short name");
});

test("lintGate: matches global::Namespace.Event prefix in handler", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs": `
public class FooHandler : IHandleMessages<global::Shared.Contracts.Events.X.AlphaEvent> {
  public Task Handle(AlphaEvent m) => Task.CompletedTask;
}
`,
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE(["AlphaEvent"]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Multiple handlers, multiple subscriptions
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: multi-handler scenario — 3 handlers, 2 subscribed, 1 missing → 1 violation", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/A.cs": HANDLER_TEMPLATE("AHandler", "AEvent"),
    "src/Application/Messaging/Handlers/B.cs": HANDLER_TEMPLATE("BHandler", "BEvent"),
    "src/Application/Messaging/Handlers/C.cs": HANDLER_TEMPLATE("CHandler", "CEvent"),
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE(["AEvent", "BEvent"]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /CEvent/);
});

// ─────────────────────────────────────────────────────────────────────────
// Generic type-parameter false positives
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: HandleMessages.cs base class (in Core) does not produce TMessage fake-event", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/HandleMessages.cs":
      "public abstract class HandleMessages<TMessage, TDbContext> : IHandleMessages<TMessage> { }",
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0, "TMessage generic param must NOT be flagged");
});

test("lintGate: BaseHandleMessages.cs (per-service wrapper) doesn't fake-trigger on TMessage", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/BaseHandleMessages.cs":
      "public abstract class BaseHandleMessages<TMessage> : HandleMessages<TMessage, IApplicationDbContext> { }",
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0, "BaseHandleMessages.cs is skipped + generic param ignored");
});

// ─────────────────────────────────────────────────────────────────────────
// No DependencyInjection.cs at all
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: missing DependencyInjection.cs → handlers still flagged (DI file absent = nothing subscribed)", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/Foo.cs": HANDLER_TEMPLATE("FooHandler", "AnyEvent"),
    // (deliberately no Infrastructure/DependencyInjection.cs)
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /AnyEvent/);
});

// ─────────────────────────────────────────────────────────────────────────
// Migrations directory is skipped
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: Migrations/ files are NOT scanned (avoids fake hits from auto-generated EF code)", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Infrastructure/Data/Migrations/Phase01.cs":
      "public class FakeMigration : IHandleMessages<FakeEvent> { }",
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Duplicate handlers across two files — only one violation per (Gate, Event)
// ─────────────────────────────────────────────────────────────────────────

test("lintGate: two handler files for the same event produce ONE violation (de-duplicated)", () => {
  const { root, gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/A.cs": HANDLER_TEMPLATE("AHandler", "SharedEvent"),
    "src/Application/Messaging/Handlers/B.cs": HANDLER_TEMPLATE("BHandler", "SharedEvent"),
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([]),
  });
  const violations = lint.lintGate(gateRoot, root);
  assert.equal(violations.length, 1, "expect exactly one (Gate, Event) tuple");
  assert.match(violations[0].message, /SharedEvent/);
});

// ─────────────────────────────────────────────────────────────────────────
// findSubscriptions
// ─────────────────────────────────────────────────────────────────────────

test("findSubscriptions returns Set of normalized event names", () => {
  const { gateRoot } = makeFixtureGate("FooGate", {
    "src/Infrastructure/DependencyInjection.cs": DI_TEMPLATE([
      "EventA",
      "global::Shared.Contracts.Events.X.EventB",
    ]),
  });
  const subs = lint.findSubscriptions(gateRoot);
  assert.equal(subs.has("EventA"), true);
  assert.equal(subs.has("EventB"), true);
  assert.equal(subs.size, 2);
});

test("findSubscriptions returns empty Set when DI file missing", () => {
  const { gateRoot } = makeFixtureGate("FooGate", {});
  const subs = lint.findSubscriptions(gateRoot);
  assert.equal(subs.size, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// findHandlers
// ─────────────────────────────────────────────────────────────────────────

test("findHandlers picks up : IHandleMessages<E> + : BaseHandleMessages<E> + : HandleMessages<E,_>", () => {
  const { gateRoot } = makeFixtureGate("FooGate", {
    "src/Application/Messaging/Handlers/A.cs": HANDLER_TEMPLATE("AHandler", "Alpha", "IHandleMessages"),
    "src/Application/Messaging/Handlers/B.cs": HANDLER_TEMPLATE("BHandler", "Beta", "BaseHandleMessages"),
    "src/Application/Messaging/Handlers/C.cs": HANDLER_TEMPLATE("CHandler", "Gamma", "HandleMessages"),
  });
  const hits = lint.findHandlers(gateRoot);
  const names = new Set(hits.map((h) => h.eventName));
  assert.equal(names.has("Alpha"), true);
  assert.equal(names.has("Beta"), true);
  assert.equal(names.has("Gamma"), true);
});

// ─────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of fails) {
    process.stdout.write(`\n--- ${f.name} ---\n${f.err.stack || f.err.message}\n`);
  }
  process.exit(1);
}
process.exit(0);
