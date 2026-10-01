import { Worker, isMainThread } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";

let lastSpeechAt = 0;
let isEnabled = config.ttsEnabled;
let currentLanguage = (process.env.TTS_LANG || "en").toLowerCase() === "hi" ? "hi" : "en";
let currentMode = Number(process.env.TTS_MODE) === 2 ? 2 : 1;
let currentVoice = process.env.TTS_VOICE || config.ttsVoice || (currentLanguage === "hi" ? "hi-IN-SwaraNeural" : "en-IN-NeerjaNeural");

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

export function setTtsLanguage(lang) {
  const l = String(lang || "").toLowerCase().trim();
  if (l === "hi" || l === "hindi") {
    currentLanguage = "hi";
    if (currentVoice.startsWith("en-")) {
      currentVoice = (currentVoice.includes("Prabhat") || currentVoice.includes("male") || currentVoice.includes("boy"))
        ? "hi-IN-MadhurNeural"
        : "hi-IN-SwaraNeural";
    }
  } else {
    currentLanguage = "en";
    if (currentVoice.startsWith("hi-")) {
      currentVoice = (currentVoice.includes("Madhur") || currentVoice.includes("male") || currentVoice.includes("boy"))
        ? "en-IN-PrabhatNeural"
        : "en-IN-NeerjaNeural";
    }
  }
  console.log(`[tts] 🌐 Announcer language set to: ${currentLanguage.toUpperCase()} (Voice: ${currentVoice})`);
  return { language: currentLanguage, voice: currentVoice };
}

export function getTtsLanguage() {
  return currentLanguage;
}

export function setTtsMode(mode) {
  const mStr = String(mode || "").toLowerCase().trim();
  if (mStr === "2" || mStr.includes("total") || mStr.includes("vote") || mStr.includes("count")) {
    currentMode = 2;
  } else {
    currentMode = 1;
  }
  console.log(`[tts] 📋 Announcer mode set to: Mode ${currentMode} (${currentMode === 2 ? "With Total Votes" : "Simple"})`);
  return currentMode;
}

export function getTtsMode() {
  return currentMode;
}

export function setTtsVoice(voice) {
  if (voice && typeof voice === "string") {
    const vLower = voice.toLowerCase().trim();
    if (vLower === "girl" || vLower === "female") {
      currentVoice = currentLanguage === "hi" ? "hi-IN-SwaraNeural" : "en-IN-NeerjaNeural";
    } else if (vLower === "boy" || vLower === "male") {
      currentVoice = currentLanguage === "hi" ? "hi-IN-MadhurNeural" : "en-IN-PrabhatNeural";
    } else if (vLower === "swara" || vLower.includes("hi-in-swara")) {
      currentVoice = "hi-IN-SwaraNeural";
      currentLanguage = "hi";
    } else if (vLower === "madhur" || vLower.includes("hi-in-madhur")) {
      currentVoice = "hi-IN-MadhurNeural";
      currentLanguage = "hi";
    } else if (vLower === "neerja" || vLower.includes("en-in-neerja")) {
      currentVoice = "en-IN-NeerjaNeural";
      currentLanguage = "en";
    } else if (vLower === "prabhat" || vLower.includes("en-in-prabhat")) {
      currentVoice = "en-IN-PrabhatNeural";
      currentLanguage = "en";
    } else {
      currentVoice = voice.trim();
      if (currentVoice.startsWith("hi-")) currentLanguage = "hi";
      else if (currentVoice.startsWith("en-")) currentLanguage = "en";
    }
    console.log(`[tts] 🎙️ Announcer voice set to: "${currentVoice}" (${currentLanguage.toUpperCase()})`);
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
    const worker = new Worker(workerPath, {
      workerData: {
        cacheInRam: config.ttsCacheInRam,
        cacheTtlHours: config.ttsCacheTtlHours
      }
    });

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

export function queueVoteSpeech({ voter, contestantNo, candidateName, count = 1, totalVotes = 0 }) {
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
  if (currentLanguage === "hi") {
    if (currentMode === 2 && totalVotes > 0) {
      if (count > 1) {
        phrase = `${cleanName} ne ${cleanCand} ke liye ${count} votes add kiye hain, aur kul votes ${totalVotes} hain`;
      } else {
        phrase = `${cleanName} ne ${cleanCand} ko vote diya hai, aur kul votes ${totalVotes} hain`;
      }
    } else {
      if (count > 1) {
        phrase = `${cleanName} ne ${cleanCand} ke liye ${count} votes add kiye hain`;
      } else {
        phrase = `${cleanName} ne ${cleanCand} ko vote diya hai`;
      }
    }
  } else {
    // English (default)
    if (currentMode === 2 && totalVotes > 0) {
      if (count > 1) {
        phrase = `${cleanName} has added ${count} votes for ${cleanCand}, and total votes are ${totalVotes}`;
      } else {
        phrase = `${cleanName} has voted for ${cleanCand}, and total votes are ${totalVotes}`;
      }
    } else {
      if (count > 1) {
        phrase = `${cleanName} has added ${count} votes for ${cleanCand}`;
      } else {
        phrase = `${cleanName} has voted for ${cleanCand}`;
      }
    }
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
