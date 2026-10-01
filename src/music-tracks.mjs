import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { isMainThread, Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

export const AUDIO_SAMPLE_RATE = 44100;

function softClip(x) {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

// -------------------------------------------------------------------------
// Pre-rendered Warm & Soft Sleep Lo-Fi Percussion Elements
// -------------------------------------------------------------------------
function createKickSample(dur = 0.22, startFreq = 75, endFreq = 38, decay = 14) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const f = startFreq + (endFreq - startFreq) * (t / dur);
    buf[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * decay);
  }
  return buf;
}

function createSnareSample(dur = 0.20, toneFreq = 190, decay = 20) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const noise = (Math.random() * 2 - 1) * 0.16;
    const tone = Math.sin(2 * Math.PI * toneFreq * t) * 0.12;
    buf[i] = (noise + tone) * Math.exp(-t * decay);
  }
  return buf;
}

function createRimshotSample(dur = 0.10, decay = 40) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const wood = Math.sin(2 * Math.PI * 520 * t) * 0.25;
    const click = (Math.random() * 2 - 1) * 0.12;
    buf[i] = (wood + click) * Math.exp(-t * decay);
  }
  return buf;
}

function createHatSample(dur = 0.04, decay = 180) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    buf[i] = (Math.random() * 2 - 1) * Math.exp(-t * decay) * 0.09;
  }
  return buf;
}

function createShakerSample(dur = 0.07, decay = 45) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    buf[i] = (Math.random() * 2 - 1) * Math.exp(-t * decay) * 0.08;
  }
  return buf;
}

const kickSoft = createKickSample(0.24, 75, 36, 12);
const snareSoft = createSnareSample(0.20, 180, 18);
const rimSoft = createRimshotSample(0.10, 42);
const hatSoft = createHatSample(0.04, 180);
const shakerSoft = createShakerSample(0.07, 45);

function addHit(pcm, offsetSample, totalSamples, sampleBuf, volL = 1.0, volR = 1.0) {
  const len = sampleBuf.length;
  for (let i = 0; i < len; i++) {
    const idx = offsetSample + i;
    if (idx >= totalSamples) break;
    pcm[idx * 2] += sampleBuf[i] * volL;
    pcm[idx * 2 + 1] += sampleBuf[i] * volR;
  }
}

// -------------------------------------------------------------------------
// Fast Sine Wavetable Oscillator
// -------------------------------------------------------------------------
const TABLE_SIZE = 4096;
const SINE_TABLE = new Float32Array(TABLE_SIZE);
for (let i = 0; i < TABLE_SIZE; i++) {
  SINE_TABLE[i] = Math.sin((i / TABLE_SIZE) * 2 * Math.PI);
}

function oscSin(phase) {
  const idx = Math.floor((phase - Math.floor(phase)) * TABLE_SIZE);
  return SINE_TABLE[idx & (TABLE_SIZE - 1)];
}

// -------------------------------------------------------------------------
// Core Ambient Sleep Lofi Track Synthesizer
// -------------------------------------------------------------------------
export function synthesizeAmbientSleepTrack(spec) {
  const {
    dur = 210, // Duration in seconds (180 to 300)
    bpm = 60, // Beats per minute (50 to 68)
    chords = [], // Array of chord arrays [freq1, freq2, ...]
    melodyNotes = [], // Melodic note pool
    leadInstrument = "rhodes", // "rhodes" | "felt_piano" | "kalimba" | "celeste" | "nylon_guitar" | "flute" | "music_box" | "singing_bowl"
    padStyle = "warm_analog", // "warm_analog" | "lush_silk" | "celestial_shimmer" | "deep_theta"
    ambientBed = "rain", // "rain" | "ocean" | "fireplace" | "crickets" | "wind" | "vinyl" | "stream" | "night_mist"
    drumStyle = "sleepy_lofi", // "sleepy_lofi" | "soft_brushes" | "heartbeat" | "none"
    barSec = null, // Bar duration (auto-computed if null)
  } = spec;

  const totalSamples = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(totalSamples);
  const tempR = new Float32Array(totalSamples);

  const secondsPerBeat = 60 / bpm;
  const barDuration = barSec || (secondsPerBeat * 4); // 4 beats per bar
  const numChords = chords.length;

  // 1. Ambient background layer
  let oceanPhase = 0;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    let ambL = 0, ambR = 0;

    if (ambientBed === "rain" || ambientBed === "night_mist") {
      const rainNoise = (Math.random() * 2 - 1) * 0.016;
      const drip = (Math.random() > 0.9998) ? (Math.random() * 2 - 1) * 0.035 : 0;
      ambL = rainNoise + drip;
      ambR = rainNoise - drip;
    } else if (ambientBed === "ocean") {
      oceanPhase = (t % 12.0) / 12.0;
      const swell = Math.sin(oceanPhase * Math.PI) * Math.sin(oceanPhase * Math.PI);
      const foam = (Math.random() * 2 - 1) * 0.02 * swell;
      const deepRumble = Math.sin(2 * Math.PI * 45 * t) * 0.018 * swell;
      ambL = foam * 1.1 + deepRumble;
      ambR = foam * 0.9 + deepRumble;
    } else if (ambientBed === "fireplace") {
      const pop = (Math.random() > 0.9988) ? (Math.random() * 2 - 1) * 0.05 : 0;
      const warmth = (Math.random() * 2 - 1) * 0.01;
      ambL = pop + warmth;
      ambR = pop * 0.8 + warmth;
    } else if (ambientBed === "crickets") {
      const chirpEnv = Math.max(0, Math.sin(2 * Math.PI * 2.8 * t)) ** 4;
      const chirpTone = (Math.sin(2 * Math.PI * 4800 * t) + Math.sin(2 * Math.PI * 5200 * t)) * 0.010 * chirpEnv;
      const breeze = (Math.random() * 2 - 1) * 0.006;
      ambL = chirpTone * 1.2 + breeze;
      ambR = chirpTone * 0.8 + breeze;
    } else if (ambientBed === "wind" || ambientBed === "stream") {
      const windLfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.12 * t);
      const flow = (Math.random() * 2 - 1) * 0.014 * windLfo;
      ambL = flow * 1.1;
      ambR = flow * 0.9;
    } else {
      const vinylDust = (Math.random() > 0.9992) ? (Math.random() * 2 - 1) * 0.025 : 0;
      const tape = (Math.random() * 2 - 1) * 0.007;
      ambL = vinylDust + tape;
      ambR = vinylDust + tape;
    }

    tempL[i] = ambL;
    tempR[i] = ambR;
  }

  // 2. Synthesize chord progression and pads using optimized phase accumulators
  const totalBars = Math.ceil(dur / barDuration);
  for (let bar = 0; bar < totalBars; bar++) {
    const barStartSample = Math.floor(bar * barDuration * AUDIO_SAMPLE_RATE);
    const barEndSample = Math.min(totalSamples, Math.floor((bar + 1) * barDuration * AUDIO_SAMPLE_RATE));
    const chord = chords[bar % numChords];
    const rootFreq = chord[0];
    const bassFreq = rootFreq > 130 ? rootFreq / 2 : rootFreq;
    const barSamples = barEndSample - barStartSample;

    const dPhases = chord.map(f => f / AUDIO_SAMPLE_RATE);
    const dPhasesDetune = chord.map(f => (f * 1.0018) / AUDIO_SAMPLE_RATE);
    const phases = new Float32Array(chord.length);
    const phasesDetune = new Float32Array(chord.length);
    for (let c = 0; c < chord.length; c++) {
      phases[c] = (barStartSample * dPhases[c]) % 1;
      phasesDetune[c] = (barStartSample * dPhasesDetune[c]) % 1;
    }

    const dBass = (bassFreq / 2) / AUDIO_SAMPLE_RATE;
    let pBass = (barStartSample * dBass) % 1;

    for (let i = barStartSample, localIdx = 0; i < barEndSample; i++, localIdx++) {
      const barNorm = localIdx / barSamples;
      const chordEnv = Math.sin(barNorm * Math.PI);
      const t = i / AUDIO_SAMPLE_RATE;

      const tremolo = 0.88 + 0.12 * Math.sin(2 * Math.PI * 3.2 * t);
      const chorus = 0.88 + 0.12 * Math.cos(2 * Math.PI * 2.8 * t);

      let padL = 0, padR = 0;
      for (let c = 0; c < chord.length; c++) {
        let p = phases[c] + dPhases[c];
        if (p >= 1) p -= 1;
        phases[c] = p;

        let pDet = phasesDetune[c] + dPhasesDetune[c];
        if (pDet >= 1) pDet -= 1;
        phasesDetune[c] = pDet;

        const tone = oscSin(p) * 0.07 + oscSin(pDet) * 0.04;
        padL += tone * tremolo;
        padR += tone * chorus;
      }

      pBass += dBass;
      if (pBass >= 1) pBass -= 1;
      const bassEnv = Math.min(1.0, barNorm * 4.0) * Math.exp(-barNorm * 0.6);
      const bassTone = (oscSin(pBass) * 0.24 + oscSin((pBass * 2) % 1) * 0.05) * bassEnv;

      tempL[i] += (padL * chordEnv * 0.9) + bassTone;
      tempR[i] += (padR * chordEnv * 0.9) + bassTone;
    }

    // Melodic Arpeggio / Lead Notes in this bar
    if (melodyNotes.length > 0) {
      const stepsPerBar = leadInstrument === "kalimba" || leadInstrument === "music_box" ? 8 : 4;
      const stepDuration = barDuration / stepsPerBar;

      for (let s = 0; s < stepsPerBar; s++) {
        if ((bar + s) % 3 === 2 && (s % 2 === 1)) continue;

        const noteIdx = (bar * 2 + s + (s % 2)) % melodyNotes.length;
        const noteFreq = melodyNotes[noteIdx];
        const stepStartSample = barStartSample + Math.floor(s * stepDuration * AUDIO_SAMPLE_RATE);
        const noteLen = Math.floor(stepDuration * AUDIO_SAMPLE_RATE * 1.8);
        const maxSample = Math.min(totalSamples, stepStartSample + noteLen);

        const panL = 0.6 + 0.4 * Math.sin(s * 1.3);
        const panR = 0.6 + 0.4 * Math.cos(s * 1.3);
        const dNote = noteFreq / AUDIO_SAMPLE_RATE;
        let pNote = 0;

        let decayRate = 2.4;
        if (leadInstrument === "kalimba" || leadInstrument === "celeste" || leadInstrument === "music_box") decayRate = 3.6;
        else if (leadInstrument === "nylon_guitar") decayRate = 2.8;
        else if (leadInstrument === "flute") decayRate = 1.6;

        for (let j = stepStartSample; j < maxSample; j++) {
          const noteT = (j - stepStartSample) / AUDIO_SAMPLE_RATE;
          pNote += dNote;
          if (pNote >= 1) pNote -= 1;

          let noteSound = 0;
          if (leadInstrument === "rhodes") {
            noteSound = (oscSin(pNote) * 0.12 + oscSin((pNote * 2) % 1) * 0.035) * Math.exp(-noteT * decayRate);
          } else if (leadInstrument === "kalimba" || leadInstrument === "celeste" || leadInstrument === "music_box") {
            noteSound = (oscSin(pNote) * 0.14 + oscSin((pNote * 3.01) % 1) * 0.04) * Math.exp(-noteT * decayRate);
          } else if (leadInstrument === "nylon_guitar") {
            noteSound = (oscSin(pNote) * 0.11 + oscSin((pNote * 1.5) % 1) * 0.03) * Math.exp(-noteT * decayRate);
          } else if (leadInstrument === "flute") {
            const breath = (Math.random() * 2 - 1) * 0.015;
            noteSound = (oscSin(pNote) * 0.13 + breath) * Math.exp(-noteT * decayRate);
          } else {
            noteSound = (oscSin(pNote) * 0.13 + oscSin((pNote * 2) % 1) * 0.02) * Math.exp(-noteT * decayRate);
          }

          tempL[j] += noteSound * panL;
          tempR[j] += noteSound * panR;
        }
      }
    }
  }

  // 3. Sleepy lofi drums
  if (drumStyle !== "none") {
    const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * secondsPerBeat);
    const drumStartBar = 4;
    const drumEndBar = totalBars - 2;

    for (let b = drumStartBar; b < drumEndBar; b++) {
      if (b % 12 >= 10) continue; // Ambient breather breakdown

      const barStart = Math.floor(b * barDuration * AUDIO_SAMPLE_RATE);

      if (drumStyle === "sleepy_lofi") {
        addHit(tempL, barStart, totalSamples, kickSoft, 0.30, 0.30);
        addHit(tempR, barStart, totalSamples, kickSoft, 0.30, 0.30);
        const swungBeat3 = barStart + Math.floor(beatSamples * 2.3);
        addHit(tempL, swungBeat3, totalSamples, kickSoft, 0.22, 0.22);
        addHit(tempR, swungBeat3, totalSamples, kickSoft, 0.22, 0.22);

        addHit(tempL, barStart + beatSamples, totalSamples, rimSoft, 0.24, 0.26);
        addHit(tempR, barStart + beatSamples, totalSamples, rimSoft, 0.26, 0.24);
        addHit(tempL, barStart + beatSamples * 3, totalSamples, snareSoft, 0.20, 0.22);
        addHit(tempR, barStart + beatSamples * 3, totalSamples, snareSoft, 0.22, 0.20);

        for (let h = 0; h < 4; h++) {
          const swing = (h % 2 === 1) ? Math.floor(beatSamples * 0.08) : 0;
          const hPos = barStart + Math.floor(h * beatSamples * 0.5) + swing;
          addHit(tempL, hPos, totalSamples, hatSoft, 0.09, 0.11);
          addHit(tempR, hPos, totalSamples, hatSoft, 0.11, 0.09);
        }
      } else if (drumStyle === "soft_brushes") {
        for (let h = 0; h < 4; h++) {
          addHit(tempL, barStart + h * beatSamples, totalSamples, shakerSoft, 0.12, 0.14);
          addHit(tempR, barStart + h * beatSamples, totalSamples, shakerSoft, 0.14, 0.12);
        }
        addHit(tempL, barStart + beatSamples * 2, totalSamples, rimSoft, 0.18, 0.20);
        addHit(tempR, barStart + beatSamples * 2, totalSamples, rimSoft, 0.20, 0.18);
      } else if (drumStyle === "heartbeat") {
        addHit(tempL, barStart, totalSamples, kickSoft, 0.24, 0.24);
        addHit(tempR, barStart, totalSamples, kickSoft, 0.24, 0.24);
        addHit(tempL, barStart + Math.floor(beatSamples * 0.35), totalSamples, kickSoft, 0.16, 0.16);
        addHit(tempR, barStart + Math.floor(beatSamples * 0.35), totalSamples, kickSoft, 0.16, 0.16);
      }
    }
  }

  // Convert to 16-bit signed PCM with soft limiting
  const out = new Int16Array(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// 30 Smooth Ambient Sleep Music Lo-Fi Track Configurations (3 to 5 Minutes Each)
// -------------------------------------------------------------------------
export const TRACK_SPECS = [
  // Track 1 (240s / 4:00)
  {
    id: 1,
    name: "Deep Theta Sleepscape",
    genre: "Theta Drone & Rhodes (240s)",
    durationSec: 240,
    bpm: 58,
    chords: [
      [130.81, 164.81, 196.00, 246.94, 293.66], // Cmaj9
      [110.00, 164.81, 220.00, 261.63, 329.63], // Am9
      [174.61, 220.00, 246.94, 329.63],         // Fmaj7#11
      [196.00, 261.63, 293.66, 329.63, 440.00], // G13sus
    ],
    melodyNotes: [329.63, 392.00, 440.00, 523.25, 587.33, 659.25],
    leadInstrument: "rhodes",
    padStyle: "deep_theta",
    ambientBed: "rain",
    drumStyle: "heartbeat",
  },
  // Track 2 (210s / 3:30)
  {
    id: 2,
    name: "Midnight Rain in Kyoto",
    genre: "Felt Piano & Rain (210s)",
    durationSec: 210,
    bpm: 62,
    chords: [
      [155.56, 196.00, 233.08, 293.66, 349.23], // Ebmaj9
      [130.81, 196.00, 233.08, 293.66, 311.13], // Cm9
      [207.65, 261.63, 311.13, 392.00],         // Abmaj7
      [233.08, 311.13, 349.23, 392.00],         // Bb9sus
    ],
    melodyNotes: [311.13, 349.23, 392.00, 466.16, 523.25],
    leadInstrument: "felt_piano",
    padStyle: "warm_analog",
    ambientBed: "rain",
    drumStyle: "sleepy_lofi",
  },
  // Track 3 (270s / 4:30)
  {
    id: 3,
    name: "Starlit Lavender Clouds",
    genre: "Dreamhop & Kalimba (270s)",
    durationSec: 270,
    bpm: 56,
    chords: [
      [146.83, 185.00, 220.00, 277.18, 329.63], // Dmaj9
      [123.47, 185.00, 220.00, 277.18, 293.66], // Bm11
      [196.00, 246.94, 293.66, 369.99, 440.00], // Gmaj9
      [220.00, 277.18, 329.63, 369.99, 440.00], // A6/9
    ],
    melodyNotes: [369.99, 440.00, 493.88, 554.37, 659.25],
    leadInstrument: "kalimba",
    padStyle: "celestial_shimmer",
    ambientBed: "wind",
    drumStyle: "soft_brushes",
  },
  // Track 4 (180s / 3:00)
  {
    id: 4,
    name: "Warm Wool Blanket & Tea",
    genre: "Cozy Guitar & Mellow Beats (180s)",
    durationSec: 180,
    bpm: 65,
    chords: [
      [174.61, 220.00, 261.63, 329.63, 392.00], // Fmaj9
      [146.83, 220.00, 261.63, 329.63],         // Dm9
      [233.08, 293.66, 349.23, 440.00],         // Bbmaj7
      [130.81, 207.65, 261.63, 311.13, 392.00], // C7alt
    ],
    melodyNotes: [261.63, 293.66, 329.63, 392.00, 440.00, 523.25],
    leadInstrument: "nylon_guitar",
    padStyle: "warm_analog",
    ambientBed: "fireplace",
    drumStyle: "sleepy_lofi",
  },
  // Track 5 (300s / 5:00)
  {
    id: 5,
    name: "Bioluminescent Ocean Tide",
    genre: "Ocean Ambient Drift (300s)",
    durationSec: 300,
    bpm: 52,
    chords: [
      [207.65, 261.63, 311.13, 392.00, 466.16], // Abmaj9
      [174.61, 261.63, 311.13, 392.00, 415.30], // Fm11
      [138.59, 207.65, 261.63, 311.13, 392.00], // Dbmaj9
      [155.56, 233.08, 311.13, 349.23, 415.30], // Eb11
    ],
    melodyNotes: [311.13, 349.23, 392.00, 415.30, 466.16, 523.25],
    leadInstrument: "celeste",
    padStyle: "lush_silk",
    ambientBed: "ocean",
    drumStyle: "none",
  },
  // Track 6 (240s / 4:00)
  {
    id: 6,
    name: "Weightless in Zero Gravity",
    genre: "Cosmic Glass & Sub (240s)",
    durationSec: 240,
    bpm: 54,
    chords: [
      [196.00, 246.94, 293.66, 369.99],         // Gmaj7
      [164.81, 246.94, 293.66, 369.99, 392.00], // Em9
      [130.81, 196.00, 246.94, 293.66, 392.00], // Cmaj9
      [146.83, 220.00, 293.66, 329.63, 392.00], // D9sus
    ],
    melodyNotes: [369.99, 392.00, 440.00, 493.88, 587.33],
    leadInstrument: "music_box",
    padStyle: "celestial_shimmer",
    ambientBed: "wind",
    drumStyle: "none",
  },
  // Track 7 (210s / 3:30)
  {
    id: 7,
    name: "Moonlit Forest Canopy",
    genre: "Zen Flute & Crickets (210s)",
    durationSec: 210,
    bpm: 60,
    chords: [
      [123.47, 185.00, 220.00, 277.18, 329.63], // Bm9
      [196.00, 246.94, 293.66, 369.99],         // Gmaj7
      [164.81, 220.00, 246.94, 293.66, 392.00], // Em9
      [185.00, 220.00, 277.18, 329.63],         // F#m7
    ],
    melodyNotes: [277.18, 329.63, 369.99, 440.00, 493.88],
    leadInstrument: "flute",
    padStyle: "warm_analog",
    ambientBed: "crickets",
    drumStyle: "soft_brushes",
  },
  // Track 8 (260s / 4:20)
  {
    id: 8,
    name: "Cozy Fireside Whispers",
    genre: "Fireside Guitar & Rhodes (260s)",
    durationSec: 260,
    bpm: 64,
    chords: [
      [116.54, 174.61, 220.00, 261.63, 329.63], // Bbmaj9
      [196.00, 261.63, 293.66, 349.23],         // Gm9
      [155.56, 233.08, 293.66, 349.23],         // Ebmaj7
      [174.61, 261.63, 329.63, 349.23, 392.00], // F11
    ],
    melodyNotes: [261.63, 293.66, 349.23, 392.00, 440.00],
    leadInstrument: "rhodes",
    padStyle: "warm_analog",
    ambientBed: "fireplace",
    drumStyle: "sleepy_lofi",
  },
  // Track 9 (195s / 3:15)
  {
    id: 9,
    name: "Slumbering in the Mist",
    genre: "Ambient Mist & Felt Piano (195s)",
    durationSec: 195,
    bpm: 59,
    chords: [
      [185.00, 220.00, 277.18, 329.63, 415.30], // F#m9
      [146.83, 220.00, 277.18, 369.99],         // Dmaj7
      [123.47, 185.00, 220.00, 277.18, 293.66], // Bm11
      [138.59, 207.65, 277.18, 329.63],         // C#m7
    ],
    melodyNotes: [277.18, 329.63, 369.99, 415.30, 493.88],
    leadInstrument: "felt_piano",
    padStyle: "deep_theta",
    ambientBed: "rain",
    drumStyle: "heartbeat",
  },
  // Track 10 (280s / 4:40)
  {
    id: 10,
    name: "Floating Through Aurora",
    genre: "Aurora Synths & Sub (280s)",
    durationSec: 280,
    bpm: 55,
    chords: [
      [164.81, 207.65, 246.94, 311.13, 369.99], // Emaj9
      [138.59, 207.65, 246.94, 311.13, 329.63], // C#m9
      [220.00, 277.18, 311.13, 392.00],         // Amaj7#11
      [246.94, 329.63, 369.99, 440.00],         // Bsus4
    ],
    melodyNotes: [329.63, 369.99, 415.30, 493.88, 554.37],
    leadInstrument: "celeste",
    padStyle: "celestial_shimmer",
    ambientBed: "wind",
    drumStyle: "none",
  },
  // Track 11 (180s / 3:00)
  {
    id: 11,
    name: "Sleepy Cat on the Sill",
    genre: "Purring Lofi & Rhodes (180s)",
    durationSec: 180,
    bpm: 68,
    chords: [
      [130.81, 164.81, 196.00, 246.94, 293.66], // Cmaj9
      [174.61, 220.00, 261.63, 329.63, 392.00], // Fmaj9
      [146.83, 220.00, 261.63, 329.63],         // Dm9
      [196.00, 246.94, 293.66, 329.63, 440.00], // G13
    ],
    melodyNotes: [261.63, 293.66, 329.63, 392.00, 440.00, 523.25],
    leadInstrument: "rhodes",
    padStyle: "warm_analog",
    ambientBed: "vinyl",
    drumStyle: "sleepy_lofi",
  },
  // Track 12 (225s / 3:45)
  {
    id: 12,
    name: "Lucid Twilight Reverie",
    genre: "Binaural Strings & Music Box (225s)",
    durationSec: 225,
    bpm: 57,
    chords: [
      [110.00, 164.81, 220.00, 277.18, 329.63], // Amaj9
      [185.00, 220.00, 277.18, 329.63, 369.99], // F#m9
      [146.83, 220.00, 277.18, 369.99],         // Dmaj7
      [164.81, 246.94, 293.66, 329.63, 392.00], // E9
    ],
    melodyNotes: [277.18, 329.63, 369.99, 440.00, 493.88],
    leadInstrument: "music_box",
    padStyle: "lush_silk",
    ambientBed: "rain",
    drumStyle: "none",
  },
  // Track 13 (300s / 5:00)
  {
    id: 13,
    name: "Distant Lighthouse Beacon",
    genre: "Deep Sea Fog & Drone (300s)",
    durationSec: 300,
    bpm: 52,
    chords: [
      [146.83, 220.00, 261.63, 329.63, 349.23], // Dm9
      [116.54, 174.61, 220.00, 261.63],         // Bbmaj7
      [196.00, 261.63, 293.66, 349.23],         // Gm9
      [220.00, 293.66, 329.63, 440.00],         // Asus4
    ],
    melodyNotes: [261.63, 293.66, 329.63, 349.23, 440.00],
    leadInstrument: "rhodes",
    padStyle: "deep_theta",
    ambientBed: "ocean",
    drumStyle: "heartbeat",
  },
  // Track 14 (210s / 3:30)
  {
    id: 14,
    name: "Raindrops on Bamboo",
    genre: "Bamboo Kalimba & Rain (210s)",
    durationSec: 210,
    bpm: 63,
    chords: [
      [196.00, 246.94, 293.66, 369.99, 440.00], // Gmaj9
      [164.81, 220.00, 246.94, 293.66, 392.00], // Em11
      [130.81, 164.81, 196.00, 246.94],         // Cmaj7
      [146.83, 220.00, 246.94, 293.66, 369.99], // D13
    ],
    melodyNotes: [293.66, 329.63, 369.99, 440.00, 493.88],
    leadInstrument: "kalimba",
    padStyle: "warm_analog",
    ambientBed: "rain",
    drumStyle: "soft_brushes",
  },
  // Track 15 (270s / 4:30)
  {
    id: 15,
    name: "Nebula Lullaby 432Hz",
    genre: "432Hz Celestial Sleep (270s)",
    durationSec: 270,
    bpm: 54,
    chords: [
      [138.59, 207.65, 277.18, 311.13, 329.63], // C#m9
      [220.00, 277.18, 329.63, 415.30],         // Amaj7
      [185.00, 220.00, 277.18, 329.63],         // F#m9
      [207.65, 246.94, 311.13, 369.99],         // G#m7
    ],
    melodyNotes: [277.18, 311.13, 329.63, 415.30, 493.88],
    leadInstrument: "singing_bowl",
    padStyle: "celestial_shimmer",
    ambientBed: "wind",
    drumStyle: "none",
  },
  // Track 16 (240s / 4:00)
  {
    id: 16,
    name: "Silent Midnight Snowfall",
    genre: "Felt Piano Snowfall (240s)",
    durationSec: 240,
    bpm: 56,
    chords: [
      [174.61, 220.00, 261.63, 329.63],         // Fmaj7
      [116.54, 174.61, 220.00, 261.63],         // Bbmaj7
      [146.83, 220.00, 261.63, 329.63],         // Dm9
      [130.81, 164.81, 196.00, 220.00, 293.66], // C6/9
    ],
    melodyNotes: [261.63, 293.66, 329.63, 349.23, 440.00],
    leadInstrument: "felt_piano",
    padStyle: "lush_silk",
    ambientBed: "wind",
    drumStyle: "soft_brushes",
  },
  // Track 17 (195s / 3:15)
  {
    id: 17,
    name: "Warm Herbal Tea Dreams",
    genre: "Neo-Soul Lofi Chords (195s)",
    durationSec: 195,
    bpm: 65,
    chords: [
      [155.56, 196.00, 233.08, 293.66, 349.23], // Ebmaj9
      [207.65, 261.63, 311.13, 392.00],         // Abmaj7
      [174.61, 261.63, 311.13, 349.23, 415.30], // Fm9
      [233.08, 311.13, 349.23, 415.30],         // Bb11
    ],
    melodyNotes: [293.66, 311.13, 349.23, 392.00, 466.16],
    leadInstrument: "nylon_guitar",
    padStyle: "warm_analog",
    ambientBed: "fireplace",
    drumStyle: "sleepy_lofi",
  },
  // Track 18 (225s / 3:45)
  {
    id: 18,
    name: "Gentle River at Dusk",
    genre: "River Brook & Flute (225s)",
    durationSec: 225,
    bpm: 60,
    chords: [
      [146.83, 185.00, 220.00, 277.18, 329.63], // Dmaj9
      [196.00, 246.94, 293.66, 369.99],         // Gmaj7
      [164.81, 246.94, 293.66, 369.99],         // Em9
      [220.00, 293.66, 329.63, 440.00],         // A7sus
    ],
    melodyNotes: [277.18, 293.66, 329.63, 369.99, 440.00],
    leadInstrument: "flute",
    padStyle: "warm_analog",
    ambientBed: "stream",
    drumStyle: "soft_brushes",
  },
  // Track 19 (290s / 4:50)
  {
    id: 19,
    name: "Submerged in Warm Waters",
    genre: "Underwater Sub Resonance (290s)",
    durationSec: 290,
    bpm: 50,
    chords: [
      [207.65, 261.63, 311.13, 392.00],         // Abmaj7
      [138.59, 207.65, 261.63, 311.13, 392.00], // Dbmaj9
      [116.54, 174.61, 207.65, 261.63, 311.13], // Bbm9
      [155.56, 233.08, 293.66, 311.13, 392.00], // Eb9
    ],
    melodyNotes: [261.63, 311.13, 349.23, 392.00, 466.16],
    leadInstrument: "rhodes",
    padStyle: "deep_theta",
    ambientBed: "ocean",
    drumStyle: "none",
  },
  // Track 20 (210s / 3:30)
  {
    id: 20,
    name: "Golden Embers in the Dark",
    genre: "Hearthside Acoustic Lofi (210s)",
    durationSec: 210,
    bpm: 64,
    chords: [
      [110.00, 164.81, 220.00, 261.63, 329.63], // Am9
      [174.61, 220.00, 261.63, 329.63],         // Fmaj7
      [146.83, 220.00, 261.63, 329.63],         // Dm9
      [164.81, 196.00, 246.94, 293.66],         // Em7
    ],
    melodyNotes: [220.00, 261.63, 293.66, 329.63, 392.00],
    leadInstrument: "nylon_guitar",
    padStyle: "warm_analog",
    ambientBed: "fireplace",
    drumStyle: "sleepy_lofi",
  },
  // Track 21 (300s / 5:00)
  {
    id: 21,
    name: "Himalayan Singing Bowls & Sleep",
    genre: "Tibetan Bowls & Theta (300s)",
    durationSec: 300,
    bpm: 50,
    chords: [
      [164.81, 246.94, 329.63, 440.00],
      [146.83, 220.00, 293.66, 440.00],
      [130.81, 196.00, 261.63, 392.00],
      [185.00, 277.18, 369.99, 440.00],
    ],
    melodyNotes: [246.94, 293.66, 329.63, 392.00, 440.00],
    leadInstrument: "singing_bowl",
    padStyle: "deep_theta",
    ambientBed: "wind",
    drumStyle: "none",
  },
  // Track 22 (180s / 3:00)
  {
    id: 22,
    name: "Midnight Attic Memories",
    genre: "Vintage Vinyl Beat & Rhodes (180s)",
    durationSec: 180,
    bpm: 67,
    chords: [
      [116.54, 174.61, 220.00, 261.63, 329.63], // Bbmaj9
      [146.83, 220.00, 261.63, 329.63],         // Dm7
      [155.56, 233.08, 293.66, 349.23],         // Ebmaj7
      [174.61, 220.00, 261.63, 311.13, 392.00], // F7
    ],
    melodyNotes: [261.63, 293.66, 329.63, 349.23, 440.00],
    leadInstrument: "rhodes",
    padStyle: "warm_analog",
    ambientBed: "rain",
    drumStyle: "sleepy_lofi",
  },
  // Track 23 (255s / 4:15)
  {
    id: 23,
    name: "Drifting Past the Moon",
    genre: "Space Ambient Celeste (255s)",
    durationSec: 255,
    bpm: 56,
    chords: [
      [196.00, 246.94, 293.66, 369.99, 440.00], // Gmaj9
      [130.81, 164.81, 196.00, 246.94],         // Cmaj7
      [110.00, 164.81, 220.00, 261.63, 329.63], // Am9
      [146.83, 220.00, 293.66, 369.99],         // D9sus
    ],
    melodyNotes: [293.66, 329.63, 369.99, 440.00, 493.88],
    leadInstrument: "celeste",
    padStyle: "celestial_shimmer",
    ambientBed: "wind",
    drumStyle: "heartbeat",
  },
  // Track 24 (225s / 3:45)
  {
    id: 24,
    name: "Whispering Pine Trees",
    genre: "Night Forest & Crickets (225s)",
    durationSec: 225,
    bpm: 60,
    chords: [
      [123.47, 185.00, 220.00, 277.18, 329.63], // Bm9
      [164.81, 220.00, 246.94, 293.66, 392.00], // Em9
      [196.00, 246.94, 293.66, 369.99],         // Gmaj7
      [220.00, 277.18, 329.63, 369.99],         // A6
    ],
    melodyNotes: [277.18, 293.66, 329.63, 369.99, 440.00],
    leadInstrument: "nylon_guitar",
    padStyle: "warm_analog",
    ambientBed: "crickets",
    drumStyle: "soft_brushes",
  },
  // Track 25 (240s / 4:00)
  {
    id: 25,
    name: "Celestial Music Box",
    genre: "Antique Music Box Lullaby (240s)",
    durationSec: 240,
    bpm: 58,
    chords: [
      [130.81, 164.81, 196.00, 246.94, 293.66], // Cmaj9
      [164.81, 196.00, 246.94, 293.66, 369.99], // Em9
      [174.61, 220.00, 261.63, 329.63],         // Fmaj7
      [196.00, 246.94, 293.66, 349.23, 440.00], // G9
    ],
    melodyNotes: [329.63, 392.00, 440.00, 523.25, 587.33],
    leadInstrument: "music_box",
    padStyle: "lush_silk",
    ambientBed: "vinyl",
    drumStyle: "none",
  },
  // Track 26 (270s / 4:30)
  {
    id: 26,
    name: "Sleepy Harbor Fog",
    genre: "Misty Harbor & Rhodes (270s)",
    durationSec: 270,
    bpm: 53,
    chords: [
      [146.83, 220.00, 261.63, 329.63, 349.23], // Dm9
      [196.00, 261.63, 293.66, 349.23, 392.00], // Gm9
      [116.54, 174.61, 220.00, 261.63],         // Bbmaj7
      [130.81, 196.00, 246.94, 293.66, 349.23], // C9
    ],
    melodyNotes: [261.63, 293.66, 329.63, 349.23, 392.00],
    leadInstrument: "rhodes",
    padStyle: "deep_theta",
    ambientBed: "ocean",
    drumStyle: "heartbeat",
  },
  // Track 27 (195s / 3:15)
  {
    id: 27,
    name: "Velvet Night Oasis",
    genre: "Silk Neo-Soul & Felt (195s)",
    durationSec: 195,
    bpm: 66,
    chords: [
      [155.56, 196.00, 233.08, 293.66, 349.23], // Ebmaj9
      [130.81, 196.00, 233.08, 293.66, 349.23], // Cm11
      [207.65, 261.63, 311.13, 392.00, 466.16], // Abmaj9
      [233.08, 311.13, 349.23, 392.00, 466.16], // Bb13
    ],
    melodyNotes: [293.66, 311.13, 349.23, 392.00, 466.16],
    leadInstrument: "felt_piano",
    padStyle: "warm_analog",
    ambientBed: "vinyl",
    drumStyle: "sleepy_lofi",
  },
  // Track 28 (285s / 4:45)
  {
    id: 28,
    name: "Solitude in the Clouds",
    genre: "Cloud Drift & Kalimba (285s)",
    durationSec: 285,
    bpm: 52,
    chords: [
      [174.61, 220.00, 261.63, 329.63, 392.00], // Fmaj9
      [110.00, 164.81, 220.00, 261.63, 329.63], // Am9
      [116.54, 174.61, 220.00, 261.63],         // Bbmaj7
      [130.81, 196.00, 246.94, 293.66, 349.23], // C9
    ],
    melodyNotes: [261.63, 329.63, 392.00, 440.00, 523.25],
    leadInstrument: "kalimba",
    padStyle: "celestial_shimmer",
    ambientBed: "wind",
    drumStyle: "none",
  },
  // Track 29 (300s / 5:00)
  {
    id: 29,
    name: "Deep REM Sleep Wave",
    genre: "Delta Harmonic Sleep Bed (300s)",
    durationSec: 300,
    bpm: 50,
    chords: [
      [207.65, 261.63, 311.13, 392.00, 466.16], // Abmaj9
      [174.61, 246.94, 261.63, 311.13, 349.23], // Fm9
      [138.59, 207.65, 261.63, 311.13],         // Dbmaj7
      [155.56, 233.08, 311.13, 349.23, 415.30], // Eb11
    ],
    melodyNotes: [261.63, 311.13, 349.23, 392.00, 466.16],
    leadInstrument: "singing_bowl",
    padStyle: "deep_theta",
    ambientBed: "rain",
    drumStyle: "heartbeat",
  },
  // Track 30 (210s / 3:30)
  {
    id: 30,
    name: "Peaceful Dawn Awakening",
    genre: "Morning Mist & Acoustic Lofi (210s)",
    durationSec: 210,
    bpm: 62,
    chords: [
      [146.83, 185.00, 220.00, 277.18, 329.63], // Dmaj9
      [196.00, 246.94, 293.66, 369.99, 440.00], // Gmaj9
      [123.47, 185.00, 220.00, 277.18, 293.66], // Bm9
      [220.00, 277.18, 329.63, 369.99, 440.00], // A6/9
    ],
    melodyNotes: [277.18, 293.66, 329.63, 369.99, 440.00],
    leadInstrument: "felt_piano",
    padStyle: "warm_analog",
    ambientBed: "crickets",
    drumStyle: "soft_brushes",
  },
];

// -------------------------------------------------------------------------
// Generator mapping for all 30 tracks
// -------------------------------------------------------------------------
export const generators = {};
for (const spec of TRACK_SPECS) {
  generators[spec.id] = () => synthesizeAmbientSleepTrack(spec);
}

// -------------------------------------------------------------------------
// Built-in 30-Track Ambient Sleep Lo-Fi Playlist
// -------------------------------------------------------------------------
export const BUILTIN_TRACKS = TRACK_SPECS.map(spec => ({
  id: spec.id,
  name: spec.name,
  genre: spec.genre,
  durationSec: spec.durationSec,
  generate: generators[spec.id],
  pcm: null,
}));

export function getTrackPcm(track) {
  if (!track) return null;
  if (track.pcm) return track.pcm;

  // Free all other tracks from RAM so only the active playing track occupies memory (~40MB instead of 1.2GB!)
  for (const t of BUILTIN_TRACKS) {
    if (t.id !== track.id && t.pcm) {
      t.pcm = null;
    }
  }

  // 1. Check disk cache (loads in <2ms)
  const cachePath = resolve(`data/audio-cache/track-${track.id}.pcm`);
  if (existsSync(cachePath)) {
    try {
      const buf = readFileSync(cachePath);
      track.pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      console.log(`[audio] loaded Track ${track.id}: "${track.name}" from disk cache in <2ms (RAM lean)`);
      return track.pcm;
    } catch (e) {
      console.warn(`[audio] disk cache read error for Track ${track.id}:`, e.message);
    }
  }

  // 2. Non-blocking safeguard: if running in live stream, return Track 1 so event loop NEVER freezes
  if (BUILTIN_TRACKS[0]?.pcm && track.id !== 1) {
    console.warn(`[audio] Track ${track.id} not in memory; playing Track 1 (zero drop safeguard)`);
    return BUILTIN_TRACKS[0].pcm;
  }

  // 3. Fallback generation (initial startup or worker only)
  if (track.generate) {
    const t0 = performance.now();
    track.pcm = track.generate();
    console.log(`[audio] synthesized ${track.durationSec || 240}s track ${track.id}: "${track.name}" in ${(performance.now() - t0).toFixed(0)}ms`);
    try {
      const cacheDir = resolve("data/audio-cache");
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath, Buffer.from(track.pcm.buffer, track.pcm.byteOffset, track.pcm.byteLength));
    } catch {}
  }
  return track.pcm;
}

export function startBackgroundAudioWorker() {
  if (!isMainThread) return;
  try {
    const workerPath = fileURLToPath(new URL("./audio-worker.mjs", import.meta.url));
    const worker = new Worker(workerPath);
    // Queue remaining tracks (2 through 30) for smooth background worker pre-generation
    let queue = Array.from({ length: BUILTIN_TRACKS.length - 1 }, (_, i) => i + 2);

    function next() {
      if (queue.length === 0) {
        worker.terminate();
        console.log(`[audio] all ${BUILTIN_TRACKS.length} background sleep music tracks verified & cached on disk`);
        return;
      }
      const nextId = queue.shift();
      const cached = resolve(`data/audio-cache/track-${nextId}.pcm`);
      if (existsSync(cached)) {
        // Disk cache ready — keep out of RAM until played!
        next();
      } else {
        worker.postMessage({ cmd: "generate", id: nextId });
      }
    }

    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        next();
      } else if (msg.type === "track_pcm") {
        const track = BUILTIN_TRACKS.find(t => t.id === msg.id);
        if (track) {
          console.log(`[audio] background worker ready: Track ${track.id} ("${track.name}") cached on disk`);
          try {
            const cacheDir = resolve("data/audio-cache");
            if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
            writeFileSync(resolve(`data/audio-cache/track-${track.id}.pcm`), Buffer.from(msg.pcm));
          } catch {}
          // Keep out of RAM until needed
        }
        next();
      }
    });

    worker.on("error", (err) => {
      console.warn("[audio] background audio worker error:", err.message);
    });
  } catch (e) {
    console.warn("[audio] could not spawn audio worker, fallback to disk cache:", e.message);
  }
}

if (isMainThread) {
  // Pre-load Track 1 from cache (<2ms)
  getTrackPcm(BUILTIN_TRACKS[0]);

  // Pre-load remaining tracks from cache or generate asynchronously on worker thread
  startBackgroundAudioWorker();
}

export let MUSIC_TRACKS = [...BUILTIN_TRACKS];

// Decode custom audio file (.mp3, .wav, .aac, .m4a, .flac) via FFmpeg into PCM
export async function decodeAudioFile(filePath) {
  return new Promise((resolve) => {
    try {
      const ff = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-i", filePath,
        "-f", "s16le", "-ar", "44100", "-ac", "2",
        "pipe:1"
      ]);
      const chunks = [];
      ff.stdout.on("data", chunk => chunks.push(chunk));
      ff.on("close", code => {
        if (code === 0 && chunks.length > 0) {
          const totalBuf = Buffer.concat(chunks);
          const pcm = new Int16Array(totalBuf.buffer, totalBuf.byteOffset, totalBuf.byteLength / 2);
          resolve(pcm);
        } else {
          resolve(null);
        }
      });
      ff.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

// Scans ./music and ./assets/music for custom audio tracks
export async function loadCustomMusicFiles() {
  const dirs = ["music", "assets/music", "audio"];
  const customTracks = [];
  const validExts = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      for (const file of files) {
        const ext = extname(file).toLowerCase();
        if (validExts.has(ext)) {
          const fullPath = join(dir, file);
          const s = await stat(fullPath);
          if (s.isFile() && s.size > 1000) {
            console.log(`[audio] decoding custom music track: ${file}...`);
            const pcm = await decodeAudioFile(fullPath);
            if (pcm && pcm.length > 44100) {
              const durSec = (pcm.length / 2 / AUDIO_SAMPLE_RATE).toFixed(0);
              const trackName = basename(file, ext).replace(/[_-]/g, " ");
              customTracks.push({
                id: customTracks.length + 1,
                name: `[Custom] ${trackName} (${durSec}s)`,
                genre: "Custom Audio",
                pcm,
                file: fullPath
              });
              console.log(`[audio] successfully loaded custom track: "${trackName}" (${durSec}s)`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[audio] error scanning ${dir}:`, err.message);
    }
  }

  if (customTracks.length > 0) {
    let idCounter = 1;
    const reindexed = [];
    for (const ct of customTracks) {
      ct.id = idCounter++;
      reindexed.push(ct);
    }
    for (const bt of BUILTIN_TRACKS) {
      reindexed.push({ ...bt, id: idCounter++ });
    }
    MUSIC_TRACKS = reindexed;
    console.log(`[audio] playlist updated: ${MUSIC_TRACKS.length} total tracks (${customTracks.length} custom, ${BUILTIN_TRACKS.length} built-in)`);
  }
  return MUSIC_TRACKS;
}
