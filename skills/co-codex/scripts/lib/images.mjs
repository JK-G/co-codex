// Finds the images a Codex turn generated, including those made by its subagents, and copies
// them out. Each imageGeneration item names its own file (savedPath, usually
// ~/.codex/generated_images/<thread>/<item>.png), so nothing guesses by "newest file".
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { walkTurn } from "./turns.mjs";

// The images among walked turn items (lib/turns.mjs), failed generations included.
export function imagesOf(entries) {
  return entries.filter(e => e.item.type === "imageGeneration").map(({ threadId, turnId, item }) => {
    const data = item.savedPath ? undefined : item.result; // base64 PNG when no file was saved
    const size = item.savedPath ? pngSize(item.savedPath) : data ? pngSize(Buffer.from(data.slice(0, 64), "base64")) : null;
    return {
      threadId,
      turnId,
      itemId: item.id,
      status: item.status,
      savedPath: item.savedPath ?? null,
      transparent: item.transparentBackground ?? null,
      prompt: item.revisedPrompt ?? null,
      failure: item.failure ?? null,
      width: size?.width ?? null,
      height: size?.height ?? null,
      data,
    };
  });
}

export async function collectImages(rpc, threadId, turn) {
  return imagesOf(await walkTurn(rpc, threadId, turn));
}

export const usableImages = images => images.filter(i => !i.failure && (i.savedPath || i.data));

// Width and height from a PNG's IHDR chunk (bytes 16-23), or null for anything else. gpt-image-2
// picks its own output size, so the real one is reported instead of the size the brief asked for.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function pngSize(source) {
  let head = source;
  if (!Buffer.isBuffer(source)) {
    head = Buffer.alloc(24);
    let fd;
    try { fd = openSync(source, "r"); if (readSync(fd, head, 0, 24, 0) < 24) return null; }
    catch { return null; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  if (head.length < 24 || !head.subarray(0, 8).equals(PNG_SIG) || head.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

// --names: validated file names, ".png" added when a name has no extension.
export function parseNames(list) {
  const names = String(list ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!names.length) throw new Error("--names needs at least one file name, such as hero.png,icon.png");
  const seen = new Set();
  return names.map(raw => {
    if (/[\\/]/.test(raw) || raw.includes("..") || /^\.+$/.test(raw) || /[<>:"|?*\x00-\x1f]/.test(raw))
      throw new Error(`--names: "${raw}" is not a plain file name (no folders, "..", or <>:"|?*)`);
    const ext = path.extname(raw).toLowerCase();
    if (ext && ext !== ".png") throw new Error(`--names: "${raw}": Codex saves PNG files, so a name ends in .png or has no extension`);
    const name = ext ? raw : `${raw}.png`;
    const key = name.toLowerCase(); // one name per file on case-insensitive file systems too
    if (seen.has(key)) throw new Error(`--names: "${name}" is listed twice`);
    seen.add(key);
    return name;
  });
}

// The instruction --names adds to the message. Codex cannot name files in a read-only session,
// so it reports which generation it kept for each name and co-codex names the copies.
export function namesNote(names) {
  return "Generate the images in this order, one per file name:\n" +
    names.map((n, i) => `${i + 1}. ${n}`).join("\n") + "\n" +
    "You do not save or name the files yourself. End your final answer with exactly one line of this form:\n" +
    `KEEP: ${names.map((n, i) => `${n}=${i + 1}`).join(", ")}\n` +
    "where each number is the position of the image you keep for that name among ALL image generations you made " +
    "in this turn, counted from 1 in the order you made them, failed and retried ones included.";
}

// The last `KEEP:` line of the answer as { name: position }, or null when there is none or it
// does not give every requested name exactly one position. Models decorate the line, so a list
// or quote marker in front, ";" between pairs, and punctuation or a remark after them are fine.
export function parseKeepLine(answer, names) {
  const lines = String(answer ?? "").split(/\r?\n/)
    .map(l => l.replace(/[`*]/g, "").replace(/^[\s>\-•]+/, "").trim())
    .filter(l => /^KEEP\s*:/i.test(l));
  if (!lines.length) return null;
  const wanted = new Map(names.map(n => [n.toLowerCase(), n]));
  const keep = {};
  for (const part of lines[lines.length - 1].replace(/^KEEP\s*:/i, "").split(/[,;]/)) {
    if (!part.includes("=")) continue; // a remark such as "(all checked)"
    const m = /^\s*(.+?)\s*=\s*#?(\d+)(?!\d)/.exec(part);
    if (!m) return null;
    let key = m[1].toLowerCase();
    if (!path.extname(key)) key += ".png";
    const name = wanted.get(key);
    if (!name || keep[name] !== undefined) return null;
    keep[name] = Number(m[2]);
  }
  return names.every(n => keep[n] !== undefined) ? keep : null;
}

// Decides where each image of the turn goes for --names. `own` is the turn's own-thread
// imageGeneration items in item order (Codex counts them the same way, failures included).
// Returns { matchedBy: "keep-line" | "order" | null, kept: [{ name, image }], rejected: [image], warning }.
export function planNames(own, names, answer) {
  const usable = usableImages(own);
  const keep = parseKeepLine(answer, names);
  if (keep) {
    const picks = names.map(name => ({ name, image: own[keep[name] - 1] }));
    const distinct = new Set(names.map(n => keep[n])).size === names.length;
    if (distinct && picks.every(p => p.image && usableImages([p.image]).length)) {
      const keptIds = new Set(picks.map(p => p.image.itemId));
      return { matchedBy: "keep-line", kept: picks, rejected: usable.filter(i => !keptIds.has(i.itemId)), warning: null };
    }
  }
  const why = keep ? "the KEEP line points at images that do not exist or failed" : "the answer has no valid KEEP line";
  if (usable.length === names.length) {
    return {
      matchedBy: "order", kept: names.map((name, i) => ({ name, image: usable[i] })), rejected: [],
      warning: `${why}; mapped the ${names.length} image(s) to the names by order, check them`,
    };
  }
  return {
    matchedBy: null, kept: [], rejected: [],
    warning: `${why}, and the turn has ${usable.length} usable image(s) for ${names.length} name(s); could not match names, copied them under their item ids`,
  };
}

const sameImage = (file, img) => {
  try { return readFileSync(file).equals(img.savedPath ? readFileSync(img.savedPath) : Buffer.from(img.data, "base64")); }
  catch { return false; }
};

// A name in dir that is free or already holds this very image: name.png, name-2.png, ...
function freeName(dir, name, img) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const file = path.join(dir, n === 1 ? name : `${base}-${n}${ext}`);
    if (!existsSync(file)) return { file, same: false };
    if (sameImage(file, img)) return { file, same: true };
  }
}

// Copies images into outDir and appends one line per new file to outDir/co-codex-images.jsonl
// (source, prompt, size, requested name), so a batch keeps its record. Without a plan every
// usable image is copied as <item id>.png. With a plan (planNames) the kept images get their
// names, never overwriting a different file, and the others go to outDir/_rejected/<item id>.png.
export function copyImages(images, outDir, plan = null) {
  mkdirSync(outDir, { recursive: true });
  const byId = img => `${img.itemId}${img.savedPath ? path.extname(img.savedPath) || ".png" : ".png"}`;
  const jobs = plan?.matchedBy
    ? [...plan.kept.map(k => ({ img: k.image, dir: outDir, name: k.name, requested: k.name, rejected: false })),
       ...plan.rejected.map(img => ({ img, dir: path.join(outDir, "_rejected"), name: byId(img), requested: null, rejected: true }))]
    : usableImages(images).map(img => ({ img, dir: outDir, name: byId(img), requested: null, rejected: false }));
  const copied = [];
  for (const { img, dir, name, requested, rejected } of jobs) {
    if (img.savedPath && !existsSync(img.savedPath)) continue;
    mkdirSync(dir, { recursive: true });
    let file = path.join(dir, name), fresh = true;
    if (requested) {
      const free = freeName(dir, name, img);
      file = free.file;
      fresh = !free.same;
    } else if (existsSync(file) && (!img.savedPath || statSync(file).size === statSync(img.savedPath).size)) {
      fresh = false; // item ids are unique, so a file of that name is the same image
    }
    copied.push({ ...img, file, data: undefined, fresh, name: requested, renamed: !!requested && path.basename(file) !== requested, rejected });
    if (!fresh) continue;
    if (img.savedPath) copyFileSync(img.savedPath, file);
    else writeFileSync(file, Buffer.from(img.data, "base64"));
    appendFileSync(path.join(outDir, "co-codex-images.jsonl"), JSON.stringify({
      file: path.relative(outDir, file).split(path.sep).join("/"),
      name: requested,
      ...(rejected ? { rejected: true } : {}),
      source: img.savedPath,
      threadId: img.threadId,
      turnId: img.turnId,
      width: img.width,
      height: img.height,
      transparent: img.transparent,
      prompt: img.prompt,
      copiedAt: new Date().toISOString(),
    }) + "\n");
  }
  return copied;
}

export function limitFailure(images) {
  const hit = images.find(i => i.failure?.type === "usageLimitExceeded");
  return hit ? { resetsAt: hit.failure.resetsAt ?? null, limitId: hit.failure.limitId ?? null } : null;
}
