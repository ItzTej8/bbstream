import { config } from "./config.mjs";

const phrasePcmCache = new Map();
let lastSpeechAt = 0;
let isEnabled = config.ttsEnabled;
let targetContestants = new Set(
  (config.ttsSpecificContestants || [])
    .map(s => String(s).toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)
);

let playAudioCallback = null;

export function registerTtsAudioPlayer(callback) {
  playAudioCallback = callback;
}

export function setTtsEnabled(enabled) {
  isEnabled = Boolean(enabled);
  console.log(`[tts] TTS speech announcer is now ${isEnabled ? "ENABLED" : "DISABLED"}`);
  return isEnabled;
}

export function isTtsEnabled() {
  return isEnabled;
}

export function setTtsTargetContestant(target) {
  if (!target || target === "all" || target === "clear" || target === "reset") {
    targetContestants.clear();
    console.log("[tts] TTS announcing for ALL contestants");
    return { ok: true, filter: "ALL" };
  }
  const cleanKey = String(target).toLowerCase().replace(/[^a-z0-9]/g, "");
  targetContestants.clear();
  targetContestants.add(cleanKey);
  console.log(`[tts] TTS locked to specific contestant: "${target}"`);
  return { ok: true, filter: target };
}

export function getTtsFilterStatus() {
  if (targetContestants.size === 0) return "ALL CONTESTANTS";
  return Array.from(targetContestants).join(", ").toUpperCase();
}

function cleanSpokenName(name) {
  if (!name) return "A viewer";
  // Remove emojis and non-alphanumeric noise so TTS pronounces clearly
  const noEmoji = String(name)
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu, " ")
    .replace(/[_@#~`^+=|\\/<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const safe = noEmoji.slice(0, 24).trim();
  return safe || "A viewer";
}

async function synthesizePcm(text) {
  const cached = phrasePcmCache.get(text);
  if (cached) return cached;

  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://translate.google.com/"
    }
  });

  if (!res.ok) {
    throw new Error(`Google TTS request failed with HTTP ${res.status}`);
  }

  const mp3Buf = Buffer.from(await res.arrayBuffer());
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", "pipe:1"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore"
    }
  );

  proc.stdin.write(mp3Buf);
  proc.stdin.end();

  const pcmBuf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;

  const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
  if (int16.length > 0) {
    if (phrasePcmCache.size > 150) phrasePcmCache.clear();
    phrasePcmCache.set(text, int16);
  }
  return int16;
}

export async function queueVoteSpeech({ voter, contestantNo, candidateName, count = 1 }) {
  if (!isEnabled) return false;

  const now = Date.now();
  if (now - lastSpeechAt < config.ttsMinIntervalMs) {
    // Too soon since last voice announcement — skip to avoid stream audio clutter
    return false;
  }

  // Check if specific contestant filter is configured
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

  try {
    const pcm = await synthesizePcm(phrase);
    if (pcm && pcm.length > 0 && typeof playAudioCallback === "function") {
      playAudioCallback(pcm, config.ttsVolume || 1.0);
      console.log(`[tts] 🗣️ Announced voice: "${phrase}"`);
      return true;
    }
  } catch (err) {
    console.warn(`[tts] Speech synthesis failed: ${err.message}`);
  }
  return false;
}
