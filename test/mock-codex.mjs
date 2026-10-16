#!/usr/bin/env node
// A fake `codex` for the co-codex tests. Run as `node test/mock-codex.mjs <args>`; the tests point
// CO_CODEX_BIN at ["<node>", "<this file>"], so it replaces codex on every OS without a shell.
//
//   --version                                   prints a version
//   app-server daemon start | version           pretends the daemon runs
//   app-server generate-json-schema --out <dir> writes ClientRequest.json / ServerNotification.json
//   app-server proxy                            WebSocket + JSON-RPC server on stdio
//
// Env:
//   MOCK_CODEX_STATE        JSON file holding threads and turns (shared by every proxy process)
//   MOCK_CODEX_DROP_METHOD  a method left out of the schema export (doctor must report it)
//   MOCK_CODEX_SLOW_MS      length of a [[slow]] turn (default 3000)
//
// Markers in the message text pick the turn's behaviour: [[image]], [[subagent]], [[limit]],
// [[slow]], [[approval]]. A turn completes at its `dueAt` time: a timer in the proxy that started
// it emits the events, and any later read completes overdue turns from the state file, so a turn
// started by a CLI process that exited early still ends (deterministically) for the next one.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const SIGNATURE = "[Claude Code → Codex]";
const TURN_MS = 100;
const SLOW_MS = Number(process.env.MOCK_CODEX_SLOW_MS) || 3000;
// 1x1 PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const METHODS = [
  "initialize", "thread/loaded/list", "thread/read", "thread/list", "thread/start", "thread/name/set",
  "thread/resume", "thread/settings/update", "thread/turns/list", "thread/queue/add", "thread/queue/list", "turn/start", "review/start",
  "turn/interrupt", "model/list", "account/read", "account/rateLimits/read",
];
const NOTIFICATIONS = ["item/started", "item/completed", "turn/started", "turn/completed", "thread/status/changed"];

const MODELS = [
  { id: "gpt-6-luna", model: "gpt-6-luna", description: "Fast and cheap", hidden: false, efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", description: "Everyday model", hidden: false, efforts: ["low", "medium", "high", "xhigh", "ultra"] },
  { id: "gpt-6-astra", model: "gpt-6-astra", description: "Strongest model", hidden: false, efforts: ["medium", "high", "xhigh", "ultra"] },
  { id: "gpt-6-hidden", model: "gpt-6-hidden", description: "Internal", hidden: true, efforts: ["medium"] },
].map(({ efforts, ...m }) => ({ ...m, supportedReasoningEfforts: efforts.map(e => ({ reasoningEffort: e, description: e })) }));

// ---------------------------------------------------------------- simple commands

if (args.length === 0) process.exit(0); // `node --test` also runs files under test/; nothing to do then
if (args[0] === "--version") {
  console.log("codex-cli 0.0.0-mock");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "daemon") {
  if (args[2] === "version") console.log(JSON.stringify({ status: "running", appServerVersion: "0.0.0-mock" }));
  process.exit(args[2] === "start" || args[2] === "version" ? 0 : 2);
}
if (args[0] === "app-server" && args[1] === "generate-json-schema") {
  const at = args.indexOf("--out");
  if (at < 0 || !args[at + 1]) { console.error("--out is required"); process.exit(2); }
  const dir = args[at + 1];
  fs.mkdirSync(dir, { recursive: true });
  const drop = process.env.MOCK_CODEX_DROP_METHOD;
  const schema = names => ({ oneOf: names.filter(n => n !== drop).map(n => ({ type: "object", properties: { method: { type: "string", enum: [n] } } })) });
  fs.writeFileSync(path.join(dir, "ClientRequest.json"), JSON.stringify(schema(METHODS), null, 2));
  fs.writeFileSync(path.join(dir, "ServerNotification.json"), JSON.stringify(schema(NOTIFICATIONS), null, 2));
  process.exit(0);
}
if (!(args[0] === "app-server" && args[1] === "proxy")) {
  console.error(`mock-codex: unsupported arguments: ${args.join(" ")}`);
  process.exit(2);
}

// ---------------------------------------------------------------- state

const STATE = process.env.MOCK_CODEX_STATE;
if (!STATE) { console.error("mock-codex: set MOCK_CODEX_STATE"); process.exit(2); }

function load() {
  let text;
  try { text = fs.readFileSync(STATE, "utf8"); } catch { return { seq: 0, threads: {}, limitHit: false, clientResponses: [] }; }
  const s = JSON.parse(text);
  s.seq ??= 0; s.threads ??= {}; s.clientResponses ??= [];
  for (const t of Object.values(s.threads)) { t.turns ??= []; t.settingsLog ??= []; }
  return s;
}

function save(s) {
  const tmp = `${STATE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, STATE); return; } catch (err) {
      if (i >= 20) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); fs.rmSync(tmp, { force: true }); return; }
      const until = Date.now() + 10; while (Date.now() < until) { /* brief retry on a Windows sharing violation */ }
    }
  }
}

const nextId = (s, prefix) => `${prefix}-${++s.seq}`;
const nowS = () => Math.floor(Date.now() / 1000);
const textOf = input => (input ?? []).filter(i => i.type === "text").map(i => i.text).join("\n");
const firstLine = input => textOf(input).replace(SIGNATURE, "").trim().split("\n")[0].trim();

function writePng(s, name) {
  const dir = path.join(path.dirname(path.resolve(STATE)), "generated");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(PNG_B64, "base64"));
  return file;
}

function threadStatus(t) {
  if (!t.loaded) return { type: "notLoaded" };
  return t.turns.some(x => x.status === "inProgress") ? { type: "active", activeFlags: [] } : { type: "idle" };
}

function publicThread(t) {
  const first = t.turns[0];
  return {
    id: t.id, name: t.name ?? null, cwd: t.cwd, threadSource: t.threadSource ?? "cli", model: t.model ?? null,
    preview: t.preview ?? (first ? firstLine(first.input) : ""), status: threadStatus(t),
    createdAt: t.createdAt ?? 0, updatedAt: t.updatedAt ?? t.createdAt ?? 0,
  };
}

const publicTurn = t => ({ id: t.id, status: t.status, items: t.items ?? [], error: t.error ?? null, startedAt: t.startedAt ?? null, completedAt: t.completedAt ?? null });

function newThread(s, fields) {
  const t = { id: randomUUID(), name: null, cwd: process.cwd(), threadSource: "cli", loaded: true, model: "gpt-6.1-sol", reasoningEffort: "medium", createdAt: nowS(), order: ++s.seq, turns: [], settingsLog: [], ...fields };
  s.threads[t.id] = t;
  return t;
}

function getThread(s, id) {
  const t = s.threads[id];
  if (!t) throw rpcError(-32600, `thread not found: ${id}`);
  return t;
}

// Finishes a turn: user message, marker-driven items, agent answer, status.
function complete(s, thread, turn) {
  const text = textOf(turn.input);
  const items = [{
    type: "userMessage", id: nextId(s, "item"),
    content: (turn.input ?? []).map(i => (i.type === "text" ? { type: "text", text: i.text, text_elements: [] } : i)),
    ...(turn.clientUserMessageId ? { clientId: turn.clientUserMessageId } : {}),
  }];
  turn.completedAt = nowS();
  if (text.includes("[[image]]")) {
    const a = nextId(s, "item");
    items.push({ type: "imageGeneration", id: a, status: "completed", revisedPrompt: "a red dot", transparentBackground: false, savedPath: writePng(s, a), result: PNG_B64 });
    items.push({ type: "imageGeneration", id: nextId(s, "item"), status: "completed", revisedPrompt: "a blue dot", transparentBackground: true, result: PNG_B64 });
  }
  if (text.includes("[[subagent]]")) {
    const child = newThread(s, { threadSource: "subagent", cwd: thread.cwd, name: null, loaded: true });
    const img = nextId(s, "item");
    child.turns.unshift({
      id: nextId(s, "turn"), status: "completed", error: null, startedAt: turn.startedAt, completedAt: turn.completedAt,
      input: [{ type: "text", text: "draw" }],
      items: [{ type: "imageGeneration", id: img, status: "completed", revisedPrompt: "subagent dot", transparentBackground: false, savedPath: writePng(s, img) }],
    });
    items.push({ type: "subAgentActivity", id: nextId(s, "item"), kind: "started", agentThreadId: child.id });
  }
  if (text.includes("[[limit]]")) {
    s.limitHit = true;
    turn.status = "failed";
    turn.error = { message: "You've hit your usage limit. Try again later.", codexErrorInfo: "usageLimitExceeded" };
  } else if (turn.review) {
    const review = `mock review of ${turn.review.type}${turn.review.branch ? " " + turn.review.branch : ""}${turn.review.sha ? " " + turn.review.sha : ""}`;
    items.push({ type: "enteredReviewMode", id: nextId(s, "item"), review: "" });
    items.push({ type: "exitedReviewMode", id: nextId(s, "item"), review });
    items.push({ type: "agentMessage", id: nextId(s, "item"), text: review });
    turn.status = "completed";
    turn.error = null;
  } else if (turn.outputSchema && !text.includes("[[noschema]]")) {
    const opinion = {
      verdict: "sound-with-changes", confidence: "medium", summary: "mock opinion",
      agreements: ["step order"], alternatives: ["do less"], questions: ["why now?"],
      concerns: [{ severity: "high", point: "no rollback", why: "data loss", suggestion: "add one", evidence: "plan step 3" }],
    };
    items.push({ type: "agentMessage", id: nextId(s, "item"), text: JSON.stringify(opinion) });
    turn.status = "completed";
    turn.error = null;
  } else {
    items.push({ type: "agentMessage", id: nextId(s, "item"), text: `echo: ${firstLine(turn.input)}` });
    turn.status = "completed";
    turn.error = null;
  }
  turn.items = items;
  thread.updatedAt = turn.completedAt;
}

// Completes every overdue turn in the state.
function settle(s) {
  const now = Date.now();
  for (const t of Object.values(s.threads)) {
    for (const turn of [...t.turns].reverse()) if (turn.status === "inProgress" && turn.dueAt <= now) complete(s, t, turn);
  }
}

function addTurn(s, thread, { input, clientUserMessageId = null }) {
  const running = thread.turns.filter(t => t.status === "inProgress").map(t => t.dueAt);
  const start = Math.max(Date.now(), ...running);
  const turn = {
    id: nextId(s, "turn"), status: "inProgress", items: [], error: null, startedAt: Math.floor(start / 1000), startAt: start, completedAt: null,
    dueAt: start + (textOf(input).includes("[[slow]]") ? SLOW_MS : TURN_MS),
    input, clientUserMessageId, model: thread.model, effort: thread.reasoningEffort,
    approval: textOf(input).includes("[[approval]]"),
  };
  thread.turns.unshift(turn); // newest first
  thread.loaded = true;
  if (!thread.preview) thread.preview = firstLine(input);
  return turn;
}

// ---------------------------------------------------------------- JSON-RPC handlers

function rpcError(code, message) { return Object.assign(new Error(message), { rpcCode: code }); }

const handlers = {
  initialize: () => ({ userAgent: "mock-codex/0.0.0", codexHome: path.dirname(path.resolve(STATE)) }),
  "thread/loaded/list": s => ({ data: Object.values(s.threads).filter(t => t.loaded).sort((a, b) => a.order - b.order).map(t => t.id) }),
  "thread/read": (s, p) => ({ thread: publicThread(getThread(s, p.threadId)) }),
  "thread/list": (s, p) => {
    let list = Object.values(s.threads).filter(t => t.threadSource !== "subagent");
    if (p.searchTerm) list = list.filter(t => (t.name ?? "").includes(p.searchTerm) || publicThread(t).preview.includes(p.searchTerm));
    if (p.cwd) list = list.filter(t => samePath(t.cwd, p.cwd));
    list.sort((a, b) => b.order - a.order);
    return { data: list.slice(0, p.limit ?? 25).map(publicThread), nextCursor: null };
  },
  "thread/start": (s, p) => {
    const t = newThread(s, {
      cwd: p.cwd ?? process.cwd(), threadSource: p.threadSource ?? "appServer", sandbox: p.sandbox ?? null,
      approvalPolicy: p.approvalPolicy ?? null, serviceTier: p.serviceTier ?? null, ...(p.model ? { model: p.model } : {}),
    });
    return { thread: publicThread(t), model: t.model, reasoningEffort: t.reasoningEffort, modelProvider: "openai", cwd: t.cwd, sandbox: t.sandbox, approvalPolicy: t.approvalPolicy };
  },
  "thread/name/set": (s, p) => { getThread(s, p.threadId).name = p.name; return {}; },
  "thread/resume": (s, p) => {
    const t = getThread(s, p.threadId);
    if (!t.turns.length) throw rpcError(-32600, `no rollout found for thread id ${t.id}`);
    t.loaded = true;
    return { thread: publicThread(t), model: t.model, reasoningEffort: t.reasoningEffort, modelProvider: "openai", cwd: t.cwd };
  },
  "thread/settings/update": (s, p) => {
    const t = getThread(s, p.threadId);
    if (p.model) t.model = p.model;
    if (p.effort) t.reasoningEffort = p.effort;
    t.settingsLog.push({ ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) });
    return {};
  },
  "thread/turns/list": (s, p) => ({ data: getThread(s, p.threadId).turns.slice(0, p.limit ?? 25).map(publicTurn), nextCursor: null }),
  "thread/queue/add": (s, p) => {
    const t = getThread(s, p.threadId);
    const turn = addTurn(s, t, { input: p.input, clientUserMessageId: p.clientUserMessageId ?? null });
    return { after: () => schedule(t.id, turn), result: { queuedSubmission: { id: "q-" + turn.id, clientUserMessageId: turn.clientUserMessageId, input: turn.input } } };
  },
  // A message counts as queued until its turn starts, behind the turn that is running.
  "thread/queue/list": (s, p) => {
    const now = Date.now();
    const waiting = getThread(s, p.threadId).turns.filter(x => x.status === "inProgress" && x.clientUserMessageId && x.startAt > now);
    return { data: waiting.reverse().map(x => ({ id: "q-" + x.id, clientUserMessageId: x.clientUserMessageId, input: x.input })), nextCursor: null };
  },
  "turn/start": (s, p) => {
    const t = getThread(s, p.threadId);
    if (p.effort) t.reasoningEffort = p.effort;
    if (p.model) t.model = p.model;
    const turn = addTurn(s, t, { input: p.input });
    if (p.outputSchema) turn.outputSchema = p.outputSchema;
    return { after: () => schedule(t.id, turn), result: { turn: publicTurn(turn) } };
  },
  "review/start": (s, p) => {
    const t = getThread(s, p.threadId);
    const turn = addTurn(s, t, { input: [{ type: "text", text: "review" }] });
    turn.review = p.target;
    turn.delivery = p.delivery ?? null;
    return { after: () => schedule(t.id, turn), result: { reviewThreadId: t.id, turn: publicTurn(turn) } };
  },
  "turn/interrupt": (s, p) => {
    const t = getThread(s, p.threadId);
    const turn = t.turns.find(x => x.id === p.turnId);
    if (!turn || turn.status !== "inProgress") throw rpcError(-32600, "no running turn to interrupt");
    turn.status = "interrupted";
    turn.completedAt = nowS();
    emitted.add(turn.id);
    return { after: () => notify("turn/completed", { threadId: t.id, turn: publicTurn(turn) }), result: {} };
  },
  "model/list": () => ({ data: MODELS, nextCursor: null }),
  "account/read": () => ({ account: { type: "chatgpt", email: "test@example.com", planType: "pro" }, requiresOpenaiAuth: true }),
  "account/rateLimits/read": s => {
    const reset = Math.floor(Date.UTC(2030, 0, 1, 12, 0) / 1000);
    const limits = {
      limitId: "codex", limitName: null, planType: "pro",
      primary: { usedPercent: s.limitHit ? 100 : 12, windowDurationMins: 300, resetsAt: reset },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: reset + 3 * 86400 },
      credits: null, rateLimitReachedType: s.limitHit ? "primary" : null,
    };
    return { rateLimits: limits, rateLimitsByLimitId: { codex: limits } };
  },
};

const caseless = process.platform === "win32" || process.platform === "darwin";
function canon(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch { /* compare by name */ }
  return caseless ? r.toLowerCase() : r;
}
const samePath = (a, b) => !!a && !!b && canon(a) === canon(b);

// ---------------------------------------------------------------- turn timers and events

const emitted = new Set();

function schedule(threadId, turn) {
  const delay = Math.max(0, turn.dueAt - Date.now());
  if (turn.approval) {
    setTimeout(() => send({
      jsonrpc: "2.0", id: `approval-${turn.id}`, method: "item/commandExecution/requestApproval",
      params: { threadId, turnId: turn.id, itemId: "cmd-1", command: "rm -rf build", reason: "needs approval" },
    }), Math.floor(delay / 2));
  }
  setTimeout(() => {
    const s = load();
    settle(s);
    save(s);
    const done = s.threads[threadId]?.turns.find(t => t.id === turn.id);
    if (!done || done.status === "inProgress" || emitted.has(done.id)) return;
    emitted.add(done.id);
    for (const item of done.items) {
      notify("item/started", { threadId, turnId: done.id, item });
      notify("item/completed", { threadId, turnId: done.id, item });
    }
    notify("turn/completed", { threadId, turn: publicTurn(done) });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
  }, delay);
}

// ---------------------------------------------------------------- WebSocket on stdio

let upgraded = false, buf = Buffer.alloc(0), fragments = [];

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function send(obj) { if (upgraded) process.stdout.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); }
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

function handle(text) {
  const msg = JSON.parse(text);
  if (msg.id != null && !msg.method) { // a client's answer to a server request: recorded, so tests can see it
    const s = load(); s.clientResponses.push(msg); save(s);
    return;
  }
  if (msg.id == null) return; // notifications such as `initialized`
  const fn = handlers[msg.method];
  if (!fn) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  let after = null;
  try {
    const s = load();
    settle(s);
    let result = fn(s, msg.params ?? {});
    if (result && typeof result.after === "function") ({ after, result } = result);
    save(s);
    send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (err) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: err.rpcCode ?? -32603, message: err.message } });
  }
  if (after) after();
}

process.stdin.on("data", chunk => {
  buf = Buffer.concat([buf, chunk]);
  if (!upgraded) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = buf.subarray(0, end).toString("latin1");
    const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(head)?.[1] ?? "";
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    upgraded = true;
    process.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    buf = buf.subarray(end + 4);
    // turns left running by an earlier CLI process finish (and report) here too
    const s = load();
    for (const t of Object.values(s.threads)) for (const turn of t.turns) if (turn.status === "inProgress") schedule(t.id, turn);
  }
  for (;;) {
    if (buf.length < 2) return;
    const op = buf[0] & 0x0f, fin = buf[0] & 0x80, masked = buf[1] & 0x80;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const keyAt = off;
    if (masked) off += 4;
    if (buf.length < off + len) return;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[keyAt + (i % 4)];
    buf = buf.subarray(off + len);
    if (op === 0x8) process.exit(0);
    else if (op === 0x9) process.stdout.write(frame(0xa, payload));
    else if (op === 0x1 || op === 0x0) {
      fragments.push(payload);
      if (fin) { const text = Buffer.concat(fragments).toString("utf8"); fragments = []; handle(text); }
    }
  }
});
process.stdin.on("end", () => process.exit(0));
