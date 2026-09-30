import { Worker, isMainThread } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";

let lastSpeechAt = 0;
let isEnabled = config.ttsEnabled;
let currentVoice = process.env.TTS_VOICE || config.ttsVoice || "en-IN-NeerjaNeural";

let targetContestants = new Set(
  (config.ttsSpecificContestants || [])
    .map(s => String(s).toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)
);

let playAudioCallback = null;
let ttsWorker = null;
let nextRequestId = 1;
const pendingRequests = new Map();

export function registerTtsAudioPlayer(callback) {
  playAudioCallback = callback;
}

export function setTtsEnabled(enabled) {
  isEnabled = Boolean(enabled);
  console.log(`[tts] 🗣️ Announcer voice is now ${isEnabled ? "ENABLED (ON)" : "DISABLED (OFF)"}`);
  return isEnabled;
}

export function isTtsEnabled() {
  return isEnabled;
}

export function setTtsVoice(voice) {
  if (voice && typeof voice === "string") {
    currentVoice = voice.trim();
    console.log(`[tts] 🎙️ Announcer voice set to: "${currentVoice}"`);
    return currentVoice;
  }
  return currentVoice;
}

export function getTtsVoice() {
  return currentVoice;
}

export function setTtsTargetContestant(target) {
  if (!target || target === "all" || target === "clear" || target === "reset") {
    targetContestants.clear();
    console.log("[tts] Announcer active for ALL contestants");
    return { ok: true, filter: "ALL" };
  }
  const cleanKey = String(target).toLowerCase().replace(/[^a-z0-9]/g, "");
  targetContestants.clear();
  targetContestants.add(cleanKey);
  console.log(`[tts] Announcer locked to contestant: "${target}"`);
  return { ok: true, filter: target };
}

export function getTtsFilterStatus() {
  if (targetContestants.size === 0) return "ALL CONTESTANTS";
  return Array.from(targetContestants).join(", ").toUpperCase();
}

function cleanSpokenName(name) {
  if (!name) return "A viewer";
  // Remove emojis, symbols, and URL noise so neural TTS speaks fluently
  const noEmoji = String(name)
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu, " ")
    .replace(/[_@#~`^+=|\\/<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const safe = noEmoji.slice(0, 24).trim();
  return safe || "A viewer";
}

function ensureWorker() {
  if (!isMainThread) return null;
  if (ttsWorker) return ttsWorker;

  try {
    const workerPath = fileURLToPath(new URL("./tts-worker.mjs", import.meta.url));
    const worker = new Worker(workerPath);

    worker.on("message", (msg) => {
      if (msg.type === "tts_pcm") {
        const req = pendingRequests.get(msg.id);
        if (req) {
          pendingRequests.delete(msg.id);
          const pcm = new Int16Array(msg.pcm);
          if (pcm.length > 0 && typeof playAudioCallback === "function") {
            playAudioCallback(pcm, config.ttsVolume || 1.0);
            console.log(`[tts] 🗣️ Announced voice: "${req.phrase}" (${currentVoice})`);
          }
        }
      } else if (msg.type === "tts_error") {
        const req = pendingRequests.get(msg.id);
        if (req) {
          pendingRequests.delete(msg.id);
          console.warn(`[tts] Speech synthesis error for "${req.phrase}": ${msg.error}`);
        }
      }
    });

    worker.on("error", (err) => {
      console.error("[tts] Background worker error:", err.message);
      ttsWorker = null;
    });

    worker.on("exit", (code) => {
      if (code !== 0) console.warn(`[tts] Background worker exited with code ${code}`);
      ttsWorker = null;
    });

    ttsWorker = worker;
    return ttsWorker;
  } catch (err) {
    console.error("[tts] Failed to initialize TTS worker:", err.message);
    return null;
  }
}

export function queueVoteSpeech({ voter, contestantNo, candidateName, count = 1 }) {
  if (!isEnabled) return false;

  const now = Date.now();
  if (now - lastSpeechAt < config.ttsMinIntervalMs) {
    return false; // Rate-limited to maintain pleasant stream audio pacing
  }

  // Check contestant filter
  if (targetContestants.size > 0) {
    const noStr = String(contestantNo);
    const cleanCand = String(candidateName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    let matches = false;
    for (const key of targetContestants) {
      if (key === noStr || cleanCand.includes(key) || key.includes(cleanCand)) {
        matches = true;
        break;
      }
    }
    if (!matches) return false;
  }

  const cleanName = cleanSpokenName(voter);
  const cleanCand = String(candidateName || `#${contestantNo}`).trim();

  let phrase = "";
  if (count > 1) {
    phrase = `${cleanName} has added ${count} votes for ${cleanCand}`;
  } else {
    phrase = `${cleanName} has voted for ${cleanCand}`;
  }

  lastSpeechAt = now;

  const worker = ensureWorker();
  if (!worker) return false;

  const id = nextRequestId++;
  pendingRequests.set(id, { phrase, at: now });

  // Post to background worker thread (zero main thread CPU impact!)
  worker.postMessage({
    cmd: "synthesize",
    id,
    text: phrase,
    voice: currentVoice
  });

  return true;
}
