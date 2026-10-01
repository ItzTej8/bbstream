import { parentPort, workerData } from "node:worker_threads";
import { Communicate } from "edge-tts-universal";
import { existsSync, rmSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const CACHE_DIR = resolve("data/audio-cache/tts");

// Determine storage mode from workerData or process.env (defaults to RAM = true)
const cacheInRam = workerData?.cacheInRam !== undefined
  ? Boolean(workerData.cacheInRam)
  : /^(1|true|yes|on)$/i.test(String(process.env.TTS_CACHE_IN_RAM ?? "true"));

const cacheTtlHours = Math.max(1, Number(workerData?.cacheTtlHours || process.env.TTS_CACHE_TTL_HOURS || 24));

// In-memory bounded cache for rapid repeats (max 50 items)
const memoryCache = new Map();
const MAX_MEMORY_ITEMS = 50;

function cleanCacheKey(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 80);
}

// Auto-delete disk cache files older than ttlHours (default 24 hours)
function pruneExpiredDiskCache(ttlHours = 24) {
  if (!existsSync(CACHE_DIR)) return;
  const now = Date.now();
  const maxAgeMs = ttlHours * 60 * 60 * 1000;
  try {
    const entries = readdirSync(CACHE_DIR, { withFileTypes: true });
    let pruned = 0;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".pcm")) {
        const fullPath = resolve(CACHE_DIR, entry.name);
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            unlinkSync(fullPath);
            pruned++;
          }
        } catch {}
      }
    }
    if (pruned > 0) {
      console.log(`[tts-cache] 🧹 Auto-pruned ${pruned} audio cache file(s) older than ${ttlHours}h`);
    }
  } catch (err) {
    console.warn(`[tts-cache] Prune error: ${err.message}`);
  }
}

if (cacheInRam) {
  // If RAM storage is selected, clean up any legacy disk cache to save space
  if (existsSync(CACHE_DIR)) {
    try { rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {}
  }
} else {
  // If Disk storage is selected, ensure directory exists and prune expired files
  if (!existsSync(CACHE_DIR)) {
    try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  }
  pruneExpiredDiskCache(cacheTtlHours);
  // Schedule hourly auto-deletion of expired files (> 24h)
  setInterval(() => pruneExpiredDiskCache(cacheTtlHours), 60 * 60 * 1000).unref();
}

function decodeMp3ToPcm44kStereo(mp3Buffer) {
  return new Promise((res, rej) => {
    try {
      const ffmpeg = spawn(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "44100", "-ac", "2", "pipe:1"],
        { stdio: ["pipe", "pipe", "inherit"] }
      );
      const outChunks = [];
      ffmpeg.stdout.on("data", (d) => outChunks.push(d));
      ffmpeg.on("error", (err) => rej(err));
      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          return rej(new Error(`FFmpeg exit code ${code}`));
        }
        const pcmBuf = Buffer.concat(outChunks);
        const pcm = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
        res(pcm);
      });
      ffmpeg.stdin.end(mp3Buffer);
    } catch (err) {
      rej(err);
    }
  });
}

parentPort.on("message", async (msg) => {
  if (msg.cmd === "synthesize") {
    const { id, text, voice } = msg;
    const voiceName = voice || "en-IN-NeerjaNeural";
    const key = `${voiceName}_${cleanCacheKey(text)}`;
    const diskPath = resolve(CACHE_DIR, `${key}.pcm`);

    // 1. Check in-memory cache
    if (memoryCache.has(key)) {
      const cached = memoryCache.get(key);
      const copy = new Int16Array(cached);
      parentPort.postMessage({ type: "tts_pcm", id, pcm: copy.buffer }, [copy.buffer]);
      return;
    }

    // 2. Check disk cache if disk mode is enabled
    if (!cacheInRam && existsSync(diskPath)) {
      try {
        const buf = readFileSync(diskPath);
        if (buf.byteLength >= 10000) {
          const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
          memoryCache.set(key, pcm);
          const copy = new Int16Array(pcm);
          parentPort.postMessage({ type: "tts_pcm", id, pcm: copy.buffer }, [copy.buffer]);
          return;
        }
      } catch {}
    }

    // 3. Synthesize via Edge Neural TTS
    try {
      const tts = new Communicate(text, {
        voice: voiceName
      });
      const stream = await tts.stream();
      const chunks = [];
      for await (const chunk of stream) {
        if (chunk.type === "audio") {
          chunks.push(chunk.data);
        }
      }

      if (chunks.length === 0) {
        parentPort.postMessage({ type: "tts_error", id, error: "No audio chunks received" });
        return;
      }

      const mp3Buf = Buffer.concat(chunks);
      const decodedPcm = await decodeMp3ToPcm44kStereo(mp3Buf);

      if (!decodedPcm || decodedPcm.length === 0) {
        parentPort.postMessage({ type: "tts_error", id, error: "Decoded audio is empty" });
        return;
      }

      // Save to memory cache
      if (memoryCache.size >= MAX_MEMORY_ITEMS) {
        const oldestKey = memoryCache.keys().next().value;
        if (oldestKey) memoryCache.delete(oldestKey);
      }
      memoryCache.set(key, decodedPcm);

      // Save to disk if disk mode is enabled
      if (!cacheInRam) {
        try {
          writeFileSync(diskPath, Buffer.from(decodedPcm.buffer, decodedPcm.byteOffset, decodedPcm.byteLength));
        } catch (err) {
          console.warn(`[tts-cache] Failed to write disk cache: ${err.message}`);
        }
      }

      const copy = new Int16Array(decodedPcm);
      parentPort.postMessage({ type: "tts_pcm", id, pcm: copy.buffer }, [copy.buffer]);
    } catch (err) {
      parentPort.postMessage({ type: "tts_error", id, error: err.message });
    }
  }
});

parentPort.postMessage({ type: "ready" });
