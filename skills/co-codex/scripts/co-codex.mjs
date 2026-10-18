#!/usr/bin/env node
// co-codex: lets an agent such as Claude Code hand work to OpenAI Codex sessions on this
// machine and read the answers. It talks to the shared Codex daemon (lib/daemon.mjs), so it
// reaches a Codex window someone already has open as well as sessions it starts itself.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCodex, runCodex } from "./lib/codex-bin.mjs";
import { loadConfig, resolveTier, userConfigPath } from "./lib/config.mjs";
import { connect } from "./lib/daemon.mjs";
import { collectImages, copyImages, imagesOf, limitFailure, namesNote, parseNames, planNames, usableImages } from "./lib/images.mjs";
import { SANDBOXES, networkConfig, networkHints, sandboxOf } from "./lib/sandbox.mjs";
import { declinedActions, walkTurn } from "./lib/turns.mjs";
import { estimate, logRun, readWindows, usageReport } from "./lib/usage.mjs";

const USAGE = `Usage: node <skill dir>/scripts/co-codex.mjs <command> [options]

Sessions
  list [--all]                        Open Codex sessions; --all adds saved ones in this project
  spawn <text|-> --name <name> [run options] [--cwd <dir>] [--sandbox <mode>] [--network] [--fast]
                                      Start a new named session and give it the task
  send <session> <text|-> [run options] [--keep]
                                      Queue a message; it runs after Codex's current turn, if any
  wait <session> [--message <id>] [--out <dir>] [--names <list>] [--json]
                                      Wait for a turn and print its answer: the turn of --message
                                      (the id send prints), else the last queued message, else the latest turn
  read <session> [--turns <n>]        Print the last answers (default 1)
  stop <session>                      Interrupt the running turn
  images <session> [--turns <n> | --turn <id>] [--out <dir>] [--json]
                                      List (and copy) the images of the last turns, subagents included
  cleanup [--older-than <30m|12h|2d|1w>] [--name-prefix <p>] [--yes] [--json]
                                      Sessions co-codex started in this project that no window has open
                                      and that were last used before the cutoff (default 2d). Lists them;
                                      --yes deletes them. Never touches sessions co-codex did not start

Second opinion (read-only, in addition to your own review)
  opinion <text|-> [--on <what>] [--mode independent|challenge] [--file <path>]... [--tier <name>]
                                      Fresh read-only session; Codex reviews a plan, decision, design or
                                      text and answers with a verdict, ranked concerns, alternatives and
                                      questions. challenge: the text carries your position, Codex attacks it
  opinion --diff | --base <branch> | --commit <sha> [--tier <name>]
                                      Codex's built-in code reviewer on uncommitted changes, a branch or a commit
                                      (default tier for opinions: high; --name, --cwd, --timeout, --json work too)

Account and setup
  models                              Models this account offers and what each tier resolves to
  limits [--json]                     Usage of the current windows (5-hour, weekly) and when they reset
  limits --estimate <n> [--tier <name>]
                                      Expected share of the windows for n images, from past --images runs
  doctor                              Check codex, the daemon, sign-in, tiers and the protocol methods used
  init [--write]                      Print the AGENTS.md note for Codex, or append it to the project's
                                      AGENTS.md (at the git top level)

Run options (spawn, send)
  --tier <name>      draft | standard | high | max (see \`models\`); --model and --effort override it
  --model <id>       --effort <level>
  --images           add the tier's image-quality instructions and ask for the kept image paths
  --subagents        ask Codex to split the work across its own subagents
  --ref <file>       attach a reference image (repeatable)
  --wait             block until the turn ends; --timeout <s> (default 3600)
  --out <dir>        with --wait: copy the turn's images there and log them in co-codex-images.jsonl
  --names <list>     with --images and --out: a.png,b.png,... Codex reports which image it kept for
                     each name; those are copied under the names, the other images to <out>/_rejected
  --json             print a machine-readable result

  <session>  a session id, an exact session name, or "open" (the one Codex window open in this project).
             Saved sessions of yours that no window has open are refused: open them with
             \`codex resume <name>\` first, so someone can answer their approval prompts.
  <text|->   the message; "-" reads it from stdin
  --sandbox  danger-full-access | workspace-write | read-only (default from config: workspace-write).
             Fixed when the session starts; send cannot change it
  --network  spawn in workspace-write with network access (installs, deploys, anything online)
  --keep     send with --tier/--model/--effort: leave the session on that model afterwards. Without
             --keep, send needs --wait and switches the session back once its turn has started

Exit codes: 0 done, 1 error, 2 timed out (Codex keeps working; run wait), 3 turn failed or was
interrupted, 4 usage limit reached (the message says when it resets), 5 answered, but a session co-codex
started was refused actions that need approval (listed on stderr and in --json "declined")`;

const SOURCE = "co-codex";
const ALL_SOURCES = ["cli", "vscode", "exec", "appServer", "unknown"]; // thread/list defaults to interactive ones only
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLAGS = new Set(["wait", "all", "json", "images", "subagents", "fast", "write", "keep", "diff", "network", "yes"]);
const VALUES = new Set([
  "name", "tier", "model", "effort", "timeout", "out", "cwd", "sandbox", "turns", "turn", "message", "ref", "on", "mode", "file", "base", "commit",
  "names", "older-than", "name-prefix", "estimate",
]);
const REPEATABLE = new Set(["ref", "file"]);
// How many positional arguments each command takes, so a stray word is an error instead of the message.
const ARITY = { list: 0, spawn: 1, send: 2, wait: 1, read: 1, stop: 1, images: 1, opinion: 1, cleanup: 0, models: 0, limits: 0, doctor: 0, init: 0 };
// The daemon methods and notifications co-codex relies on; `doctor` checks them against the installed Codex.
const USED_METHODS = [
  "thread/loaded/list", "thread/read", "thread/list", "thread/resume", "thread/turns/list", "thread/queue/add", "thread/queue/list",
  "thread/start", "thread/name/set", "thread/settings/update", "thread/delete", "turn/start", "turn/interrupt", "review/start",
  "model/list", "account/read", "account/rateLimits/read", "config/read",
];
const USED_NOTIFICATIONS = ["item/started", "item/completed", "turn/completed", "thread/status/changed"];
const SUBAGENTS_NOTE =
  "Split this work across your subagents (for example one per image or per group of related images) and run them " +
  "in parallel. Give each subagent its own files; only you edit shared files such as logs or indexes, from their reports.";
// Codex does not see where its image tool saves files; co-codex collects them from the turn itself.
const IMAGES_NOTE =
  "You do not need to report where generated images are stored; they are collected from this turn automatically. " +
  "If the task asks you to save images to files, end your answer with those file paths.";

const OPINION_MODES = ["independent", "challenge"];
// The final message of an opinion turn is constrained to this shape (strict: every key required).
const OPINION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "summary", "agreements", "concerns", "alternatives", "questions"],
  properties: {
    verdict: { type: "string", enum: ["sound", "sound-with-changes", "rethink"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string" },
    agreements: { type: "array", items: { type: "string" } },
    concerns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "point", "why", "suggestion", "evidence"],
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          point: { type: "string" },
          why: { type: "string" },
          suggestion: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    alternatives: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
  },
};

const debug = (...args) => { if (process.env.CO_CODEX_DEBUG) console.error("[co-codex debug]", ...args); };

class BridgeError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--") || a === "-") { pos.push(a); continue; }
    const key = a.slice(2);
    if (FLAGS.has(key)) { opt[key] = true; continue; }
    if (!VALUES.has(key)) throw new BridgeError(`unknown option ${a}; see help`);
    if (i + 1 >= argv.length) throw new BridgeError(`${a} needs a value`);
    const value = argv[++i];
    if (REPEATABLE.has(key)) (opt[key] ??= []).push(value);
    else opt[key] = value;
  }
  return { pos, opt };
}

function posInt(value, fallback, flag, max = 2_000_000) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > max) throw new BridgeError(`--${flag} must be a whole number from 1 to ${max}`);
  return n;
}
const timeoutOf = opt => posInt(opt.timeout, 3600, "timeout");

const AGE_UNITS = { m: 60, h: 3600, d: 86400, w: 604800 };
function ageSeconds(value) {
  const m = /^(\d+)([mhdw])$/.exec(String(value).trim());
  if (!m || Number(m[1]) <= 0) throw new BridgeError("--older-than takes a number and a unit, such as 30m, 12h, 2d or 1w");
  return Number(m[1]) * AGE_UNITS[m[2]];
}

async function readText(arg) {
  if (arg === undefined) throw new BridgeError("missing message text (or - for stdin)");
  let text = arg;
  if (arg === "-") { // a stream, not readFileSync(0), which can fail with EAGAIN on a non-blocking pipe
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (!text.trim()) throw new BridgeError("message is empty");
  return text;
}

// Paths compare case-insensitively where the file system usually is (Windows, macOS), and
// through realpath so /tmp and /private/tmp on macOS are the same place.
const caseless = process.platform === "win32" || process.platform === "darwin";
function canon(p) {
  let r = path.resolve(p);
  try { r = realpathSync.native(r); } catch { /* a path that no longer exists still compares by name */ }
  return caseless ? r.toLowerCase() : r;
}
const samePath = (a, b) => !!a && !!b && canon(a) === canon(b);
function inside(child, parent) {
  if (!child || !parent) return false;
  const c = canon(child), p = canon(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// The git top level, or the working directory outside a repository (git: false).
function projectRoot() {
  const cwd = process.cwd();
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? { root: path.resolve(r.stdout.trim()), git: true } : { root: cwd, git: false };
}

const statusLabel = s => !s ? "?" : s.type === "active" && s.activeFlags?.length ? `active (${s.activeFlags.join(", ")})` : s.type;
const oneLine = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const shellArg = s => (/\s/.test(s) ? `"${s}"` : s);
const userText = item => (item.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
const pad = n => String(n).padStart(2, "0");
function localTime(unixS) {
  if (!unixS) return "unknown";
  const d = new Date(unixS * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Notifications are routed to whichever waiter is listening for that thread.
const listeners = new Set();
const onNotification = msg => { for (const l of listeners) l(msg); };
const notedRequests = new Set();
const onServerRequest = msg => {
  const key = `${msg.params?.threadId}:${msg.method}`;
  if (notedRequests.has(key)) return;
  notedRequests.add(key);
  console.error(`! Codex asks for approval (${msg.method}). Answer it in the Codex window; co-codex never approves.`);
};

async function readThread(rpc, threadId) {
  return (await rpc.request("thread/read", { threadId })).thread;
}

const isSubagent = t => !!t.parentThreadId || t.threadSource === "subagent";

// Every saved session whose name is exactly `name`, newest first (a search matches substrings).
async function sessionsNamed(rpc, name) {
  const hits = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const res = await rpc.request("thread/list", { searchTerm: name, limit: 100, sourceKinds: ALL_SOURCES, ...(cursor ? { cursor } : {}) });
    hits.push(...(res.data ?? []).filter(t => t.name === name));
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return hits;
}

async function resolveThread(rpc, ctx, ref) {
  if (!ref) throw new BridgeError("missing <session>");
  if (UUID_RE.test(ref)) return readThread(rpc, ref);
  if (ref === "open") {
    const ids = (await rpc.request("thread/loaded/list", {})).data ?? [];
    const threads = await Promise.all(ids.map(id => readThread(rpc, id)));
    const windows = threads.filter(t => inside(t.cwd, ctx.root) && t.threadSource !== SOURCE && !isSubagent(t));
    if (windows.length === 1) return windows[0];
    if (!windows.length) throw new BridgeError("no open Codex window in this project; start `codex` in a terminal here, or use spawn");
    throw new BridgeError("more than one open Codex window here, name one:\n" + windows.map(t => `  ${t.id}  ${t.name ?? "(no name)"}  ${oneLine(t.preview, 50)}`).join("\n"));
  }
  const hits = await sessionsNamed(rpc, ref);
  if (!hits.length) throw new BridgeError(`no session named "${ref}"; see \`list --all\``);
  // The same name can exist in several projects: this project's newest wins, elsewhere it must be unique.
  const local = hits.filter(t => inside(t.cwd, ctx.root));
  if (local.length) return readThread(rpc, local[0].id);
  if (hits.length === 1) return readThread(rpc, hits[0].id);
  throw new BridgeError(`"${ref}" names sessions in several other projects; use the id:\n` + hits.map(t => `  ${t.id}  @ ${t.cwd}`).join("\n"));
}

// Subscribes this connection to the thread's events (and loads a saved thread onto the daemon).
// Returns the resume response, which carries the thread's current model and effort, or null for
// a brand-new window that has no turn yet.
async function subscribe(rpc, thread, ctx) {
  // A session co-codex started has nobody at a window, so it keeps its no-prompt policy when reloaded.
  const own = thread.threadSource === SOURCE ? { approvalPolicy: ctx.config.spawn?.approvalPolicy ?? "never" } : {};
  try { return await rpc.request("thread/resume", { threadId: thread.id, excludeTurns: true, ...own }); }
  catch (err) { if (/no rollout/i.test(err.message)) return null; throw err; }
}

// "summary" carries the user and agent messages (enough to match a turn and read the answer) and
// stays small; "full" adds every item, including the base64 data of each generated image.
async function recentTurns(rpc, threadId, limit, view = "full") {
  const { data } = await rpc.request("thread/turns/list", { threadId, limit, itemsView: view });
  return data ?? [];
}
const RECENT = 10; // turns looked at when matching a queued message to its turn

async function turnById(rpc, threadId, id, depth = RECENT) {
  return (await recentTurns(rpc, threadId, depth, "full")).find(t => t.id === id) ?? null;
}

async function queuedMessages(rpc, threadId) {
  return (await rpc.request("thread/queue/list", { threadId })).data ?? [];
}

async function defaultEffort(rpc, modelId) {
  const models = (await rpc.request("model/list", {}).catch(() => null))?.data ?? [];
  return models.find(m => (m.id ?? m.model) === modelId)?.defaultReasoningEffort ?? null;
}

const finalAnswer = items => {
  const msgs = items.filter(i => i.type === "agentMessage" && i.text?.trim());
  return msgs.length ? msgs[msgs.length - 1].text : "";
};

// Waits for one turn to end, the known `turnId` or the first turn `match` accepts, and resolves
// with that turn as the history records it (items, subagents, error). Events drive it; a poll of
// the history covers events that cannot or did not arrive. `state.turnId` tells the caller
// whether the turn was found at all, even when the wait times out.
function waitForTurn(rpc, threadId, { turnId = null, match = {}, timeoutS, subscribed, state = {} }) {
  return new Promise((resolve, reject) => {
    let timer, poller, polling = false, settled = false, lastFlags = "";
    const seen = new Map(); // items reported by events, kept in case the history lags behind
    const found = id => { turnId = id; state.turnId = id; };
    if (turnId) found(turnId);
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      listeners.delete(listener); clearTimeout(timer); clearInterval(poller); fn(v);
    };
    const fullTurn = async (id, depth) => (await recentTurns(rpc, threadId, depth, "full")).find(t => t.id === id);
    const poll = async ({ final } = {}) => {
      if (polling || settled) return;
      polling = true;
      try {
        const turns = await recentTurns(rpc, threadId, turnId ? 3 : RECENT, "summary");
        debug("poll", turns.map(t => `${t.id}:${t.status}`).join(" "), final ? `final:${final.status}` : "");
        const at = turns.findIndex(t => (turnId ? t.id === turnId : match.byTurn?.(t)));
        if (at >= 0) {
          found(turns[at].id);
          if (turns[at].status !== "inProgress") {
            // Seen live once: the summary view called a turn finished while the full view still had it running.
            const full = await fullTurn(turnId, at + 1);
            if (!full || full.status !== "inProgress") return finish(resolve, full ?? turns[at]);
            debug("summary and full views disagree; still waiting");
          }
        }
        if (final?.status && final.status !== "inProgress") finish(resolve, final); // the turn ended but the history has not caught up
      } catch {
        if (final?.status && final.status !== "inProgress") finish(resolve, final); // a lost connection is reported through rpc.closed; anything else retries
      } finally { polling = false; }
    };
    const listener = msg => {
      const p = msg.params ?? {};
      if (p.threadId !== threadId) return;
      if (!/delta$/.test(msg.method)) debug("event", msg.method, p.turn?.id ?? p.turnId ?? "", p.turn?.status ?? "");
      if ((msg.method === "item/started" || msg.method === "item/completed") && !turnId && match.byItem?.(p.item)) found(p.turnId);
      if (msg.method === "item/completed" && p.item) seen.set(p.item.id, { turnId: p.turnId, item: p.item });
      if (msg.method === "thread/status/changed") {
        const flags = (p.status?.activeFlags ?? []).join(", ");
        if (flags && flags !== lastFlags) console.error(`! Codex is ${flags}; it continues once that is answered in the Codex window.`);
        lastFlags = flags;
      }
      if (msg.method !== "turn/completed") return;
      if (!turnId) return void poll(); // the start event came before we listened
      if (p.turn?.id !== turnId) return;
      const items = [...seen.values()].filter(x => x.turnId === turnId).map(x => x.item);
      const final = { ...p.turn, items: p.turn.items?.length ? p.turn.items : items };
      const settle = () => (polling ? setTimeout(settle, 200) : poll({ final })); // let a running poll finish first
      settle();
    };
    listeners.add(listener);
    rpc.closed.then(err => finish(reject, new BridgeError(`lost the Codex daemon (${err.message}); Codex may still be working, run wait again`)));
    poller = setInterval(poll, subscribed ? 30_000 : 5_000);
    poll();
    timer = setTimeout(() => finish(reject, new BridgeError(`no answer within ${timeoutS}s; Codex keeps working, run: wait ${threadId}`, 2)), timeoutS * 1000);
  });
}

// Model and effort for a spawn or send: the tier (or config.defaultTier), then explicit flags.
async function chooseRun(rpc, config, opt) {
  const name = opt.tier ?? config.defaultTier;
  let tier = null;
  if (name) {
    const models = (await rpc.request("model/list", {})).data ?? [];
    tier = resolveTier(config, name, models);
    for (const w of tier.warnings) console.error(`co-codex: ${w}`);
  }
  return {
    tier: tier?.tier ?? null,
    model: opt.model ?? tier?.model ?? null,
    effort: opt.effort ?? tier?.effort ?? null,
    imageNote: tier?.imageNote || config.tiers?.standard?.imageNote || "",
  };
}

function compose(config, text, run, opt) {
  const parts = [config.signature, text.trim()];
  if (opt.images) parts.push(`Image quality${run.tier ? ` (${run.tier} tier)` : ""}: ${run.imageNote} ${IMAGES_NOTE}`.replace(/\s+$/, ""));
  if (run.names) parts.push(namesNote(run.names));
  if (opt.subagents) parts.push(SUBAGENTS_NOTE);
  return parts.filter(Boolean).join("\n\n");
}

// --names: checked before anything reaches Codex. Subagents generate in their own threads, which
// a single count across the turn cannot cover, so the two do not mix.
function namesOption(opt, cmd) {
  if (opt.names === undefined) return null;
  if (opt.subagents) throw new BridgeError("--names does not work with --subagents: each subagent numbers its images in its own thread. Leave out one of them");
  if (cmd !== "wait" && !opt.images) throw new BridgeError("--names needs --images");
  if (!opt.out) throw new BridgeError("--names needs --out <dir>, the folder the named files go to");
  try { return parseNames(opt.names); } catch (err) { throw new BridgeError(err.message); }
}

// The sandbox is fixed per session; a task that sounds like it goes online gets a warning (never
// a block) when the session cannot reach the network.
function warnOffline(text, access) {
  const hints = networkHints(text);
  if (!hints.length || access.network !== false) return;
  console.error(`co-codex: warning: the task mentions ${hints.join(", ")}, but this session (${access.sandbox ?? "sandbox unknown"}) has no network access. ` +
    "If Codex needs to go online it will fail. The sandbox cannot change once a session has started: spawn a new one with --network, " +
    "or with --sandbox danger-full-access only with the user's agreement.");
}

const namesHint = opt => (opt.names ? ` --out ${shellArg(opt.out)} --names ${opt.names}` : "");

const accessLabel = a => `${a.sandbox ?? "sandbox unknown"}, network ${a.network === true ? "on" : a.network === false ? "off" : "unknown"}`;

function inputs(text, refs = []) {
  const list = [{ type: "text", text }];
  for (const ref of refs) {
    const file = path.resolve(ref);
    if (!existsSync(file)) throw new BridgeError(`--ref file not found: ${ref}`);
    list.push({ type: "localImage", path: file });
  }
  return list;
}

async function usageLimit(rpc, turn, images) {
  let hit = turn.error?.codexErrorInfo === "usageLimitExceeded" ? { resetsAt: null, limitId: null } : limitFailure(images);
  if (hit && !hit.resetsAt) {
    try {
      const r = await rpc.request("account/rateLimits/read", { excludeResetCreditDetails: true });
      const limits = (hit.limitId && r.rateLimitsByLimitId?.[hit.limitId]) || r.rateLimits;
      const full = [limits?.primary, limits?.secondary].filter(w => w && w.usedPercent >= 100 && w.resetsAt);
      hit.resetsAt = full.length ? Math.max(...full.map(w => w.resetsAt)) : null;
    } catch { /* the reset time stays unknown */ }
  }
  return hit && { resetsAt: hit.resetsAt, resetsAtLocal: hit.resetsAt ? localTime(hit.resetsAt) : null };
}

const sizeOf = i => (i.width && i.height ? `${i.width}x${i.height}` : null);

// Prints a finished turn (answer on stdout, or JSON) and turns its outcome into the exit code.
async function report(rpc, run, turn, opt) {
  const entries = await walkTurn(rpc, run.threadId, turn).catch(err => {
    console.error(`co-codex: could not read the subagents of the turn: ${err.message}`);
    return (turn.items ?? []).map(item => ({ threadId: run.threadId, turnId: turn.id, item }));
  });
  const images = imagesOf(entries);
  const kept = usableImages(images);
  const answer = finalAnswer(turn.items ?? []);
  const plan = run.names && opt.out ? planNames(images.filter(i => i.threadId === run.threadId), run.names, answer) : null;
  if (plan?.warning) console.error(`co-codex: warning: ${plan.warning}`);
  // Codex can start subagents on its own; their images are not in its count, so they are kept aside.
  if (plan?.matchedBy) plan.rejected.push(...usableImages(images.filter(i => i.threadId !== run.threadId)));
  const copied = opt.out ? copyImages(images, path.resolve(opt.out), plan) : [];
  for (const c of copied.filter(c => c.renamed)) console.error(`co-codex: ${c.name} already exists with other content; saved this image as ${path.basename(c.file)}`);
  const finals = copied.filter(c => !c.rejected), rejected = copied.filter(c => c.rejected);
  const declined = declinedActions(entries);
  const limit = await usageLimit(rpc, turn, images);
  const usage = usageReport(run.before, await readWindows(rpc));
  if (opt.images && run.before && turn.status === "completed") { // a failed or cut-off run would skew the estimate
    try { logRun(usage, { ...run, images: kept.length }); }
    catch (err) { console.error(`co-codex: could not log the quota use of this run: ${err.message}`); }
  }
  if (opt.json) {
    console.log(JSON.stringify({
      threadId: run.threadId, name: run.name ?? null, turnId: turn.id, status: turn.status,
      tier: run.tier ?? null, model: run.model ?? null, effort: run.effort ?? null,
      sandbox: run.sandbox ?? null, network: run.network ?? null,
      answer, error: turn.error?.message ?? null,
      images: kept.map(i => ({ path: i.savedPath, threadId: i.threadId, itemId: i.itemId, transparent: i.transparent, width: i.width, height: i.height })),
      copied: finals.map(c => c.file),
      names: plan ? Object.fromEntries(finals.filter(c => c.name).map(c => [c.name, c.file])) : null,
      rejected: rejected.map(c => c.file),
      namesMatchedBy: plan?.matchedBy ?? null,
      declined,
      limit,
      usage,
    }, null, 2));
  } else {
    if (answer) console.log(answer);
    const sizes = [...new Set(kept.map(sizeOf).filter(Boolean))];
    if (kept.length) {
      console.error(`${kept.length} image(s) generated${sizes.length ? ` (${sizes.join(", ")})` : ""}` +
        (copied.length ? `, ${finals.length} copied to ${opt.out}${plan?.matchedBy ? ` under the requested names` : ""}${rejected.length ? `, ${rejected.length} other(s) to ${path.join(opt.out, "_rejected")}` : ""}` : `; copy them with: images ${run.threadId} --out <dir>`));
    }
  }
  // Only a session co-codex started runs with approvals off, so only there was a refusal nobody's
  // choice. In a window a person holds, they declined it themselves: reported, not an error.
  const refused = run.own === false ? [] : declined;
  if (declined.length && run.own === false) {
    console.error(`co-codex: note: ${declined.length} action(s) were declined in the Codex window: ${declined.map(d => d.action).join(", ")}`);
  } else if (declined.length) {
    const resume = `codex resume ${shellArg(run.name ?? run.threadId)} -a on-request`;
    console.error(`! Codex was refused ${declined.length} action(s) that need approval:\n` +
      declined.map(d => `  - ${d.action} (${d.type}): ${oneLine(d.reason, 160)}`).join("\n") +
      `\n  This session runs with approvals off (policy "never"), so nobody could approve them. Ask the user to open \`${resume}\`` +
      " and let Codex retry there; the user approves each action in that window. If the retry needs the network, add" +
      " `-c sandbox_workspace_write.network_access=true`, or `-s danger-full-access` only with the user's agreement.");
  }
  failIfBad(turn, limit, refused);
}

// Precedence: usage limit (4), then a failed or interrupted turn (3), then refused actions (5).
function failIfBad(turn, limit, refused = []) {
  if (limit) throw new BridgeError(`Codex hit the usage limit; it resets at ${limit.resetsAtLocal ?? "an unknown time (see limits)"}. Resend the unfinished part after that.`, 4);
  if (turn.status !== "completed") throw new BridgeError(`Codex turn ${turn.id} ended as "${turn.status}"${turn.error?.message ? ": " + turn.error.message : ""}`, 3);
  if (refused.length) throw new BridgeError(`Codex answered, but ${refused.length} action(s) were refused because they need approval (listed above)`, 5);
}

function opinionPrompt(config, material, { on, mode, files }) {
  return [
    config.signature,
    `Second opinion requested on a ${on}. Claude, another AI agent, is working on this with the user. The user wants ` +
      "your independent view in addition to Claude's own review, not instead of it. You are read-only here: do not change any files.",
    mode === "challenge"
      ? "The material includes Claude's position. Try to refute it: make the strongest case against it, name the assumption " +
        "most likely to be wrong, and say what evidence would change the conclusion. Concede the points that hold."
      : "Form your own view. Claude's conclusion is left out on purpose, so it does not anchor you.",
    files.length ? `Read these files yourself rather than trusting any summary:\n${files.map(f => `- ${f}`).join("\n")}` : "",
    "Check claims against the code and files of this project where you can. Look for wrong assumptions, missing steps, " +
      "risks and failure modes, ordering problems, and simpler or safer alternatives. Disagree where you have grounds and say " +
      "why; agree briefly where it is sound. Do not invent problems to seem useful: an empty concerns list is a valid answer. " +
      "Severity: high means it would cause failure, data loss, a security problem or large rework; medium means real cost " +
      "or risk; low means an improvement. Put a file path with line, a command output or a quote in evidence when you have one.",
    `Material:\n${material.trim()}`,
  ].filter(Boolean).join("\n\n");
}

function renderOpinion(o) {
  const out = [`Verdict: ${o.verdict} (confidence ${o.confidence})`, o.summary];
  if (o.concerns?.length) {
    out.push("", "Concerns:");
    for (const c of o.concerns) {
      out.push(`  [${c.severity}] ${c.point}`);
      if (c.why) out.push(`      why: ${c.why}`);
      if (c.suggestion) out.push(`      do: ${c.suggestion}`);
      if (c.evidence) out.push(`      evidence: ${c.evidence}`);
    }
  }
  for (const [title, xs] of [["Agrees with", o.agreements], ["Alternatives", o.alternatives], ["Questions", o.questions]]) {
    if (xs?.length) out.push("", `${title}:`, ...xs.map(x => `  - ${x}`));
  }
  return out.join("\n");
}

const windowLabel = mins => mins === 300 ? "5-hour window" : mins === 10080 ? "weekly window" : mins ? `${mins}-minute window` : "window";

const commands = {
  async list(rpc, ctx, { opt }) {
    const ids = (await rpc.request("thread/loaded/list", {})).data ?? [];
    const open = (await Promise.all(ids.map(id => readThread(rpc, id)))).filter(t => !isSubagent(t));
    const row = t => `  ${t.id}  ${statusLabel(t.status).padEnd(10)} ${(t.name ?? "(no name)").padEnd(22)} ${(t.model ?? "").padEnd(13)} ${t.threadSource === SOURCE ? "[co-codex] " : ""}${oneLine(t.preview, 50)}${inside(t.cwd, ctx.root) ? "" : "  @ " + t.cwd}`;
    console.log(open.length ? "Open on the daemon:\n" + open.map(row).join("\n") : "No Codex session is open on the daemon.");
    if (opt.all) {
      // Filtered here rather than by the server's exact `cwd` match, which misses other letter case and subfolders.
      const { data } = await rpc.request("thread/list", { limit: 100, sourceKinds: ALL_SOURCES });
      const saved = (data ?? []).filter(t => !ids.includes(t.id) && !isSubagent(t) && inside(t.cwd, ctx.root)).slice(0, 15);
      if (saved.length) console.log("Saved in this project:\n" + saved.map(row).join("\n"));
    }
  },

  async send(rpc, ctx, { pos, opt }) {
    // Codex fixes the sandbox when a thread starts; accepting the flag here would only pretend to change it.
    if (opt.sandbox || opt.network) throw new BridgeError("the sandbox is fixed when a session starts, so send cannot change it; spawn a new session with --sandbox or --network");
    const names = namesOption(opt, "send");
    const thread = await resolveThread(rpc, ctx, pos[0]);
    if (thread.status?.type === "notLoaded" && thread.threadSource !== SOURCE)
      throw new BridgeError(`"${thread.name ?? thread.id}" is not open in any Codex window. Open it with \`codex resume ${shellArg(thread.name ?? thread.id)}\` first, or spawn a new session.`);
    const run = { ...await chooseRun(rpc, ctx.config, opt), threadId: thread.id, name: thread.name, names, own: thread.threadSource === SOURCE };
    const switching = !!(run.model || run.effort);
    if (switching && !opt.wait && !opt.keep)
      throw new BridgeError("--tier/--model/--effort on send changes the model of that session; add --wait (it switches back after the turn) or --keep (it stays)");
    const raw = await readText(pos[1]);
    const text = compose(ctx.config, raw, run, opt);
    const input = inputs(text, opt.ref);
    const timeoutS = timeoutOf(opt);
    const label = thread.name ?? thread.id;
    const on = `${run.model ?? "its model"} / ${run.effort ?? "its effort"}`;
    const resumed = await subscribe(rpc, thread, ctx);
    Object.assign(run, resumed ? sandboxOf(resumed.sandbox) : { sandbox: null, network: null });
    if (!opt.images) warnOffline(raw, run); // image sessions are read-only by design
    const before = new Set((await recentTurns(rpc, thread.id, RECENT, "summary")).map(t => t.id));
    run.before = opt.wait ? await readWindows(rpc) : null;
    const prev = switching && resumed ? { model: resumed.model ?? null, effort: resumed.reasoningEffort ?? null } : null;
    if (prev?.model && !prev.effort) prev.effort = await defaultEffort(rpc, prev.model);
    const was = prev ? ` (it was ${prev.model ?? "?"} / ${prev.effort ?? "?"})` : "";
    const state = {};
    let queued = false;
    try {
      if (switching) await rpc.request("thread/settings/update", { threadId: thread.id, ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}) });
      const clientUserMessageId = randomUUID();
      const { queuedSubmission } = await rpc.request("thread/queue/add", { threadId: thread.id, clientUserMessageId, input });
      queued = true;
      console.error(`queued for ${label} (${statusLabel(thread.status)})${switching ? ` on ${on}` : ""}${resumed ? "" : "; new window, answer is read from history"}`);
      if (switching && opt.keep) console.error(`co-codex: ${label} now runs ${on} for later turns too${was}`);
      if (!opt.wait) {
        if (opt.json) console.log(JSON.stringify({ threadId: thread.id, name: thread.name ?? null, clientUserMessageId, queuedSubmissionId: queuedSubmission?.id ?? null, sandbox: run.sandbox, network: run.network }, null, 2));
        else console.error(`wait for the answer with: wait ${shellArg(label)} --message ${clientUserMessageId}${namesHint(opt)}`);
        return;
      }
      const mine = i => i?.type === "userMessage" && (i.clientId === clientUserMessageId || (i.clientId == null && userText(i) === text));
      const turn = await waitForTurn(rpc, thread.id, {
        match: { byItem: mine, byTurn: t => !before.has(t.id) && (t.items ?? []).some(mine) },
        timeoutS,
        subscribed: !!resumed,
        state,
      });
      await report(rpc, run, turn, opt);
    } finally {
      // Switch back once the turn has started (it keeps the model it started with) or when queueing
      // failed. A message still waiting in the queue would run on the old model, so it is left alone.
      if (switching && !opt.keep && opt.wait) {
        if (prev && (state.turnId || !queued)) {
          const back = { ...(prev.model ? { model: prev.model } : {}), ...(prev.effort ? { effort: prev.effort } : {}) };
          await rpc.request("thread/settings/update", { threadId: thread.id, ...back })
            .then(() => console.error(`co-codex: switched ${label} back to ${prev.model ?? "its model"} / ${prev.effort ?? "its effort"}`))
            .catch(err => console.error(`co-codex: could not switch ${label} back${was}: ${err.message}`));
        } else {
          console.error(`co-codex: ${label} stays on ${on}${prev ? " because the message has not started yet" : ""}${was}`);
        }
      }
    }
  },

  async spawn(rpc, ctx, { pos, opt }) {
    const name = opt.name;
    if (!name) throw new BridgeError("spawn needs --name, so you can find the session later");
    const sandbox = opt.sandbox ?? ctx.config.spawn?.sandbox ?? "workspace-write";
    if (!SANDBOXES.includes(sandbox)) throw new BridgeError(`--sandbox must be one of ${SANDBOXES.join(", ")}`);
    if (opt.network && sandbox === "read-only") throw new BridgeError("--network does not work with the read-only sandbox; use workspace-write (the default) with --network");
    if (opt.network && sandbox === "danger-full-access") console.error("co-codex: --network is not needed with danger-full-access, which already has network access");
    const names = namesOption(opt, "spawn");
    const run = { ...await chooseRun(rpc, ctx.config, opt), names };
    const raw = await readText(pos[0]);
    const text = compose(ctx.config, raw, run, opt);
    const input = inputs(text, opt.ref);
    const timeoutS = timeoutOf(opt);
    if ((await sessionsNamed(rpc, name)).length) throw new BridgeError(`a session named "${name}" already exists; send to it or pick another name`);
    const started = await rpc.request("thread/start", {
      cwd: path.resolve(opt.cwd ?? ctx.root),
      sandbox,
      approvalPolicy: ctx.config.spawn?.approvalPolicy ?? "never",
      threadSource: SOURCE,
      ...(opt.network && sandbox === "workspace-write" ? networkConfig() : {}),
      ...(run.model ? { model: run.model } : {}),
      ...(opt.fast ? { serviceTier: "fast" } : {}),
    });
    const { thread } = started;
    Object.assign(run, { threadId: thread.id, name, model: started.model ?? run.model }, sandboxOf(started.sandbox, sandbox));
    if (opt.network && run.network === false) console.error("co-codex: warning: Codex started the session without network access although --network asked for it; check `doctor` and Codex's own sandbox settings");
    if (!opt.images) warnOffline(raw, run); // image sessions are read-only by design
    await rpc.request("thread/name/set", { threadId: thread.id, name });
    run.before = opt.wait ? await readWindows(rpc) : null;
    const { turn } = await rpc.request("turn/start", { threadId: thread.id, input, ...(run.effort ? { effort: run.effort } : {}) });
    console.error(`spawned "${name}" ${thread.id} (${run.model ?? "default model"}${run.effort ? " / " + run.effort : ""}, ${accessLabel(run)}); watch it with \`codex resume ${shellArg(name)}\``);
    if (!opt.wait) {
      if (opt.json) console.log(JSON.stringify({ threadId: thread.id, name, turnId: turn.id, tier: run.tier, model: run.model, effort: run.effort, sandbox: run.sandbox, network: run.network }, null, 2));
      else console.log(thread.id);
      if (names) console.error(`collect the named images with: wait ${shellArg(name)}${namesHint(opt)}`);
      return;
    }
    const done = await waitForTurn(rpc, thread.id, { turnId: turn.id, timeoutS, subscribed: true });
    await report(rpc, run, done, opt);
  },

  // Waits for: the turn of --message <id>; else the last queued message; else the latest turn.
  async wait(rpc, ctx, { pos, opt }) {
    const names = namesOption(opt, "wait");
    const thread = await resolveThread(rpc, ctx, pos[0]);
    const timeoutS = timeoutOf(opt);
    // A session no window holds has nothing running: read its history without loading it onto the daemon.
    const idle = thread.status?.type === "notLoaded";
    const resumed = idle ? null : await subscribe(rpc, thread, ctx);
    const run = { threadId: thread.id, name: thread.name, model: resumed?.model ?? thread.model, names, own: thread.threadSource === SOURCE, ...(resumed ? sandboxOf(resumed.sandbox) : {}) };
    const turns = await recentTurns(rpc, thread.id, RECENT, "summary");
    const queue = idle ? [] : await queuedMessages(rpc, thread.id);
    const target = opt.message ?? queue[queue.length - 1]?.clientUserMessageId ?? null;
    let turnId = turns[0]?.id ?? null, match = {};
    if (target) {
      const carries = t => (t.items ?? []).some(i => i.type === "userMessage" && i.clientId === target);
      const hit = turns.find(carries);
      if (hit) turnId = hit.id;
      else if (queue.some(q => q.clientUserMessageId === target)) {
        turnId = null;
        match = { byItem: i => i?.type === "userMessage" && i.clientId === target, byTurn: carries };
        if (!opt.message) console.error(`waiting for the last queued message (${queue.length} in the queue)`);
      } else throw new BridgeError(`message ${target} is neither queued nor among the last ${RECENT} turns`);
    }
    if (!turnId && !match.byTurn) throw new BridgeError("this session has no turns yet");
    const known = turnId && turns.find(t => t.id === turnId);
    const turn = known && known.status !== "inProgress"
      ? (await turnById(rpc, thread.id, turnId)) ?? known
      : await waitForTurn(rpc, thread.id, { turnId, match, timeoutS, subscribed: !!resumed });
    await report(rpc, run, turn, opt);
  },

  async read(rpc, ctx, { pos, opt }) {
    const thread = await resolveThread(rpc, ctx, pos[0]);
    const turns = (await recentTurns(rpc, thread.id, posInt(opt.turns, 1, "turns", 50))).reverse();
    if (!turns.length) return console.log("(no turns yet)");
    for (const t of turns) {
      const asked = (t.items ?? []).filter(i => i.type === "userMessage").map(userText).join("\n");
      const failed = t.error?.message ? `\n(${t.error.message})` : "";
      console.log(`--- turn ${t.id} [${t.status}]\n> ${oneLine(asked, 200)}\n${finalAnswer(t.items ?? []) || "(no answer yet)"}${failed}`);
    }
  },

  async stop(rpc, ctx, { pos }) {
    const thread = await resolveThread(rpc, ctx, pos[0]);
    const [last] = await recentTurns(rpc, thread.id, 1);
    if (last?.status !== "inProgress") return console.log("nothing running");
    await rpc.request("turn/interrupt", { threadId: thread.id, turnId: last.id });
    console.log(`interrupted turn ${last.id}`);
  },

  async images(rpc, ctx, { pos, opt }) {
    const thread = await resolveThread(rpc, ctx, pos[0]);
    let turns = await recentTurns(rpc, thread.id, opt.turn ? 50 : posInt(opt.turns, 1, "turns", 50));
    if (opt.turn) {
      turns = turns.filter(t => t.id === opt.turn);
      if (!turns.length) throw new BridgeError(`turn ${opt.turn} is not among the last 50 turns of this session`);
    }
    const all = [];
    for (const t of turns) all.push(...await collectImages(rpc, thread.id, t));
    const kept = usableImages(all);
    const failed = all.filter(i => i.failure);
    const copied = opt.out ? copyImages(all, path.resolve(opt.out)) : [];
    if (opt.json) {
      console.log(JSON.stringify({
        threadId: thread.id,
        images: kept.map(i => ({ path: i.savedPath, threadId: i.threadId, turnId: i.turnId, itemId: i.itemId, transparent: i.transparent, width: i.width, height: i.height, prompt: i.prompt })),
        failed: failed.map(i => ({ itemId: i.itemId, failure: i.failure })),
        copied: copied.map(c => c.file),
      }, null, 2));
      return;
    }
    for (const i of kept) console.log(i.savedPath ?? `(inline image ${i.itemId}; use --out to save it)`);
    console.error(`${kept.length} image(s) in ${turns.length} turn(s)${failed.length ? `, ${failed.length} failed` : ""}${copied.length ? `; ${copied.filter(c => c.fresh).length} new file(s) in ${opt.out}` : ""}`);
  },

  // An independent, read-only review by Codex in addition to Claude's own: of a plan, decision,
  // design or text (a structured verdict), or of code changes through Codex's built-in reviewer.
  async opinion(rpc, ctx, { pos, opt }) {
    const diff = !!(opt.diff || opt.base || opt.commit);
    if (diff && pos[0]) throw new BridgeError("opinion --diff/--base/--commit reviews code changes and takes no text; for a focused review, pass the text without them");
    const mode = opt.mode ?? "independent";
    if (!OPINION_MODES.includes(mode)) throw new BridgeError(`--mode must be one of ${OPINION_MODES.join(", ")}`);
    const run = await chooseRun(rpc, ctx.config, { ...opt, tier: opt.tier ?? ctx.config.opinionTier ?? "high" });
    const material = diff ? null : opinionPrompt(ctx.config, await readText(pos[0]), { on: opt.on ?? "plan", mode, files: opt.file ?? [] });
    const timeoutS = timeoutOf(opt);
    const name = opt.name ?? `opinion-${new Date().toISOString().replace(/\D/g, "").slice(2, 14)}`;
    if ((await sessionsNamed(rpc, name)).length) throw new BridgeError(`a session named "${name}" already exists; pick another --name`);
    const started = await rpc.request("thread/start", {
      cwd: path.resolve(opt.cwd ?? ctx.root),
      sandbox: "read-only", // an opinion never changes the project, whatever the config says for spawn
      approvalPolicy: "never",
      threadSource: SOURCE,
      ...(run.model ? { model: run.model } : {}),
    });
    const { thread } = started;
    Object.assign(run, { threadId: thread.id, name, model: started.model ?? run.model });
    await rpc.request("thread/name/set", { threadId: thread.id, name });
    let turn, target = null;
    if (diff) {
      target = opt.commit ? { type: "commit", sha: opt.commit } : opt.base ? { type: "baseBranch", branch: opt.base } : { type: "uncommittedChanges" };
      if (run.effort) await rpc.request("thread/settings/update", { threadId: thread.id, effort: run.effort });
      ({ turn } = await rpc.request("review/start", { threadId: thread.id, target, delivery: "inline" }));
    } else {
      ({ turn } = await rpc.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: material }], outputSchema: OPINION_SCHEMA, ...(run.effort ? { effort: run.effort } : {}) }));
    }
    const what = !diff ? `${mode} opinion` : target.type === "commit" ? `code review of ${target.sha}` : target.type === "baseBranch" ? `code review against ${target.branch}` : "code review of uncommitted changes";
    console.error(`asked Codex for a second opinion: "${name}" ${thread.id} (${run.model ?? "default model"}${run.effort ? " / " + run.effort : ""}, read-only, ${what})`);
    const done = await waitForTurn(rpc, thread.id, { turnId: turn.id, timeoutS, subscribed: true });
    const limit = await usageLimit(rpc, done, []);
    const answer = finalAnswer(done.items ?? []);
    const review = diff ? ((done.items ?? []).filter(i => i.type === "exitedReviewMode" && i.review?.trim()).pop()?.review ?? answer) : null;
    let parsed = null;
    if (!diff && answer) { try { parsed = JSON.parse(answer); } catch { /* the model ignored the schema: its text is shown as is */ } }
    const text = diff ? review : parsed ? null : answer;
    if (opt.json) {
      console.log(JSON.stringify({
        threadId: thread.id, name, kind: diff ? "code-review" : "opinion", mode: diff ? null : mode, target,
        model: run.model ?? null, effort: run.effort ?? null, status: done.status,
        opinion: parsed, text: text || null, error: done.error?.message ?? null, limit,
      }, null, 2));
    } else if (parsed || text) {
      console.log(parsed ? renderOpinion(parsed) : text);
    }
    failIfBad(done, limit);
  },

  // Throwaway sessions pile up: one per image batch or question. Only sessions co-codex started,
  // in this project, that no window has open and that nobody used since the cutoff.
  async cleanup(rpc, ctx, { opt }) {
    const olderThan = opt["older-than"] ?? "2d";
    const cutoff = Math.floor(Date.now() / 1000) - ageSeconds(olderThan);
    const prefix = opt["name-prefix"] ?? null;
    const open = new Set((await rpc.request("thread/loaded/list", {})).data ?? []);
    const listed = new Map();
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const res = await rpc.request("thread/list", { limit: 100, sourceKinds: ALL_SOURCES, ...(cursor ? { cursor } : {}) });
      for (const t of res.data ?? []) listed.set(t.id, t);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    // Outside a git repository the root is just the working directory, and a prefix match from a
    // parent folder would reach every project below it: there only that exact folder counts.
    const here = ctx.git ? t => inside(t.cwd, ctx.root) : t => samePath(t.cwd, ctx.root);
    const maybe = [...listed.values()].filter(t => !open.has(t.id) && !isSubagent(t) && here(t) &&
      (t.updatedAt ?? t.createdAt ?? Infinity) < cutoff && (!prefix || (t.name ?? "").startsWith(prefix)));
    const stale = [], skipped = [];
    for (const t of maybe) { // thread/list leaves threadSource out; thread/read has it
      const full = await readThread(rpc, t.id).catch(() => null);
      if (full?.threadSource !== SOURCE || isSubagent(full) || full.status?.type !== "notLoaded") continue;
      // A person can take over a spawned session with `codex resume`; their last message carries no signature.
      const [last] = await recentTurns(rpc, t.id, 1, "summary").catch(() => []);
      const asked = (last?.items ?? []).filter(i => i.type === "userMessage").map(userText).join("\n");
      if (asked && !asked.trimStart().startsWith(ctx.config.signature ?? "")) {
        skipped.push({ threadId: t.id, name: full.name ?? null, reason: "used in a Codex window" });
        continue;
      }
      stale.push({ ...full, updatedAt: t.updatedAt ?? full.updatedAt });
    }
    const results = stale.map(t => ({ threadId: t.id, name: t.name ?? null, updatedAt: t.updatedAt ?? null, deleted: false, error: null }));
    if (opt.yes) {
      for (const r of results) {
        try { await rpc.request("thread/delete", { threadId: r.threadId }); r.deleted = true; }
        catch (err) { r.error = err.message; }
      }
    }
    const confirm = `cleanup --older-than ${olderThan}${prefix ? ` --name-prefix ${shellArg(prefix)}` : ""} --yes`;
    if (opt.json) {
      console.log(JSON.stringify({ olderThan, cutoff: new Date(cutoff * 1000).toISOString(), namePrefix: prefix, dryRun: !opt.yes, sessions: results, skipped }, null, 2));
      if (results.some(r => r.error)) throw new BridgeError("some sessions could not be deleted (see the JSON)");
      return;
    }
    for (const s of skipped) console.log(`skipped ${s.threadId}  ${s.name ?? "(no name)"}: ${s.reason}`);
    if (!results.length) {
      console.log(`Nothing to clean up: no session co-codex started in this project${prefix ? ` with a name starting "${prefix}"` : ""} is closed and unused since ${localTime(cutoff)}.`);
    } else if (!opt.yes) {
      console.log(`Sessions co-codex started in this project, open nowhere, last used before ${localTime(cutoff)}${prefix ? `, named ${prefix}*` : ""}:`);
      for (const t of stale) console.log(`  ${t.id}  ${(t.name ?? "(no name)").padEnd(22)} ${localTime(t.updatedAt)}  ${oneLine(t.preview, 50)}`);
      console.log(`${results.length} session(s). Nothing was deleted. Delete them with: ${confirm}`);
    } else {
      for (const r of results) console.log(r.deleted ? `deleted ${r.threadId}  ${r.name ?? "(no name)"}` : `could not delete ${r.threadId}  ${r.name ?? "(no name)"}: ${r.error}`);
    }
    if (results.some(r => r.error)) throw new BridgeError("some sessions could not be deleted (see above)");
  },

  async models(rpc, ctx) {
    const models = ((await rpc.request("model/list", {})).data ?? []).filter(m => !m.hidden);
    console.log("Models offered to this account:");
    for (const m of models) console.log(`  ${(m.id ?? m.model).padEnd(16)} ${(m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort ?? e).join(" ").padEnd(40)} ${oneLine(m.description, 60)}`);
    console.log("\nTiers (--tier):");
    for (const name of Object.keys(ctx.config.tiers ?? {})) {
      const t = resolveTier(ctx.config, name, models);
      console.log(`  ${name.padEnd(9)} ${(t.model ?? "(Codex default)").padEnd(16)} ${(t.effort ?? "").padEnd(7)} ${t.about}${t.warnings.length ? "\n            ! " + t.warnings.join("\n            ! ") : ""}`);
    }
    console.log(`\nDefault tier: ${ctx.config.defaultTier ?? "none (Codex's own default)"}`);
    console.log(`Config: ${ctx.sources.length ? ctx.sources.join(", ") : `built-in defaults (override in ${userConfigPath()} or <project>/.co-codex.json)`}`);
  },

  async limits(rpc, ctx, { opt }) {
    const r = await rpc.request("account/rateLimits/read", { excludeResetCreditDetails: true });
    if (opt.json) return console.log(JSON.stringify(r, null, 2));
    const byId = r.rateLimitsByLimitId ?? (r.rateLimits ? { [r.rateLimits.limitId ?? "codex"]: r.rateLimits } : {});
    const plan = r.rateLimits?.planType ?? Object.values(byId)[0]?.planType ?? "unknown";
    console.log(`Plan: ${plan}${r.ordinaryUsageAllowed === false ? "  (included usage is blocked right now)" : ""}`);
    for (const [id, l] of Object.entries(byId)) {
      console.log(`${l.limitName ?? id}:`);
      for (const w of [l.primary, l.secondary].filter(Boolean)) console.log(`  ${windowLabel(w.windowDurationMins).padEnd(16)} ${String(w.usedPercent).padStart(3)}% used, resets ${localTime(w.resetsAt)}`);
      if (l.credits && (l.credits.hasCredits || l.credits.unlimited)) console.log(`  credits: ${l.credits.unlimited ? "unlimited" : l.credits.balance}`);
      if (l.rateLimitReachedType) console.log(`  reached: ${l.rateLimitReachedType}`);
    }
    console.log("Image generation uses these limits several times faster than text turns.");
  },
};

async function doctor(ctx) {
  let failed = false, codexConfig = "not read";
  const ok = (label, text) => console.log(`ok    ${label.padEnd(9)} ${text}`);
  const bad = (label, text) => { failed = true; console.log(`FAIL  ${label.padEnd(9)} ${text}`); };
  const note = (label, text) => console.log(`      ${label.padEnd(9)} ${text}`);
  note("system", `${process.platform} ${process.arch}, node ${process.versions.node}`);

  const bin = findCodex();
  const version = runCodex(["--version"], { timeout: 30_000 });
  if (version.error || version.status !== 0) {
    bad("codex", `cannot run ${bin.file}: ${version.error?.message ?? version.stderr.trim()}. Install Codex or set CO_CODEX_BIN.`);
    return 1;
  }
  ok("codex", `${version.stdout.trim()} (${[bin.file, ...bin.prefix].join(" ")})`);

  let rpc;
  try {
    rpc = await connect({ clientName: SOURCE, onNotification, onServerRequest });
    const info = runCodex(["app-server", "daemon", "version"], { timeout: 30_000 });
    let server = "";
    try { server = `, app-server ${JSON.parse(info.stdout).appServerVersion}`; } catch { /* older Codex prints no JSON */ }
    ok("daemon", `connected${server}`);
  } catch (err) {
    bad("daemon", err.message);
    return 1;
  }
  try {
    const acct = await rpc.request("account/read", {}).catch(() => null);
    if (acct?.account) ok("account", `${acct.account.type}${acct.account.planType ? ", plan " + acct.account.planType : ""}`);
    else bad("account", "not signed in; run `codex login`");
    const models = ((await rpc.request("model/list", {})).data ?? []).filter(m => !m.hidden);
    for (const name of Object.keys(ctx.config.tiers ?? {})) {
      const t = resolveTier(ctx.config, name, models);
      (t.model ? ok : note)("tier", `${name} -> ${t.model ?? "Codex default"}${t.effort ? " / " + t.effort : ""}${t.warnings.length ? " (" + t.warnings.join("; ") + ")" : ""}`);
    }
    // Codex's own settings for this project, shown next to what co-codex asks for when it spawns.
    try {
      const c = (await rpc.request("config/read", { cwd: ctx.root })).config ?? {};
      const shown = v => (v == null ? "not set" : typeof v === "object" ? JSON.stringify(v) : String(v));
      codexConfig = `sandbox_mode ${shown(c.sandbox_mode)}, sandbox_workspace_write.network_access ${shown(c.sandbox_workspace_write?.network_access)}, ` +
        `approval_policy ${shown(c.approval_policy)} (Codex's own config for this project)`;
    } catch (err) {
      codexConfig = `not read: ${err.message}`;
    }
  } finally { rpc.close(); }

  const dir = mkdtempSync(path.join(os.tmpdir(), "co-codex-schema-"));
  try {
    const gen = runCodex(["app-server", "generate-json-schema", "--experimental", "--out", dir], { timeout: 60_000 });
    if (gen.status !== 0) throw new Error((gen.stderr || gen.stdout).trim().split("\n").pop() || "schema export failed");
    const names = file => {
      const schema = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
      return new Set((schema.oneOf ?? schema.anyOf ?? []).map(v => v.properties?.method?.enum?.[0]).filter(Boolean));
    };
    const methods = names("ClientRequest.json"), events = names("ServerNotification.json");
    const missing = [...USED_METHODS.filter(m => !methods.has(m)), ...USED_NOTIFICATIONS.filter(m => !events.has(m))];
    if (missing.length) bad("protocol", `this Codex lacks ${missing.join(", ")}; co-codex needs an update`);
    else ok("protocol", `all ${USED_METHODS.length} methods and ${USED_NOTIFICATIONS.length} events co-codex uses are present`);
  } catch (err) {
    note("protocol", `not checked: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  note("config", ctx.sources.length ? ctx.sources.join(", ") : "built-in defaults");
  note("codex cfg", codexConfig);
  const mode = ctx.config.spawn?.sandbox;
  const net = mode === "danger-full-access" ? "network on" : mode === "read-only" ? "no network" : "network off unless --network";
  note("spawn", `co-codex starts sessions with sandbox ${mode}, ${net}, approvals ${ctx.config.spawn?.approvalPolicy}`);
  return failed ? 1 : 0;
}

// limits --estimate: offline, from the log of past --images runs (lib/usage.mjs).
function estimateLimits(ctx, { opt }) {
  const n = posInt(opt.estimate, undefined, "estimate", 100_000);
  const tier = opt.tier ?? null;
  if (tier && !ctx.config.tiers?.[tier]) throw new BridgeError(`unknown tier "${tier}"; known: ${Object.keys(ctx.config.tiers ?? {}).join(", ")}`);
  const e = estimate(n, { tier });
  if (opt.json) { console.log(JSON.stringify(e, null, 2)); return 0; }
  const on = tier ? ` on the ${tier} tier` : "";
  if (!e.runs) {
    console.log(`No past image runs${on} to estimate from yet. co-codex logs each completed --images --wait run in ${e.log}.`);
    return 0;
  }
  if (!e.fiveHour.used && !e.weekly.used) {
    console.log(`${n} image(s)${on}: no measurable use yet in ${e.runs} past run(s). Codex reports whole percents, so small batches read as 0.`);
    return 0;
  }
  const share = ({ percent, used }, w) => {
    if (percent == null) return `an unknown share of the ${w}`;
    const whole = Math.round(percent);
    return whole === 0 ? (used ? `less than 1% of the ${w}` : `no measurable share of the ${w}`) : `about ${whole}% of the ${w}`;
  };
  console.log(`${n} image(s)${on}: ${share(e.fiveHour, "5-hour window")} and ${share(e.weekly, "weekly window")}, ` +
    `from ${e.runs} past run(s); other Codex use in the same window inflates it.`);
  return 0;
}

const MARKER = "<!-- co-codex -->";
function init(ctx, { opt }) {
  const snippet = readFileSync(path.join(SKILL_DIR, "templates", "AGENTS.md"), "utf8");
  if (!opt.write) { console.log(snippet); return 0; }
  const target = path.join(ctx.root, "AGENTS.md");
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current.includes(MARKER)) { console.log(`${target} already has the co-codex note`); return 0; }
  const eol = current.includes("\r\n") ? "\r\n" : "\n"; // keep the file's own line endings
  const gap = !current || current.endsWith(eol + eol) ? "" : current.endsWith(eol) ? eol : eol + eol;
  appendFileSync(target, gap + snippet.replace(/\r?\n/g, eol));
  console.log(`${current ? "appended the co-codex note to" : "created"} ${target}`);
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const known = cmd === "doctor" || cmd === "init" || Object.hasOwn(commands, cmd ?? "");
  if (!cmd || cmd === "help" || cmd === "--help" || !known) {
    console.log(USAGE);
    return cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
  const args = parseArgs(rest);
  if (args.pos.length > ARITY[cmd]) throw new BridgeError(`${cmd} takes ${ARITY[cmd] || "no"} argument${ARITY[cmd] === 1 ? "" : "s"}, got: ${args.pos.map(shellArg).join(" ")}`);
  const { root, git } = projectRoot();
  const { config, sources } = loadConfig(root);
  const ctx = { root, git, config, sources };
  if (cmd === "init") return init(ctx, args);
  if (cmd === "doctor") return doctor(ctx);
  if (cmd === "limits" && args.opt.estimate !== undefined) return estimateLimits(ctx, args);
  const rpc = await connect({ clientName: SOURCE, onNotification, onServerRequest });
  try { await commands[cmd](rpc, ctx, args); } finally { rpc.close(); }
  return 0;
}

// exitCode instead of process.exit(), so piped stdout is flushed first (pipes are asynchronous on
// macOS); the unref'd timer only fires if something unexpected keeps the process alive.
const exit = code => { process.exitCode = code; setTimeout(() => process.exit(code), 3000).unref(); };
main().then(exit, err => {
  console.error(`co-codex: ${err.message}`);
  exit(err.exitCode ?? 1);
});
