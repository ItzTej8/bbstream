import { parentPort } from "node:worker_threads";
import { Communicate } from "edge-tts-universal";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const CACHE_DIR = resolve("data/audio-cache/tts");
if (!existsSync(CACHE_DIR)) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
}

const memoryCache = new Map();

function cleanCacheKey(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 80);
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

    // 1. Check memory cache
    if (memoryCache.has(key)) {
      const cached = memoryCache.get(key);
      const copy = new Int16Array(cached);
      parentPort.postMessage({ type: "tts_pcm", id, pcm: copy.buffer }, [copy.buffer]);
      return;
    }

    // 2. Check disk cache (require at least 10,000 bytes = > 0.05s valid audio)
    if (existsSync(diskPath)) {
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

    // 3. Synthesize via Edge Neural TTS in background
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

      // Save to memory cache and write to disk
      if (memoryCache.size > 200) memoryCache.clear();
      memoryCache.set(key, decodedPcm);
      try {
        writeFileSync(diskPath, Buffer.from(decodedPcm.buffer, decodedPcm.byteOffset, decodedPcm.byteLength));
      } catch {}

      const copy = new Int16Array(decodedPcm);
      parentPort.postMessage({ type: "tts_pcm", id, pcm: copy.buffer }, [copy.buffer]);
    } catch (err) {
      parentPort.postMessage({ type: "tts_error", id, error: err.message });
    }
  }
});

parentPort.postMessage({ type: "ready" });
