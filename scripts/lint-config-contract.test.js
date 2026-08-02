#!/usr/bin/env node
/**
 * Tests for lint-config-contract.js — SX0008 (BL-4e5be9e4).
 *
 *   node scripts/lint-config-contract.test.js
 *
 * Every behavioural test is written in BOTH directions: a fixture that must be
 * flagged, and the corrected fixture that must be silent. A check that cannot be
 * shown to fail is not evidence that anything passed — that is the exact failure
 * mode this lint exists to prevent, so the tests refuse to repeat it.
 *
 * Exit code 0 → all pass, 1 → at least one fail.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const lint = require("./lint-config-contract.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`✗ ${name}\n  ${err.message}\n`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// compose parsing
// ─────────────────────────────────────────────────────────────────────────

const COMPOSE = `name: sitenyx

x-dotnet-env: &dotnet-env
  ASPNETCORE_ENVIRONMENT: Production
  MainTenant__Identifier: sitenyx.com
  Consul__Host: consul

x-dotnet-defaults: &dotnet-defaults
  restart: always

services:
  notify-gate:
    <<: *dotnet-defaults
    image: ghcr.io/sitenyx/notify-gate:latest
    environment:
      <<: *dotnet-env
      Sql__DatabaseName: notify-gate
      # a comment inside the environment block
      Unsubscribe__Secret: \${NOTIFY_UNSUBSCRIBE_SECRET:?}
      Unsubscribe__PublicHost: https://api.\${DOMAIN}

  cash-gate:
    <<: *dotnet-defaults
    profiles: ["financial-gates"]
    environment:
      <<: *dotnet-env
      Loose__Key: \${MAYBE_UNSET}

volumes:
  id-gate-keys:
`;

test("parseComposeEnvironments finds each service", () => {
  const s = lint.parseComposeEnvironments(COMPOSE);
  assert.deepEqual([...s.keys()], ["notify-gate", "cash-gate"]);
});

test("parseComposeEnvironments merges the <<: *anchor block", () => {
  const s = lint.parseComposeEnvironments(COMPOSE);
  assert.equal(s.get("notify-gate").env.get("MainTenant__Identifier"), "sitenyx.com");
  assert.equal(s.get("cash-gate").env.get("Consul__Host"), "consul");
});

test("parseComposeEnvironments keeps per-service overrides and skips comments", () => {
  const env = lint.parseComposeEnvironments(COMPOSE).get("notify-gate").env;
  assert.equal(env.get("Sql__DatabaseName"), "notify-gate");
  assert.equal(env.get("Unsubscribe__Secret"), "${NOTIFY_UNSUBSCRIBE_SECRET:?}");
  assert.ok(![...env.keys()].some((k) => k.startsWith("#")));
});

test("parseComposeEnvironments reads profiles and stops at the next top-level key", () => {
  const s = lint.parseComposeEnvironments(COMPOSE);
  assert.deepEqual(s.get("cash-gate").profiles, ["financial-gates"]);
  assert.ok(!s.has("volumes"));
});

test("envKeyToConfigPath maps the .NET double-underscore convention", () => {
  assert.equal(lint.envKeyToConfigPath("Consul__Discovery__Services__0__Port"), "Consul:Discovery:Services:0:Port");
});

test("isUnguardedInterpolation distinguishes ${X} from ${X:?} and ${X:-d}", () => {
  assert.equal(lint.isUnguardedInterpolation("${MAYBE_UNSET}"), true);
  assert.equal(lint.isUnguardedInterpolation("${NOTIFY_UNSUBSCRIBE_SECRET:?}"), false);
  assert.equal(lint.isUnguardedInterpolation("${IMAGE_SHA:-unknown}"), false);
  assert.equal(lint.isUnguardedInterpolation("https://api.${DOMAIN}"), false); // not a bare interpolation
  assert.equal(lint.isUnguardedInterpolation("sitenyx.com"), false);
});

// ─────────────────────────────────────────────────────────────────────────
// appsettings flattening
// ─────────────────────────────────────────────────────────────────────────

test("flattenLeafPaths produces .NET leaf paths including array indices", () => {
  const out = [...lint.flattenLeafPaths({ Consul: { Discovery: { Services: [{ Port: 80 }] } } }, "", new Set())];
  assert.deepEqual(out, ["Consul:Discovery:Services:0:Port"]);
});

test("collectSectionNodes collapses array indices away", () => {
  const out = [...lint.collectSectionNodes({ Consul: { Discovery: { Services: [{ Port: 80 }, { Port: 81 }] } } }, "", new Set())];
  assert.deepEqual(out, ["Consul", "Consul:Discovery", "Consul:Discovery:Services", "Consul:Discovery:Services:Port"]);
});

test("sectionNodesFromEnvKey yields every named prefix, indices dropped", () => {
  const out = [...lint.sectionNodesFromEnvKey("Consul__Discovery__Services__0__Port", new Set())];
  assert.deepEqual(out, ["Consul", "Consul:Discovery", "Consul:Discovery:Services", "Consul:Discovery:Services:Port"]);
});

test("gateToComposeService kebab-cases multi-word Gate names", () => {
  assert.equal(lint.gateToComposeService("NotifyGate"), "notify-gate");
  assert.equal(lint.gateToComposeService("JobFlowGate"), "job-flow-gate");
  assert.equal(lint.gateToComposeService("PetGroomerGate"), "pet-groomer-gate");
});

// ─────────────────────────────────────────────────────────────────────────
// C# extraction — the half that silently under-reported during development
// ─────────────────────────────────────────────────────────────────────────

test("requiredPropertiesFromChain catches a min-length guard through ?.Trim()", () => {
  // NotifyGate's real shape. An earlier revision of the regex could not cross the
  // parentheses of `?.Trim()`, so it returned NO required properties for the very
  // key this lint was written for and reported a clean tree.
  const chain = `services.AddOptions<UnsubscribeOptions>()
      .Bind(configuration.GetSection(UnsubscribeOptions.SectionName))
      .Validate<IHostEnvironment>(
          (options, env) => env.IsDevelopment()
                            || (options.Secret?.Trim().Length ?? 0) >= UnsubscribeOptions.MinSecretLength,
          "message")
      .ValidateOnStart();`;
  assert.deepEqual([...lint.requiredPropertiesFromChain(chain)], ["Secret"]);
});

test("requiredPropertiesFromChain catches IsNullOrWhiteSpace guards", () => {
  const chain = `services.AddOptions<MobilePayOptions>()
      .Bind(configuration.GetSection(MobilePayOptions.SectionName))
      .Validate(opts => !string.IsNullOrWhiteSpace(opts.BaseUrl), "a")
      .Validate(opts => !string.IsNullOrEmpty(opts.AccessTokenUrl), "b")
      .ValidateOnStart();`;
  assert.deepEqual([...lint.requiredPropertiesFromChain(chain)].sort(), ["AccessTokenUrl", "BaseUrl"]);
});

test("requiredPropertiesFromChain ignores validation that is NOT a presence check", () => {
  // ExpenseGate's AnthropicOptions deliberately tolerates an unset key
  // (AI-disabled graceful degradation) and only rejects literal placeholders.
  const chain = `services.AddOptions<AnthropicOptions>()
      .BindConfiguration(AnthropicOptions.SectionName)
      .Validate(opts => !AnthropicOptions.IsLiteralPlaceholder(opts.ApiKey), "m")
      .ValidateOnStart();`;
  assert.deepEqual([...lint.requiredPropertiesFromChain(chain)], []);
});

test("findBootValidatedOptions requires ValidateOnStart and resolves both bind forms", () => {
  const src = new Map([
    [
      "/x/DependencyInjection.cs",
      `services.AddOptions<A>().Bind(configuration.GetSection(A.SectionName)).ValidateOnStart();
       services.AddOptions<B>().BindConfiguration("Literal:Section").ValidateOnStart();
       services.AddOptions<C>().Bind(configuration.GetSection("NotValidated"));`,
    ],
  ]);
  const chains = lint.findBootValidatedOptions(src);
  assert.deepEqual(chains.map((c) => c.optionsType), ["A", "B"]);
  assert.deepEqual(chains[0].section, { constOf: "A" });
  assert.equal(chains[1].section, "Literal:Section");
});

test("classBody scopes lookups to the right type in a multi-type file", () => {
  const text = `public class Other { public const string SectionName = "WRONG"; }
                public class UnsubscribeOptions { public const string SectionName = "Unsubscribe";
                  public string Secret { get; set; } = string.Empty; }`;
  const sources = new Map([["/x/f.cs", text]]);
  assert.equal(lint.resolveSectionNameConst("UnsubscribeOptions", sources), "Unsubscribe");
  assert.equal(lint.resolveSectionNameConst("Other", sources), "WRONG");
});

test("propertyHasNonEmptyDefault treats string.Empty as no default but a literal as a default", () => {
  const sources = new Map([
    ["/x/f.cs", `public class O { public string Secret { get; set; } = string.Empty;
                                  public string Name { get; set; } = "Sitenyx ApS"; }`],
  ]);
  assert.equal(lint.propertyHasNonEmptyDefault("O", "Secret", sources), false);
  assert.equal(lint.propertyHasNonEmptyDefault("O", "Name", sources), true);
});

test("dataAnnotationRequiredProperties picks up [Required]", () => {
  const sources = new Map([
    ["/x/f.cs", `public class O { [Required] public string ApiKey { get; set; } = string.Empty;
                                  public string Other { get; set; } = string.Empty; }`],
  ]);
  assert.deepEqual([...lint.dataAnnotationRequiredProperties("O", sources)], ["ApiKey"]);
});

// ─────────────────────────────────────────────────────────────────────────
// CHECK A, end to end over a temp Gate — both directions
// ─────────────────────────────────────────────────────────────────────────

function makeGate(root, gateName, { appsettings, production, docker, di, options }) {
  const dir = path.join(root, gateName);
  const entry = path.join(dir, "src", gateName);
  fs.mkdirSync(entry, { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "Infrastructure"), { recursive: true });
  fs.writeFileSync(path.join(entry, "appsettings.json"), JSON.stringify(appsettings || {}));
  if (production) fs.writeFileSync(path.join(entry, "appsettings.Production.json"), JSON.stringify(production));
  if (docker) fs.writeFileSync(path.join(entry, "appsettings.Docker.json"), JSON.stringify(docker));
  fs.writeFileSync(path.join(dir, "src", "Infrastructure", "DependencyInjection.cs"), di || "");
  fs.writeFileSync(path.join(dir, "src", "Infrastructure", "Options.cs"), options || "");
  return dir;
}

const DI = `public static class DependencyInjection {
  public static void Add(IServiceCollection services, IConfiguration configuration) {
    services.AddOptions<WidgetOptions>()
        .Bind(configuration.GetSection(WidgetOptions.SectionName))
        .Validate(o => !string.IsNullOrWhiteSpace(o.Secret), "required")
        .ValidateOnStart();
  }
}`;
const OPTIONS = `public class WidgetOptions {
  public const string SectionName = "Widget";
  public string Secret { get; set; } = string.Empty;
}`;
const COMPOSE_WITHOUT = `services:
  widget-gate:
    environment:
      Sql__DatabaseName: widget-gate
`;
const COMPOSE_WITH = `services:
  widget-gate:
    environment:
      Sql__DatabaseName: widget-gate
      Widget__Secret: \${WIDGET_SECRET:?}
`;

function withTmp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx0008-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("CHECK A flags a boot-required key that nothing supplies", () => {
  withTmp((root) => {
    makeGate(root, "WidgetGate", { appsettings: { Widget: {} }, di: DI, options: OPTIONS });
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, COMPOSE_WITHOUT);
    const res = lint.run(["--gate", path.join(root, "WidgetGate"), "--compose", compose]);
    assert.equal(res.exit, 1, "expected a non-zero exit");
    assert.equal(res.report.checkA.length, 1);
    assert.equal(res.report.checkA[0].configPath, "Widget:Secret");
  });
});

test("CHECK A is silent once the compose supplies the key (the fix)", () => {
  withTmp((root) => {
    makeGate(root, "WidgetGate", { appsettings: { Widget: {} }, di: DI, options: OPTIONS });
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, COMPOSE_WITH);
    const res = lint.run(["--gate", path.join(root, "WidgetGate"), "--compose", compose]);
    assert.equal(res.exit, 0, "expected a clean exit");
    assert.equal(res.report.checkA.length, 0);
  });
});

test("CHECK A is silent when appsettings.Production.json supplies the key", () => {
  withTmp((root) => {
    makeGate(root, "WidgetGate", {
      appsettings: { Widget: {} },
      production: { Widget: { Secret: "x".repeat(32) } },
      di: DI,
      options: OPTIONS,
    });
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, COMPOSE_WITHOUT);
    const res = lint.run(["--gate", path.join(root, "WidgetGate"), "--compose", compose]);
    assert.equal(res.exit, 0);
  });
});

test("CHECK A still flags when the key is ONLY in appsettings.Docker.json", () => {
  // Production never loads that file — the (b) mechanism, reached through (a).
  withTmp((root) => {
    makeGate(root, "WidgetGate", {
      appsettings: { Widget: {} },
      docker: { Widget: { Secret: "x".repeat(32) } },
      di: DI,
      options: OPTIONS,
    });
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, COMPOSE_WITHOUT);
    const res = lint.run(["--gate", path.join(root, "WidgetGate"), "--compose", compose]);
    assert.equal(res.exit, 1);
    assert.equal(res.report.checkA[0].configPath, "Widget:Secret");
  });
});

test("CHECK A2 warns (but does not fail) on an unguarded ${VAR} interpolation", () => {
  withTmp((root) => {
    makeGate(root, "WidgetGate", { appsettings: { Widget: {} }, di: DI, options: OPTIONS });
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, `services:\n  widget-gate:\n    environment:\n      Widget__Secret: \${WIDGET_SECRET}\n`);
    const res = lint.run(["--gate", path.join(root, "WidgetGate"), "--compose", compose]);
    assert.equal(res.exit, 0, "an unguarded interpolation is a warning, not a failure");
    assert.equal(res.report.checkA2.length, 1);
    assert.equal(res.report.checkA2[0].configPath, "Widget:Secret");
  });
});

test("--gate refuses to run without --compose rather than emit false positives", () => {
  withTmp((root) => {
    makeGate(root, "WidgetGate", { appsettings: { Widget: {} }, di: DI, options: OPTIONS });
    const res = lint.run(["--gate", path.join(root, "WidgetGate")]);
    assert.equal(res.exit, 2);
    assert.ok(/requires --compose/.test(res.error), res.error);
  });
});

test("an options chain whose section cannot be resolved is REPORTED, not skipped silently", () => {
  withTmp((root) => {
    makeGate(root, "WidgetGate", {
      appsettings: {},
      di: `services.AddOptions<WidgetOptions>().Bind(SomethingExotic()).Validate(o => !string.IsNullOrWhiteSpace(o.Secret), "m").ValidateOnStart();`,
      options: OPTIONS,
    });
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, COMPOSE_WITHOUT);
    const res = lint.run(["--gate", path.join(root, "WidgetGate"), "--compose", compose]);
    assert.equal(res.report.unresolved.length, 1);
    assert.equal(res.report.unresolved[0].optionsType, "WidgetOptions");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CHECK B — fleet parity, both directions
// ─────────────────────────────────────────────────────────────────────────

function parityFixture(root, { advisorProductionHasConsul }) {
  const consul = { Discovery: { Services: [{ ServiceName: "s", Port: 80 }] } };
  for (let i = 0; i < 12; i++) {
    makeGate(root, `Filler${i}Gate`, { appsettings: { Consul: consul }, di: "", options: "" });
  }
  makeGate(root, "AdvisorGate", {
    appsettings: { Consul: { Host: "localhost" } },
    production: advisorProductionHasConsul ? { Consul: consul } : { Consul: { Host: "consul" } },
    docker: { Consul: consul },
    di: "",
    options: "",
  });
  const compose = path.join(root, "compose.yml");
  fs.writeFileSync(compose, "services:\n  advisor-gate:\n    environment:\n      Sql__DatabaseName: advisor-gate\n");
  return compose;
}

test("CHECK B flags a section declared only in appsettings.Docker.json", () => {
  withTmp((root) => {
    const compose = parityFixture(root, { advisorProductionHasConsul: false });
    const res = lint.run(["--tree", root, "--compose", compose]);
    assert.equal(res.exit, 1);
    const nodes = res.report.checkB.map((f) => `${f.gate}/${f.node}`);
    assert.deepEqual(nodes, ["AdvisorGate/Consul:Discovery"], JSON.stringify(nodes));
  });
});

test("CHECK B is silent once the section reaches appsettings.Production.json (the fix)", () => {
  withTmp((root) => {
    const compose = parityFixture(root, { advisorProductionHasConsul: true });
    const res = lint.run(["--tree", root, "--compose", compose]);
    assert.equal(res.exit, 0, JSON.stringify(res.report.checkB));
  });
});

test("CHECK B stays silent when too few Gates share the section (no fleet consensus)", () => {
  withTmp((root) => {
    // Only 3 Gates declare it — below PARITY_MIN_GATES, so absence proves nothing.
    for (let i = 0; i < 3; i++) makeGate(root, `Filler${i}Gate`, { appsettings: { Rare: { Key: 1 } }, di: "", options: "" });
    makeGate(root, "AdvisorGate", { appsettings: {}, docker: { Rare: { Key: 1 } }, di: "", options: "" });
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, "services:\n  advisor-gate:\n    environment:\n      X: y\n");
    const res = lint.run(["--tree", root, "--compose", compose]);
    assert.equal(res.report.checkB.length, 0);
  });
});

test("CHECK B reports only the shallowest missing node, not every descendant", () => {
  withTmp((root) => {
    const compose = parityFixture(root, { advisorProductionHasConsul: false });
    const res = lint.run(["--tree", root, "--compose", compose]);
    assert.ok(!res.report.checkB.some((f) => f.node.startsWith("Consul:Discovery:")), "descendants must be collapsed");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The fleet-parity baseline — the bridge that lets CHECK B run in a
// single-Gate CI checkout. It MUST agree with a full --tree run.
// ─────────────────────────────────────────────────────────────────────────

test("--write-baseline emits only nodes that pass BOTH parity conditions", () => {
  withTmp((root) => {
    // `Shared` is reachable for 12 Gates and nobody misses it → belongs in the baseline.
    // `Contested` is reachable for 12 Gates but 12 more declare it Docker-only
    // (50% > 20%) → the fleet has never agreed on it, so it must NOT be listed.
    for (let i = 0; i < 12; i++) {
      makeGate(root, `A${i}Gate`, { appsettings: { Shared: { K: 1 }, Contested: { K: 1 } }, di: "", options: "" });
    }
    for (let i = 0; i < 12; i++) {
      makeGate(root, `B${i}Gate`, { appsettings: { Shared: { K: 1 } }, docker: { Contested: { K: 1 } }, di: "", options: "" });
    }
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, "services: {}\n");
    const out = path.join(root, "baseline.json");
    lint.run(["--tree", root, "--compose", compose, "--write-baseline", out]);
    const baseline = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.ok(baseline.nodes.Shared, "Shared must be in the baseline");
    assert.equal(baseline.nodes.Contested, undefined, "Contested must NOT be in the baseline");
  });
});

test("baseline-driven CHECK B agrees with --tree on the same fixture (no false positive)", () => {
  // The regression this guards: an earlier baseline stored only the reachable
  // count, dropping the missing-share condition. Gate mode then reported
  // AdvisorGate for `IdentityServer:ValidIssuers` (22 of 47) and `Outbox`
  // (10 of 47) on the CORRECTED tree — findings --tree never produced.
  withTmp((root) => {
    for (let i = 0; i < 12; i++) {
      makeGate(root, `A${i}Gate`, { appsettings: { Shared: { K: 1 }, Contested: { K: 1 } }, di: "", options: "" });
    }
    for (let i = 0; i < 12; i++) {
      makeGate(root, `B${i}Gate`, { appsettings: { Shared: { K: 1 } }, docker: { Contested: { K: 1 } }, di: "", options: "" });
    }
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, "services: {}\n");
    const out = path.join(root, "baseline.json");
    const treeRun = lint.run(["--tree", root, "--compose", compose, "--write-baseline", out]);
    assert.equal(treeRun.report.checkB.length, 0, "tree mode must be clean here");

    const gateRun = lint.run(["--gate", path.join(root, "B0Gate"), "--compose", compose, "--baseline", out]);
    assert.equal(gateRun.report.checkB.length, 0, JSON.stringify(gateRun.report.checkB.map((f) => f.node)));
  });
});

test("baseline-driven CHECK B still flags the real gap", () => {
  withTmp((root) => {
    for (let i = 0; i < 12; i++) makeGate(root, `A${i}Gate`, { appsettings: { Shared: { K: 1 } }, di: "", options: "" });
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, "services: {}\n");
    const out = path.join(root, "baseline.json");
    lint.run(["--tree", root, "--compose", compose, "--write-baseline", out]);

    // A Gate that declares the fleet-wide section only for Docker.
    makeGate(root, "LateGate", { appsettings: {}, docker: { Shared: { K: 1 } }, di: "", options: "" });
    const res = lint.run(["--gate", path.join(root, "LateGate"), "--compose", compose, "--baseline", out]);
    assert.equal(res.exit, 1);
    assert.deepEqual(res.report.checkB.map((f) => f.node), ["Shared"]);
  });
});

test("a missing or unreadable baseline is an error, never a silent pass", () => {
  withTmp((root) => {
    makeGate(root, "WidgetGate", { appsettings: { Widget: { Secret: "s" } }, di: DI, options: OPTIONS });
    const compose = path.join(root, "compose.yml");
    fs.writeFileSync(compose, COMPOSE_WITHOUT);
    const missing = lint.run(["--gate", path.join(root, "WidgetGate"), "--compose", compose, "--baseline", path.join(root, "nope.json")]);
    assert.equal(missing.exit, 2);
    const bad = path.join(root, "bad.json");
    fs.writeFileSync(bad, "{not json");
    const unreadable = lint.run(["--gate", path.join(root, "WidgetGate"), "--compose", compose, "--baseline", bad]);
    assert.equal(unreadable.exit, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
