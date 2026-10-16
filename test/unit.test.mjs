// Unit tests for the pure parts of the lib: tiers, config merging, finding the codex binary.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { findCodex } from "../skills/co-codex/scripts/lib/codex-bin.mjs";
import { DEFAULTS, clampEffort, loadConfig, merge, resolveTier, userConfigPath } from "../skills/co-codex/scripts/lib/config.mjs";

const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-codex-unit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const model = (id, efforts, extra = {}) => ({ id, supportedReasoningEfforts: efforts.map(e => ({ reasoningEffort: e })), ...extra });

describe("clampEffort", () => {
  test("keeps a supported effort", () => assert.equal(clampEffort("high", ["low", "medium", "high"]), "high"));
  test("drops to the strongest effort below the wanted one", () => {
    assert.equal(clampEffort("ultra", ["low", "medium", "high", "xhigh"]), "xhigh");
    assert.equal(clampEffort("max", ["low", "high", "ultra"]), "high");
  });
  test("rises to the weakest effort when nothing is below", () => assert.equal(clampEffort("minimal", ["medium", "high"]), "medium"));
  test("ignores unknown effort names", () => assert.equal(clampEffort("xhigh", ["turbo", "high"]), "high"));
  test("passes the wish through without a supported list", () => {
    assert.equal(clampEffort("high", []), "high");
    assert.equal(clampEffort("high", undefined), "high");
    assert.equal(clampEffort(undefined, ["low"]), null);
    assert.equal(clampEffort("high", ["turbo"]), "high");
  });
});

describe("resolveTier", () => {
  const config = merge(DEFAULTS, {
    tiers: { test: { about: "t", models: ["first", "second", "third"], effort: "ultra", imageNote: "note" } },
  });

  test("picks the first offered model in the tier's order", () => {
    const r = resolveTier(config, "test", [model("third", ["ultra"]), model("second", ["ultra"])]);
    assert.equal(r.model, "second");
    assert.equal(r.effort, "ultra");
    assert.deepEqual(r.warnings, []);
    assert.equal(r.tier, "test");
    assert.equal(r.imageNote, "note");
    assert.equal(r.about, "t");
  });

  test("skips hidden models", () => {
    const r = resolveTier(config, "test", [model("first", ["ultra"], { hidden: true }), model("third", ["ultra"])]);
    assert.equal(r.model, "third");
  });

  test("accepts the `model` field when `id` is missing", () => {
    const r = resolveTier(config, "test", [{ model: "second", supportedReasoningEfforts: ["high", "ultra"] }]);
    assert.equal(r.model, "second");
    assert.equal(r.effort, "ultra");
  });

  test("clamps the effort and warns", () => {
    const r = resolveTier(config, "test", [model("first", ["low", "medium", "high", "xhigh"])]);
    assert.equal(r.effort, "xhigh");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /first does not support effort "ultra"; using "xhigh"/);
  });

  test("no offered model: null model, the tier's effort and a warning", () => {
    for (const models of [[], undefined, [model("other", ["high"])], [model("first", ["high"], { hidden: true })]]) {
      const r = resolveTier(config, "test", models);
      assert.equal(r.model, null);
      assert.equal(r.effort, "ultra");
      assert.equal(r.warnings.length, 1);
      assert.match(r.warnings[0], /none of the test tier models \(first, second, third\) is offered/);
    }
  });

  test("unknown tier throws with the known names", () => {
    assert.throws(() => resolveTier(DEFAULTS, "nope", []), /unknown tier "nope"; known: draft, standard, high, max/);
  });

  test("default tiers on the default model names", () => {
    const models = [model("gpt-6-luna", ["low", "medium"]), model("gpt-6.1-sol", ["medium", "high"]), model("gpt-6-astra", ["high"])];
    assert.equal(resolveTier(DEFAULTS, "draft", models).model, "gpt-6-luna");
    assert.equal(resolveTier(DEFAULTS, "standard", models).model, "gpt-6.1-sol");
    assert.equal(resolveTier(DEFAULTS, "high", models).effort, "high");
    assert.equal(resolveTier(DEFAULTS, "max", models).model, "gpt-6-astra");
  });
});

describe("merge", () => {
  test("merges nested objects and replaces arrays and scalars", () => {
    const base = { a: 1, nested: { x: 1, y: [1, 2] }, list: [1] };
    const out = merge(base, { nested: { y: [3] , z: true }, list: [9, 8], b: "new" });
    assert.deepEqual(out, { a: 1, nested: { x: 1, y: [3], z: true }, list: [9, 8], b: "new" });
    assert.deepEqual(base, { a: 1, nested: { x: 1, y: [1, 2] }, list: [1] }, "base is not mutated");
  });
  test("null and non-object overrides", () => {
    const base = { a: { b: 1 } };
    assert.equal(merge(base, null), base);
    assert.equal(merge(base, [1]), base);
    assert.equal(merge(base, "x"), base);
    assert.deepEqual(merge(base, { a: null }), { a: null });
    assert.deepEqual(merge(base, { a: 5 }), { a: 5 });
  });
});

describe("loadConfig", () => {
  test("built-in defaults when no file exists", t => {
    const dir = tmp(t);
    const r = loadConfig(dir, { CO_CODEX_CONFIG: path.join(dir, "missing.json") });
    assert.equal(r.config, DEFAULTS);
    assert.deepEqual(r.sources, []);
  });

  test("user file, then project file on top", t => {
    const dir = tmp(t);
    const user = path.join(dir, "user.json");
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj);
    fs.writeFileSync(user, JSON.stringify({ defaultTier: "draft", signature: "[user]", tiers: { draft: { effort: "low" } } }));
    fs.writeFileSync(path.join(proj, ".co-codex.json"), JSON.stringify({ defaultTier: "high", tiers: { draft: { models: ["mine"] } } }));
    const r = loadConfig(proj, { CO_CODEX_CONFIG: user });
    assert.deepEqual(r.sources, [path.resolve(user), path.join(proj, ".co-codex.json")]);
    assert.equal(r.config.defaultTier, "high");
    assert.equal(r.config.signature, "[user]");
    assert.equal(r.config.tiers.draft.effort, "low");
    assert.deepEqual(r.config.tiers.draft.models, ["mine"]);
    assert.equal(r.config.tiers.draft.about, DEFAULTS.tiers.draft.about);
    assert.equal(r.config.spawn.sandbox, "workspace-write");
  });

  test("XDG_CONFIG_HOME locates the user file when CO_CODEX_CONFIG is unset", t => {
    const dir = tmp(t);
    fs.mkdirSync(path.join(dir, "co-codex"));
    fs.writeFileSync(path.join(dir, "co-codex", "config.json"), JSON.stringify({ defaultTier: "max" }));
    assert.equal(userConfigPath({ XDG_CONFIG_HOME: dir }), path.join(dir, "co-codex", "config.json"));
    assert.equal(loadConfig(path.join(dir, "nowhere"), { XDG_CONFIG_HOME: dir }).config.defaultTier, "max");
  });

  test("a broken file names itself", t => {
    const dir = tmp(t);
    const user = path.join(dir, "user.json");
    fs.writeFileSync(user, "{ not json");
    assert.throws(() => loadConfig(dir, { CO_CODEX_CONFIG: user }), /cannot read .*user\.json/);
  });
});

describe("findCodex", () => {
  test("JSON array override", () => {
    assert.deepEqual(findCodex({ CO_CODEX_BIN: '["node", "/x/mock.mjs", "--flag"]' }, "linux"), { file: "node", prefix: ["/x/mock.mjs", "--flag"], shell: false });
    assert.deepEqual(findCodex({ CO_CODEX_BIN: ' ["node","m.mjs"] ' }, "win32"), { file: "node", prefix: ["m.mjs"], shell: false });
  });

  test("path override: .cmd/.bat need a shell on win32 only", () => {
    assert.deepEqual(findCodex({ CO_CODEX_BIN: "C:\\tools\\codex.cmd" }, "win32"), { file: "C:\\tools\\codex.cmd", prefix: [], shell: true });
    assert.equal(findCodex({ CO_CODEX_BIN: "C:\\tools\\CODEX.BAT" }, "win32").shell, true);
    assert.equal(findCodex({ CO_CODEX_BIN: "C:\\tools\\codex.exe" }, "win32").shell, false);
    assert.equal(findCodex({ CO_CODEX_BIN: "/opt/codex.cmd" }, "linux").shell, false);
  });

  test("non-win32 without override uses `codex` from PATH", () => {
    assert.deepEqual(findCodex({ PATH: "/usr/bin" }, "linux", { fallbacks: [] }), { file: "codex", prefix: [], shell: false });
    assert.deepEqual(findCodex({}, "darwin", { fallbacks: [] }), { file: "codex", prefix: [], shell: false });
  });

  test("win32 PATH search follows PATH order; within a folder codex.exe beats the .cmd shim", t => {
    const dir = tmp(t);
    const [a, b, c] = ["a", "b", "c"].map(n => path.join(dir, n));
    for (const d of [a, b, c]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(a, "codex.cmd"), "");
    fs.writeFileSync(path.join(b, "codex.exe"), "");
    fs.writeFileSync(path.join(b, "codex.cmd"), "");
    assert.deepEqual(findCodex({ PATH: [c, b, a].join(path.delimiter) }, "win32"), { file: path.join(b, "codex.exe"), prefix: [], shell: false });
    assert.deepEqual(findCodex({ PATH: [c, a, b].join(path.delimiter) }, "win32"), { file: path.join(a, "codex.cmd"), prefix: [], shell: true });
    assert.deepEqual(findCodex({ Path: [c, a].join(path.delimiter) }, "win32"), { file: path.join(a, "codex.cmd"), prefix: [], shell: true });
    assert.deepEqual(findCodex({ PATH: c }, "win32"), { file: "codex", prefix: [], shell: false });
  });

  test("unix: PATH first, then the fallback folders", t => {
    const dir = tmp(t);
    const [onPath, extra] = ["bin", "extra"].map(n => path.join(dir, n));
    for (const d of [onPath, extra]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(extra, "codex"), "");
    const fallback = path.join(extra, "codex");
    assert.deepEqual(findCodex({ PATH: onPath }, "linux", { fallbacks: [fallback] }), { file: fallback, prefix: [], shell: false });
    fs.writeFileSync(path.join(onPath, "codex"), "");
    assert.deepEqual(findCodex({ PATH: onPath }, "darwin", { fallbacks: [fallback] }), { file: path.join(onPath, "codex"), prefix: [], shell: false });
  });

  test("an empty override is ignored", () => {
    assert.deepEqual(findCodex({ CO_CODEX_BIN: "  " }, "linux", { fallbacks: [] }), { file: "codex", prefix: [], shell: false });
  });
});
