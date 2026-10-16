// Finds and starts the `codex` executable on Windows, macOS and Linux.
// Override with CO_CODEX_BIN: a path ("/opt/codex/bin/codex") or a JSON array
// (["node", "/path/to/mock-codex.mjs"]) for wrappers and tests.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };

// Where Codex usually lands when an app started from the dock or a desktop launcher (such as
// Claude Code) gets a PATH without Homebrew, npm or ~/.local/bin. Checked only after PATH.
const unixFallbacks = home => [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  path.join(home, ".local", "bin", "codex"),
  path.join(home, ".npm-global", "bin", "codex"),
  path.join(home, ".volta", "bin", "codex"),
  "/Applications/Codex.app/Contents/Resources/codex",
];

export function findCodex(env = process.env, platform = process.platform, { fallbacks = unixFallbacks(os.homedir()) } = {}) {
  const override = env.CO_CODEX_BIN?.trim();
  if (override) {
    if (override.startsWith("[")) {
      const [file, ...prefix] = JSON.parse(override);
      return { file, prefix, shell: false };
    }
    return { file: override, prefix: [], shell: platform === "win32" && /\.(cmd|bat)$/i.test(override) };
  }
  const dirs = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  if (platform !== "win32") {
    const hit = [...dirs.map(d => path.join(d, "codex")), ...fallbacks].find(isFile);
    return { file: hit ?? "codex", prefix: [], shell: false }; // spawn reports ENOENT with a clear message
  }
  // PATH order decides, as in a terminal. Node cannot start the npm .cmd shim without a shell,
  // so within one folder a real codex.exe wins over the shim.
  for (const dir of dirs) {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const file = path.join(dir, "codex" + ext);
      if (existsSync(file)) return { file, prefix: [], shell: ext !== ".exe" };
    }
  }
  return { file: "codex", prefix: [], shell: false };
}

const quote = s => (/[\s"&|<>^]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);

function invocation(args, bin = findCodex()) {
  const all = [...bin.prefix, ...args];
  if (!bin.shell) return { file: bin.file, args: all, options: {} };
  return { file: [bin.file, ...all].map(quote).join(" "), args: [], options: { shell: true } };
}

export function startCodex(args, options = {}) {
  const inv = invocation(args);
  const proc = spawn(inv.file, inv.args, { windowsHide: true, ...inv.options, ...options });
  proc.viaShell = !!inv.options.shell;
  return proc;
}

export function runCodex(args, { timeout = 60_000 } = {}) {
  const inv = invocation(args);
  const r = spawnSync(inv.file, inv.args, { encoding: "utf8", timeout, windowsHide: true, ...inv.options });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

// Ends a process this module started. Through a Windows shell the real codex is a child of
// cmd.exe, so the tree is ended by the pid we own (never by image name).
export function endProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  if (proc.viaShell && process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    proc.kill();
  }
}
