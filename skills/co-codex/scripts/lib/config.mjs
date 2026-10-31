// Settings and quality tiers. Defaults below; a user file and a project file can override any
// part of them (see templates/co-codex.config.json):
//   $CO_CODEX_CONFIG, or ~/.config/co-codex/config.json ($XDG_CONFIG_HOME respected)
//   <project>/.co-codex.json
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// Model lists are tried in order against the models this Codex account offers right now,
// so the tiers keep working when OpenAI renames or retires a model.
export const DEFAULTS = {
  signature: "[Claude Code → Codex]",
  defaultTier: null, // null: Codex's own default model and effort unless --tier is given
  maxUsedPercent: null, // spawn, send and opinion refuse to send when a quota window is above this share (--max-used)
  spawn: {
    sandbox: "workspace-write", // danger-full-access | workspace-write | read-only
    approvalPolicy: "never", // nobody watches a spawned session, so blocked commands go back to Codex instead of waiting
  },
  tiers: {
    draft: {
      about: "cheapest: sketches, thumbnails, quick checks, bulk simple edits",
      models: ["gpt-6-luna", "gpt-5.6-luna"],
      effort: "medium",
      imageNote:
        "Draft pass. Make one attempt per image at the smallest size that still shows the idea. " +
        "Do not regenerate unless an image is unusable, and do not polish.",
    },
    standard: {
      about: "everyday work: normal assets, routine code",
      models: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
      effort: "medium",
      imageNote:
        "Look at each result once with view_image against the brief. " +
        "Regenerate an image at most once, and only when it clearly misses the brief.",
    },
    high: {
      about: "final assets and careful work",
      models: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
      effort: "high",
      imageNote:
        "Final quality. Use the full size and detail the brief asks for. Check every result with view_image " +
        "against each point of the brief, regenerate failures up to 2 times, and say what still deviates.",
    },
    max: {
      about: "hardest work, hero images; slowest and most expensive",
      models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"],
      effort: "high",
      imageNote:
        "Best possible result. Make 2 variants of each image, compare them against the brief with view_image, " +
        "keep the better one, regenerate failures up to 3 times, and say what still deviates.",
    },
  },
};

export function userConfigPath(env = process.env) {
  if (env.CO_CODEX_CONFIG) return path.resolve(env.CO_CODEX_CONFIG);
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "co-codex", "config.json");
}

const isObject = v => v && typeof v === "object" && !Array.isArray(v);
export function merge(base, over) {
  if (!isObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

export function loadConfig(projectRoot, env = process.env) {
  let config = DEFAULTS;
  const sources = [];
  for (const file of [userConfigPath(env), path.join(projectRoot, ".co-codex.json")]) {
    if (!existsSync(file)) continue;
    config = merge(config, readJson(file));
    sources.push(file);
  }
  return { config, sources };
}

const effortRank = e => EFFORT_ORDER.indexOf(e);

// The strongest effort the model supports that does not exceed the wanted one.
export function clampEffort(wanted, supported) {
  if (!wanted || !supported?.length || supported.includes(wanted)) return wanted ?? null;
  const ranked = supported.filter(e => effortRank(e) >= 0).sort((a, b) => effortRank(a) - effortRank(b));
  const below = ranked.filter(e => effortRank(e) <= effortRank(wanted));
  return (below.length ? below[below.length - 1] : ranked[0]) ?? wanted;
}

// models: the `model/list` data of the daemon ([{ id, hidden, supportedReasoningEfforts }]).
export function resolveTier(config, name, models) {
  const tier = config.tiers?.[name];
  if (!tier) throw new Error(`unknown tier "${name}"; known: ${Object.keys(config.tiers ?? {}).join(", ")}`);
  const offered = new Map((models ?? []).filter(m => !m.hidden).map(m => [m.id ?? m.model, m]));
  const warnings = [];
  const id = (tier.models ?? []).find(m => offered.has(m)) ?? null;
  if (!id) warnings.push(`none of the ${name} tier models (${(tier.models ?? []).join(", ")}) is offered to this account; using Codex's default model`);
  const supported = id ? (offered.get(id).supportedReasoningEfforts ?? []).map(e => e.reasoningEffort ?? e) : [];
  const effort = id ? clampEffort(tier.effort, supported) : tier.effort ?? null;
  if (id && tier.effort && effort !== tier.effort) warnings.push(`${id} does not support effort "${tier.effort}"; using "${effort}"`);
  return { tier: name, model: id, effort, imageNote: tier.imageNote ?? "", about: tier.about ?? "", warnings };
}
