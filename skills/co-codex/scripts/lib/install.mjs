// Where co-codex lives: the copy Claude Code's plugin manager installed, a launcher at a path
// that does not change between versions, and the newest version published.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "./usage.mjs";

const SCRIPT = ["skills", "co-codex", "scripts", "co-codex.mjs"];
export const UPDATE_URL = "https://raw.githubusercontent.com/JK-G/co-codex/main/package.json";

// The co-codex plugins Claude Code installed (from any marketplace), most recently updated first.
export function installedPlugins(env = process.env) {
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    const plugins = JSON.parse(readFileSync(path.join(home, "plugins", "installed_plugins.json"), "utf8")).plugins ?? {};
    return Object.entries(plugins).filter(([id]) => id.startsWith("co-codex@"))
      .flatMap(([id, list]) => (Array.isArray(list) ? list : []).map(e => ({ id, ...e })))
      .filter(e => e.installPath && existsSync(path.join(e.installPath, ...SCRIPT)))
      .sort((a, b) => String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")));
  } catch { return []; }
}

// This copy's version, from the package.json two folders above the skill (the plugin cache has it too).
export function ownVersion(skillDir) {
  for (const file of [path.join(skillDir, "..", "..", "package.json"), path.join(skillDir, "..", "..", ".claude-plugin", "plugin.json")]) {
    try { const v = JSON.parse(readFileSync(file, "utf8")).version; if (v) return v; } catch { /* next */ }
  }
  return null;
}

// True when version a is newer than b (major.minor.patch).
export function newer(a, b) {
  const parts = v => String(v).split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The version on GitHub's main branch. CO_CODEX_UPDATE_URL=off skips the check.
export async function latestVersion(env = process.env) {
  const url = env.CO_CODEX_UPDATE_URL ?? UPDATE_URL;
  if (!url || url === "off") return { skipped: true };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { version: (await res.json()).version ?? null };
  } catch (err) {
    return { error: err.message };
  }
}

export const launcherPath = (env = process.env) => path.join(configDir(env), "bin", "co-codex.mjs");

// The launcher runs the copy Claude Code has installed, else the copy that wrote it. Subagents and
// saved workflow scripts call it instead of a plugin-cache path that names a version.
function launcherSource(fallback) {
  return [
    "#!/usr/bin/env node",
    "// Written by co-codex: a path to the co-codex CLI that stays the same when the plugin updates.",
    "// It runs the copy Claude Code has installed, else the copy that last wrote this file.",
    'import { existsSync, readFileSync } from "node:fs";',
    'import os from "node:os";',
    'import path from "node:path";',
    'import { pathToFileURL } from "node:url";',
    "",
    'const SCRIPT = path.join("skills", "co-codex", "scripts", "co-codex.mjs");',
    `const FALLBACK = ${JSON.stringify(fallback)};`,
    "function installed() {",
    "  try {",
    '    const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");',
    '    const plugins = JSON.parse(readFileSync(path.join(home, "plugins", "installed_plugins.json"), "utf8")).plugins ?? {};',
    '    return Object.entries(plugins).filter(([id]) => id.startsWith("co-codex@")).flatMap(([, list]) => (Array.isArray(list) ? list : []))',
    "      .filter(e => e.installPath && existsSync(path.join(e.installPath, SCRIPT)))",
    '      .sort((a, b) => String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")))',
    "      .map(e => path.join(e.installPath, SCRIPT))[0] ?? null;",
    "  } catch { return null; }",
    "}",
    "const target = installed() ?? FALLBACK;",
    'if (!existsSync(target)) { console.error("co-codex: not found at " + target + "; reinstall the plugin or run co-codex once from its new folder"); process.exit(1); }',
    "await import(pathToFileURL(target).href);",
    "",
  ].join("\n");
}

// Writes the launcher when it is missing or names another fallback. Best effort: a folder that
// cannot be written must not break the command that was asked for. Returns its path, or null.
export function ensureLauncher(self, env = process.env) {
  const file = launcherPath(env);
  const source = launcherSource(self);
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === source) return file;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`; // parallel runs never see half a file
    writeFileSync(tmp, source);
    try { renameSync(tmp, file); } catch { rmSync(tmp, { force: true }); }
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}
