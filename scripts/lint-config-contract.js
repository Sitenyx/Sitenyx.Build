#!/usr/bin/env node
/**
 * lint-config-contract.js
 *
 * SX0008 — "a required config key with nothing supplying it".
 *
 * ORIGIN (two production incidents, both 2026-08-02, BL-4e5be9e4):
 *
 *   (a) NotifyGate added a boot guard requiring `Unsubscribe:Secret` (>=32 chars;
 *       the anonymous /unsubscribe endpoint persists GDPR Art. 7(3) withdrawals and
 *       authenticates by HMAC alone, so a forgeable signing key is a forged
 *       withdrawal). Nothing wired the key into the production compose. The image
 *       failed its health check on every deploy attempt. Blue-green correctly
 *       declined to swap, so there was no outage — but the deploy could never
 *       succeed and the only signal was a Fatal in Seq. Fixed by
 *       sitenyx-infra `628ece0`.
 *
 *   (b) AdvisorGate and ComplianceGate declared `Consul:Discovery:Services` ONLY in
 *       `appsettings.Docker.json`, which .NET never loads under
 *       ASPNETCORE_ENVIRONMENT=Production. Core's RegisterService() found an empty
 *       list and silently no-opped, so both Gates were unroutable behind the
 *       gateway with zero errors logged. Fixed by AdvisorGate `7a8695c` /
 *       ComplianceGate `894a615`.
 *
 * Both are the same defect class: a configuration CONTRACT with no enforcement.
 * One side of the contract is C# (a boot-time validation, or the section a Gate's
 * production estate needs); the other side is deployment data (the production
 * compose `environment:` block, `appsettings.json`, `appsettings.Production.json`).
 * Nothing checked that the two agreed, and neither incident produced a failing
 * test — only a runtime Fatal, or silence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCRIPT CHECKS
 *
 * CHECK A — boot-required key not supplied in Production.
 *   For every `services.AddOptions<TOptions>()...ValidateOnStart()` chain, work
 *   out which option PROPERTIES the chain requires to be *present* (a
 *   `!string.IsNullOrWhiteSpace(o.P)` / `!string.IsNullOrEmpty(o.P)` guard, a
 *   minimum-length guard, or `[Required]`/`[MinLength]` under
 *   `.ValidateDataAnnotations()`), map each to its config path via the bound
 *   section name, and assert the path is reachable when the process runs with
 *   ASPNETCORE_ENVIRONMENT=Production — i.e. it is present in `appsettings.json`,
 *   in `appsettings.Production.json`, or in the Gate's `environment:` block in
 *   the production compose.
 *
 *   Properties that carry a non-empty C# default are skipped: the guard passes
 *   without any configuration, so there is no contract to break.
 *
 * CHECK B — production-unreachable config section (fleet parity). `--tree` only.
 *   A section that is Production-reachable for (nearly) the whole fleet but not
 *   for one Gate is the (b) shape. The fleet is the baseline, so the check needs
 *   no hand-maintained allowlist and updates itself as the platform moves.
 *   Naive "declared only in appsettings.Docker.json" is NOT usable as the rule —
 *   measured over the 47-Gate tree it produces 138 hits, essentially all benign
 *   (extra local Serilog sinks, an extra dev Consul registration, a local
 *   `ConnectionStrings`, `Kestrel` port bindings). Parity produces 0 on the
 *   corrected tree and fires on both real incidents.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCRIPT CANNOT CATCH — read before trusting a green run.
 *
 *   1. Host-side values. The compose supplies most secrets by interpolation
 *      (`${NOTIFY_UNSUBSCRIBE_SECRET:?}`). This script sees that the KEY exists;
 *      it cannot see whether the variable is set in the host's `.env.production`.
 *      A key written `${VAR}` (no `:?`, no `:-default`) resolves to the EMPTY
 *      STRING when the host var is missing, which still trips a presence guard at
 *      boot. Those are reported as warnings (CHECK A2), not errors, because the
 *      host file is not in any repo.
 *   2. Non-file, non-compose configuration providers — Consul KV, Azure App
 *      Configuration, user-secrets, a custom IConfigurationSource. Nothing here
 *      models them.
 *   3. Boot guards that are not options-validation: a bare
 *      `throw new InvalidOperationException(...)` in Program.cs, or a hosted
 *      service that refuses to start. AgentGate's ToolRegistryBootCheck is one.
 *      Extending CHECK A to those means recognising arbitrary control flow;
 *      it was deliberately not attempted rather than done badly.
 *   4. `[ConfigurationKeyName]` renames, and options bound by anything other than
 *      `.Bind(configuration.GetSection(...))` / `.BindConfiguration(...)`. Such a
 *      chain is REPORTED as unresolved (see the `unresolved` counter) rather than
 *      silently dropped — a skipped chain must never look like a passing one.
 *   5. Validation that is not a presence check. ExpenseGate's AnthropicOptions
 *      rejects only literal placeholder values and deliberately tolerates an
 *      unset key (AI-disabled graceful degradation). Correctly not flagged.
 *   6. A key that is supplied but WRONG (a stale URL, a 20-char secret where 32
 *      are required). Presence is the whole of the contract modelled here.
 *   7. The frontends (AdminGate/ClientGate). They are Next.js and have no
 *      appsettings/options graph.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 *
 *   # Whole superproject (all Gates + the production compose): CHECK A + B
 *   node Sitenyx.Build/scripts/lint-config-contract.js --tree .
 *
 *   # One Gate, in its own CI checkout, with the compose fetched alongside: CHECK A
 *   node build/scripts/lint-config-contract.js --gate . --compose <path/to/docker-compose.yml>
 *
 *   --json     machine-readable report on stdout
 *   --warn     never exit non-zero (report only)
 *
 * Exit 0 = clean, 1 = findings, 2 = usage/IO error.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ───────────────────────────────────────────────────────────────────────────
// Files that ASPNETCORE_ENVIRONMENT=Production actually loads.
// The host adds appsettings.json then appsettings.{Environment}.json, and
// nothing else. appsettings.Docker.json / .Development.json / .Staging.json /
// .Testing.json are unreachable in production by construction — that is the
// entire mechanism behind incident (b).
// ───────────────────────────────────────────────────────────────────────────
const PRODUCTION_APPSETTINGS = ["appsettings.json", "appsettings.Production.json"];

// ───────────────────────────────────────────────────────────────────────────
// docker-compose parsing
//
// Deliberately dependency-free: these lint scripts run in every Gate's CI with
// a bare `node`, no npm install step. The compose file is 2-space-indented and
// regular; this reads the pieces the check needs (per-service `environment:`
// blocks, with `<<: *anchor` merges resolved from the top-level `x-*: &anchor`
// blocks) and ignores everything else.
// ───────────────────────────────────────────────────────────────────────────

function parseComposeEnvironments(composeText) {
  const lines = composeText.split("\n");
  const anchors = new Map();

  // Top-level anchor blocks: `x-dotnet-env: &dotnet-env`
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_.-]+):\s*&([A-Za-z0-9_.-]+)\s*$/.exec(lines[i]);
    if (!m) continue;
    const map = new Map();
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*$/.test(l) || /^\s*#/.test(l)) continue;
      if (!/^\s/.test(l)) break; // dedent to column 0 ends the block
      const kv = /^  ([^\s#][^:]*):\s?(.*)$/.exec(l);
      if (kv) map.set(kv[1].trim(), kv[2].trim());
    }
    anchors.set(m[2], map);
  }

  const services = new Map();
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (start < 0) return services;

  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim() !== "") break; // next top-level key
    const svc = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(l);
    if (svc) {
      cur = { name: svc[1], env: new Map(), profiles: [] };
      services.set(cur.name, cur);
      continue;
    }
    if (!cur) continue;

    const prof = /^    profiles:\s*\[(.*)\]\s*$/.exec(l);
    if (prof) {
      cur.profiles = prof[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }

    if (/^    environment:\s*$/.test(l)) {
      for (let j = i + 1; j < lines.length; j++) {
        const e = lines[j];
        if (/^\s*$/.test(e) || /^\s*#/.test(e)) continue;
        if (!/^      \S/.test(e)) break; // dedent ends the environment block
        const merge = /^      <<:\s*\*([A-Za-z0-9_.-]+)\s*$/.exec(e);
        if (merge) {
          const a = anchors.get(merge[1]);
          if (a) for (const [k, v] of a) cur.env.set(k, v);
          continue;
        }
        const kv = /^      ([^\s#][^:]*):\s?(.*)$/.exec(e);
        if (kv) {
          cur.env.set(kv[1].trim(), kv[2].trim());
          continue;
        }
        const item = /^      -\s+([^=]+)=(.*)$/.exec(e); // list form
        if (item) cur.env.set(item[1].trim(), item[2].trim());
      }
    }
  }
  return services;
}

/** `A__B__C` (the .NET env-var convention) → `A:B:C`. */
const envKeyToConfigPath = (key) => key.replace(/__/g, ":");

/**
 * Does a compose value depend on a host variable that may be unset?
 * `${X:?}`  → deploy fails loudly if unset  → safe
 * `${X:-d}` → defaults                      → safe
 * `${X}`    → EMPTY STRING if unset         → still trips a presence guard
 */
function isUnguardedInterpolation(value) {
  if (typeof value !== "string") return false;
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}$/.exec(value.trim());
  if (!m) return false;
  return m[2] === "";
}

// ───────────────────────────────────────────────────────────────────────────
// appsettings flattening
// ───────────────────────────────────────────────────────────────────────────

/** Every leaf path of a JSON document, in .NET `A:B:0:C` form. */
function flattenLeafPaths(value, prefix, out) {
  if (value === null || typeof value !== "object") {
    if (prefix) out.add(prefix);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0 && prefix) out.add(prefix);
    value.forEach((v, i) => flattenLeafPaths(v, prefix ? `${prefix}:${i}` : String(i), out));
    return out;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 && prefix) out.add(prefix);
  for (const k of keys) flattenLeafPaths(value[k], prefix ? `${prefix}:${k}` : k, out);
  return out;
}

/**
 * Every NAMED section node of a JSON document, with array indices collapsed
 * away: `Consul:Discovery:Services:0:HostName` contributes `Consul`,
 * `Consul:Discovery`, `Consul:Discovery:Services` and
 * `Consul:Discovery:Services:HostName`. Collapsing indices is what makes the
 * fleet-parity comparison meaningful — "Docker registers one more sibling than
 * Production does" is not a defect, "Production has no Services array at all"
 * is.
 */
function collectSectionNodes(value, prefix, out) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) collectSectionNodes(v, prefix, out);
    return out;
  }
  for (const k of Object.keys(value)) {
    const p = prefix ? `${prefix}:${k}` : k;
    out.add(p);
    collectSectionNodes(value[k], p, out);
  }
  return out;
}

function sectionNodesFromEnvKey(key, out) {
  const segs = envKeyToConfigPath(key)
    .split(":")
    .filter((s) => !/^\d+$/.test(s));
  for (let n = 1; n <= segs.length; n++) out.add(segs.slice(0, n).join(":"));
  return out;
}

function readJsonQuiet(file) {
  try {
    // strip a UTF-8 BOM; several appsettings files carry one
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// C# scanning
// ───────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["bin", "obj", "node_modules", ".git", "Migrations"]);

/**
 * `statSync` rather than the Dirent type, so symlinked directories are followed.
 * Submodule working trees and CI checkouts both use them, and a silently
 * unwalked directory is exactly the kind of vacuous green this lint exists to
 * prevent.
 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function collectCsFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    if (isDir(p)) {
      if (SKIP_DIRS.has(name)) continue;
      collectCsFiles(p, out);
    } else if (name.endsWith(".cs")) {
      out.push(p);
    }
  }
  return out;
}

/** Slice from `AddOptions<...>` to the `;` that closes the statement. */
function chainFrom(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * The body of `class X` / `record X` / `struct X`, brace-matched.
 *
 * Scoping matters: several Gates declare the options class in the same file as
 * the service that consumes it (NotifyGate's UnsubscribeOptions lives beside
 * UnsubscribeTokenService), and PaymentGate's MobilePay models declare an
 * unrelated `Secret` property. Regexing the whole file would let a sibling
 * type's `SectionName` or default initialiser answer for this one.
 */
function classBody(typeName, text) {
  const shortName = typeName.split(".").pop();
  const decl = new RegExp(`\\b(?:class|record|struct)\\s+${shortName}\\b`);
  const m = decl.exec(text);
  if (!m) return null;
  const open = text.indexOf("{", m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** Every declaration body for a type across the Gate's sources. */
function bodiesFor(typeName, sources) {
  const out = [];
  for (const [, text] of sources) {
    const b = classBody(typeName, text);
    if (b) out.push(b);
  }
  return out;
}

/** Resolve `XOptions.SectionName` to its literal value across the Gate's sources. */
function resolveSectionNameConst(optionsType, sources) {
  for (const body of bodiesFor(optionsType, sources)) {
    const m = /\bconst\s+string\s+SectionName\s*=\s*"([^"]*)"/.exec(body);
    if (m) return m[1];
    const m2 = /\bstatic\s+(?:readonly\s+)?string\s+SectionName\s*=\s*"([^"]*)"/.exec(body);
    if (m2) return m2[1];
  }
  return null;
}

/**
 * A property with a non-empty C# initialiser satisfies a presence guard without
 * any configuration at all, so it carries no deployment contract.
 * `= string.Empty` / `= ""` / `= null!` do NOT count as defaults.
 */
function propertyHasNonEmptyDefault(optionsType, prop, sources) {
  for (const body of bodiesFor(optionsType, sources)) {
    const re = new RegExp(`\\b${prop}\\s*\\{\\s*get;[^}]*\\}\\s*=\\s*([^;]+);`, "m");
    const m = re.exec(body);
    if (!m) continue;
    const init = m[1].trim();
    if (/^string\.Empty$/.test(init)) return false;
    if (/^""$/.test(init)) return false;
    if (/^null!?$/.test(init)) return false;
    return true;
  }
  return false;
}

/**
 * Properties a `ValidateOnStart` chain requires to be PRESENT.
 * Only presence-shaped guards count — see boundary note 5.
 */
function requiredPropertiesFromChain(chain) {
  const props = new Set();

  // `.Validate(o => ...)` / `.Validate<IHostEnvironment>((o, env) => ...)`
  const lambdaRe = /\.Validate(?:<[^>]*>)?\s*\(\s*(?:\(\s*([A-Za-z_]\w*)\s*(?:,[^)]*)?\)|([A-Za-z_]\w*))\s*=>/g;
  let m;
  while ((m = lambdaRe.exec(chain))) {
    const param = m[1] || m[2];
    if (!param) continue;
    const body = chainFromLambda(chain, m.index + m[0].length);
    if (!body) continue;
    const p = new RegExp(`!\\s*string\\.IsNullOrWhiteSpace\\s*\\(\\s*${param}\\s*\\??\\.\\s*([A-Z]\\w*)`, "g");
    let q;
    while ((q = p.exec(body))) props.add(q[1]);
    const p2 = new RegExp(`!\\s*string\\.IsNullOrEmpty\\s*\\(\\s*${param}\\s*\\??\\.\\s*([A-Z]\\w*)`, "g");
    while ((q = p2.exec(body))) props.add(q[1]);
    // minimum-length guards, e.g. `(options.Secret?.Trim().Length ?? 0) >= Min`.
    // The span between the property and `.Length` may contain calls — and so
    // parentheses (`?.Trim()`) — and the span between `.Length` and the
    // comparison may contain `?? 0)`. Only `;` and `,` are excluded, because
    // those end the statement or the lambda argument.
    const p3 = new RegExp(`${param}\\s*\\??\\.\\s*([A-Z]\\w*)[^;,]{0,80}?\\.Length\\b[^;,]{0,30}?(?:>=|>)`, "g");
    while ((q = p3.exec(body))) props.add(q[1]);
    // explicit null/empty guards, e.g. `options.Key is not null`, `o.Key != null`
    const p4 = new RegExp(`${param}\\s*\\.\\s*([A-Z]\\w*)\\s*(?:is\\s+not\\s+null|!=\\s*null)`, "g");
    while ((q = p4.exec(body))) props.add(q[1]);
  }
  return props;
}

/** Text of a lambda body starting just after `=>`, to the end of that argument. */
function chainFromLambda(chain, from) {
  let depth = 0;
  for (let i = from; i < chain.length; i++) {
    const c = chain[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return chain.slice(from, i);
      depth--;
    } else if (c === "," && depth === 0) {
      return chain.slice(from, i);
    }
  }
  return chain.slice(from);
}

/** `[Required]` / `[MinLength(n)]` properties, for `.ValidateDataAnnotations()`. */
function dataAnnotationRequiredProperties(optionsType, sources) {
  const props = new Set();
  for (const body of bodiesFor(optionsType, sources)) {
    const re = /\[(Required|MinLength)\b[^\]]*\][\s\S]{0,400}?\b(?:public|internal)\s+[\w<>?\[\],\s]+?\s+([A-Z]\w*)\s*\{\s*get;/g;
    let m;
    while ((m = re.exec(body))) props.add(m[2]);
  }
  return props;
}

/** Every boot-validated options chain in a Gate. */
function findBootValidatedOptions(sources) {
  const chains = [];
  const addOptionsRe = /(?:services|Services)\s*\.\s*AddOptions\s*<\s*([A-Za-z0-9_.]+)\s*>\s*\(\s*\)/g;
  for (const [file, text] of sources) {
    let m;
    addOptionsRe.lastIndex = 0;
    while ((m = addOptionsRe.exec(text))) {
      const chain = chainFrom(text, m.index);
      if (!chain || !/\.ValidateOnStart\s*\(\s*\)/.test(chain)) continue;
      const optionsType = m[1];
      let section = null;
      const bind = /\.Bind\s*\(\s*\w+\s*\.\s*GetSection\s*\(\s*(?:"([^"]*)"|([A-Za-z0-9_.]+)\s*\.\s*SectionName)\s*\)/.exec(chain);
      const bindCfg = /\.BindConfiguration\s*\(\s*(?:"([^"]*)"|([A-Za-z0-9_.]+)\s*\.\s*SectionName)\s*\)/.exec(chain);
      const hit = bind || bindCfg;
      if (hit) section = hit[1] !== undefined ? hit[1] : { constOf: hit[2] };
      chains.push({
        file,
        line: text.slice(0, m.index).split("\n").length,
        optionsType,
        section,
        chain,
        dataAnnotations: /\.ValidateDataAnnotations\s*\(\s*\)/.test(chain),
      });
    }
  }
  return chains;
}

// ───────────────────────────────────────────────────────────────────────────
// Gate model
// ───────────────────────────────────────────────────────────────────────────

/** `NotifyGate` → `notify-gate`, `JobFlowGate` → `job-flow-gate`. */
const gateToComposeService = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

function loadGate(gateDir) {
  const srcDir = path.join(gateDir, "src");
  if (!fs.existsSync(srcDir)) return null;
  let entry = null;
  for (const d of fs.readdirSync(srcDir)) {
    if (fs.existsSync(path.join(srcDir, d, "appsettings.json"))) {
      entry = d;
      break;
    }
  }
  if (!entry) return null;
  const settingsDir = path.join(srcDir, entry);

  // The Gate's identity comes from the entry project (`src/<Name>/appsettings.json`),
  // not the checkout directory name. In a Gate's own CI the workspace happens to be
  // named after the repo, but relying on that would make the compose-service lookup
  // — and therefore every CHECK A verdict — depend on where someone cloned it.
  // Verified: for all 47 .NET Gates the entry project equals the repo directory name
  // and kebab-cases to a service that exists in the production compose.
  const name = /Gate$/.test(entry) ? entry : path.basename(path.resolve(gateDir));

  const productionLeafPaths = new Set();
  const productionNodes = new Set();
  for (const f of PRODUCTION_APPSETTINGS) {
    const j = readJsonQuiet(path.join(settingsDir, f));
    if (j) {
      flattenLeafPaths(j, "", productionLeafPaths);
      collectSectionNodes(j, "", productionNodes);
    }
  }

  const nonProductionNodes = new Set();
  const nonProductionFiles = [];
  for (const f of fs.readdirSync(settingsDir)) {
    if (!/^appsettings\.[A-Za-z0-9]+\.json$/.test(f)) continue;
    if (PRODUCTION_APPSETTINGS.includes(f)) continue;
    const j = readJsonQuiet(path.join(settingsDir, f));
    if (!j) continue;
    nonProductionFiles.push(f);
    collectSectionNodes(j, "", nonProductionNodes);
  }

  const sources = new Map();
  for (const f of collectCsFiles(srcDir, [])) sources.set(f, fs.readFileSync(f, "utf8"));

  return {
    name,
    dir: gateDir,
    entryProject: entry,
    settingsDir,
    productionLeafPaths,
    productionNodes,
    nonProductionNodes,
    nonProductionFiles,
    sources,
    composeService: gateToComposeService(name),
  };
}

const lower = (s) => s.toLowerCase();

// ───────────────────────────────────────────────────────────────────────────
// CHECK A
// ───────────────────────────────────────────────────────────────────────────

function checkA(gate, composeService) {
  const findings = [];
  const warnings = [];
  const unresolved = [];

  const composeEnv = composeService ? composeService.env : new Map();
  const composePaths = new Map();
  for (const [k, v] of composeEnv) composePaths.set(lower(envKeyToConfigPath(k)), v);
  const prodPaths = new Set([...gate.productionLeafPaths].map(lower));

  for (const chain of findBootValidatedOptions(gate.sources)) {
    let section = chain.section;
    if (section && typeof section === "object") {
      section = resolveSectionNameConst(section.constOf, gate.sources);
    }
    if (typeof section !== "string" || section === "") {
      unresolved.push({
        gate: gate.name,
        file: path.relative(gate.dir, chain.file),
        line: chain.line,
        optionsType: chain.optionsType,
        reason: "could not resolve the bound configuration section",
      });
      continue;
    }

    const required = requiredPropertiesFromChain(chain.chain);
    if (chain.dataAnnotations) {
      for (const p of dataAnnotationRequiredProperties(chain.optionsType, gate.sources)) required.add(p);
    }

    for (const prop of required) {
      if (propertyHasNonEmptyDefault(chain.optionsType, prop, gate.sources)) continue;
      const configPath = `${section}:${prop}`;
      const key = lower(configPath);
      const inAppsettings = prodPaths.has(key);
      const inCompose = composePaths.has(key);

      if (!inAppsettings && !inCompose) {
        findings.push({
          check: "A",
          gate: gate.name,
          configPath,
          optionsType: chain.optionsType,
          file: path.relative(gate.dir, chain.file),
          line: chain.line,
          composeService: gate.composeService,
          composeSeen: !!composeService,
          message:
            `${gate.name} refuses to boot outside Development unless \`${configPath}\` is set ` +
            `(${chain.optionsType}, ValidateOnStart), but nothing supplies it in Production: ` +
            `it is absent from appsettings.json, appsettings.Production.json` +
            (composeService
              ? `, and from the \`${gate.composeService}\` environment block in the production compose.`
              : `, and no \`${gate.composeService}\` service was found in the production compose.`),
        });
        continue;
      }
      if (inCompose && !inAppsettings && isUnguardedInterpolation(composePaths.get(key))) {
        warnings.push({
          check: "A2",
          gate: gate.name,
          configPath,
          composeService: gate.composeService,
          value: composePaths.get(key),
          message:
            `${gate.name}'s \`${configPath}\` is supplied only by an unguarded compose interpolation ` +
            `(\`${composePaths.get(key)}\`). If that host variable is unset, docker compose substitutes the ` +
            `EMPTY STRING and the boot guard still fails — with no deploy-time error. Use \`\${VAR:?}\` so the ` +
            `deploy fails loudly, or \`\${VAR:-default}\`.`,
        });
      }
    }
  }
  return { findings, warnings, unresolved };
}

// ───────────────────────────────────────────────────────────────────────────
// CHECK B — fleet parity (--tree only)
// ───────────────────────────────────────────────────────────────────────────

const PARITY_MIN_GATES = 10; // a node must be near-universal before absence is a signal
const PARITY_MAX_MISSING_SHARE = 0.2;

/**
 * Two conditions must BOTH hold before a section is reported:
 *
 *   1. INTENT — the Gate declares the section in one of its own non-Production
 *      appsettings files. The Gate has said, in its own repo, that its
 *      containerised estate needs this section; it just put it where a
 *      Production host will never read it.
 *   2. PARITY — the same section IS Production-reachable for a large majority of
 *      the fleet, so the omission is an outlier rather than a design choice.
 *
 * Condition 1 alone is far too weak: measured over the 47-Gate tree it yields 138
 * hits (extra dev Serilog sinks, a second local Consul registration, local
 * `ConnectionStrings`, `Kestrel` port bindings). Condition 2 alone is also too
 * weak: "reachable for 44/47, absent in these 3" yields 20 hits, all legitimate
 * (QuotaGate has no `QuotaGate:Url` because it IS QuotaGate; ServiceGate is a
 * gateway). Together they yield 0 on the corrected tree and fire on the real
 * AdvisorGate/ComplianceGate incident.
 */
/** Every config node a Gate can actually read under Production. */
function productionReachableNodes(gate, composeServices) {
  const nodes = new Set(gate.productionNodes);
  const svc = composeServices.get(gate.composeService);
  if (svc) for (const k of svc.env.keys()) sectionNodesFromEnvKey(k, nodes);
  return nodes;
}

function checkBParity(gates, composeServices) {
  const reachable = new Map(); // node -> Set(gate name)
  const perGate = new Map();

  for (const g of gates) {
    const nodes = productionReachableNodes(g, composeServices);
    perGate.set(g.name, nodes);
    for (const n of nodes) {
      if (!reachable.has(n)) reachable.set(n, new Set());
      reachable.get(n).add(g.name);
    }
  }

  const findings = [];
  for (const [node, holders] of reachable) {
    if (holders.size < PARITY_MIN_GATES) continue;
    // condition 1: declared for a non-Production environment, not reachable in Production
    const missing = gates.filter((g) => !perGate.get(g.name).has(node) && g.nonProductionNodes.has(node));
    if (missing.length === 0) continue;
    // condition 2: the omission is an outlier among the Gates that declare it at all
    const declaring = holders.size + missing.length;
    if (missing.length / declaring > PARITY_MAX_MISSING_SHARE) continue;
    for (const g of missing) {
      findings.push({
        check: "B",
        gate: g.name,
        node,
        reachableIn: holders.size,
        fleetSize: gates.length,
        nonProductionFiles: g.nonProductionFiles,
        message:
          `${g.name} declares \`${node}\` only in a non-Production appsettings file ` +
          `(${g.nonProductionFiles.join(", ")}). .NET loads appsettings.json + ` +
          `appsettings.{ASPNETCORE_ENVIRONMENT}.json and nothing else, so under Production the section is ` +
          `absent at runtime and whatever reads it silently sees empty — no error, no log. ` +
          `${holders.size} of ${gates.length} Gates DO make it Production-reachable. ` +
          `Add it to appsettings.Production.json, or supply it from the \`${g.composeService}\` ` +
          `environment block in the production compose.`,
      });
    }
  }
  // Collapse to the shallowest missing node per Gate. A missing `Consul:Discovery`
  // drags every descendant with it; reporting `Consul:Discovery:Services:HostName`
  // alongside its parent is 18 lines for 2 defects, and volume is how a gate gets
  // ignored. The root of the missing subtree is the actionable fact.
  const flagged = new Set(findings.map((f) => `${f.gate} ${f.node}`));
  const roots = findings.filter((f) => {
    const segs = f.node.split(":");
    for (let n = 1; n < segs.length; n++) {
      if (flagged.has(`${f.gate} ${segs.slice(0, n).join(":")}`)) return false;
    }
    return true;
  });

  // most-shared node first
  roots.sort((a, b) => b.reachableIn - a.reachableIn || a.gate.localeCompare(b.gate));
  return roots;
}

/**
 * The fleet-parity baseline, so CHECK B can also run in a single-Gate checkout.
 *
 * CHECK B needs to know how much of the fleet makes a section Production-reachable,
 * and a Gate's own CI has only that Gate. The counts are therefore computed once
 * from a full-tree run and committed next to the production compose, where a Gate's
 * CI already fetches it.
 *
 * A stale baseline can only cause FALSE NEGATIVES (a newly universal section is not
 * yet listed, so its absence is not yet a signal) — never a false positive, because
 * every listed node is one a large majority of Gates already satisfy. `--tree` never
 * reads the baseline; it recomputes from the live fleet.
 */
function buildBaseline(gates, composeServices) {
  const reachable = {};
  const unreachableWithIntent = {};
  for (const g of gates) {
    const nodes = productionReachableNodes(g, composeServices);
    for (const n of nodes) reachable[n] = (reachable[n] || 0) + 1;
    for (const n of g.nonProductionNodes) {
      if (!nodes.has(n)) unreachableWithIntent[n] = (unreachableWithIntent[n] || 0) + 1;
    }
  }
  // A node earns a baseline entry only if it satisfies BOTH parity conditions the
  // tree-mode check applies. Storing the reachable count alone loses the
  // missing-share denominator, and the check then fires on sections the fleet has
  // never agreed on — measured: `IdentityServer:ValidIssuers` (22 of 47) and
  // `Outbox` (10 of 47) both reported AdvisorGate on the CORRECTED tree.
  const nodes = {};
  for (const [n, r] of Object.entries(reachable).sort()) {
    if (r < PARITY_MIN_GATES) continue;
    const missing = unreachableWithIntent[n] || 0;
    if (missing / (r + missing) > PARITY_MAX_MISSING_SHARE) continue;
    nodes[n] = { reachable: r, unreachableWithIntent: missing };
  }
  return {
    _comment:
      "SX0008 fleet-parity baseline — GENERATED, do not hand-edit. A node is listed only when it is reachable " +
      "under ASPNETCORE_ENVIRONMENT=Production for at least " + PARITY_MIN_GATES + " Gates AND fewer than " +
      Math.round(PARITY_MAX_MISSING_SHARE * 100) + "% of the Gates that declare it fail to make it reachable. " +
      "Regenerate with: node Sitenyx.Build/scripts/lint-config-contract.js --tree <superproject> " +
      "--write-baseline <this file>",
    generatedFrom: {
      gates: gates.length,
      minGates: PARITY_MIN_GATES,
      maxMissingShare: PARITY_MAX_MISSING_SHARE,
    },
    nodes,
  };
}

/** CHECK B for one Gate, using a committed baseline instead of the live fleet. */
function checkBAgainstBaseline(gate, composeServices, baseline) {
  const reachableHere = productionReachableNodes(gate, composeServices);
  const findings = [];
  for (const [node, entry] of Object.entries(baseline.nodes || {})) {
    const count = typeof entry === "number" ? entry : entry.reachable;
    if (reachableHere.has(node)) continue;
    if (!gate.nonProductionNodes.has(node)) continue;
    findings.push({
      check: "B",
      gate: gate.name,
      node,
      reachableIn: count,
      fleetSize: (baseline.generatedFrom && baseline.generatedFrom.gates) || null,
      nonProductionFiles: gate.nonProductionFiles,
      message:
        `${gate.name} declares \`${node}\` only in a non-Production appsettings file ` +
        `(${gate.nonProductionFiles.join(", ")}). .NET loads appsettings.json + ` +
        `appsettings.{ASPNETCORE_ENVIRONMENT}.json and nothing else, so under Production the section is ` +
        `absent at runtime and whatever reads it silently sees empty — no error, no log. ` +
        `${count} Gates DO make it Production-reachable. Add it to appsettings.Production.json, or supply ` +
        `it from the \`${gate.composeService}\` environment block in the production compose.`,
    });
  }
  const flagged = new Set(findings.map((f) => f.node));
  const roots = findings.filter((f) => {
    const segs = f.node.split(":");
    for (let n = 1; n < segs.length; n++) if (flagged.has(segs.slice(0, n).join(":"))) return false;
    return true;
  });
  roots.sort((a, b) => b.reachableIn - a.reachableIn);
  return roots;
}

// ───────────────────────────────────────────────────────────────────────────
// drivers
// ───────────────────────────────────────────────────────────────────────────

function discoverGates(treeRoot) {
  const out = [];
  for (const name of fs.readdirSync(treeRoot)) {
    if (!/Gate$/.test(name)) continue;
    const p = path.join(treeRoot, name);
    if (!isDir(p)) continue;
    const g = loadGate(p);
    if (g) out.push(g);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function loadCompose(file) {
  if (!file) return new Map();
  return parseComposeEnvironments(fs.readFileSync(file, "utf8"));
}

function run(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tree") args.tree = argv[++i];
    else if (a === "--gate") args.gate = argv[++i];
    else if (a === "--compose") args.compose = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--write-baseline") args.writeBaseline = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--warn") args.warn = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else return { exit: 2, error: `unknown argument: ${a}` };
  }
  if (args.help || (!args.tree && !args.gate)) {
    return {
      exit: 2,
      error:
        "usage: lint-config-contract.js --tree <root> [--compose <file>] [--write-baseline <file>]\n" +
        "       lint-config-contract.js --gate <dir> --compose <file> [--baseline <file>]\n" +
        "       [--json] [--warn]",
    };
  }

  const report = { checkA: [], checkA2: [], checkB: [], unresolved: [], scanned: {} };

  if (args.tree) {
    const root = path.resolve(args.tree);
    const composeFile = args.compose || path.join(root, "sitenyx-infra/services/docker-compose.yml");
    if (!fs.existsSync(composeFile)) return { exit: 2, error: `production compose not found: ${composeFile}` };
    const composeServices = loadCompose(composeFile);
    const gates = discoverGates(root);
    report.scanned = { mode: "tree", root, composeFile, gates: gates.length, composeServices: composeServices.size };
    for (const g of gates) {
      const r = checkA(g, composeServices.get(g.composeService));
      report.checkA.push(...r.findings);
      report.checkA2.push(...r.warnings);
      report.unresolved.push(...r.unresolved);
    }
    report.checkB = checkBParity(gates, composeServices);
    if (args.writeBaseline) {
      fs.writeFileSync(args.writeBaseline, JSON.stringify(buildBaseline(gates, composeServices), null, 2) + "\n");
      report.scanned.baselineWritten = args.writeBaseline;
    }
  } else {
    const gateDir = path.resolve(args.gate);
    const gate = loadGate(gateDir);
    if (!gate) return { exit: 2, error: `not a .NET Gate (no src/*/appsettings.json): ${gateDir}` };
    // --compose is MANDATORY here. Without it every key the compose supplies looks
    // unsupplied, and CHECK A reports the whole estate as broken. A caller that
    // cannot fetch the compose must SKIP this lint, not run a version of it that
    // cannot tell a real gap from a missing input.
    if (!args.compose) {
      return { exit: 2, error: "--gate requires --compose: CHECK A cannot distinguish a missing key from a missing compose file" };
    }
    if (!fs.existsSync(args.compose)) return { exit: 2, error: `production compose not found: ${args.compose}` };
    const composeServices = loadCompose(args.compose);
    const svc = composeServices.get(gate.composeService);
    report.scanned = {
      mode: "gate",
      gate: gate.name,
      composeFile: args.compose || null,
      composeService: gate.composeService,
      composeServiceFound: !!svc,
      baselineFile: args.baseline || null,
    };
    const r = checkA(gate, svc);
    report.checkA.push(...r.findings);
    report.checkA2.push(...r.warnings);
    report.unresolved.push(...r.unresolved);

    if (args.baseline) {
      if (!fs.existsSync(args.baseline)) return { exit: 2, error: `parity baseline not found: ${args.baseline}` };
      const baseline = readJsonQuiet(args.baseline);
      if (!baseline || !baseline.nodes) return { exit: 2, error: `parity baseline is unreadable: ${args.baseline}` };
      report.checkB = checkBAgainstBaseline(gate, composeServices, baseline);
      report.scanned.baselineNodes = Object.keys(baseline.nodes).length;
    }
  }

  const failed = report.checkA.length + report.checkB.length;
  return { exit: args.warn ? 0 : failed > 0 ? 1 : 0, report, failed };
}

function printHuman(report, failed) {
  const s = report.scanned;
  if (s.mode === "tree") {
    process.stdout.write(
      `SX0008 config-contract lint — ${s.gates} Gates, compose ${path.relative(s.root, s.composeFile)} ` +
        `(${s.composeServices} services)\n`,
    );
  } else {
    process.stdout.write(
      `SX0008 config-contract lint — ${s.gate} (compose service \`${s.composeService}\`: ` +
        `${s.composeFile ? (s.composeServiceFound ? "found" : "NOT FOUND in " + s.composeFile) : "not supplied"})\n`,
    );
  }

  for (const f of report.checkA) {
    process.stdout.write(`\n::error file=${f.file},line=${f.line}::[SX0008-A] ${f.message}\n`);
  }
  for (const f of report.checkB) {
    process.stdout.write(`\n::error::[SX0008-B] ${f.message}\n`);
  }
  for (const w of report.checkA2) {
    process.stdout.write(`\n::warning::[SX0008-A2] ${w.message}\n`);
  }
  for (const u of report.unresolved) {
    process.stdout.write(
      `\n::warning::[SX0008-?] ${u.gate}: ${u.optionsType} at ${u.file}:${u.line} has ValidateOnStart but ${u.reason} — NOT CHECKED.\n`,
    );
  }

  process.stdout.write(
    `\nCHECK A (boot-required key unsupplied in Production): ${report.checkA.length}\n` +
      `CHECK B (production-unreachable section, fleet parity): ${report.checkB.length}\n` +
      `warnings: ${report.checkA2.length} unguarded interpolation, ${report.unresolved.length} unresolved chain(s)\n` +
      (failed === 0 ? "OK — no config-contract gaps.\n" : `FAIL — ${failed} config-contract gap(s).\n`),
  );
}

if (require.main === module) {
  const res = run(process.argv.slice(2));
  if (res.error) {
    process.stderr.write(res.error + "\n");
    process.exit(res.exit);
  }
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(res.report, null, 2) + "\n");
  else printHuman(res.report, res.failed);
  process.exit(res.exit);
}

module.exports = {
  parseComposeEnvironments,
  envKeyToConfigPath,
  isUnguardedInterpolation,
  flattenLeafPaths,
  collectSectionNodes,
  sectionNodesFromEnvKey,
  gateToComposeService,
  requiredPropertiesFromChain,
  findBootValidatedOptions,
  resolveSectionNameConst,
  propertyHasNonEmptyDefault,
  dataAnnotationRequiredProperties,
  classBody,
  loadGate,
  checkA,
  checkBParity,
  productionReachableNodes,
  buildBaseline,
  checkBAgainstBaseline,
  run,
  PRODUCTION_APPSETTINGS,
};
