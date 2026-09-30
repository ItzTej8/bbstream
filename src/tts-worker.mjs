import { parentPort } from "node:worker_threads";
import { Communicate } from "edge-tts-universal";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const CACHE_DIR = resolve("data/audio-cache/tts");
if (!existsSync(CACHE_DIR)) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
}

const memoryCache = new Map();

function resample24kMonoTo44kStereo(src) {
  const srcSamples = src.length;
  const ratio = 24000 / 44100;
  const targetSamples = Math.floor(srcSamples / ratio);
  const out = new Int16Array(targetSamples * 2);

  for (let i = 0; i < targetSamples; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(srcSamples - 1, idx0 + 1);
    const frac = srcPos - idx0;
    const val = Math.round(src[idx0] * (1 - frac) + src[idx1] * frac);
    const s16 = Math.max(-32768, Math.min(32767, val));
    out[i * 2] = s16;     // Left
    out[i * 2 + 1] = s16; // Right
  }
  return out;
}

function cleanCacheKey(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 80);
}

parentPort.on("message", async (msg) => {
  if (msg.cmd === "synthesize") {
    const { id, text, voice } = msg;
    const voiceName = voice || "en-IN-PrabhatNeural";
    const key = `${voiceName}_${cleanCacheKey(text)}`;
    const diskPath = resolve(CACHE_DIR, `${key}.pcm`);

    // 1. Check memory cache
    if (memoryCache.has(key)) {
      const cached = memoryCache.get(key);
      const copy = new Int16Array(cached);
      parentPort.postMessage({ type: "tts_pcm", id, pcm: copy.buffer }, [copy.buffer]);
      return;
    }

    // 2. Check disk cache
    if (existsSync(diskPath)) {
      try {
        const buf = readFileSync(diskPath);
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
        memoryCache.set(key, pcm);
        const copy = new Int16Array(pcm);
        parentPort.postMessage({ type: "tts_pcm", id, pcm: copy.buffer }, [copy.buffer]);
        return;
      } catch {}
    }

    // 3. Synthesize via Edge Neural TTS in background
    try {
      const tts = new Communicate(text, {
        voice: voiceName,
        outputFormat: "raw-24khz-16bit-mono-pcm"
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

      const rawBuf = Buffer.concat(chunks);
      const raw24k = new Int16Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength / 2);
      const resampled44k = resample24kMonoTo44kStereo(raw24k);

      // Save to cache
      if (memoryCache.size > 200) memoryCache.clear();
      memoryCache.set(key, resampled44k);
      try {
        writeFileSync(diskPath, Buffer.from(resampled44k.buffer, resampled44k.byteOffset, resampled44k.byteLength));
      } catch {}

      parentPort.postMessage({ type: "tts_pcm", id, pcm: resampled44k.buffer }, [resampled44k.buffer]);
    } catch (err) {
      parentPort.postMessage({ type: "tts_error", id, error: err.message });
    }
  }
});

parentPort.postMessage({ type: "ready" });
