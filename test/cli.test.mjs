// End-to-end tests: the real CLI against test/mock-codex.mjs (never the real Codex).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "skills", "co-codex", "scripts", "co-codex.mjs");
const MOCK = path.join(HERE, "mock-codex.mjs");
const TEMPLATE = path.join(HERE, "..", "skills", "co-codex", "templates", "AGENTS.md");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One sandbox per test: a project dir (the cwd), a mock state file and a config path that does not exist.
function sandbox(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "co-codex-test-")));
  const proj = path.join(dir, "proj");
  fs.mkdirSync(proj);
  const state = path.join(dir, "state.json");
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CO_CODEX_|MOCK_CODEX_)/.test(k)) delete env[k];
  Object.assign(env, {
    CO_CODEX_BIN: JSON.stringify([process.execPath, MOCK]),
    CO_CODEX_CONFIG: path.join(dir, "no-user-config.json"),
    MOCK_CODEX_STATE: state,
    XDG_CONFIG_HOME: path.join(dir, "xdg"), // usage.jsonl lands in <dir>/xdg/co-codex
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const cli = (args, { input, env: extra = {}, timeout = 20_000 } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: proj, env: { ...env, ...extra }, windowsHide: true });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.setEncoding("utf8").on("data", d => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", d => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`co-codex ${args.join(" ")} did not finish in ${timeout} ms\n${stderr}`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

  const readState = () => JSON.parse(fs.readFileSync(state, "utf8"));
  const thread = name => Object.values(readState().threads).find(x => x.name === name);
  // Writes threads straight into the mock's state, e.g. a Codex window someone has open.
  const seed = threads => {
    const s = fs.existsSync(state) ? readState() : { seq: 1000, threads: {}, limitHit: false, clientResponses: [] };
    for (const th of threads) {
      const id = th.id ?? randomUUID();
      s.threads[id] = { id, name: null, cwd: proj, threadSource: "cli", loaded: true, model: "gpt-6.1-sol", reasoningEffort: "medium", createdAt: 1, order: ++s.seq, turns: [], settingsLog: [], ...th };
    }
    fs.writeFileSync(state, JSON.stringify(s));
  };
  const doneTurn = (id, text, answer) => ({
    id, status: "completed", error: null, startedAt: 1, completedAt: 2, input: [{ type: "text", text }],
    items: [{ type: "userMessage", id: `${id}-u`, content: [{ type: "text", text }] }, { type: "agentMessage", id: `${id}-a`, text: answer }],
  });
  return { dir, proj, state, cli, readState, thread, seed, doneTurn };
}

const ok = (r, label = "command") => assert.equal(r.code, 0, `${label} exited ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
const json = r => { ok(r); return JSON.parse(r.stdout); };

describe("co-codex CLI", { concurrency: 4 }, () => {
  test("help, no command and unknown commands", async t => {
    const { cli } = sandbox(t);
    const help = await cli(["help"]);
    ok(help);
    assert.match(help.stdout, /^Usage:/);
    assert.equal((await cli([])).code, 0);
    assert.equal((await cli(["--help"])).code, 0);
    const bad = await cli(["frobnicate"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /Usage:/);
  });

  test("doctor passes on the mock", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["doctor"]);
    ok(r, "doctor");
    assert.match(r.stdout, /ok\s+codex\s+codex-cli 0\.0\.0-mock/);
    assert.match(r.stdout, /ok\s+daemon\s+connected, app-server 0\.0\.0-mock/);
    assert.match(r.stdout, /ok\s+account\s+chatgpt, plan pro/);
    assert.match(r.stdout, /ok\s+protocol\s+all \d+ methods/);
    assert.doesNotMatch(r.stdout, /FAIL/);
  });

  test("doctor fails when the installed Codex lacks a method", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["doctor"], { env: { MOCK_CODEX_DROP_METHOD: "thread/queue/add" } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FAIL\s+protocol\s+this Codex lacks thread\/queue\/add/);
  });

  test("models lists offered models and resolves tiers", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["models"]);
    ok(r, "models");
    assert.match(r.stdout, /gpt-6-luna/);
    assert.doesNotMatch(r.stdout, /gpt-6-hidden/);
    assert.match(r.stdout, /draft\s+gpt-6-luna\s+medium/);
    assert.match(r.stdout, /standard\s+gpt-6\.1-sol\s+medium/);
    assert.match(r.stdout, /max\s+gpt-6-astra\s+high/);
    assert.match(r.stdout, /Config: built-in defaults/);
  });

  test("models clamps an effort the model lacks and reports a missing model (project config)", async t => {
    const { cli, proj } = sandbox(t);
    fs.writeFileSync(path.join(proj, ".co-codex.json"), JSON.stringify({ tiers: { draft: { effort: "ultra" }, high: { models: ["gpt-nope"] } } }));
    const r = await cli(["models"]);
    ok(r, "models");
    assert.match(r.stdout, /draft\s+gpt-6-luna\s+xhigh/);
    assert.match(r.stdout, /gpt-6-luna does not support effort "ultra"; using "xhigh"/);
    assert.match(r.stdout, /high\s+\(Codex default\)/);
    assert.match(r.stdout, /none of the high tier models \(gpt-nope\)/);
    assert.match(r.stdout, /\.co-codex\.json/);
  });

  test("spawn --tier draft --wait --json", async t => {
    const { cli, thread, proj } = sandbox(t);
    const out = json(await cli(["spawn", "hello there", "--name", "x", "--tier", "draft", "--wait", "--json"]));
    assert.match(out.threadId, UUID_RE);
    assert.equal(out.name, "x");
    assert.equal(out.status, "completed");
    assert.equal(out.tier, "draft");
    assert.equal(out.model, "gpt-6-luna");
    assert.equal(out.effort, "medium");
    assert.equal(out.answer, "echo: hello there");
    assert.equal(out.limit, null);
    const th = thread("x");
    assert.equal(th.threadSource, "co-codex");
    assert.equal(th.sandbox, "workspace-write");
    assert.equal(th.approvalPolicy, "never");
    assert.equal(fs.realpathSync.native(th.cwd), proj);
    assert.equal(th.turns[0].model, "gpt-6-luna");
    assert.equal(th.turns[0].effort, "medium");
    assert.match(th.turns[0].input[0].text, /^\[Claude Code → Codex\]\n\nhello there/);
  });

  test("spawn refuses a duplicate name and a missing --name", async t => {
    const { cli } = sandbox(t);
    ok(await cli(["spawn", "one", "--name", "x", "--wait"]));
    const dup = await cli(["spawn", "two", "--name", "x"]);
    assert.equal(dup.code, 1);
    assert.match(dup.stderr, /a session named "x" already exists/);
    const none = await cli(["spawn", "three"]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /spawn needs --name/);
    const badSandbox = await cli(["spawn", "four", "--name", "y", "--sandbox", "wide-open"]);
    assert.equal(badSandbox.code, 1);
    assert.match(badSandbox.stderr, /--sandbox must be one of/);
  });

  test("spawn reads the message from stdin with -", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["spawn", "-", "--name", "s", "--wait"], { input: "from stdin\nsecond line\n" });
    ok(r);
    assert.equal(r.stdout.trim(), "echo: from stdin");
    const empty = await cli(["spawn", "-", "--name", "e"], { input: "  \n" });
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /message is empty/);
  });

  test("send --wait returns the answer, read shows the turns", async t => {
    const { cli } = sandbox(t);
    ok(await cli(["spawn", "first", "--name", "x", "--wait"]));
    const r = await cli(["send", "x", "second", "--wait"]);
    ok(r, "send");
    assert.equal(r.stdout.trim(), "echo: second");
    assert.match(r.stderr, /queued for x/);
    const one = await cli(["read", "x"]);
    ok(one, "read");
    assert.equal(one.stdout.match(/--- turn/g).length, 1);
    assert.match(one.stdout, /echo: second/);
    const two = await cli(["read", "x", "--turns", "2"]);
    ok(two, "read --turns 2");
    assert.equal(two.stdout.match(/--- turn/g).length, 2);
    assert.ok(two.stdout.indexOf("echo: first") < two.stdout.indexOf("echo: second"), "oldest turn first");
    const bad = await cli(["read", "x", "--turns", "0"]);
    assert.equal(bad.code, 1);
  });

  test("send messages from stdin", async t => {
    const { cli } = sandbox(t);
    ok(await cli(["spawn", "first", "--name", "x", "--wait"]));
    const r = await cli(["send", "x", "-", "--wait"], { input: "piped text\n" });
    ok(r);
    assert.equal(r.stdout.trim(), "echo: piped text");
  });

  test("send --tier high switches the model for the turn and back afterwards", async t => {
    const { cli, thread } = sandbox(t);
    ok(await cli(["spawn", "first", "--name", "x", "--tier", "draft", "--wait"]));
    const r = await cli(["send", "x", "careful", "--tier", "high", "--wait", "--json"]);
    const out = json(r);
    assert.equal(out.model, "gpt-6.1-sol");
    assert.equal(out.effort, "high");
    assert.match(r.stderr, /switched x back to gpt-6-luna \/ medium/);
    const th = thread("x");
    assert.deepEqual(th.settingsLog, [{ model: "gpt-6.1-sol", effort: "high" }, { model: "gpt-6-luna", effort: "medium" }]);
    assert.equal(th.turns[0].model, "gpt-6.1-sol");
    assert.equal(th.turns[0].effort, "high");
    assert.equal(th.model, "gpt-6-luna");
    assert.equal(th.reasoningEffort, "medium");
  });

  test("send --tier --keep leaves the new model in place", async t => {
    const { cli, thread } = sandbox(t);
    ok(await cli(["spawn", "first", "--name", "x", "--tier", "draft", "--wait"]));
    const r = await cli(["send", "x", "careful", "--tier", "max", "--wait", "--keep"]);
    ok(r);
    assert.match(r.stderr, /now runs gpt-6-astra \/ high for later turns too/);
    const th = thread("x");
    assert.equal(th.settingsLog.length, 1);
    assert.equal(th.model, "gpt-6-astra");
  });

  test("a turn whose completion timer fires early still ends promptly (no 30 s poll gap)", async t => {
    const { cli } = sandbox(t);
    const env = { MOCK_CODEX_EARLY_MS: "80" };
    const started = Date.now();
    const r = await cli(["spawn", "hello", "--name", "e", "--wait"], { env });
    ok(r);
    assert.equal(r.stdout.trim(), "echo: hello");
    const sent = await cli(["send", "e", "again", "--wait"], { env });
    assert.equal(sent.stdout.trim(), "echo: again");
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
  });

  test("spawn without --wait, then wait", async t => {
    const { cli } = sandbox(t);
    const s = await cli(["spawn", "later please", "--name", "x"]);
    ok(s, "spawn");
    assert.match(s.stdout.trim(), UUID_RE);
    const w = await cli(["wait", "x"]);
    ok(w, "wait");
    assert.equal(w.stdout.trim(), "echo: later please");
    const byId = await cli(["wait", s.stdout.trim(), "--json"]);
    assert.equal(json(byId).answer, "echo: later please");
  });

  test("wait catches a turn that is still running", async t => {
    const { cli } = sandbox(t);
    const env = { MOCK_CODEX_SLOW_MS: "1500" };
    ok(await cli(["spawn", "[[slow]] take your time", "--name", "x"], { env }));
    const w = await cli(["wait", "x"], { env });
    ok(w, "wait");
    assert.equal(w.stdout.trim(), "echo: [[slow]] take your time");
  });

  test("--images --out copies saved and inline images and logs them", async t => {
    const { cli, dir, thread } = sandbox(t);
    const outDir = path.join(dir, "out");
    const r = await cli(["spawn", "[[image]] draw two dots", "--name", "img", "--images", "--wait", "--out", outDir, "--json"]);
    const out = json(r);
    assert.equal(out.images.length, 2);
    assert.equal(out.copied.length, 2);
    for (const f of out.copied) {
      assert.ok(fs.existsSync(f), `${f} exists`);
      assert.equal(fs.readFileSync(f).subarray(1, 4).toString(), "PNG");
    }
    const log = fs.readFileSync(path.join(outDir, "co-codex-images.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(log.length, 2);
    assert.deepEqual(log.map(l => l.prompt).sort(), ["a blue dot", "a red dot"]);
    assert.match(thread("img").turns[0].input[0].text, /Image quality: .*collected from this turn automatically/s);
    // a second copy of the same turn adds no new log lines for the saved file
    const again = await cli(["images", "img", "--out", outDir]);
    ok(again);
    assert.match(again.stderr, /2 image\(s\) in 1 turn\(s\)/);
  });

  test("images <session> --json lists the images of the last turn", async t => {
    const { cli } = sandbox(t);
    const spawned = json(await cli(["spawn", "[[image]] dots", "--name", "img", "--wait", "--json"]));
    const out = json(await cli(["images", "img", "--json"]));
    assert.equal(out.threadId, spawned.threadId);
    assert.equal(out.images.length, 2);
    assert.equal(out.images.filter(i => i.path).length, 1);
    assert.ok(fs.existsSync(out.images.find(i => i.path).path));
    assert.deepEqual(out.copied, []);
    const byTurn = await cli(["images", spawned.threadId, "--turn", spawned.turnId, "--json"]);
    assert.equal(json(byTurn).images.length, 2);
    const noTurn = await cli(["images", "img", "--turn", "turn-nope"]);
    assert.equal(noTurn.code, 1);
  });

  test("images made by subagents are collected", async t => {
    const { cli } = sandbox(t);
    const out = json(await cli(["spawn", "[[subagent]] split it", "--name", "sub", "--subagents", "--wait", "--json"]));
    assert.equal(out.images.length, 1);
    assert.notEqual(out.images[0].threadId, out.threadId);
    assert.ok(fs.existsSync(out.images[0].path));
    const listed = json(await cli(["images", "sub", "--json"]));
    assert.equal(listed.images.length, 1);
  });

  test("a usage limit ends with exit code 4", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["spawn", "[[limit]] too much", "--name", "lim", "--wait"]);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /usage limit/);
    assert.match(r.stderr, /resets at \d{4}-\d\d-\d\d \d\d:\d\d/);
  });

  test("--timeout ends with exit code 2 while Codex keeps working", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["spawn", "[[slow]] long job", "--name", "slow", "--wait", "--timeout", "1"]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /no answer within 1s; Codex keeps working, run: wait/);
    const bad = await cli(["spawn", "x", "--name", "y", "--timeout", "soon"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--timeout must be a whole number/);
  });

  test("approval requests are reported and never answered", async t => {
    const { cli, readState } = sandbox(t);
    const r = await cli(["spawn", "[[approval]] delete build", "--name", "ap", "--wait"]);
    ok(r);
    assert.match(r.stderr, /Codex asks for approval \(item\/commandExecution\/requestApproval\)/);
    assert.deepEqual(readState().clientResponses, []);
  });

  test("--ref attaches a local image; a missing file is an error", async t => {
    const { cli, proj, thread } = sandbox(t);
    fs.writeFileSync(path.join(proj, "ref.png"), "png");
    ok(await cli(["spawn", "like this", "--name", "r", "--ref", "ref.png", "--wait"]));
    const input = thread("r").turns[0].input;
    assert.deepEqual(input.slice(1), [{ type: "localImage", path: path.join(proj, "ref.png") }]);
    const missing = await cli(["spawn", "like this", "--name", "r2", "--ref", "nope.png"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--ref file not found: nope\.png/);
    assert.equal(thread("r2"), undefined);
  });

  test("list and list --all", async t => {
    const { cli, seed, doneTurn } = sandbox(t);
    seed([{ name: "old-one", loaded: false, turns: [doneTurn("turn-old", "old work", "old answer")] }]);
    ok(await cli(["spawn", "fresh", "--name", "x", "--wait"]));
    const r = await cli(["list"]);
    ok(r, "list");
    assert.match(r.stdout, /Open on the daemon:/);
    assert.match(r.stdout, /idle\s+x\s+.*\[co-codex\] fresh/);
    assert.doesNotMatch(r.stdout, /old-one/);
    const all = await cli(["list", "--all"]);
    ok(all, "list --all");
    assert.match(all.stdout, /Saved in this project:\n.*old-one/);
  });

  test("list with nothing open", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["list"]);
    ok(r);
    assert.match(r.stdout, /No Codex session is open on the daemon\./);
  });

  test("send refuses a saved session no window has open", async t => {
    const { cli, seed, doneTurn } = sandbox(t);
    seed([{ name: "old-one", loaded: false, turns: [doneTurn("turn-old", "old work", "old answer")] }]);
    const r = await cli(["send", "old-one", "more"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"old-one" is not open in any Codex window/);
    const unknown = await cli(["send", "ghost", "hi"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no session named "ghost"/);
    // read still works on a saved session
    const read = await cli(["read", "old-one"]);
    ok(read);
    assert.match(read.stdout, /old answer/);
  });

  test("stop interrupts the running turn", async t => {
    const { cli, thread } = sandbox(t);
    const env = { MOCK_CODEX_SLOW_MS: "60000" };
    ok(await cli(["spawn", "[[slow]] forever", "--name", "x"], { env }));
    const r = await cli(["stop", "x"], { env });
    ok(r, "stop");
    assert.match(r.stdout, /interrupted turn turn-\d+/);
    assert.equal(thread("x").turns[0].status, "interrupted");
    const again = await cli(["stop", "x"], { env });
    ok(again);
    assert.match(again.stdout, /nothing running/);
    const w = await cli(["wait", "x"], { env });
    assert.equal(w.code, 3);
    assert.match(w.stderr, /ended as "interrupted"/);
  });

  test("limits and limits --json", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["limits"]);
    ok(r, "limits");
    assert.match(r.stdout, /Plan: pro/);
    assert.match(r.stdout, /5-hour window\s+12% used, resets \d{4}-/);
    assert.match(r.stdout, /weekly window\s+40% used/);
    const out = json(await cli(["limits", "--json"]));
    assert.equal(out.rateLimits.planType, "pro");
    assert.equal(out.rateLimits.primary.windowDurationMins, 300);
    assert.equal(out.rateLimits.secondary.windowDurationMins, 10080);
    assert.ok(out.rateLimitsByLimitId.codex);
  });

  test("init prints the note; init --write appends it once", async t => {
    const { cli, proj } = sandbox(t);
    const template = fs.readFileSync(TEMPLATE, "utf8");
    const p = await cli(["init"]);
    ok(p, "init");
    assert.ok(p.stdout.includes("<!-- co-codex -->"));
    assert.equal(p.stdout.trimEnd(), template.trimEnd());
    const target = path.join(proj, "AGENTS.md");
    fs.writeFileSync(target, "# Our notes\n");
    const w = await cli(["init", "--write"]);
    ok(w, "init --write");
    assert.match(w.stdout, /appended the co-codex note to/);
    const again = await cli(["init", "--write"]);
    ok(again);
    assert.match(again.stdout, /already has the co-codex note/);
    const text = fs.readFileSync(target, "utf8");
    assert.ok(text.startsWith("# Our notes\n\n"));
    assert.equal(text.split("<!-- co-codex -->").length - 1, template.split("<!-- co-codex -->").length - 1);
    assert.equal(text, "# Our notes\n\n" + template);
  });

  test("init --write creates AGENTS.md when there is none", async t => {
    const { cli, proj } = sandbox(t);
    const w = await cli(["init", "--write"]);
    ok(w);
    assert.match(w.stdout, /^created /);
    assert.equal(fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8"), fs.readFileSync(TEMPLATE, "utf8"));
  });

  test("send open finds the one Codex window open in this project", async t => {
    const { cli, seed, dir } = sandbox(t);
    seed([
      { name: "elsewhere", cwd: dir },              // another project: not counted
      { name: "child", threadSource: "subagent" },  // subagents are not windows
    ]);
    const none = await cli(["send", "open", "hi"]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no open Codex window in this project/);

    seed([{ name: "mine" }]);
    const r = await cli(["send", "open", "hi there", "--wait"]);
    ok(r, "send open");
    assert.equal(r.stdout.trim(), "echo: hi there");
    assert.match(r.stderr, /queued for mine/);

    seed([{ name: "second" }]);
    const two = await cli(["send", "open", "hi"]);
    assert.equal(two.code, 1);
    assert.match(two.stderr, /more than one open Codex window here/);
    assert.match(two.stderr, /mine/);
    assert.match(two.stderr, /second/);
  });
test("wait --message finds a message queued behind a running turn; plain wait takes the last queued one", async t => {
    const { cli } = sandbox(t);
    const env = { MOCK_CODEX_SLOW_MS: "1500" };
    ok(await cli(["spawn", "[[slow]] busy", "--name", "x"], { env }));
    const queued = json(await cli(["send", "x", "second", "--json"], { env }));
    assert.match(queued.clientUserMessageId, UUID_RE);
    const w = await cli(["wait", "x", "--message", queued.clientUserMessageId], { env });
    ok(w, "wait --message");
    assert.equal(w.stdout.trim(), "echo: second");

    ok(await cli(["send", "x", "[[slow]] third"], { env }));
    ok(await cli(["send", "x", "fourth"], { env }));
    const last = await cli(["wait", "x"], { env });
    ok(last, "wait");
    assert.equal(last.stdout.trim(), "echo: fourth");
    assert.match(last.stderr, /waiting for the last queued message/);
  });

  test("wait --message with an unknown id is an error", async t => {
    const { cli } = sandbox(t);
    ok(await cli(["spawn", "hi", "--name", "x", "--wait"]));
    const r = await cli(["wait", "x", "--message", "not-a-real-id"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /neither queued nor among the last/);
  });

  test("send --tier needs --wait or --keep and changes nothing otherwise", async t => {
    const { cli, thread } = sandbox(t);
    ok(await cli(["spawn", "hi", "--name", "x", "--wait"]));
    const r = await cli(["send", "x", "more", "--tier", "high"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /add --wait .* or --keep/);
    assert.deepEqual(thread("x").settingsLog, []);
    assert.equal(thread("x").turns.length, 1);
  });

  test("send --tier does not switch back while its message is still queued", async t => {
    const { cli, thread } = sandbox(t);
    const env = { MOCK_CODEX_SLOW_MS: "3000" };
    ok(await cli(["spawn", "[[slow]] busy", "--name", "x", "--tier", "draft"], { env }));
    const r = await cli(["send", "x", "later", "--tier", "high", "--wait", "--timeout", "1"], { env });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /stays on gpt-6\.1-sol \/ high because the message has not started yet/);
    assert.equal(thread("x").settingsLog.length, 1);
  });

  test("unknown options and stray arguments are errors", async t => {
    const { cli } = sandbox(t);
    const bogus = await cli(["list", "--bogus"]);
    assert.equal(bogus.code, 1);
    assert.match(bogus.stderr, /unknown option --bogus/);
    const stray = await cli(["send", "x", "--wait", "60", "task"]);
    assert.equal(stray.code, 1);
    assert.match(stray.stderr, /send takes 2 arguments/);
  });

  test("a session name used in other projects must be unique; this project wins", async t => {
    const { cli, seed, doneTurn, dir, proj } = sandbox(t);
    const elsewhere = n => path.join(dir, n);
    seed([
      { name: "art", cwd: elsewhere("one"), loaded: false, turns: [doneTurn("t-one", "a", "from one")] },
      { name: "art", cwd: elsewhere("two"), loaded: false, turns: [doneTurn("t-two", "b", "from two")] },
    ]);
    const amb = await cli(["read", "art"]);
    assert.equal(amb.code, 1);
    assert.match(amb.stderr, /names sessions in several other projects/);
    seed([{ name: "art", cwd: proj, loaded: false, turns: [doneTurn("t-here", "c", "from here")] }]);
    const here = await cli(["read", "art"]);
    ok(here);
    assert.match(here.stdout, /from here/);
  });
test("opinion: fresh read-only session on the high tier, verdict rendered", async t => {
    const { cli, thread, dir } = sandbox(t);
    // Even a user config that gives spawned sessions full access must not reach an opinion.
    fs.writeFileSync(path.join(dir, "no-user-config.json"), JSON.stringify({ spawn: { sandbox: "danger-full-access" } }));
    const r = await cli(["opinion", "Rename the column, then deploy.", "--on", "migration plan", "--name", "op1", "--file", "docs/plan.md"]);
    ok(r, "opinion");
    assert.match(r.stdout, /^Verdict: sound-with-changes \(confidence medium\)/);
    assert.match(r.stdout, /\[high\] no rollback\n      why: data loss\n      do: add one\n      evidence: plan step 3/);
    assert.match(r.stdout, /Agrees with:\n  - step order/);
    assert.match(r.stderr, /asked Codex for a second opinion: "op1" .*gpt-6\.1-sol \/ high, read-only, independent opinion/);
    const th = thread("op1");
    assert.equal(th.sandbox, "read-only");
    assert.equal(th.approvalPolicy, "never");
    assert.equal(th.model, "gpt-6.1-sol");
    const sent = th.turns[0].input[0].text;
    assert.match(sent, /Second opinion requested on a migration plan\./);
    assert.match(sent, /Claude's conclusion is left out on purpose/);
    assert.match(sent, /- docs\/plan\.md/);
    assert.match(sent, /Material:\nRename the column, then deploy\.$/);
    assert.ok(th.turns[0].outputSchema, "the turn asks for structured output");
  });

  test("opinion --mode challenge --json returns the parsed opinion", async t => {
    const { cli, thread } = sandbox(t);
    const out = json(await cli(["opinion", "My position: ship on Friday.", "--mode", "challenge", "--name", "op2", "--tier", "draft", "--json"]));
    assert.equal(out.kind, "opinion");
    assert.equal(out.mode, "challenge");
    assert.equal(out.model, "gpt-6-luna");
    assert.equal(out.opinion.verdict, "sound-with-changes");
    assert.equal(out.opinion.concerns[0].severity, "high");
    assert.equal(out.text, null);
    assert.match(thread("op2").turns[0].input[0].text, /Try to refute it/);
  });

  test("opinion shows Codex's text when it ignores the schema", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["opinion", "[[noschema]] plan", "--name", "op3"]);
    ok(r);
    assert.match(r.stdout, /^echo: Second opinion requested on a plan\./);
  });

  test("opinion --diff, --base and --commit use Codex's built-in reviewer", async t => {
    const { cli, thread } = sandbox(t);
    const d = await cli(["opinion", "--diff", "--name", "d1"]);
    ok(d, "--diff");
    assert.equal(d.stdout.trim(), "mock review of uncommittedChanges");
    assert.match(d.stderr, /code review of uncommitted changes/);
    assert.deepEqual(thread("d1").turns[0].review, { type: "uncommittedChanges" });
    assert.equal(thread("d1").turns[0].delivery, "inline");
    assert.deepEqual(thread("d1").settingsLog, [{ effort: "high" }]);
    assert.equal(thread("d1").sandbox, "read-only");
    const b = json(await cli(["opinion", "--base", "main", "--name", "d2", "--json"]));
    assert.equal(b.kind, "code-review");
    assert.equal(b.text, "mock review of baseBranch main");
    assert.deepEqual(b.target, { type: "baseBranch", branch: "main" });
    const c = await cli(["opinion", "--commit", "abc123", "--name", "d3"]);
    ok(c, "--commit");
    assert.equal(c.stdout.trim(), "mock review of commit abc123");
  });

  test("opinion rejects text with --diff, a bad --mode and a taken name", async t => {
    const { cli } = sandbox(t);
    const withText = await cli(["opinion", "look here", "--diff"]);
    assert.equal(withText.code, 1);
    assert.match(withText.stderr, /takes no text/);
    const mode = await cli(["opinion", "plan", "--mode", "angry"]);
    assert.equal(mode.code, 1);
    assert.match(mode.stderr, /--mode must be one of independent, challenge/);
    ok(await cli(["opinion", "plan", "--name", "same"]));
    const taken = await cli(["opinion", "plan", "--name", "same"]);
    assert.equal(taken.code, 1);
    assert.match(taken.stderr, /a session named "same" already exists/);
  });

  // ------------------------------------------------------------ 0.3.0

  test("spawn reports the sandbox and network; --network turns network on through the config override", async t => {
    const { cli, thread } = sandbox(t);
    const plain = await cli(["spawn", "hello", "--name", "a", "--wait", "--json"]);
    const a = json(plain);
    assert.equal(a.sandbox, "workspace-write");
    assert.equal(a.network, false);
    assert.match(plain.stderr, /spawned "a" .*workspace-write, network off\)/);
    assert.equal(thread("a").config, null);

    const net = await cli(["spawn", "hello", "--name", "b", "--network", "--wait", "--json"]);
    const b = json(net);
    assert.equal(b.sandbox, "workspace-write");
    assert.equal(b.network, true);
    assert.match(net.stderr, /workspace-write, network on\)/);
    assert.deepEqual(thread("b").config, { sandbox_workspace_write: { network_access: true } });
    assert.equal(thread("b").sandbox, "workspace-write");

    const full = await cli(["spawn", "hello", "--name", "c", "--network", "--sandbox", "danger-full-access", "--json"]);
    const c = json(full);
    assert.equal(c.sandbox, "danger-full-access");
    assert.equal(c.network, true);
    assert.match(full.stderr, /--network is not needed with danger-full-access/);
    assert.equal(thread("c").config, null);

    const ro = await cli(["spawn", "hello", "--name", "d", "--network", "--sandbox", "read-only"]);
    assert.equal(ro.code, 1);
    assert.match(ro.stderr, /--network does not work with the read-only sandbox/);
    assert.equal(thread("d"), undefined);
  });

  test("a task that sounds online warns when the session has no network, and only then", async t => {
    const { cli, seed } = sandbox(t);
    const off = await cli(["spawn", "Build it, run npm install, then deploy to Sites.", "--name", "a", "--wait"]);
    ok(off);
    assert.match(off.stderr, /warning: the task mentions npm install, deploy to, but this session \(workspace-write\) has no network access/);
    assert.match(off.stderr, /spawn a new one with --network, or with --sandbox danger-full-access only with the user's agreement/);
    const on = await cli(["spawn", "Run npm install, then deploy to prod.", "--name", "b", "--network", "--wait"]);
    ok(on);
    assert.doesNotMatch(on.stderr, /warning/);
    const quiet = await cli(["spawn", "List the web sites we link to and the Download now button.", "--name", "c", "--wait"]);
    assert.doesNotMatch(quiet.stderr, /warning/);
    // image sessions are read-only by design: no warning, whatever the brief says
    const img = await cli(["spawn", "[[image]] a poster that says npm install", "--name", "i", "--images", "--sandbox", "read-only", "--wait"]);
    ok(img);
    assert.doesNotMatch(img.stderr, /warning/);
    // send warns too, from the sandbox the session reports when co-codex subscribes
    seed([{ name: "win", turns: [] }]);
    ok(await cli(["send", "win", "first", "--wait"]));
    const sent = await cli(["send", "win", "git push the branch", "--wait"]);
    ok(sent);
    assert.match(sent.stderr, /the task mentions git push/);
  });

  test("send cannot change the sandbox of a session", async t => {
    const { cli, thread } = sandbox(t);
    ok(await cli(["spawn", "hi", "--name", "x", "--wait"]));
    for (const flags of [["--sandbox", "danger-full-access"], ["--network"]]) {
      const r = await cli(["send", "x", "retry", "--wait", ...flags]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /the sandbox is fixed when a session starts, so send cannot change it; spawn a new session/);
    }
    assert.equal(thread("x").turns.length, 1);
    const out = json(await cli(["send", "x", "more", "--wait", "--json"]));
    assert.equal(out.sandbox, "workspace-write");
    assert.equal(out.network, false);
  });

  test("doctor shows Codex's sandbox settings next to co-codex's; a failing config/read is a note", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["doctor"]);
    ok(r, "doctor");
    assert.match(r.stdout, /codex cfg sandbox_mode danger-full-access, sandbox_workspace_write\.network_access false, approval_policy on-request/);
    assert.match(r.stdout, /spawn\s+co-codex starts sessions with sandbox workspace-write, network off unless --network, approvals never/);
    const failing = await cli(["doctor"], { env: { MOCK_CODEX_CONFIG_FAIL: "1" } });
    ok(failing, "doctor without config/read");
    assert.match(failing.stdout, /codex cfg not read: config\/read: config unavailable/);
    const missing = await cli(["doctor"], { env: { MOCK_CODEX_DROP_METHOD: "thread/delete" } });
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /lacks thread\/delete/);
  });

  test("actions refused for approval: JSON, stderr block and exit code 5", async t => {
    const { cli } = sandbox(t);
    const r = await cli(["spawn", "[[declined]] publish the package", "--name", "pub", "--network", "--wait", "--json"]);
    assert.equal(r.code, 5, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, "completed");
    assert.deepEqual(out.declined, [
      { type: "commandExecution", action: "npm publish", reason: "declined: needs approval" },
      { type: "fileChange", action: "edit site/index.html", reason: "declined: needs approval" },
      { type: "mcpToolCall", action: "sites.invite_member", reason: "user rejected the tool call: approval required" },
    ]);
    assert.match(r.stderr, /! Codex was refused 3 action\(s\) that need approval:\n  - npm publish \(commandExecution\)/);
    assert.match(r.stderr, /open `codex resume pub -a on-request` and let Codex retry there/);
    assert.match(r.stderr, /`-c sandbox_workspace_write\.network_access=true`, or `-s danger-full-access` only with the user's agreement/);
    assert.doesNotMatch(r.stderr, /fs\.read/); // "permission denied" is an ordinary failure
    assert.match(r.stderr, /Codex answered, but 3 action\(s\) were refused/);
    // without --json the answer still reaches stdout
    const plain = await cli(["send", "pub", "[[declined]] again", "--wait"]);
    assert.equal(plain.code, 5);
    assert.equal(plain.stdout.trim(), "echo: [[declined]] again");
    const none = json(await cli(["send", "pub", "fine now", "--wait", "--json"]));
    assert.deepEqual(none.declined, []);
  });

  test("declines in a window a person holds are reported, not an error", async t => {
    const { cli, seed, doneTurn } = sandbox(t);
    seed([{ name: "win", turns: [doneTurn("t-0", "hi", "hello")] }]);
    const r = await cli(["send", "win", "[[declined]] try it", "--wait", "--json"]);
    ok(r, "send to a window");
    assert.equal(JSON.parse(r.stdout).declined.length, 3);
    assert.match(r.stderr, /note: 3 action\(s\) were declined in the Codex window: npm publish, edit site\/index\.html, sites\.invite_member/);
    assert.doesNotMatch(r.stderr, /codex resume|! Codex was refused/);
  });

  test("refused actions of subagents count; a usage limit and a failed turn take precedence over exit 5", async t => {
    const { cli } = sandbox(t);
    const sub = await cli(["spawn", "[[subagent]] [[declined]] split", "--name", "s", "--subagents", "--wait", "--json"]);
    assert.equal(sub.code, 5);
    const out = JSON.parse(sub.stdout);
    assert.equal(out.declined.length, 4);
    assert.ok(out.declined.some(d => d.action === "git push"));
    const lim = await cli(["spawn", "[[limit]] [[declined]] too much", "--name", "l", "--wait"]);
    assert.equal(lim.code, 4);
    assert.match(lim.stderr, /! Codex was refused 3 action/);
    const env = { MOCK_CODEX_SLOW_MS: "60000" };
    ok(await cli(["spawn", "[[slow]] [[declined]] forever", "--name", "x"], { env }));
    ok(await cli(["stop", "x"], { env }));
    assert.equal((await cli(["wait", "x"], { env })).code, 3);
  });

  test("--names with a KEEP line: named copies, the others in _rejected, names in the log", async t => {
    const { cli, dir, thread } = sandbox(t);
    const outDir = path.join(dir, "out");
    const r = await cli(["spawn", "[[images:4]] [[fail:2]] [[keep:a.png=3,b=4]] two icons", "--name", "n", "--images", "--names", "a.png,b",
      "--sandbox", "read-only", "--wait", "--out", outDir, "--json"]);
    const out = json(r);
    assert.equal(out.namesMatchedBy, "keep-line");
    assert.deepEqual(out.names, { "a.png": path.join(outDir, "a.png"), "b.png": path.join(outDir, "b.png") });
    assert.deepEqual(out.copied, [path.join(outDir, "a.png"), path.join(outDir, "b.png")]);
    assert.equal(out.rejected.length, 1);
    assert.equal(path.dirname(out.rejected[0]), path.join(outDir, "_rejected"));
    assert.match(out.answer, /\nKEEP: a\.png=3, b=4$/);
    // generation 3 is 1003x503, generation 4 is 1004x504
    const sized = file => { const b = fs.readFileSync(file); return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`; };
    assert.equal(sized(out.names["a.png"]), "1003x503");
    assert.equal(sized(out.names["b.png"]), "1004x504");
    assert.equal(sized(out.rejected[0]), "1001x501");
    const sent = thread("n").turns[0].input[0].text;
    assert.match(sent, /Generate the images in this order, one per file name:\n1\. a\.png\n2\. b\.png/);
    assert.match(sent, /KEEP: a\.png=1, b\.png=2/);
    const log = fs.readFileSync(path.join(outDir, "co-codex-images.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.deepEqual(log.map(l => [l.file, l.name, l.rejected ?? false]), [
      ["a.png", "a.png", false], ["b.png", "b.png", false], [`_rejected/${path.basename(out.rejected[0])}`, null, true],
    ]);
    assert.equal(log[0].width, 1003);
    assert.equal(log[0].height, 503);
  });

  test("--names fallbacks: by order when the count fits, item ids when it does not", async t => {
    const { cli, dir } = sandbox(t);
    const outDir = path.join(dir, "out");
    const order = await cli(["spawn", "[[images:2]] no keep line", "--name", "o", "--images", "--names", "x,y", "--wait", "--out", outDir, "--json"]);
    const o = json(order);
    assert.equal(o.namesMatchedBy, "order");
    assert.deepEqual(Object.keys(o.names), ["x.png", "y.png"]);
    assert.match(order.stderr, /the answer has no valid KEEP line; mapped the 2 image\(s\) to the names by order, check them/);

    const failed = await cli(["spawn", "[[images:3]] [[fail:1]] [[keep:x=1,y=2]] keep points at a failure", "--name", "f", "--images", "--names", "x,y",
      "--wait", "--out", path.join(dir, "out2"), "--json"]);
    const f = json(failed);
    assert.equal(f.namesMatchedBy, "order");
    assert.match(failed.stderr, /the KEEP line points at images that do not exist or failed/);

    const wrong = await cli(["spawn", "[[images:3]] three for two", "--name", "w", "--images", "--names", "x,y", "--wait", "--out", path.join(dir, "out3"), "--json"]);
    const w = json(wrong);
    assert.equal(w.namesMatchedBy, null);
    assert.deepEqual(w.names, {});
    assert.deepEqual(w.rejected, []);
    assert.equal(w.copied.length, 3);
    assert.ok(w.copied.every(c => /item-\d+\.png$/.test(c)));
    assert.match(wrong.stderr, /3 usable image\(s\) for 2 name\(s\); could not match names, copied them under their item ids/);
  });

  test("--names never overwrites a different file and validates its list", async t => {
    const { cli, dir } = sandbox(t);
    const outDir = path.join(dir, "out");
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, "a.png"), "someone else's file");
    const r = await cli(["spawn", "[[images:1]] [[keep:a.png=1]] one", "--name", "k", "--images", "--names", "a.png", "--wait", "--out", outDir, "--json"]);
    const out = json(r);
    assert.equal(out.names["a.png"], path.join(outDir, "a-2.png"));
    assert.equal(fs.readFileSync(path.join(outDir, "a.png"), "utf8"), "someone else's file");
    assert.match(r.stderr, /a\.png already exists with other content; saved this image as a-2\.png/);
    // copying the same turn again finds its own file instead of making a-3.png
    const again = json(await cli(["wait", "k", "--out", outDir, "--names", "a.png", "--json"]));
    assert.equal(again.names["a.png"], path.join(outDir, "a-2.png"));
    assert.ok(!fs.existsSync(path.join(outDir, "a-3.png")));

    const bad = [
      [["--names", "a.png"], /--names needs --images/],
      [["--images", "--names", "a.png", "--wait"], /--names needs --out <dir>/],
      [["--images", "--names", "a.png", "--out", outDir, "--subagents"], /--names does not work with --subagents/],
      [["--images", "--names", "../a.png", "--out", outDir], /is not a plain file name/],
      [["--images", "--names", "sub/a.png", "--out", outDir], /is not a plain file name/],
      [["--images", "--names", "a,A.png", "--out", outDir], /"A\.png" is listed twice/],
      [["--images", "--names", "a.jpg", "--out", outDir], /Codex saves PNG files/],
      [["--images", "--names", " , ", "--out", outDir], /--names needs at least one file name/],
    ];
    for (const [flags, message] of bad) {
      const e = await cli(["spawn", "x", "--name", "bad", ...flags]);
      assert.equal(e.code, 1, flags.join(" "));
      assert.match(e.stderr, message);
    }
  });

  test("spawn --names without --wait, then wait --names maps them", async t => {
    const { cli, dir } = sandbox(t);
    const outDir = path.join(dir, "out");
    const s = await cli(["spawn", "[[images:3]] [[keep:p=2,q=3]] later", "--name", "later", "--images", "--names", "p,q", "--out", outDir]);
    ok(s);
    assert.match(s.stderr, /collect the named images with: wait later --out .* --names p,q/);
    const out = json(await cli(["wait", "later", "--out", outDir, "--names", "p,q", "--json"]));
    assert.equal(out.namesMatchedBy, "keep-line");
    assert.deepEqual(Object.keys(out.names), ["p.png", "q.png"]);
    assert.equal(out.rejected.length, 1);
  });

  test("--names puts images of subagents Codex started on its own in _rejected", async t => {
    const { cli, dir } = sandbox(t);
    const outDir = path.join(dir, "out");
    const out = json(await cli(["spawn", "[[images:2]] [[subagent]] [[keep:x=1,y=2]] two", "--name", "sa", "--images", "--names", "x,y", "--wait", "--out", outDir, "--json"]));
    assert.equal(out.namesMatchedBy, "keep-line");
    assert.deepEqual(Object.keys(out.names), ["x.png", "y.png"]);
    assert.equal(out.rejected.length, 1);
    assert.ok(fs.existsSync(out.rejected[0]));
    assert.equal(path.dirname(out.rejected[0]), path.join(outDir, "_rejected"));
    assert.notEqual(out.images.find(i => out.rejected[0].includes(i.itemId)).threadId, out.threadId);
  });

  test("real image sizes in JSON results and the log", async t => {
    const { cli, dir } = sandbox(t);
    const outDir = path.join(dir, "out");
    const r = await cli(["spawn", "[[image]] two dots", "--name", "img", "--images", "--wait", "--out", outDir, "--json"]);
    const out = json(r);
    assert.deepEqual(out.images.map(i => [i.width, i.height]), [[1254, 1254], [1538, 1022]]);
    const listed = json(await cli(["images", "img", "--json"]));
    assert.deepEqual(listed.images.map(i => [i.width, i.height]), [[1254, 1254], [1538, 1022]]);
    const log = fs.readFileSync(path.join(outDir, "co-codex-images.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.deepEqual(log.map(l => [l.width, l.height]), [[1254, 1254], [1538, 1022]]);
    const plain = await cli(["send", "img", "[[image]] again", "--images", "--wait"]);
    assert.match(plain.stderr, /2 image\(s\) generated \(1254x1254, 1538x1022\)/);
  });

  test("cleanup lists only closed, old sessions co-codex started here; --yes deletes them", async t => {
    const { cli, seed, readState, dir, proj, doneTurn } = sandbox(t);
    const now = Math.floor(Date.now() / 1000);
    const old = now - 3 * 86400;
    const id = n => `00000000-0000-4000-8000-00000000000${n}`;
    seed([
      { id: id(1), name: "img-a", threadSource: "co-codex", loaded: false, updatedAt: old },
      { id: id(2), name: "q-b", threadSource: "co-codex", loaded: false, updatedAt: old },
      { id: id(3), name: "img-open", threadSource: "co-codex", loaded: true, updatedAt: old },
      { id: id(4), name: "img-user", threadSource: "cli", loaded: false, updatedAt: old },
      { id: id(5), name: "img-fresh", threadSource: "co-codex", loaded: false, updatedAt: now - 600 },
      { id: id(6), name: "img-elsewhere", threadSource: "co-codex", loaded: false, updatedAt: old, cwd: path.join(dir, "other") },
      // the project here is not a git repository: a subfolder is another project
      { id: id(7), name: "img-sub", threadSource: "co-codex", loaded: false, updatedAt: old, cwd: path.join(proj, "sub") },
      // a person took this one over with `codex resume`: their message has no signature
      { id: id(8), name: "img-taken", threadSource: "co-codex", loaded: false, updatedAt: old, turns: [doneTurn("t-8", "a person typed this", "ok")] },
      { id: id(9), name: "img-signed", threadSource: "co-codex", loaded: false, updatedAt: old, turns: [doneTurn("t-9", "[Claude Code → Codex]\n\ndraw", "ok")] },
    ]);
    const dry = await cli(["cleanup"]);
    ok(dry, "cleanup");
    for (const n of ["img-a", "q-b", "img-signed"]) assert.match(dry.stdout, new RegExp(`${n}\\s`));
    assert.doesNotMatch(dry.stdout, /img-open|img-user|img-fresh|img-elsewhere|img-sub/);
    assert.match(dry.stdout, /skipped 00000000-0000-4000-8000-000000000008  img-taken: used in a Codex window/);
    assert.match(dry.stdout, /3 session\(s\)\. Nothing was deleted\. Delete them with: cleanup --older-than 2d --yes/);
    assert.equal(Object.keys(readState().threads).length, 9);

    const prefixed = json(await cli(["cleanup", "--name-prefix", "img-", "--json"]));
    assert.equal(prefixed.dryRun, true);
    assert.deepEqual(prefixed.sessions.map(s => s.name).sort(), ["img-a", "img-signed"]);
    assert.deepEqual(prefixed.skipped, [{ threadId: id(8), name: "img-taken", reason: "used in a Codex window" }]);

    const shorter = json(await cli(["cleanup", "--older-than", "5m", "--json"]));
    assert.deepEqual(shorter.sessions.map(s => s.name).sort(), ["img-a", "img-fresh", "img-signed", "q-b"]);

    const del = json(await cli(["cleanup", "--name-prefix", "img-", "--yes", "--json"]));
    assert.deepEqual(del.sessions.map(s => [s.name, s.deleted]).sort(), [["img-a", true], ["img-signed", true]]);
    assert.deepEqual(readState().deleted.sort(), [id(1), id(9)]);
    const rest = await cli(["cleanup", "--yes"]);
    ok(rest);
    assert.match(rest.stdout, /deleted 00000000-0000-4000-8000-000000000002  q-b/);
    const nothing = await cli(["cleanup"]);
    ok(nothing);
    assert.match(nothing.stdout, /Nothing to clean up/);
    const bad = await cli(["cleanup", "--older-than", "2 days"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--older-than takes a number and a unit/);

    // in a git repository the whole tree below the top level is the project
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: proj }).status, 0);
    const inRepo = json(await cli(["cleanup", "--json"]));
    assert.deepEqual(inRepo.sessions.map(s => s.name), ["img-sub"]);
  });

  test("quota per batch: usage before and after, the user-level log and limits --estimate", async t => {
    const { cli, dir } = sandbox(t);
    const none = await cli(["limits", "--estimate", "10"]);
    ok(none);
    assert.match(none.stdout, /No past image runs to estimate from yet\. co-codex logs each completed --images --wait run in .*usage\.jsonl/);

    const out = json(await cli(["spawn", "[[image]] two dots", "--name", "q", "--tier", "draft", "--images", "--wait", "--json"]));
    assert.deepEqual(out.usage, { fiveHour: { before: 12, after: 16 }, weekly: { before: 40, after: 42 } });
    ok(await cli(["spawn", "no images here", "--name", "t", "--wait"])); // not an --images run: not logged
    // the log sits in the user config folder (XDG_CONFIG_HOME), not next to CO_CODEX_CONFIG
    const logFile = path.join(dir, "xdg", "co-codex", "usage.jsonl");
    assert.ok(!fs.existsSync(path.join(dir, "usage.jsonl")));
    const log = fs.readFileSync(logFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].tier, "draft");
    assert.equal(log[0].model, "gpt-6-luna");
    assert.equal(log[0].effort, "medium");
    assert.equal(log[0].images, 2);
    assert.equal(log[0].fiveHourDelta, 4);
    assert.equal(log[0].weeklyDelta, 2);
    assert.match(log[0].date, /^\d{4}-\d\d-\d\dT/);

    const est = await cli(["limits", "--estimate", "10"]);
    ok(est);
    assert.match(est.stdout, /10 image\(s\): about 20% of the 5-hour window and about 10% of the weekly window, from 1 past run\(s\); other Codex use in the same window inflates it\./);
    const byTier = await cli(["limits", "--estimate", "10", "--tier", "high"]);
    assert.match(byTier.stdout, /No past image runs on the high tier/);
    const e = json(await cli(["limits", "--estimate", "5", "--tier", "draft", "--json"]));
    assert.deepEqual(e.fiveHour, { percent: 10, used: true });
    assert.equal(e.runs, 1);
    // whole-percent readings: most small runs read 0, so the runs are pooled, not averaged per run
    const zero = tier => JSON.stringify({ date: "2026-10-18T00:00:00Z", tier, images: 1, fiveHourDelta: 0, weeklyDelta: 0 }) + "\n";
    fs.appendFileSync(logFile, zero("draft") + zero("draft") + zero("draft"));
    const pooled = await cli(["limits", "--estimate", "1", "--tier", "draft"]);
    assert.match(pooled.stdout, /1 image\(s\) on the draft tier: about 1% of the 5-hour window and less than 1% of the weekly window, from 4 past run\(s\)/);
    fs.appendFileSync(logFile, zero("standard") + zero("standard"));
    const flat = await cli(["limits", "--estimate", "10", "--tier", "standard"]);
    assert.match(flat.stdout, /no measurable use yet in 2 past run\(s\)/);
    assert.equal((await cli(["limits", "--estimate", "0"])).code, 1);
    // wait has no reading from before the turn
    const w = json(await cli(["wait", "q", "--json"]));
    assert.equal(w.usage.fiveHour.before, null);
    assert.equal(w.usage.fiveHour.after, 16);
    // a run that did not complete is not logged
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").length;
    assert.equal((await cli(["spawn", "[[limit]] [[image]] too many", "--name", "l", "--images", "--wait"])).code, 4);
    assert.equal(fs.readFileSync(logFile, "utf8").trim().split("\n").length, lines);
  });
});


