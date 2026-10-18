// Connection to the local Codex app-server daemon, the shared backend of every Codex
// session on this machine (terminal, desktop app, IDE). `codex app-server proxy` pipes stdio
// to the daemon's control socket, which speaks JSON-RPC inside WebSocket frames.
// The protocol is marked experimental by OpenAI: `co-codex doctor` checks the methods used here.
import { randomBytes } from "node:crypto";
import { endProcess, runCodex, startCodex } from "./codex-bin.mjs";

const OP_TEXT = 0x1, OP_CONT = 0x0, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;
export const CLIENT_VERSION = "0.3.0";
const REQUEST_TIMEOUT_MS = 120_000; // one reply; waiting for a whole turn is handled by the caller
const UPGRADE_TIMEOUT_MS = 30_000;
const daemonDown = err => /failed to connect|connection refused|no such file|os error/i.test(err.message);
const pause = ms => new Promise(res => setTimeout(res, ms));

// Connects, starting the daemon first if it is not running.
export async function connect(opts = {}) {
  try {
    return await connectDaemon(opts);
  } catch (err) {
    if (!daemonDown(err)) throw err;
    console.error("co-codex: the Codex daemon is not running; starting it (codex app-server daemon start)");
    const r = runCodex(["app-server", "daemon", "start"], { timeout: 60_000 });
    if (r.error || r.status !== 0) {
      const why = r.error?.message ?? (r.stderr || r.stdout).trim().split("\n").pop();
      throw new Error(`could not start the Codex daemon: ${why}`);
    }
    for (let attempt = 1; ; attempt++) { // the socket can take a moment to appear
      try { return await connectDaemon(opts); }
      catch (again) { if (attempt >= 5 || !daemonDown(again)) throw again; await pause(1000); }
    }
  }
}

// Resolves `closed` with the reason when the connection drops on its own (not on close()).
export async function connectDaemon({ clientName = "co-codex", onNotification = () => {}, onServerRequest = () => {} } = {}) {
  const proc = startCodex(["app-server", "proxy"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 0, chunks = [], size = 0, need = 0, upgraded = false, fragments = [], stderr = "", closed = false;
  let markClosed, onUpgrade, onUpgradeFail;
  const closedP = new Promise(res => { markClosed = res; });
  const upgradeP = new Promise((res, rej) => { onUpgrade = res; onUpgradeFail = rej; });
  upgradeP.catch(() => {});

  const fail = err => {
    if (closed) return;
    closed = true;
    onUpgradeFail(err);
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    markClosed(err);
    endProcess(proc);
  };
  proc.on("error", err => fail(new Error(
    err.code === "ENOENT"
      ? "cannot find the `codex` command. Install Codex (https://developers.openai.com/codex) or set CO_CODEX_BIN to its path"
      : `cannot start "codex app-server proxy": ${err.message}`,
  )));
  proc.on("exit", code => fail(new Error(`codex proxy exited (${code})${stderr ? ": " + stderr.trim().slice(0, 400) : ""}`)));
  proc.stdin.on("error", err => fail(new Error(`codex proxy pipe: ${err.message}`)));
  proc.stderr.on("data", d => { stderr += d; });

  const sendFrame = (opcode, data) => {
    if (closed) return;
    const mask = randomBytes(4);
    let head;
    if (data.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
    const body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    proc.stdin.write(Buffer.concat([head, mask, body]));
  };
  const sendJson = obj => sendFrame(OP_TEXT, Buffer.from(JSON.stringify(obj)));

  const safely = (fn, msg) => {
    try { fn(msg); } catch (err) { console.error(`co-codex: handler failed on ${msg.method}: ${err.message}`); }
  };
  const dispatch = text => {
    const msg = JSON.parse(text);
    if (msg.id != null && !msg.method) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { code: msg.error.code }));
      else p.resolve(msg.result);
    } else if (msg.id != null) safely(onServerRequest, msg); // never answered here: approvals belong to the person at the Codex window
    else safely(onNotification, msg);
  };

  // Chunks are joined only once the frame they belong to is complete, so large replies stay linear.
  proc.stdout.on("data", chunk => {
    chunks.push(chunk);
    size += chunk.length;
    if (size < need) return;
    let buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
    chunks = []; size = 0; need = 0;
    try {
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) { chunks = [buf]; size = buf.length; return; }
        const head = buf.subarray(0, end).toString("latin1");
        if (!head.startsWith("HTTP/1.1 101")) return fail(new Error("daemon refused the WebSocket upgrade: " + head.split("\r\n")[0]));
        upgraded = true;
        buf = buf.subarray(end + 4);
        onUpgrade();
      }
      for (;;) {
        if (buf.length < 2) { need = 2; break; }
        const op = buf[0] & 0x0f, fin = buf[0] & 0x80, masked = buf[1] & 0x80;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) { need = 4; break; } len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) { need = 10; break; } len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const keyAt = off;
        if (masked) off += 4;
        if (buf.length < off + len) { need = off + len; break; }
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[keyAt + (i % 4)];
        buf = buf.subarray(off + len);
        if (op === OP_PING) sendFrame(OP_PONG, payload);
        else if (op === OP_CLOSE) return fail(new Error("the daemon closed the connection"));
        else if (op === OP_TEXT || op === OP_CONT) {
          fragments.push(payload);
          if (fin) { const text = Buffer.concat(fragments).toString("utf8"); fragments = []; dispatch(text); }
        }
      }
      if (buf.length) { chunks = [buf]; size = buf.length; }
    } catch (err) {
      fail(new Error(`unreadable message from the daemon: ${err.message}`));
    }
  });

  proc.stdin.write(
    "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );

  const upgradeTimer = setTimeout(() => fail(new Error(`the Codex daemon did not answer within ${UPGRADE_TIMEOUT_MS / 1000}s`)), UPGRADE_TIMEOUT_MS);
  upgradeP.then(() => clearTimeout(upgradeTimer), () => clearTimeout(upgradeTimer));

  const request = async (method, params = {}) => {
    await upgradeP;
    if (closed) throw new Error(`${method}: connection closed`);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no reply from the Codex daemon within ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      const settle = fn => v => { clearTimeout(timer); fn(v); };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      sendJson({ jsonrpc: "2.0", id, method, params });
    });
  };

  await request("initialize", { clientInfo: { name: clientName, version: CLIENT_VERSION }, capabilities: { experimentalApi: true } });
  sendJson({ jsonrpc: "2.0", method: "initialized" });

  const close = () => {
    if (closed) return;
    closed = true;
    for (const { reject } of pending.values()) reject(new Error("connection closed"));
    pending.clear();
    proc.stdin.end();
    setTimeout(() => endProcess(proc), 500).unref();
  };
  return { request, close, closed: closedP };
}
