#!/usr/bin/env node
/**
 * lint-subscribe-matrix.js
 *
 * SX0005 — Pre-merge guardrail that catches the
 * "`IHandleMessages<TEvent>` handler exists but `bus.Subscribe<TEvent>()`
 *  missing in Infrastructure/DependencyInjection.cs" regression class.
 *
 * Origin (DEV-012 V3 USER APPROVED 2026-05-12, ComplianceGate WORM
 * subscribe-binding fix `8836034`):
 *   ComplianceGate shipped `AuditEntryWrittenHandler` (commit `7c40dde`)
 *   without the matching `await bus.Subscribe<AuditEntryWrittenIntegrationEvent>()`
 *   line in `DependencyInjection.cs`. Rebus auto-registered the handler in
 *   the DI container, but RabbitMQ never bound the queue to the topic, so
 *   cross-Gate audit-ledger events from BudgetGate / DebtorGate / ExpenseGate
 *   / AdvisorGate were silently dropped at the broker fan-out.
 *
 *   Defense-in-depth lesson from the V3 audit closure: Rebus's handler-
 *   auto-registration does NOT imply subscribe-auto-registration. This
 *   lint catches the class at PR time.
 *
 * RULE (SX0005):
 *   For every Gate, every `IHandleMessages<TEvent>` (or `HandleMessages<TEvent, ...>` /
 *   `BaseHandleMessages<TEvent>`) implementation under <Gate>/src/ must have
 *   a matching `await bus.Subscribe<TEvent>()` call somewhere in the Gate's
 *   `<Gate>/src/Infrastructure/DependencyInjection.cs`.
 *
 * SCANS:
 *   - <Gate>/src/**\/*.cs — extracts every TEvent referenced as the type
 *     parameter of `IHandleMessages<TEvent>`, `HandleMessages<TEvent, _>`,
 *     or `BaseHandleMessages<TEvent>` in a class declaration.
 *   - <Gate>/src/Infrastructure/DependencyInjection.cs — extracts every
 *     TEvent passed to `bus.Subscribe<TEvent>()`.
 *
 * MATCHES (handler→subscribe pair):
 *   The pair { handlerEvent → subscribedEvent } matches when the short
 *   type names (after stripping `global::Namespace.` prefixes and trailing
 *   generic args) are equal.
 *
 * EXEMPTIONS:
 *   1. Handlers that DON'T need a Subscribe call:
 *      - In-process domain event handlers (`INotificationHandler<Event<...>>`)
 *        — NOT in scope (this rule only covers Rebus integration events).
 *      - Origin-Gate handlers that only react to a locally-routed event
 *        (handler runs because the message lands in our own queue via
 *        `bus.SendLocal` or `bus.Send` from this same service). Mark these
 *        with the file-level marker comment:
 *           // SX0005-IGNORE: local-send-only — no broker subscription needed
 *      - Endpoint-test mocks / fixture handlers under tests/. Tests are
 *        skipped by default (scan path is only src/).
 *      - Handlers for events from Core's `Shared.Contracts.Events` that are
 *        wired via Core's `SubscribeToCommonEvents` helper (e.g.
 *        `InvalidateTenantCacheEvent`) — listed in COMMON_EVENTS below.
 *
 *   2. Subscribe calls without a handler: NOT a violation. Some events are
 *      legitimately subscribed for side effects routed through MediatR
 *      pipeline (e.g. logging interceptors, retry shims). The asymmetric
 *      direction (handler missing subscribe) is the regression class —
 *      not the reverse.
 *
 * EXIT CODES:
 *   0 — all handler events have a matching Subscribe call in the same Gate
 *   1 — one or more handler events lack a Subscribe call; report lists each
 *       violation grep-compatible.
 *
 * USAGE:
 *   # Platform-wide (developer workflow, from Sitenyx root):
 *   node Sitenyx.Build/scripts/lint-subscribe-matrix.js
 *
 *   # Single Gate (per-Gate CI checkout, no platform-root context):
 *   node build/scripts/lint-subscribe-matrix.js --single-gate
 *
 *   # Explicit override:
 *   node scripts/lint-subscribe-matrix.js --platform-root /path/to/Sitenyx
 *
 * REPORT FORMAT (grep-compatible):
 *   <file>:<line>:<col>: <severity>: <msg>
 *
 *   ComplianceGate/src/Application/Messaging/Handlers/AuditEntryWrittenHandler.cs:39:14:
 *       error: Handler for AuditEntryWrittenIntegrationEvent found but no
 *       `bus.Subscribe<AuditEntryWrittenIntegrationEvent>()` call in
 *       ComplianceGate/src/Infrastructure/DependencyInjection.cs.
 *       Add the line (e.g. line 749) or mark the file with `// SX0005-IGNORE: <reason>`.
 *
 * See: Core/docs/analyzers/SITENYX001.md for the canonical rule manifest entry.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────

// Events subscribed by Core's SubscribeToCommonEvents helper. Per-Gate
// Subscribe calls for these are redundant — Core wires them on every
// service via AddRebusAndRabbitMq.onCreated. If a Gate ships its own
// handler for one of these, it does NOT need to add a local Subscribe.
//
// Source of truth: Core/Core/DependencyInjection/RebusAndRabbitMq.cs
//   → SubscribeToCommonEvents(bus)
const COMMON_EVENTS = new Set([
  "InvalidateTenantCacheEvent",
  // GDPR Art. 17 erasure. The handler lives in Core
  // (Core.Gdpr.ErasureRequestedEventHandler) and SubscribeToCommonEvents binds
  // the queue in all 47 Gates — a per-Gate Subscribe would be redundant, and
  // telling authors to add one would be actively wrong.
  "ErasureRequestedEvent",
]);

// File-level exemption marker. A handler file with this comment anywhere
// in its top 50 lines opts out of the check.
const IGNORE_MARKER = /\/\/\s*SX0005-IGNORE\s*:/;

// ─────────────────────────────────────────────────────────────────────────
// Regex patterns
// ─────────────────────────────────────────────────────────────────────────

// Class-declaration patterns that establish a Rebus event handler. Each
// captures the inner TEvent type name (group 1).
//
// Note on TEvent capture: we deliberately allow `global::Namespace.Name`
// and arbitrary nesting in the captured text. The `normalizeEventName`
// helper below strips the namespace prefix to leave the short name.
//
// `IHandleMessages<TEvent>` — direct interface implementation.
const HANDLER_PATTERNS = [
  // : IHandleMessages<Event>
  /:\s*IHandleMessages\s*<\s*([A-Za-z_][\w.:<>,\s]*?)\s*>/g,
  // : HandleMessages<Event, TDbContext>  (Core's generic base)
  /:\s*HandleMessages\s*<\s*([A-Za-z_][\w.:]*?)\s*,/g,
  // : BaseHandleMessages<Event>          (service-local convenience base)
  /:\s*BaseHandleMessages\s*<\s*([A-Za-z_][\w.:]*?)\s*>/g,
];

// `bus.Subscribe<TEvent>()` — broker queue→topic binding call. Captures
// the inner TEvent type name (group 1).
//
// Allows arbitrary whitespace and a leading `await `, and tolerates the
// `global::Namespace.Type` prefix.
const SUBSCRIBE_PATTERN =
  /bus\s*\.\s*Subscribe\s*<\s*([A-Za-z_][\w.:]*?)\s*>\s*\(/g;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
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

// Strip `global::Namespace.SubNamespace.` prefix to leave the short type
// name. Also strips trailing generic-args text in case the regex captured
// extra (defensive — patterns above should already isolate the TEvent
// proper, but in some service files `BaseHandleMessages<Event, T2>` may
// drift to other shapes).
function normalizeEventName(raw) {
  if (!raw) return raw;
  let name = raw.trim();
  // Drop trailing whitespace + commas / extra type args.
  name = name.replace(/[,\s].*$/, "");
  // Strip everything before the final `.` (also drops `global::` prefix).
  const lastDot = name.lastIndexOf(".");
  if (lastDot >= 0) name = name.substring(lastDot + 1);
  // Strip any trailing `<…>` if the regex still captured generic args.
  name = name.replace(/<.*$/, "");
  return name;
}

// Walks <root> recursively, calling fn(absolutePath, relativePath) on every
// .cs file. Skips obj/ and bin/ and Migrations/ directories.
function walkCs(root, fn) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ent.name === "obj" || ent.name === "bin" || ent.name === "Migrations") continue;
        stack.push(path.join(dir, ent.name));
      } else if (ent.isFile() && ent.name.endsWith(".cs")) {
        fn(path.join(dir, ent.name));
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Scanners
// ─────────────────────────────────────────────────────────────────────────

// Returns array of { eventName, file, line, col } for every Rebus handler
// declared in any .cs file under gateRoot/src/. Skips files with the
// SX0005-IGNORE marker.
function findHandlers(gateRoot) {
  const hits = [];
  const srcDir = path.join(gateRoot, "src");
  walkCs(srcDir, (fp) => {
    let content;
    try {
      content = fs.readFileSync(fp, "utf8");
    } catch {
      return;
    }
    // File-level exemption check (only consider top 50 lines for the marker).
    const head = content.split("\n").slice(0, 50).join("\n");
    if (IGNORE_MARKER.test(head)) return;

    // Skip the Core HandleMessages.cs base class itself — generic param
    // names like `TMessage` would otherwise show up as fake events.
    if (fp.endsWith(`${path.sep}HandleMessages.cs`)) return;
    if (fp.endsWith(`${path.sep}BaseHandleMessages.cs`)) return;

    for (const rx of HANDLER_PATTERNS) {
      // Re-create regex per pass so .lastIndex doesn't pollute the next file.
      const re = new RegExp(rx.source, rx.flags);
      let m;
      while ((m = re.exec(content)) !== null) {
        const raw = m[1];
        const name = normalizeEventName(raw);
        // Skip generic type params (TMessage, T, TEvent etc.) — these are
        // declarations in BaseHandleMessages-style wrappers.
        if (/^T[A-Z][A-Za-z0-9_]*$/.test(name) || /^T$/.test(name)) continue;
        // Compute line/column of the match.
        const upToMatch = content.substring(0, m.index);
        const line = upToMatch.split("\n").length;
        const col = m.index - upToMatch.lastIndexOf("\n");
        hits.push({ eventName: name, file: fp, line, col });
      }
    }
  });
  return hits;
}

// Returns Set<string> of event short names that the Gate's DI Subscribe
// list includes. Reads ONLY <Gate>/src/Infrastructure/DependencyInjection.cs.
function findSubscriptions(gateRoot) {
  const out = new Set();
  const diPath = path.join(gateRoot, "src", "Infrastructure", "DependencyInjection.cs");
  if (!fs.existsSync(diPath)) return out;
  const content = fs.readFileSync(diPath, "utf8");
  let m;
  // Fresh regex per call.
  const re = new RegExp(SUBSCRIBE_PATTERN.source, SUBSCRIBE_PATTERN.flags);
  while ((m = re.exec(content)) !== null) {
    out.add(normalizeEventName(m[1]));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-Gate runner
// ─────────────────────────────────────────────────────────────────────────

function lintGate(gateRoot, platformRoot) {
  const violations = [];
  const handlers = findHandlers(gateRoot);
  const subscribed = findSubscriptions(gateRoot);

  // De-duplicate handler-event names across multiple files. We only need
  // to flag one violation per (Gate, Event) pair — the report cites the
  // first handler file found. The second file with the same event would
  // not surface a *different* fix.
  const seen = new Set();
  for (const h of handlers) {
    if (seen.has(h.eventName)) continue;
    seen.add(h.eventName);

    if (COMMON_EVENTS.has(h.eventName)) continue;       // wired via Core
    if (subscribed.has(h.eventName)) continue;          // happy path

    const reportPath = platformRoot
      ? path.relative(platformRoot, h.file)
      : path.relative(gateRoot, h.file);
    const diPath = path.join(gateRoot, "src", "Infrastructure", "DependencyInjection.cs");
    const diRelPath = platformRoot
      ? path.relative(platformRoot, diPath)
      : path.relative(gateRoot, diPath);

    violations.push({
      file: reportPath,
      line: h.line,
      col: h.col,
      severity: "error",
      message:
        `Handler for ${h.eventName} found but no \`bus.Subscribe<${h.eventName}>()\` ` +
        `call in ${diRelPath}. ` +
        `Add the Subscribe line, OR mark the handler file with ` +
        `\`// SX0005-IGNORE: <reason>\` if the handler is local-send-only ` +
        `(no broker queue binding needed). See Core/docs/analyzers/SITENYX001.md.`,
    });
  }

  return violations;
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let platformRoot = null;
  let singleGate = false;
  // Severity ladder per SX0005 deployment plan (analogous to SX0004):
  //   Initial release: warn-only (default) — CI does NOT fail. Surfaces
  //                    the current handler-vs-Subscribe gap inventory so
  //                    each gap is triaged before flipping severity.
  //   +30d: triage + bulk-annotate. Add `// SX0005-IGNORE: <reason>` to
  //         genuine point-to-point/local-send-only handlers; ship missing
  //         Subscribe lines for the rest.
  //   +60d: flip --strict (errors fail CI) once the inventory is zero.
  //
  // The lint-statutory-citations and lint-concurrency-token rules both
  // ship strict from day one because their inventory was zero on first
  // ship. SX0005 inherits a pre-existing inventory of 36 platform-wide
  // gaps (DEV-012 V3 sweep), so a warn→strict ramp is required. See
  // qa-findings/cross-gate/SPRINT-D-V3-CORE-SUBSCRIBE-LINTER-CLOSURE.md.
  let strict = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--platform-root") platformRoot = args[++i];
    else if (args[i] === "--single-gate") singleGate = true;
    else if (args[i] === "--strict") strict = true;
  }

  let gates;
  if (singleGate) {
    // Per-Gate CI mode — the checkout is a single repo. The current dir
    // (or its closest `src/` ancestor) IS the Gate root.
    gates = [process.cwd()];
    platformRoot = process.cwd();
  } else {
    platformRoot =
      platformRoot ||
      findPlatformRoot(process.cwd()) ||
      process.cwd();
    gates = listGateRoots(platformRoot);
  }

  let totalViolations = 0;
  let totalHandlers = 0;
  for (const gate of gates) {
    const handlers = findHandlers(gate);
    totalHandlers += handlers.length;
    const violations = lintGate(gate, platformRoot);
    for (const v of violations) {
      const severity = strict ? v.severity : "warning";
      process.stdout.write(
        `${v.file}:${v.line}:${v.col}: ${severity}: ${v.message}\n`,
      );
      totalViolations++;
    }
  }

  const banner = strict
    ? `[lint-subscribe-matrix SX0005] strict mode — violations fail CI.`
    : `[lint-subscribe-matrix SX0005] warn-only mode — violations surface as warnings ` +
      `(CI does not fail). Pass --strict to flip severity to error.`;
  process.stdout.write(
    `\n${banner}\nScanned ${totalHandlers} handler declaration(s) across ${gates.length} Gate(s). ` +
      `${totalViolations} violation(s).\n`,
  );

  // In warn-only mode, the lint never fails CI. In strict mode, exit 1
  // when there is at least one violation.
  process.exit(strict && totalViolations > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  COMMON_EVENTS,
  IGNORE_MARKER,
  HANDLER_PATTERNS,
  SUBSCRIBE_PATTERN,
  normalizeEventName,
  findHandlers,
  findSubscriptions,
  lintGate,
};
