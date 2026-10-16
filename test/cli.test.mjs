// End-to-end tests: the real CLI against test/mock-codex.mjs (never the real Codex).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
});

