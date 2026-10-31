// Quota use per image batch: the 5-hour and weekly windows read before and after a run, a log
// of completed --images runs in the user config folder, and an estimate for the next batch from it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The 5-hour and weekly windows ({ usedPercent, resetsAt, ... }) of an account/rateLimits/read
// reply, null when a window is missing.
export function windowsDetail(reply) {
  const limits = reply?.rateLimits ?? reply?.rateLimitsByLimitId?.codex ?? null;
  const pick = mins => [limits?.primary, limits?.secondary].find(w => w?.windowDurationMins === mins) ?? null;
  return { fiveHour: pick(300), weekly: pick(10080) };
}

// usedPercent of the 5-hour and weekly windows from an account/rateLimits/read reply, null when unknown.
export function windowsOf(reply) {
  const { fiveHour, weekly } = windowsDetail(reply);
  return { fiveHour: fiveHour?.usedPercent ?? null, weekly: weekly?.usedPercent ?? null };
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
export const configDir = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "co-codex");
export const usageLogPath = (env = process.env) => path.join(configDir(env), "usage.jsonl");

// `start` is when the windows were read before the run, `date` when it ended. Runs that overlap
// in time each see the other's use, so the estimate needs both ends and both readings.
export function logRun(usage, { tier, model, effort, images, start }, env = process.env) {
  const file = usageLogPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({
    start: start ?? null, date: new Date().toISOString(), tier: tier ?? null, model: model ?? null, effort: effort ?? null, images,
    fiveHourDelta: delta(usage.fiveHour), weeklyDelta: delta(usage.weekly), fiveHour: usage.fiveHour, weekly: usage.weekly,
  }) + "\n");
  return file;
}

// Runs whose times overlap are merged into one measurement: the window from the first run's
// reading before to the last run's reading after, shared by all their images. Each run's own
// delta would count the others' use as well (22 parallel runs once logged 189 points while the
// window moved 34).
function mergeOverlapping(runs) {
  const timed = runs.map(r => ({ r, s: Date.parse(r.start), e: Date.parse(r.date) })).sort((a, b) => a.s - b.s);
  const groups = [];
  for (const x of timed) {
    const g = groups[groups.length - 1];
    if (g && x.s < g.e) { g.runs.push(x); if (x.e > g.e) { g.e = x.e; g.last = x; } }
    else groups.push({ runs: [x], first: x, last: x, e: x.e });
  }
  return groups.map(g => ({
    runs: g.runs.map(x => x.r),
    images: g.runs.reduce((s, x) => s + x.r.images, 0),
    fiveHourDelta: delta({ before: g.first.r.fiveHour?.before, after: g.last.r.fiveHour?.after }),
    weeklyDelta: delta({ before: g.first.r.weekly?.before, after: g.last.r.weekly?.after }),
  }));
}

// Share of each window for n images: summed deltas over summed images (one tier, or all). Codex
// reports whole percents, so most single runs read 0 and a per-run median would collapse to 0;
// pooling keeps the few runs that moved the window. Runs logged with their start time are merged
// where they overlap; a merged group that mixes tiers counts only for the all-tier estimate.
// Runs logged before start times were recorded (`legacy`) are used only when there is nothing
// newer, since parallel runs among them counted each other's use.
// Per window: { percent, used }, percent null when no run measured it and used false when every delta was 0.
export function estimate(n, { tier = null, env = process.env } = {}) {
  const file = usageLogPath(env);
  const all = existsSync(file)
    ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];
  const withImages = all.filter(r => r.images > 0);
  const isTimed = r => !Number.isNaN(Date.parse(r.start)) && !Number.isNaN(Date.parse(r.date));
  const measured = g => g.fiveHourDelta != null || g.weeklyDelta != null;
  const groups = mergeOverlapping(withImages.filter(isTimed))
    .filter(g => measured(g) && (!tier || g.runs.every(r => r.tier === tier)));
  const legacy = !groups.length;
  const fit = legacy
    ? withImages.filter(r => !isTimed(r) && (!tier || r.tier === tier) && measured(r)).map(r => ({ runs: [r], images: r.images, fiveHourDelta: r.fiveHourDelta, weeklyDelta: r.weeklyDelta }))
    : groups;
  const pooled = key => {
    const known = fit.filter(g => g[key] != null);
    const images = known.reduce((s, g) => s + g.images, 0), used = known.reduce((s, g) => s + g[key], 0);
    return images ? { percent: Math.round((used / images) * n * 10) / 10, used: used > 0 } : { percent: null, used: false };
  };
  const runs = fit.reduce((s, g) => s + g.runs.length, 0);
  return {
    images: n, tier, runs, merged: fit.filter(g => g.runs.length > 1).reduce((s, g) => s + g.runs.length, 0),
    legacy: legacy && runs > 0, fiveHour: pooled("fiveHourDelta"), weekly: pooled("weeklyDelta"), log: file,
  };
}
