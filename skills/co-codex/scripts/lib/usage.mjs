// Quota use per image batch: the 5-hour and weekly windows read before and after a run, a log
// of completed --images runs in the user config folder, and an estimate for the next batch from it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// usedPercent of the 5-hour and weekly windows from an account/rateLimits/read reply, null when unknown.
export function windowsOf(reply) {
  const limits = reply?.rateLimits ?? reply?.rateLimitsByLimitId?.codex ?? null;
  const pick = mins => [limits?.primary, limits?.secondary].find(w => w?.windowDurationMins === mins)?.usedPercent ?? null;
  return { fiveHour: pick(300), weekly: pick(10080) };
}

export async function readWindows(rpc) {
  try { return windowsOf(await rpc.request("account/rateLimits/read", { excludeResetCreditDetails: true })); }
  catch { return { fiveHour: null, weekly: null }; }
}

export const usageReport = (before, after) => ({
  fiveHour: { before: before?.fiveHour ?? null, after: after?.fiveHour ?? null },
  weekly: { before: before?.weekly ?? null, after: after?.weekly ?? null },
});

// A window that reset during the run reads lower afterwards; that delta says nothing, so null.
const delta = w => (w.before == null || w.after == null || w.after < w.before ? null : Math.round((w.after - w.before) * 100) / 100);

// Always the user-level folder (XDG_CONFIG_HOME or ~/.config), never CO_CODEX_CONFIG's folder,
// which can sit inside a project and would mix quota records into it.
export const usageLogPath = (env = process.env) =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "co-codex", "usage.jsonl");

export function logRun(usage, { tier, model, effort, images }, env = process.env) {
  const file = usageLogPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({
    date: new Date().toISOString(), tier: tier ?? null, model: model ?? null, effort: effort ?? null, images,
    fiveHourDelta: delta(usage.fiveHour), weeklyDelta: delta(usage.weekly),
  }) + "\n");
  return file;
}

// Share of each window for n images: summed deltas over summed images of the logged runs (one
// tier, or all). Codex reports whole percents, so most single runs read 0 and a per-run median
// would collapse to 0; pooling keeps the few runs that moved the window. Per window:
// { percent, used } with percent null when no run measured it and used false when every delta was 0.
export function estimate(n, { tier = null, env = process.env } = {}) {
  const file = usageLogPath(env);
  const runs = existsSync(file)
    ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];
  const fit = runs.filter(r => r.images > 0 && (!tier || r.tier === tier) && (r.fiveHourDelta != null || r.weeklyDelta != null));
  const pooled = key => {
    const known = fit.filter(r => r[key] != null);
    const images = known.reduce((s, r) => s + r.images, 0), used = known.reduce((s, r) => s + r[key], 0);
    return images ? { percent: Math.round((used / images) * n * 10) / 10, used: used > 0 } : { percent: null, used: false };
  };
  return { images: n, tier, runs: fit.length, fiveHour: pooled("fiveHourDelta"), weekly: pooled("weeklyDelta"), log: file };
}
