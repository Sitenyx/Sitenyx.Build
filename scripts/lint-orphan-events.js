#!/usr/bin/env node
/**
 * lint-orphan-events.js
 *
 * SX0007 — Pre-merge guardrail that catches the
 * "`IIntegrationEvent` record declared in `Core/Shared.Contracts/Events/` but
 *  no `IHandleMessages<TThatEvent>` consumer anywhere in the platform AND
 *  no `// SX-ORPHAN-OK:` source marker on the declaring file" regression
 * class.
 *
 * Origin (orphan event audit, commit `17d0cb4c` 2026-05-25):
 *   58 orphan integration events were inventoried across `Shared.Contracts/
 *   Events/` (49 marked as intentional via the prior `// SX0006-IGNORE:`
 *   marker — renamed to `// SX-ORPHAN-OK:` in commit `362a308f` to free
 *   SX0006 for the IgnoreQueryFilters family; 9 unmarked, with
 *   `MomsRefundIssuedIntegrationEvent` flagged P0 as a missed VAT-recovery
 *   wiring gap).
 *
 *   Until this lint shipped, the marker was a doc-level convention only —
 *   nothing enforced that a NEW event declared without a consumer carried
 *   the marker. This lint catches the class at PR time.
 *
 * RULE (SX0007):
 *   For every `IIntegrationEvent` record / class declared under
 *   `Core/Shared.Contracts/Events/**\/*.cs`, there must exist either:
 *     (a) at least one `IHandleMessages<TThatEvent>` consumer somewhere
 *         under any sibling `*Gate/src/` tree
 *     OR
 *     (b) a `// SX-ORPHAN-OK: <reason>` marker comment in the event's
 *         declaring file (top 50 lines).
 *
 * SCANS:
 *   - Core/Shared.Contracts/Events/**\/*.cs — collects every event type
 *     declared (records and classes whose name matches a Sitenyx event
 *     suffix convention OR that the file ALSO carries a SX-ORPHAN-OK
 *     marker, in which case we trust the file is an event file even
 *     without a suffix match).
 *   - <Gate>/src/**\/*.cs — collects every TEvent referenced as the type
 *     parameter of `IHandleMessages<TEvent>`, `HandleMessages<TEvent, _>`,
 *     or `BaseHandleMessages<TEvent>` (mirrors lint-subscribe-matrix.js
 *     so the two rules see exactly the same consumer surface).
 *
 * MATCHES (event-decl → consumer):
 *   Short type name equality after stripping `global::Namespace.` prefixes
 *   and trailing generic args. The two rules use the same `normalizeEventName`
 *   helper for symmetric semantics.
 *
 * EXEMPTIONS:
 *   1. File-level marker `// SX-ORPHAN-OK: <reason>` in the event-declaring
 *      file's top 50 lines. The reason text is free-form (typical values:
 *      "fan-and-forget", "future / cross-cutting signal", "platform-global
 *      table eviction"). Per the audit convention the marker can also live
 *      INSIDE the file body alongside the record declaration — we scan the
 *      whole file body once per event declaration to be conservative.
 *   2. Events under `Shared.Contracts/Events/<GateFolder>/` are still
 *      scanned — folder structure is organisational, not a scope gate.
 *   3. Generic type parameter names (TMessage, TEvent, T, …) discovered in
 *      `BaseHandleMessages<TMessage>`-style base class declarations are
 *      skipped — mirrors lint-subscribe-matrix.js behavior.
 *
 * EXIT CODES:
 *   0 — all event declarations have a consumer or carry the marker
 *   1 — one or more events are unmarked AND unconsumed (strict mode only)
 *
 * USAGE:
 *   # Platform-wide (developer workflow, from Sitenyx root):
 *   node Sitenyx.Build/scripts/lint-orphan-events.js
 *
 *   # Strict mode (errors fail CI):
 *   node Sitenyx.Build/scripts/lint-orphan-events.js --strict
 *
 *   # Explicit override:
 *   node Sitenyx.Build/scripts/lint-orphan-events.js --platform-root /path/to/Sitenyx
 *
 * REPORT FORMAT (grep-compatible):
 *   <file>:<line>:<col>: <severity>: <msg>
 *
 *   Core/Shared.Contracts/Events/MomsGate/MomsRefundIssuedIntegrationEvent.cs:14:18:
 *       error: Event 'MomsRefundIssuedIntegrationEvent' is declared in
 *       Shared.Contracts.Events but no IHandleMessages<MomsRefundIssuedIntegrationEvent>
 *       consumer was found across any *Gate/src/ tree, and the file does not
 *       carry a `// SX-ORPHAN-OK: <reason>` marker. Either wire a consumer
 *       Gate to handle the event, or add the marker comment to the top of
 *       the file (free-form reason text).
 *
 * See: Core/Sitenyx.Analyzers/DiagnosticIds.cs SX0007 entry,
 *      qa-findings/cross-gate/_ORPHAN-EVENT-AUDIT-2026-05-25.md.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────

// File-level exemption marker. A file with this comment anywhere within
// its body opts out of the check. Whole-file scan (not just top 50 lines)
// because the orphan audit's convention sometimes places the marker
// alongside the record declaration rather than at file top.
const ORPHAN_OK_MARKER = /\/\/\s*SX-ORPHAN-OK\s*:/;

// Event declaration patterns inside Shared.Contracts/Events/. Sitenyx event
// naming convention: `*Event` or `*IntegrationEvent` suffix. We capture
// records AND classes (some legacy events are still plain classes).
//
// Capture group 1 is the event short name.
const EVENT_RECORD_PATTERN =
  /\b(?:public|internal)?\s*(?:sealed\s+|abstract\s+)?(?:record|class)\s+([A-Z][A-Za-z0-9_]*(?:Event|IntegrationEvent))\b/g;

// Consumer patterns — kept in sync with lint-subscribe-matrix.js so SX0005
// and SX0007 see the same consumer surface by construction.
const CONSUMER_PATTERNS = [
  // : IHandleMessages<Event>
  /:\s*IHandleMessages\s*<\s*([A-Za-z_][\w.:<>,\s]*?)\s*>/g,
  // : HandleMessages<Event, TDbContext>  (Core's generic base)
  /:\s*HandleMessages\s*<\s*([A-Za-z_][\w.:]*?)\s*,/g,
  // : BaseHandleMessages<Event>          (service-local convenience base)
  /:\s*BaseHandleMessages\s*<\s*([A-Za-z_][\w.:]*?)\s*>/g,
];

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
// name. Mirrors lint-subscribe-matrix.js so the two rules normalize names
// identically.
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

// Walks <root> recursively, calling fn(absolutePath) on every .cs file.
// Skips obj/, bin/, Migrations/ — same as lint-subscribe-matrix.js.
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

// Returns array of { eventName, file, line, col, hasMarker } for every
// event type declared anywhere under `Core/Shared.Contracts/Events/`.
function findEventDeclarations(platformRoot) {
  const hits = [];
  const eventsRoot = path.join(platformRoot, "Core", "Shared.Contracts", "Events");
  walkCs(eventsRoot, (fp) => {
    let content;
    try {
      content = fs.readFileSync(fp, "utf8");
    } catch {
      return;
    }
    const hasMarker = ORPHAN_OK_MARKER.test(content);

    const re = new RegExp(EVENT_RECORD_PATTERN.source, EVENT_RECORD_PATTERN.flags);
    let m;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      // Compute line/column of the captured TYPE NAME (group 1), not the
      // entire match — produces a clean caret in editors.
      const nameIndex = m.index + m[0].indexOf(name);
      const upToName = content.substring(0, nameIndex);
      const line = upToName.split("\n").length;
      const col = nameIndex - upToName.lastIndexOf("\n");
      hits.push({ eventName: name, file: fp, line, col, hasMarker });
    }
  });
  return hits;
}

// Returns Set<string> of event short names that are consumed by ANY Gate
// across the platform (union over every Gate root's src/ tree). Mirrors
// lint-subscribe-matrix.js's handler-discovery semantics; the only delta
// is the aggregation across Gates (vs. per-Gate there).
function findConsumedEvents(platformRoot) {
  const out = new Set();
  for (const gateRoot of listGateRoots(platformRoot)) {
    const srcDir = path.join(gateRoot, "src");
    walkCs(srcDir, (fp) => {
      // Skip the Core HandleMessages.cs base class itself — generic param
      // names like `TMessage` would otherwise show up as fake events.
      // (The Core HandleMessages.cs is under Core/Core/ which isn't a Gate
      // root, but the per-service BaseHandleMessages.cs wrappers ARE under
      // each Gate's src/.)
      if (fp.endsWith(`${path.sep}HandleMessages.cs`)) return;
      if (fp.endsWith(`${path.sep}BaseHandleMessages.cs`)) return;

      let content;
      try {
        content = fs.readFileSync(fp, "utf8");
      } catch {
        return;
      }
      for (const rx of CONSUMER_PATTERNS) {
        const re = new RegExp(rx.source, rx.flags);
        let m;
        while ((m = re.exec(content)) !== null) {
          const name = normalizeEventName(m[1]);
          // Skip generic type parameters (TMessage, T, TEvent etc.) — these
          // are declarations in BaseHandleMessages-style wrappers, not real
          // consumer pairings.
          if (/^T[A-Z][A-Za-z0-9_]*$/.test(name) || /^T$/.test(name)) continue;
          out.add(name);
        }
      }
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Cross-Gate runner
// ─────────────────────────────────────────────────────────────────────────

function lintOrphans(platformRoot) {
  const violations = [];
  const decls = findEventDeclarations(platformRoot);
  const consumed = findConsumedEvents(platformRoot);

  // De-duplicate by event name — only flag the FIRST declaration site if
  // multiple files redundantly declare the same event short name (defensive;
  // should not happen in practice since C# wouldn't compile).
  const seen = new Set();
  for (const d of decls) {
    if (seen.has(d.eventName)) continue;
    seen.add(d.eventName);

    if (consumed.has(d.eventName)) continue; // happy path
    if (d.hasMarker) continue;                // intentional orphan

    const reportPath = path.relative(platformRoot, d.file);
    violations.push({
      file: reportPath,
      line: d.line,
      col: d.col,
      severity: "error",
      eventName: d.eventName,
      message:
        `Event '${d.eventName}' is declared in Shared.Contracts.Events but no ` +
        `IHandleMessages<${d.eventName}> consumer was found across any *Gate/src/ ` +
        `tree, and the file does not carry a \`// SX-ORPHAN-OK: <reason>\` marker. ` +
        `Either wire a consumer Gate to handle the event, or add the marker comment ` +
        `to the top of the file (free-form reason text). See ` +
        `Core/Sitenyx.Analyzers/DiagnosticIds.cs SX0007.`,
    });
  }

  return { violations, totalDeclarations: seen.size };
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let platformRoot = null;
  // Severity ladder mirrored from SX0005:
  //   Initial release: warn-only (default) — CI does NOT fail. Surfaces
  //                    the current event-vs-consumer gap inventory so each
  //                    gap is triaged before flipping severity.
  //   +30d: triage + bulk-annotate. Add `// SX-ORPHAN-OK: <reason>` to
  //         genuine fan-and-forget / future-signal events; wire consumers
  //         for the rest (P0/P1 from the orphan audit).
  //   +60d: flip --strict (errors fail CI) once the inventory is zero.
  let strict = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--platform-root") platformRoot = args[++i];
    else if (args[i] === "--strict") strict = true;
  }

  platformRoot =
    platformRoot ||
    findPlatformRoot(process.cwd()) ||
    process.cwd();

  const { violations, totalDeclarations } = lintOrphans(platformRoot);

  for (const v of violations) {
    const severity = strict ? v.severity : "warning";
    process.stdout.write(
      `${v.file}:${v.line}:${v.col}: ${severity}: ${v.message}\n`,
    );
  }

  const banner = strict
    ? `[lint-orphan-events SX0007] strict mode — violations fail CI.`
    : `[lint-orphan-events SX0007] warn-only mode — violations surface as warnings ` +
      `(CI does not fail). Pass --strict to flip severity to error.`;
  process.stdout.write(
    `\n${banner}\nScanned ${totalDeclarations} event declaration(s) across ` +
      `Core/Shared.Contracts/Events/. ${violations.length} violation(s).\n`,
  );

  process.exit(strict && violations.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  ORPHAN_OK_MARKER,
  EVENT_RECORD_PATTERN,
  CONSUMER_PATTERNS,
  normalizeEventName,
  findEventDeclarations,
  findConsumedEvents,
  lintOrphans,
};
