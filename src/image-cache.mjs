import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "./config.mjs";
import { createHash } from "node:crypto";
const extFor = url => { const m=String(url).match(/\.(png|jpe?g|webp)(?:[?#]|$)/i); return m?`.${m[1].toLowerCase().replace("jpeg","jpg")}`:".jpg"; };
export async function loadContestantImages(){
  const dir = resolve(config.imageCacheDir);
  await mkdir(dir, { recursive: true });
  const result = new Map();
  for (const c of config.contestants) {
    // 1. Check local assets/contestants first
    const localCandidates = [
      resolve(`assets/contestants/${c.no}.jpg`),
      resolve(`assets/contestants/${c.no}.png`),
      resolve(`assets/contestants/${c.no}.webp`),
      resolve(`assets/contestants/${String(c.no).padStart(2, "0")}.jpg`),
    ];
    let found = false;
    for (const file of localCandidates) {
      try {
        await stat(file);
        result.set(c.no, file);
        found = true;
        break;
      } catch {}
    }
    if (found) continue;

    // 2. Check cached file in imageCacheDir
    if (!c.imageUrl) continue;
    const file = join(dir, `${String(c.no).padStart(2,"0")}-${createHash("sha1").update(c.imageUrl).digest("hex").slice(0,8)}${extFor(c.imageUrl)}`);
    try {
      await stat(file);
      result.set(c.no, file);
      continue;
    } catch {}

    // 3. Fetch from remote imageUrl
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), config.imageFetchTimeoutMs);
      const res = await fetch(c.imageUrl, {
        signal: ac.signal,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 1000) throw new Error("image too small");
      await Bun.write(file, bytes);
      result.set(c.no, file);
      console.log(`[images] cached ${c.displayName}`);
    } catch (e) {
      console.warn(`[images] ${c.displayName}: ${e.message}`);
    }
  }
  return result;
}
