// Unit tests for the pure parts of the lib: tiers, config merging, finding the codex binary.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { findCodex } from "../skills/co-codex/scripts/lib/codex-bin.mjs";
import { DEFAULTS, clampEffort, loadConfig, merge, resolveTier, userConfigPath } from "../skills/co-codex/scripts/lib/config.mjs";
import { parseKeepLine, parseNames, planNames, pngSize } from "../skills/co-codex/scripts/lib/images.mjs";
import { networkHints, sandboxOf } from "../skills/co-codex/scripts/lib/sandbox.mjs";
import { declinedActions, soundsRefused } from "../skills/co-codex/scripts/lib/turns.mjs";
import { newer } from "../skills/co-codex/scripts/lib/install.mjs";
import { estimate, logRun, usageLogPath, windowsOf } from "../skills/co-codex/scripts/lib/usage.mjs";

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

describe("refused actions", () => {
  test("the matcher hears refusals and nothing else", () => {
    for (const s of ["not approved by the user", "user DECLINED", "user rejected the tool call", "User denied it", "approval required",
      "this action requires approval", "needs approval", "blocked by the approval policy", "the user did not approve"])
      assert.ok(soundsRefused(s), s);
    for (const s of ["timed out", "connection reset", "404 not found", "", null, undefined, "approved",
      "EACCES: permission denied, open 'x'", "HTTP 403: access denied", "upstream rejected the request: 429", "payment declined by provider"])
      assert.ok(!soundsRefused(s), String(s));
  });

  test("declinedActions picks declined commands and file changes and refused tool calls", () => {
    const e = item => ({ threadId: "t", turnId: "u", item });
    const out = declinedActions([
      e({ type: "commandExecution", command: "npm publish", status: "declined" }),
      e({ type: "commandExecution", command: "npm test", status: "failed", aggregatedOutput: "denied" }),
      e({ type: "fileChange", status: "declined", changes: [{ path: "a.txt" }, { path: "b.txt" }] }),
      e({ type: "fileChange", status: "completed", changes: [{ path: "c.txt" }] }),
      e({ type: "mcpToolCall", server: "sites", tool: "share", status: "failed", error: { message: "user declined" } }),
      e({ type: "mcpToolCall", server: "docs", tool: "search", status: "failed", error: { message: "timed out" } }),
      e({ type: "mcpToolCall", server: "fs", tool: "read", status: "failed", error: { message: "EACCES: permission denied, open 'x'" } }),
      e({ type: "dynamicToolCall", namespace: "app", tool: "invite", status: "failed", contentItems: [{ type: "inputText", text: "not approved" }] }),
      e({ type: "dynamicToolCall", tool: "lookup", status: "failed", contentItems: [{ type: "inputText", text: "no such record" }] }),
    ]);
    assert.deepEqual(out, [
      { type: "commandExecution", action: "npm publish", reason: "declined: needs approval" },
      { type: "fileChange", action: "edit a.txt, b.txt", reason: "declined: needs approval" },
      { type: "mcpToolCall", action: "sites.share", reason: "user declined" },
      { type: "dynamicToolCall", action: "app.invite", reason: "not approved" },
    ]);
  });
});

describe("named images", () => {
  test("parseNames adds .png and refuses paths, duplicates and other formats", () => {
    assert.deepEqual(parseNames("hero, icon.png ,Logo.PNG"), ["hero.png", "icon.png", "Logo.PNG"]);
    for (const bad of ["", " , ", "a/b.png", "a\\b.png", "../a.png", "..", "a:b.png", "a,a.png", "x.jpg", "x.webp"]) assert.throws(() => parseNames(bad), Error, bad);
  });

  test("parseKeepLine reads the last KEEP line and needs every name once", () => {
    const names = ["a.png", "b.png"];
    assert.deepEqual(parseKeepLine("done\nKEEP: a.png=3, b.png=1", names), { "a.png": 3, "b.png": 1 });
    assert.deepEqual(parseKeepLine("KEEP: a=9, b=9\nmore\n`KEEP: A.PNG=2, b=#4`", names), { "a.png": 2, "b.png": 4 });
    assert.equal(parseKeepLine("no line here", names), null);
    assert.equal(parseKeepLine("KEEP: a.png=1", names), null);
    assert.equal(parseKeepLine("KEEP: a.png=1, b.png=2, c.png=3", names), null);
    assert.equal(parseKeepLine("KEEP: a.png=1, a.png=2", names), null);
    assert.equal(parseKeepLine("KEEP: a.png=one, b.png=2", names), null);
  });

  test("parseKeepLine tolerates the ways models decorate the line", () => {
    const names = ["a.png", "b.png"], want = { "a.png": 1, "b.png": 2 };
    for (const line of [
      "- KEEP: a.png=1, b.png=2",          // list marker
      "* KEEP: a.png=1, b.png=2",
      "> KEEP: a.png=1, b.png=2",          // quote marker
      "KEEP: a.png=1, b.png=2.",           // trailing punctuation
      "KEEP: a.png=1; b.png=2",            // ";" between pairs
      "KEEP: a.png = 1 , b.png = 2 \r\n",
      "KEEP: a.png=1,b.png=2 (retry of 1)", // a remark after the pairs
      "KEEP: a.png=1, b.png=2, all checked against the brief",
    ]) assert.deepEqual(parseKeepLine(`Done.\n${line}`, names), want, line);
    assert.equal(planNames([{ itemId: "i1", savedPath: "x" }, { itemId: "i2", savedPath: "y" }, { itemId: "i3", savedPath: "z" }], names, "KEEP: a.png=0, b.png=2").matchedBy, null);
  });

  test("planNames: KEEP line, then order, then nothing", () => {
    const img = (id, ok = true) => ({ itemId: id, savedPath: ok ? `/x/${id}.png` : null, failure: null });
    const own = [img("i1"), img("i2", false), img("i3"), img("i4")];
    const keep = planNames(own, ["a.png", "b.png"], "KEEP: a.png=4, b.png=1");
    assert.equal(keep.matchedBy, "keep-line");
    assert.deepEqual(keep.kept.map(k => [k.name, k.image.itemId]), [["a.png", "i4"], ["b.png", "i1"]]);
    assert.deepEqual(keep.rejected.map(i => i.itemId), ["i3"]);
    assert.equal(keep.warning, null);
    // the same position twice, or a failed generation, falls back
    assert.equal(planNames(own, ["a.png", "b.png"], "KEEP: a.png=1, b.png=1").matchedBy, null);
    const byOrder = planNames(own, ["a.png", "b.png", "c.png"], "KEEP: a.png=2, b.png=3, c.png=4");
    assert.equal(byOrder.matchedBy, "order");
    assert.deepEqual(byOrder.kept.map(k => k.image.itemId), ["i1", "i3", "i4"]);
    assert.match(byOrder.warning, /check them/);
    const none = planNames(own, ["a.png"], "");
    assert.equal(none.matchedBy, null);
    assert.match(none.warning, /could not match names/);
  });

  test("pngSize reads IHDR and returns null for anything else", t => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    png.writeUInt32BE(1538, 16);
    png.writeUInt32BE(1022, 20);
    assert.deepEqual(pngSize(png), { width: 1538, height: 1022 });
    const dir = tmp(t);
    fs.writeFileSync(path.join(dir, "a.png"), png);
    fs.writeFileSync(path.join(dir, "b.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(30).fill(0)]));
    fs.writeFileSync(path.join(dir, "short.png"), png.subarray(0, 10));
    assert.deepEqual(pngSize(path.join(dir, "a.png")), { width: 1538, height: 1022 });
    assert.equal(pngSize(path.join(dir, "b.jpg")), null);
    assert.equal(pngSize(path.join(dir, "short.png")), null);
    assert.equal(pngSize(path.join(dir, "missing.png")), null);
  });
});

describe("sandbox", () => {
  test("sandboxOf reads every policy type and falls back to the requested mode", () => {
    assert.deepEqual(sandboxOf({ type: "dangerFullAccess" }), { sandbox: "danger-full-access", network: true });
    assert.deepEqual(sandboxOf({ type: "workspaceWrite", networkAccess: true }), { sandbox: "workspace-write", network: true });
    assert.deepEqual(sandboxOf({ type: "workspaceWrite" }), { sandbox: "workspace-write", network: false });
    assert.deepEqual(sandboxOf({ type: "readOnly", networkAccess: false }), { sandbox: "read-only", network: false });
    assert.deepEqual(sandboxOf({ type: "externalSandbox", networkAccess: "enabled" }), { sandbox: "external", network: true });
    assert.deepEqual(sandboxOf(undefined, "workspace-write"), { sandbox: "workspace-write", network: null });
    assert.deepEqual(sandboxOf(null, "danger-full-access"), { sandbox: "danger-full-access", network: true });
  });

  test("networkHints finds command-like phrases only", () => {
    assert.deepEqual(networkHints("Run pnpm install, git push, then publish to Codex Sites"), ["pnpm install", "git push", "publish to", "codex sites"]);
    assert.deepEqual(networkHints("Create a Sites project and publish the site"), ["sites project", "publish the site"]);
    assert.deepEqual(networkHints("npm i, yarn add x, npm publish, pip install y, cargo install z, git clone r, curl it, wget it, deploy the app"),
      ["npm i", "yarn add", "npm publish", "pip install", "cargo install", "git clone", "curl", "wget", "deploy the"]);
    assert.deepEqual(networkHints("Wdróż stronę na serwer"), ["wdróż"]);
    for (const quiet of ["A square Instagram ad with a 'Download now' button", "Hero image for the page we will publish next week",
      "Banner: Pobierz aplikację", "Icon for the app install screen", "Poster for an npm meetup", "Draw an icon for our web sites", ""])
      assert.deepEqual(networkHints(quiet), [], quiet);
  });
});

describe("usage", () => {
  test("windowsOf picks the windows by length", () => {
    assert.deepEqual(windowsOf({ rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300 }, secondary: { usedPercent: 3, windowDurationMins: 10080 } } }), { fiveHour: 7, weekly: 3 });
    assert.deepEqual(windowsOf({ rateLimits: { primary: { usedPercent: 3, windowDurationMins: 10080 } } }), { fiveHour: null, weekly: 3 });
    assert.deepEqual(windowsOf(null), { fiveHour: null, weekly: null });
  });

  test("the log sits in the user config folder, never next to CO_CODEX_CONFIG", () => {
    const xdg = path.join(os.tmpdir(), "xdg-test");
    assert.equal(usageLogPath({ XDG_CONFIG_HOME: xdg, CO_CODEX_CONFIG: "/some/project/co-codex.json" }), path.join(xdg, "co-codex", "usage.jsonl"));
    assert.equal(usageLogPath({}), path.join(os.homedir(), ".config", "co-codex", "usage.jsonl"));
  });

  test("the estimate pools whole-percent deltas: summed deltas over summed images", t => {
    const env = { XDG_CONFIG_HOME: tmp(t) };
    assert.equal(estimate(10, { env }).runs, 0);
    const run = (b5, a5, bw, aw, images, tier = "draft") => logRun({ fiveHour: { before: b5, after: a5 }, weekly: { before: bw, after: aw } }, { tier, model: "m", effort: "e", images }, env);
    run(10, 10, 40, 40, 1); // three runs too small to move a whole percent
    run(10, 10, 40, 40, 1);
    run(10, 10, 40, 40, 1);
    run(10, 14, 40, 42, 2); // one run that did
    run(50, 10, 42, 43, 4); // the 5-hour window reset during the run: that delta is unknown
    run(1, 2, 1, 2, 0);     // no images: left out
    run(0, 0, 0, 0, 3, "max");
    const draft = estimate(10, { tier: "draft", env });
    assert.equal(draft.runs, 5);
    assert.deepEqual(draft.fiveHour, { percent: 8, used: true });  // 4% over 5 images
    assert.deepEqual(draft.weekly, { percent: 3.3, used: true });   // 3% over 9 images
    assert.deepEqual(estimate(1, { tier: "draft", env }).weekly, { percent: 0.3, used: true });
    assert.deepEqual(estimate(10, { tier: "max", env }).fiveHour, { percent: 0, used: false });
    assert.equal(estimate(10, { env }).runs, 6);
    assert.equal(draft.legacy, true); // logged without start times
    const lines = fs.readFileSync(usageLogPath(env), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(lines[4].fiveHourDelta, null);
    assert.equal(lines[4].weeklyDelta, 1);
  });

  test("runs that overlap in time are measured together, so parallel runs do not count each other's use", t => {
    const env = { XDG_CONFIG_HOME: tmp(t) };
    const at = m => `2026-10-28T08:${String(m).padStart(2, "0")}:00Z`;
    const line = (s, e, b5, a5, images, tier = "high") => JSON.stringify({
      start: at(s), date: at(e), tier, images, fiveHourDelta: a5 - b5, weeklyDelta: 0,
      fiveHour: { before: b5, after: a5 }, weekly: { before: 1, after: 1 },
    });
    fs.mkdirSync(path.dirname(usageLogPath(env)), { recursive: true });
    fs.writeFileSync(usageLogPath(env), [
      JSON.stringify({ date: at(0), tier: "high", images: 1, fiveHourDelta: 50, weeklyDelta: 9 }), // no start time: left out
      line(10, 20, 10, 20, 2), // two parallel runs: 10 + 8 points on their own,
      line(15, 22, 14, 22, 2), // but the window went from 10 to 22 while they ran
      line(30, 35, 22, 24, 1), // a run of its own
    ].join("\n") + "\n");
    const e = estimate(10, { tier: "high", env });
    assert.equal(e.runs, 3);
    assert.equal(e.merged, 2);
    assert.equal(e.legacy, false);
    assert.deepEqual(e.fiveHour, { percent: 28, used: true }); // 14 points over 5 images, not 20 over 5
    // a merged group that mixes tiers counts only for the all-tier estimate
    fs.appendFileSync(usageLogPath(env), line(33, 40, 23, 26, 1, "draft") + "\n");
    assert.deepEqual(estimate(10, { tier: "high", env }).fiveHour, { percent: 30, used: true }); // 12 over 4
    assert.equal(estimate(10, { tier: "draft", env }).runs, 0);
    const all = estimate(10, { env });
    assert.equal(all.runs, 4);
    assert.deepEqual(all.fiveHour, { percent: 26.7, used: true }); // 12 + (26 - 22) points over 6 images
    // a window that reset inside a merged group measures nothing there
    fs.appendFileSync(usageLogPath(env), line(50, 55, 90, 95, 1, "max") + "\n" + line(52, 58, 95, 3, 1, "max") + "\n");
    assert.deepEqual(estimate(10, { tier: "max", env }).fiveHour, { percent: null, used: false });
  });

  test("newer compares versions part by part", () => {
    assert.equal(newer("0.10.0", "0.9.0"), true);
    assert.equal(newer("1.0.0", "0.99.9"), true);
    assert.equal(newer("0.5.0", "0.5.0"), false);
    assert.equal(newer("0.4.1", "0.5.0"), false);
  });
});
