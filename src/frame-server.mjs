import http from "node:http";
import { config } from "./config.mjs";
import { runtime } from "./runtime.mjs";
import { on } from "./events.mjs";
import { isMusicEnabled } from "./interactive.mjs";

const boundary = "bbframe";
let server = null;
let latest = null;
let latestRaw = null;
let snapshotGenerator = null;
export function setSnapshotGenerator(fn) { snapshotGenerator = fn; }
const clients = new Set();
const rawClients = new Set();
const audioClients = new Set();
const RAW_BUF_SIZE = (config.renderWidth || 720) * (config.renderHeight || 1280) * 4;
const rawFramePool = Array.from({ length: 8 }, () => Buffer.alloc(RAW_BUF_SIZE));
let rawPoolIndex = 0;

// --- Audio Synthesizer & Real-time Mixer ---
const AUDIO_SAMPLE_RATE = 44100;
const INITIAL_BUFFER_SECONDS = 0;
const INITIAL_BUFFER_SAMPLES = Math.floor(AUDIO_SAMPLE_RATE * INITIAL_BUFFER_SECONDS);
const silencePool = Buffer.alloc(AUDIO_SAMPLE_RATE * 2 * 4); // 2 seconds pre-allocated silence

// Pre-synthesize celebratory Golden Fanfare Chime for votes
const VOTE_FANFARE_DURATION = 1.1;
const voteFanfareSamples = Math.floor(AUDIO_SAMPLE_RATE * VOTE_FANFARE_DURATION);
const voteFanfarePcm = new Int16Array(voteFanfareSamples * 2);

for (let i = 0; i < voteFanfareSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  let sL = 0, sR = 0;

  // Punchy bass kick at attack (t < 0.14)
  if (t < 0.14) {
    const kFreq = 125 - (t / 0.14) * 70;
    const kick = Math.sin(2 * Math.PI * kFreq * t) * Math.exp(-t * 28) * 0.45;
    sL += kick;
    sR += kick;
  }

  // Ascending 5-note broadcast fanfare arpeggio (C5 -> E5 -> G5 -> C6 -> E6)
  const notes = [
    { t0: 0.00, dur: 0.30, freq: 523.25, pan: -0.4 },
    { t0: 0.09, dur: 0.30, freq: 659.25, pan: -0.2 },
    { t0: 0.18, dur: 0.32, freq: 783.99, pan: 0.1 },
    { t0: 0.27, dur: 0.38, freq: 1046.50, pan: 0.25 },
    { t0: 0.36, dur: 0.72, freq: 1318.51, pan: 0.4 }
  ];

  for (const n of notes) {
    if (t >= n.t0 && t < n.t0 + n.dur) {
      const nt = t - n.t0;
      const att = Math.min(1, nt / 0.005);
      const dec = Math.exp(-nt * (n === notes[4] ? 3.8 : 8.5));
      const tone = (
        Math.sin(2 * Math.PI * n.freq * nt) * 0.48 +
        Math.sin(2 * Math.PI * (n.freq * 2) * nt) * 0.28 +
        Math.sin(2 * Math.PI * (n.freq * 3) * nt) * 0.14
      ) * att * dec;

      const panL = 0.5 * (1 - n.pan);
      const panR = 0.5 * (1 + n.pan);
      sL += tone * panL;
      sR += tone * panR;
    }
  }

  // Crystalline bell sparkle shimmer (t >= 0.36 to end)
  if (t >= 0.36) {
    const st = t - 0.36;
    const sDec = Math.exp(-st * 5.0);
    const shL = (Math.sin(2 * Math.PI * 2637 * st) * 0.15 + Math.sin(2 * Math.PI * 3951 * st) * 0.10) * sDec;
    const shR = (Math.sin(2 * Math.PI * 2637 * (st + 0.0012)) * 0.15 + Math.sin(2 * Math.PI * 3951 * (st - 0.0012)) * 0.10) * sDec;
    sL += shL;
    sR += shR;
  }

  voteFanfarePcm[i * 2] = Math.max(-32767, Math.min(32767, Math.round(sL * 25000)));
  voteFanfarePcm[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(sR * 25000)));
}

// Pre-synthesize Bomb Explosion sound effect
const BOMB_SOUND_DURATION = 1.2;
const bombSamples = Math.floor(AUDIO_SAMPLE_RATE * BOMB_SOUND_DURATION);
const bombPcm = new Int16Array(bombSamples * 2);
for (let i = 0; i < bombSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const boom = Math.sin(2 * Math.PI * Math.max(25, 80 - t * 50) * t) * Math.exp(-t * 4.2);
  const noise = (Math.random() * 2 - 1) * Math.exp(-t * 8.5) * 0.35;
  const s = Math.max(-1, Math.min(1, boom + noise));
  bombPcm[i * 2] = Math.round(s * 25000);
  bombPcm[i * 2 + 1] = Math.round(s * 25000);
}

// Confetti shimmer: rising metallic chime cluster
const CONFETTI_DUR = 1.0;
const confettiSamples = Math.floor(AUDIO_SAMPLE_RATE * CONFETTI_DUR);
const confettiPcm = new Int16Array(confettiSamples * 2);
for (let i = 0; i < confettiSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const notes = [1047, 1319, 1568, 2093];
  let s = 0;
  for (let n = 0; n < notes.length; n++) {
    const t0 = n * 0.08;
    if (t >= t0) {
      const nt = t - t0;
      s += Math.sin(2 * Math.PI * notes[n] * nt) * Math.exp(-nt * 5.5) * 0.28;
    }
  }
  const shimmer = Math.sin(2 * Math.PI * 3500 * t) * Math.exp(-t * 8) * 0.08;
  const val = Math.max(-32767, Math.min(32767, Math.round((s + shimmer) * 24000)));
  confettiPcm[i * 2] = val;
  confettiPcm[i * 2 + 1] = val;
}

// Fireworks whistle+burst: ascending whistle then explosion pop
const FIREWORKS_DUR = 1.2;
const fireworksSamples = Math.floor(AUDIO_SAMPLE_RATE * FIREWORKS_DUR);
const fireworksPcm = new Int16Array(fireworksSamples * 2);
for (let i = 0; i < fireworksSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  let s = 0;
  // Ascending whistle 0-0.4s
  if (t < 0.4) {
    const freq = 400 + (t / 0.4) * 2400;
    s += Math.sin(2 * Math.PI * freq * t) * 0.25;
  }
  // Pop burst at 0.42s
  if (t >= 0.42 && t < 0.70) {
    const bt = t - 0.42;
    s += Math.sin(2 * Math.PI * Math.max(20, 120 - bt * 200) * bt) * Math.exp(-bt * 18) * 0.55;
    s += (Math.random() * 2 - 1) * Math.exp(-bt * 20) * 0.3;
  }
  // Sparkle tail 0.55s+
  if (t >= 0.55) {
    const st = t - 0.55;
    s += (Math.sin(2 * Math.PI * 2093 * st) * 0.12 + Math.sin(2 * Math.PI * 3136 * st) * 0.08) * Math.exp(-st * 6);
  }
  const val = Math.max(-32767, Math.min(32767, Math.round(s * 24000)));
  fireworksPcm[i * 2] = val;
  fireworksPcm[i * 2 + 1] = val;
}

// Lightning crack: sharp noise burst + electric shimmer
const LIGHTNING_DUR = 0.7;
const lightningSamples = Math.floor(AUDIO_SAMPLE_RATE * LIGHTNING_DUR);
const lightningPcm = new Int16Array(lightningSamples * 2);
for (let i = 0; i < lightningSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const crack = (Math.random() * 2 - 1) * Math.exp(-t * 28) * 0.8;
  const rumble = Math.sin(2 * Math.PI * Math.max(20, 60 - t * 40) * t) * Math.exp(-t * 6) * 0.35;
  const electric = (Math.sin(2 * Math.PI * 1200 * t) + Math.sin(2 * Math.PI * 800 * t)) * Math.exp(-t * 14) * 0.15;
  const s = Math.max(-1, Math.min(1, crack + rumble + electric));
  const val = Math.round(s * 26000);
  lightningPcm[i * 2] = val;
  lightningPcm[i * 2 + 1] = val;
}

// Drop whoosh + touchdown chime
const DROP_DUR = 0.9;
const dropSamples = Math.floor(AUDIO_SAMPLE_RATE * DROP_DUR);
const dropPcm = new Int16Array(dropSamples * 2);
for (let i = 0; i < dropSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  let s = 0;
  // Descending whistle 0-0.45s
  if (t < 0.45) {
    const freq = 1800 - (t / 0.45) * 1200;
    s += Math.sin(2 * Math.PI * freq * t) * 0.22;
    s += (Math.random() * 2 - 1) * 0.05 * (1 - t / 0.45);
  } else {
    // Touchdown chime chord at 0.45s
    const ct = t - 0.45;
    const chime = (Math.sin(2 * Math.PI * 1046.5 * ct) * 0.25 + Math.sin(2 * Math.PI * 1318.5 * ct) * 0.2 + Math.sin(2 * Math.PI * 1567.98 * ct) * 0.15) * Math.exp(-ct * 6.5);
    s += chime;
  }
  const val = Math.max(-32767, Math.min(32767, Math.round(s * 25000)));
  dropPcm[i * 2] = val;
  dropPcm[i * 2 + 1] = val;
}

// Wheel clicking ratchet (1.4s)
const WHEEL_DUR = 1.4;
const wheelSamples = Math.floor(AUDIO_SAMPLE_RATE * WHEEL_DUR);
const wheelPcm = new Int16Array(wheelSamples * 2);
for (let i = 0; i < wheelSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  // Ticks that start fast (25Hz) and slow down to 4Hz
  const tickRate = Math.max(4, 25 * (1 - Math.pow(t / WHEEL_DUR, 1.8)));
  const phase = (t * tickRate) % 1.0;
  const click = phase < 0.08 ? (Math.sin(2 * Math.PI * 880 * phase) * Math.exp(-phase * 80) * 0.4 + (Math.random() * 2 - 1) * 0.15) : 0;
  const val = Math.max(-32767, Math.min(32767, Math.round(click * 24000)));
  wheelPcm[i * 2] = val;
  wheelPcm[i * 2 + 1] = val;
}

// Dice clatter rattle (0.8s)
const DICE_DUR = 0.8;
const diceSamples = Math.floor(AUDIO_SAMPLE_RATE * DICE_DUR);
const dicePcm = new Int16Array(diceSamples * 2);
for (let i = 0; i < diceSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const decay = Math.exp(-t * 5.0);
  const click = (Math.random() * 2 - 1) * (Math.sin(t * 70) > 0.6 ? 0.35 : 0.04) * decay;
  const thud = Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t * 9) * 0.3;
  const val = Math.max(-32767, Math.min(32767, Math.round((click + thud) * 25000)));
  dicePcm[i * 2] = val;
  dicePcm[i * 2 + 1] = val;
}

// Vegas Slot Jackpot / Arpeggio Chime (1.2s)
const SLOT_DUR = 1.2;
const slotSamples = Math.floor(AUDIO_SAMPLE_RATE * SLOT_DUR);
const slotPcm = new Int16Array(slotSamples * 2);
for (let i = 0; i < slotSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98];
  const step = Math.floor(t / 0.15) % notes.length;
  const noteT = t % 0.15;
  const tone = Math.sin(2 * Math.PI * notes[step] * noteT) * Math.exp(-noteT * 7) * 0.35;
  const shimmer = Math.sin(2 * Math.PI * (notes[step] * 2) * noteT) * 0.12 * Math.exp(-noteT * 10);
  const val = Math.max(-32767, Math.min(32767, Math.round((tone + shimmer) * 26000)));
  slotPcm[i * 2] = val;
  slotPcm[i * 2 + 1] = val;
}

// Celestial Magic Spell Chime (1.2s)
const MAGIC_DUR = 1.2;
const magicSamples = Math.floor(AUDIO_SAMPLE_RATE * MAGIC_DUR);
const magicPcm = new Int16Array(magicSamples * 2);
for (let i = 0; i < magicSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const mNotes = [659.25, 783.99, 987.77, 1318.51, 1567.98, 1975.53];
  const step = Math.min(mNotes.length - 1, Math.floor(t / 0.12));
  const noteT = t - step * 0.12;
  const bell = Math.sin(2 * Math.PI * mNotes[step] * noteT) * Math.exp(-noteT * 6) * 0.32;
  const shimmer = Math.sin(2 * Math.PI * (mNotes[step] * 2.5) * noteT) * 0.15 * Math.exp(-noteT * 9);
  const val = Math.max(-32767, Math.min(32767, Math.round((bell + shimmer) * 26000)));
  magicPcm[i * 2] = val;
  magicPcm[i * 2 + 1] = val;
}

// Sci-Fi Energy Forcefield Shield Hum (1.1s)
const SHIELD_DUR = 1.1;
const shieldSamples = Math.floor(AUDIO_SAMPLE_RATE * SHIELD_DUR);
const shieldPcm = new Int16Array(shieldSamples * 2);
for (let i = 0; i < shieldSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const fEnv = t < 0.1 ? (t / 0.1) : Math.exp(-(t - 0.1) * 3);
  const hum = Math.sin(2 * Math.PI * (120 + t * 40) * t) * 0.35 * fEnv;
  const buzz = Math.sin(2 * Math.PI * (240 + t * 80) * t) * 0.18 * fEnv;
  const val = Math.max(-32767, Math.min(32767, Math.round((hum + buzz) * 25000)));
  shieldPcm[i * 2] = val;
  shieldPcm[i * 2 + 1] = val;
}

// Cosmic Meteor Strike Explosion (1.3s)
const METEOR_DUR = 1.3;
const meteorSamples = Math.floor(AUDIO_SAMPLE_RATE * METEOR_DUR);
const meteorPcm = new Int16Array(meteorSamples * 2);
for (let i = 0; i < meteorSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  let s = 0;
  if (t < 0.35) {
    const wFreq = 420 - (t / 0.35) * 320;
    s += (Math.random() * 2 - 1) * 0.25 * (t / 0.35) + Math.sin(2 * Math.PI * wFreq * t) * 0.2;
  } else {
    const it = t - 0.35;
    const boom = Math.sin(2 * Math.PI * (65 * Math.exp(-it * 10)) * it) * Math.exp(-it * 4.5) * 0.55;
    const noise = (Math.random() * 2 - 1) * Math.exp(-it * 8) * 0.3;
    s += boom + noise;
  }
  const val = Math.max(-32767, Math.min(32767, Math.round(s * 27000)));
  meteorPcm[i * 2] = val;
  meteorPcm[i * 2 + 1] = val;
}

// Nitro Rocket Booster Thruster Roar (1.1s)
const BOOST_DUR = 1.1;
const boostSamples = Math.floor(AUDIO_SAMPLE_RATE * BOOST_DUR);
const boostPcm = new Int16Array(boostSamples * 2);
for (let i = 0; i < boostSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const bEnv = t < 0.15 ? (t / 0.15) : Math.exp(-(t - 0.15) * 2.8);
  const roar = (Math.random() * 2 - 1) * 0.35 * bEnv;
  const turbine = Math.sin(2 * Math.PI * (220 + t * 450) * t) * 0.25 * bEnv;
  const val = Math.max(-32767, Math.min(32767, Math.round((roar + turbine) * 25000)));
  boostPcm[i * 2] = val;
  boostPcm[i * 2 + 1] = val;
}

// Cosmic Gravitational Singularity Vortex (1.3s)
const VORTEX_DUR = 1.3;
const vortexSamples = Math.floor(AUDIO_SAMPLE_RATE * VORTEX_DUR);
const vortexPcm = new Int16Array(vortexSamples * 2);
for (let i = 0; i < vortexSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  let s = 0;
  if (t < 0.85) {
    const p = t / 0.85;
    const f = 240 - p * 190;
    const hum = Math.sin(2 * Math.PI * f * t) * (0.2 + 0.3 * p);
    const swirl = Math.sin(2 * Math.PI * (f * 1.5) * t + Math.sin(t * 18) * 3) * 0.18 * p;
    s = hum + swirl + (Math.random() * 2 - 1) * 0.08 * p;
  } else {
    const et = t - 0.85;
    const burst = Math.sin(2 * Math.PI * 90 * et) * Math.exp(-et * 12) * 0.55;
    const noise = (Math.random() * 2 - 1) * Math.exp(-et * 16) * 0.35;
    s = burst + noise;
  }
  const val = Math.max(-32767, Math.min(32767, Math.round(s * 25000)));
  vortexPcm[i * 2] = val;
  vortexPcm[i * 2 + 1] = val;
}

// Volumetric Dragon Flamethrower Breath (1.2s)
const DRAGON_DUR = 1.2;
const dragonSamples = Math.floor(AUDIO_SAMPLE_RATE * DRAGON_DUR);
const dragonPcm = new Int16Array(dragonSamples * 2);
for (let i = 0; i < dragonSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const env = t < 0.15 ? (t / 0.15) : Math.exp(-(t - 0.15) * 2.5);
  const roar = Math.sin(2 * Math.PI * (80 + Math.sin(t * 25) * 30) * t) * 0.35 * env;
  const flameNoise = (Math.random() * 2 - 1) * 0.32 * env;
  const emberCrackle = (Math.random() > 0.985 ? (Math.random() * 2 - 1) * 0.4 : 0) * env;
  const val = Math.max(-32767, Math.min(32767, Math.round((roar + flameNoise + emberCrackle) * 25000)));
  dragonPcm[i * 2] = val;
  dragonPcm[i * 2 + 1] = val;
}

// Celestial Supernova Star Explosion (1.4s)
const SUPERNOVA_DUR = 1.4;
const supernovaSamples = Math.floor(AUDIO_SAMPLE_RATE * SUPERNOVA_DUR);
const supernovaPcm = new Int16Array(supernovaSamples * 2);
for (let i = 0; i < supernovaSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  let sL = 0, sR = 0;
  if (t < 0.30) {
    const impl = t / 0.30;
    const pitch = 80 + impl * 500;
    const suck = Math.sin(2 * Math.PI * pitch * t) * (0.15 + 0.35 * impl);
    sL += suck; sR += suck;
  } else {
    const bt = t - 0.30;
    const boom = Math.sin(2 * Math.PI * Math.max(25, 110 - bt * 80) * bt) * Math.exp(-bt * 3.8) * 0.55;
    const noise = (Math.random() * 2 - 1) * Math.exp(-bt * 6) * 0.3;
    const bellL = (Math.sin(2 * Math.PI * 1046.5 * bt) * 0.2 + Math.sin(2 * Math.PI * 1567.98 * bt) * 0.15) * Math.exp(-bt * 4.5);
    const bellR = (Math.sin(2 * Math.PI * 1318.51 * bt) * 0.2 + Math.sin(2 * Math.PI * 1975.53 * bt) * 0.15) * Math.exp(-bt * 4.5);
    sL += boom + noise + bellL;
    sR += boom + noise + bellR;
  }
  supernovaPcm[i * 2] = Math.max(-32767, Math.min(32767, Math.round(sL * 25000)));
  supernovaPcm[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(sR * 25000)));
}

// Live Interactive Poll Vote Tally Chime (0.6s)
const POLL_DUR = 0.6;
const pollSamples = Math.floor(AUDIO_SAMPLE_RATE * POLL_DUR);
const pollPcm = new Int16Array(pollSamples * 2);
for (let i = 0; i < pollSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  let s = 0;
  if (t < 0.25) {
    s += Math.sin(2 * Math.PI * 1046.5 * t) * Math.exp(-t * 22) * 0.38;
  }
  if (t >= 0.10) {
    const t2 = t - 0.10;
    s += Math.sin(2 * Math.PI * 1567.98 * t2) * Math.exp(-t2 * 18) * 0.42;
    s += Math.sin(2 * Math.PI * 3135.96 * t2) * Math.exp(-t2 * 26) * 0.15;
  }
  const val = Math.max(-32767, Math.min(32767, Math.round(s * 25000)));
  pollPcm[i * 2] = val;
  pollPcm[i * 2 + 1] = val;
}

// Bigg Boss Confession Box Mystery Chime (1.0s)
const CONFESS_DUR = 1.0;
const confessSamples = Math.floor(AUDIO_SAMPLE_RATE * CONFESS_DUR);
const confessPcm = new Int16Array(confessSamples * 2);
for (let i = 0; i < confessSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const cello = Math.sin(2 * Math.PI * 146.83 * t) * 0.28 * Math.exp(-t * 2.5);
  const chimeNotes = [880, 1174.66, 1479.98, 1760];
  let ch = 0;
  for (let n = 0; n < chimeNotes.length; n++) {
    const ct = t - n * 0.07;
    if (ct > 0) {
      ch += Math.sin(2 * Math.PI * chimeNotes[n] * ct) * Math.exp(-ct * 7) * 0.15;
    }
  }
  const val = Math.max(-32767, Math.min(32767, Math.round((cello + ch) * 24000)));
  confessPcm[i * 2] = val;
  confessPcm[i * 2 + 1] = val;
}

// Trivia Quiz Game-Show Chime (0.8s)
const QUIZ_DUR = 0.8;
const quizSamples = Math.floor(AUDIO_SAMPLE_RATE * QUIZ_DUR);
const quizPcm = new Int16Array(quizSamples * 2);
for (let i = 0; i < quizSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const qNotes = [523.25, 659.25, 783.99, 1046.5];
  const step = Math.min(qNotes.length - 1, Math.floor(t / 0.10));
  const nt = t - step * 0.10;
  const bell = Math.sin(2 * Math.PI * qNotes[step] * nt) * Math.exp(-nt * 8) * 0.35;
  const vibraphone = Math.sin(2 * Math.PI * (qNotes[step] * 2) * nt) * Math.exp(-nt * 12) * 0.15;
  const val = Math.max(-32767, Math.min(32767, Math.round((bell + vibraphone) * 25000)));
  quizPcm[i * 2] = val;
  quizPcm[i * 2 + 1] = val;
}

// Reality TV Golden Buzzer Fanfare (1.4s)
const BUZZER_DUR = 1.4;
const buzzerSamples = Math.floor(AUDIO_SAMPLE_RATE * BUZZER_DUR);
const buzzerPcm = new Int16Array(buzzerSamples * 2);
for (let i = 0; i < buzzerSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  let sL = 0, sR = 0;
  if (t < 0.45) {
    const horn = (Math.sin(2 * Math.PI * 220 * t) * 0.4 + Math.sin(2 * Math.PI * 440 * t) * 0.3 + Math.sin(2 * Math.PI * 660 * t) * 0.15) * Math.exp(-t * 2.5);
    sL += horn; sR += horn;
  }
  if (t < 0.3) {
    const sub = Math.sin(2 * Math.PI * (95 - t * 180) * t) * Math.exp(-t * 12) * 0.6;
    sL += sub; sR += sub;
  }
  if (t >= 0.15) {
    const st = t - 0.15;
    const cHarm = (Math.sin(2 * Math.PI * 1046.5 * st) * 0.25 + Math.sin(2 * Math.PI * 1318.5 * st) * 0.22 + Math.sin(2 * Math.PI * 1568 * st) * 0.18 + Math.sin(2 * Math.PI * 2093 * st) * 0.15) * Math.exp(-st * 3.5);
    sL += cHarm * 0.9; sR += cHarm * 1.1;
  }
  buzzerPcm[i * 2] = Math.max(-32767, Math.min(32767, Math.round(sL * 25000)));
  buzzerPcm[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(sR * 25000)));
}

// 1v1 Battle Duel Clash Sound (1.2s)
const CLASH_DUR = 1.2;
const clashSamples = Math.floor(AUDIO_SAMPLE_RATE * CLASH_DUR);
const clashPcm = new Int16Array(clashSamples * 2);
for (let i = 0; i < clashSamples; i++) {
  const t = i / AUDIO_SAMPLE_RATE;
  const thunder = (Math.random() * 2 - 1) * Math.exp(-t * 8) * 0.5;
  const boom = Math.sin(2 * Math.PI * Math.max(30, 140 - t * 90) * t) * Math.exp(-t * 4.5) * 0.6;
  const power = Math.sin(2 * Math.PI * (350 + Math.sin(t * 40) * 120) * t) * Math.exp(-t * 5) * 0.25;
  const s = Math.max(-1, Math.min(1, thunder + boom + power));
  clashPcm[i * 2] = Math.round(s * 25000);
  clashPcm[i * 2 + 1] = Math.round(s * 25000);
}

import { MUSIC_TRACKS, getTrackPcm, loadCustomMusicFiles } from "./music-tracks.mjs";
export { MUSIC_TRACKS, loadCustomMusicFiles };

let currentTrackIndex = 0;
let trackLoopMode = "loop"; // "loop" (cycles tracks continuously) or "single" (repeats selected)
let autoAdvanceIntervalMs = 120000; // 2 minutes (120s) per track in loop mode
let lastTrackAdvanceAt = Date.now();
let activeSounds = [];
let bgLoopSampleIndex = 0;
let bgMusicVolume = 0.75; // Boosted broadcast volume: loud, clear, punchy

export function setMusicTrack(idx) {
  const targetIdx = (Number(idx) - 1 + MUSIC_TRACKS.length) % MUSIC_TRACKS.length;
  currentTrackIndex = targetIdx;
  bgLoopSampleIndex = 0;
  lastTrackAdvanceAt = Date.now();
  const trk = MUSIC_TRACKS[currentTrackIndex];
  console.log(`[audio] switched background music to Track ${trk.id}: "${trk.name}" (${trk.genre})`);
  return trk;
}

export function nextMusicTrack() {
  currentTrackIndex = (currentTrackIndex + 1) % MUSIC_TRACKS.length;
  bgLoopSampleIndex = 0;
  lastTrackAdvanceAt = Date.now();
  const trk = MUSIC_TRACKS[currentTrackIndex];
  console.log(`[audio] advanced background music to Track ${trk.id}: "${trk.name}" (${trk.genre})`);
  return trk;
}

export function prevMusicTrack() {
  currentTrackIndex = (currentTrackIndex - 1 + MUSIC_TRACKS.length) % MUSIC_TRACKS.length;
  bgLoopSampleIndex = 0;
  lastTrackAdvanceAt = Date.now();
  const trk = MUSIC_TRACKS[currentTrackIndex];
  console.log(`[audio] retreated background music to Track ${trk.id}: "${trk.name}" (${trk.genre})`);
  return trk;
}

export function setTrackLoopMode(mode) {
  if (mode === "single" || mode === "repeat" || mode === "hold" || mode === false) {
    trackLoopMode = "single";
  } else {
    trackLoopMode = "loop";
  }
  console.log(`[audio] track loop mode set to: ${trackLoopMode}`);
  return trackLoopMode;
}

export function getTrackLoopMode() {
  return trackLoopMode;
}

export function getMusicTrackInfo() {
  const trk = MUSIC_TRACKS[currentTrackIndex];
  return { id: trk.id, name: trk.name, genre: trk.genre, index: currentTrackIndex, total: MUSIC_TRACKS.length, loopMode: trackLoopMode };
}

export function setBgMusicVolume(vol) {
  const v = Math.max(0.1, Math.min(1.0, Number(vol) || 0.75));
  bgMusicVolume = v;
  console.log(`[audio] background music volume set to ${Math.round(bgMusicVolume * 100)}%`);
  return bgMusicVolume;
}

export function getBgMusicVolume() {
  return bgMusicVolume;
}

const SAMPLES_PER_FRAME = Math.round(AUDIO_SAMPLE_RATE / config.fps);
const frameSilenceBuf = Buffer.alloc(SAMPLES_PER_FRAME * 4);

export function playVoteSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: voteFanfarePcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playDropSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: dropPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playWheelTickSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: wheelPcm, offset: 0, volume: 0.9 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playDiceRattleSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: dicePcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playSlotJackpotSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: slotPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playBombSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: bombPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playConfettiSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: confettiPcm, offset: 0, volume: 0.9 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playFireworksSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: fireworksPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playLightningSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: lightningPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playMagicSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: magicPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playShieldSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: shieldPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playMeteorSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: meteorPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playBoostSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: boostPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playVortexSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: vortexPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playDragonSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: dragonPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playSupernovaSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: supernovaPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playPollSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: pollPcm, offset: 0, volume: 0.9 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playConfessSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: confessPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playQuizSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: quizPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playBuzzerSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: buzzerPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function playClashSound() {
  if (!isMusicEnabled()) return;
  activeSounds.push({ pcm: clashPcm, offset: 0, volume: 1.0 });
  if (activeSounds.length > 8) activeSounds.shift();
}

export function getAudioVisualizerLevels(now = Date.now()) {
  const musicOn = isMusicEnabled();
  const trk = MUSIC_TRACKS[currentTrackIndex] || MUSIC_TRACKS[0];
  const trkId = trk.id;
  const vol = bgMusicVolume;

  const t = (now % 4000) / 1000;
  const beat = (t % 0.5) / 0.5;
  const pulse = Math.exp(-beat * 4);
  const activeSfxBoost = Math.min(0.6, activeSounds.length * 0.2);

  const levels = [];
  for (let i = 0; i < 8; i++) {
    if (!musicOn) {
      levels.push(0.08);
      continue;
    }
    const bandPhase = (t * (1.2 + i * 0.4) + i * 0.75 + trkId * 0.3) % (Math.PI * 2);
    const wave = 0.5 + 0.5 * Math.sin(bandPhase);
    const beatSens = (i < 3) ? pulse * 0.55 : (i < 6) ? pulse * 0.32 : pulse * 0.18;
    const base = 0.22 + 0.42 * wave + beatSens + activeSfxBoost;
    levels.push(Math.max(0.12, Math.min(1.0, base * vol)));
  }
  return levels;
}

// Pipeline latency offset: with PIPELINE_DEPTH = 6 frames at 30 fps,
// a visual event dispatched now will reach the screen in ~160ms.
// By matching the audio trigger delay to the pipeline delivery time,
// the sound and the visual alert hit at the EXACT SAME VIDEO FRAME!
const PIPELINE_AUDIO_DELAY_MS = 160;

function queueSfx(fn) {
  setTimeout(fn, PIPELINE_AUDIO_DELAY_MS);
}

// Auto-trigger sound whenever a vote is accepted in the system
on("vote", (vote) => {
  queueSfx(playVoteSound);
});

on("interactive", (e) => {
  if (e.type === "drop") queueSfx(playDropSound);
  else if (e.type === "wheel" || e.type === "spin") queueSfx(playWheelTickSound);
  else if (e.type === "dice") queueSfx(playDiceRattleSound);
  else if (e.type === "slot") queueSfx(playSlotJackpotSound);
  else if (e.type === "bomb") queueSfx(playBombSound);
  else if (e.type === "confetti") queueSfx(playConfettiSound);
  else if (e.type === "fireworks") queueSfx(playFireworksSound);
  else if (e.type === "lightning") queueSfx(playLightningSound);
  else if (e.type === "magic") queueSfx(playMagicSound);
  else if (e.type === "shield") queueSfx(playShieldSound);
  else if (e.type === "meteor") queueSfx(playMeteorSound);
  else if (e.type === "boost") queueSfx(playBoostSound);
  else if (e.type === "vortex") queueSfx(playVortexSound);
  else if (e.type === "dragon") queueSfx(playDragonSound);
  else if (e.type === "supernova") queueSfx(playSupernovaSound);
  else if (e.type === "aurora" || e.type === "borealis") queueSfx(playMagicSound);
  else if (e.type === "phoenix" || e.type === "firebird") queueSfx(playDragonSound);
  else if (e.type === "disco" || e.type === "laserstorm" || e.type === "rave") queueSfx(playSupernovaSound);
  else if (e.type === "tornado" || e.type === "twister" || e.type === "cyclone") queueSfx(playVortexSound);
  else if (e.type === "clap" || e.type === "applause") queueSfx(playVoteSound);
  else if (e.type === "confess" || e.type === "gossip") queueSfx(playConfessSound);
  else if (e.type === "quiz") queueSfx(playQuizSound);
  else if (e.type === "buzzer" || e.type === "goldenbuzzer") queueSfx(playBuzzerSound);
  else if (e.type === "clash" || e.type === "battle") queueSfx(playClashSound);
  else if (e.type === "lucky" || e.type === "fortune") queueSfx(playWheelTickSound);
  else if (e.type === "champion" || e.type === "trophy") queueSfx(playSupernovaSound);
  else if (e.type === "spotlight") queueSfx(playMagicSound);
  else if (e.type === "freeze" || e.type === "ice" || e.type === "blizzard") queueSfx(playMagicSound);
  else if (e.type === "galaxy" || e.type === "nebula" || e.type === "milkyway") queueSfx(playSupernovaSound);
  else if (e.type === "tsunami" || e.type === "ocean" || e.type === "wave") queueSfx(playDropSound);
  else if (e.type === "diamond" || e.type === "gem" || e.type === "prism") queueSfx(playMagicSound);
  else if (e.type === "cheer") queueSfx(playVoteSound);
});

let lastAudioSentAt = Date.now();
let audioHeartbeatTimer = null;
let audioWallClockStart = 0;
let totalAudioSamplesSent = 0;

function ensureAudioHeartbeat() {
  if (!audioHeartbeatTimer) {
    audioHeartbeatTimer = setInterval(() => {
      if (audioClients.size === 0) return;
      // CRITICAL: Do NOT send audio before the video renderer has published its first frame!
      if (!runtime.renderer?.lastFramePublishedAt) return;
      sendAudioFrame();
    }, 20);
  }
}

function sendAudioFrame(forcedSamples = 0) {
  if (audioClients.size === 0) {
    audioWallClockStart = 0;
    totalAudioSamplesSent = 0;
    return;
  }
  // If video hasn't published its first frame yet, don't accumulate or send audio
  if (!runtime.renderer?.lastFramePublishedAt && !forcedSamples) {
    return;
  }
  const now = performance.now();
  if (audioWallClockStart === 0) {
    audioWallClockStart = now;
    totalAudioSamplesSent = 0;
  }

  let neededSamples = forcedSamples;
  if (!neededSamples) {
    const elapsedSec = (now - audioWallClockStart) / 1000;
    const targetSamples = Math.floor(elapsedSec * AUDIO_SAMPLE_RATE);
    neededSamples = targetSamples - totalAudioSamplesSent;
    // Don't send micro-chunks smaller than ~5ms (220 samples)
    if (neededSamples < 220) return;
    // Safety cap: don't generate more than 1 second of audio in a single call
    if (neededSamples > AUDIO_SAMPLE_RATE) {
      neededSamples = AUDIO_SAMPLE_RATE;
    }
  }

  totalAudioSamplesSent += neededSamples;
  lastAudioSentAt = Date.now();

  // Auto-advance track sequentially if loop mode is "loop" (every 3 minutes)
  if (trackLoopMode === "loop" && (Date.now() - lastTrackAdvanceAt > autoAdvanceIntervalMs)) {
    lastTrackAdvanceAt = Date.now();
    nextMusicTrack();
  }

  const chunkPcm = new Int16Array(neededSamples * 2);
  const musicOn = isMusicEnabled();
  const curTrack = MUSIC_TRACKS[currentTrackIndex] || MUSIC_TRACKS[0];
  const curPcm = curTrack ? getTrackPcm(curTrack) : null;
  const trackSamples = curPcm ? ((curPcm.length / 2) | 0) : 0;

  for (let i = 0; i < neededSamples; i++) {
    let sumL = 0, sumR = 0;

    // Ambient TV studio music bed (at dynamic bgMusicVolume)
    if (musicOn && curPcm && trackSamples > 0) {
      sumL += curPcm[bgLoopSampleIndex * 2] * bgMusicVolume;
      sumR += curPcm[bgLoopSampleIndex * 2 + 1] * bgMusicVolume;
      bgLoopSampleIndex = (bgLoopSampleIndex + 1) % trackSamples;
    }

    // Overlay active vote / explosion / fanfare sound effects
    for (const snd of activeSounds) {
      if (snd.offset + 1 < snd.pcm.length) {
        sumL += snd.pcm[snd.offset] * snd.volume;
        sumR += snd.pcm[snd.offset + 1] * snd.volume;
        snd.offset += 2;
      }
    }

    // Soft broadcast analog saturation limiter
    const limitL = (sumL > 32000) ? (32000 + Math.tanh((sumL - 32000) / 10000) * 767) : (sumL < -32000) ? (-32000 + Math.tanh((sumL + 32000) / 10000) * 767) : sumL;
    const limitR = (sumR > 32000) ? (32000 + Math.tanh((sumR - 32000) / 10000) * 767) : (sumR < -32000) ? (-32000 + Math.tanh((sumR + 32000) / 10000) * 767) : sumR;

    chunkPcm[i * 2] = Math.max(-32767, Math.min(32767, Math.round(limitL)));
    chunkPcm[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(limitR)));
  }

  activeSounds = activeSounds.filter(snd => snd.offset < snd.pcm.length);
  const chunkBuf = Buffer.from(chunkPcm.buffer);

  for (const client of [...audioClients]) {
    if (client.closed || !client.res.writable) {
      audioClients.delete(client);
      continue;
    }
    if (client.res.writableLength > 500_000) continue;
    try {
      client.res.write(chunkBuf);
      client.samplesSent += neededSamples;
    } catch {
      client.closed = true;
      try { client.res.destroy(); } catch {}
      audioClients.delete(client);
    }
  }
}

function remove(client, reason = "unknown") {
  const had = clients.has(client);
  clients.delete(client);
  runtime.encoder.inputClients = clients.size;
  if (had) {
    console.warn(`[mjpeg] client disconnected (${reason}); remaining clients: ${clients.size}`);
  }
}

function send(client, frame) {
  if (client.closed || !client.res.writable) return;

  // Real-time backpressure management for live streaming:
  // If the TCP send buffer has > 8MB queued (~50-60 frames),
  // skip writing this frame to prevent buffer bloat.
  if (client.res.writableLength > 8_000_000) {
    if (client.backedUpSince) {
      if (Date.now() - client.backedUpSince > 20000) {
        console.error(`[mjpeg] client unresponsive for 20s (${client.res.writableLength} bytes unconsumed); disconnecting`);
        client.closed = true;
        try { client.res.destroy(); } catch {}
        remove(client, "unresponsive-client-timeout");
      }
    } else {
      client.backedUpSince = Date.now();
    }
    return;
  }
  client.backedUpSince = 0;

  try {
    const chunk = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\nCache-Control: no-cache\r\n\r\n`),
      frame,
      Buffer.from("\r\n")
    ]);
    client.res.write(chunk);
    runtime.encoder.lastInputFrameAt = Date.now();
  } catch (error) {
    console.error(`[mjpeg] client write error: ${error.message}`);
    client.closed = true;
    try { client.res.destroy(); } catch {}
    remove(client, `write-error: ${error.message}`);
    runtime.encoder.lastError = `MJPEG client write: ${error.message}`;
  }
}

export function startFrameServer() {
  if (server) return server;
  server = http.createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    res.socket?.setNoDelay?.(true);

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ ok: true, clients: clients.size, audioClients: audioClients.size, hasFrame: Boolean(latest) }));
      return;
    }


    if (req.url === "/audio") {
      res.writeHead(200, {
        "Content-Type": "audio/l16; rate=44100; channels=2",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Connection": "keep-alive",
      });
      res.flushHeaders?.();
      const client = { req, res, closed: false, samplesSent: 0 };
      res.setTimeout(0);
      req.setTimeout(0);

      // Pre-send initial buffer to prime FFmpeg's audio buffer
      const initBuf = silencePool.subarray(0, INITIAL_BUFFER_SAMPLES * 4);
      res.write(initBuf);
      client.samplesSent += INITIAL_BUFFER_SAMPLES;

      audioClients.add(client);
      console.log(`[audio] client connected (total: ${audioClients.size})`);
      audioWallClockStart = performance.now();
      totalAudioSamplesSent = 0;
      ensureAudioHeartbeat();

      const cleanup = () => {
        client.closed = true;
        audioClients.delete(client);
        if (audioClients.size === 0) {
          audioWallClockStart = 0;
          totalAudioSamplesSent = 0;
        }
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      req.on("error", cleanup);
      res.on("error", cleanup);
      return;
    }

    if (req.url === "/raw") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders?.();
      const client = { res, req, closed: false };
      res.setTimeout(0);
      req.setTimeout(0);
      rawClients.add(client);
      runtime.encoder.inputClients = clients.size + rawClients.size;
      console.log(`[raw] client connected (total raw: ${rawClients.size})`);

      const cleanup = (reason = "close") => {
        client.closed = true;
        rawClients.delete(client);
        runtime.encoder.inputClients = clients.size + rawClients.size;
        console.warn(`[raw] client disconnected (${reason}); remaining: ${rawClients.size}`);
      };
      req.on("close", () => cleanup("req-close"));
      res.on("close", () => cleanup("res-close"));
      req.on("error", (e) => cleanup(`req-err: ${e?.message}`));
      res.on("error", (e) => cleanup(`res-err: ${e?.message}`));
      return;
    }

    if (req.url === "/frame" || req.url === "/frame.jpg" || req.url === "/snapshot") {
      let f = latest;
      if (!f && snapshotGenerator) {
        try { f = snapshotGenerator(); } catch {}
      }
      if (f) {
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": f.length,
          "Cache-Control": "no-cache, no-store, must-revalidate",
        });
        res.end(f);
      } else {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("no frame\n");
      }
      return;
    }

    if (req.url !== "/mjpeg") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found\n");
      return;
    }

    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.flushHeaders?.();
    const client = { res, req, blocked: false, closed: false, drainTimer: null };
    res.setTimeout(0);
    req.setTimeout(0);
    clients.add(client);
    runtime.encoder.inputClients = clients.size + rawClients.size;

    req.on("aborted", () => { client.closed = true; remove(client, "req-aborted"); });
    res.on("close", () => { client.closed = true; remove(client, "res-close"); });
    req.on("error", (e) => { client.closed = true; remove(client, `req-error: ${e?.message}`); });
    res.on("error", (e) => { client.closed = true; remove(client, `res-error: ${e?.message}`); });

    if (latest) send(client, latest);
  });

  server.on("error", error => {
    runtime.encoder.lastError = `Frame server: ${error.message}`;
    console.error(`[mjpeg] server error: ${error.message}`);
  });

  server.listen(config.frameServerPort, "127.0.0.1", () => {
    const isRaw = config.videoFeedFormat === "raw";
    runtime.encoder.inputUrl = isRaw
      ? `http://127.0.0.1:${config.frameServerPort}/raw`
      : `http://127.0.0.1:${config.frameServerPort}/mjpeg`;
    console.log(`[video] input server ${runtime.encoder.inputUrl} (${config.videoFeedFormat})`);
    console.log(`[audio] input server http://127.0.0.1:${config.frameServerPort}/audio`);
    loadCustomMusicFiles().catch(() => {});
  });
  return server;
}

export async function waitForRawDrain() {
  // Never block the render loop. Backpressure is handled by dropping unconsumed frames in publishFrame
  return;
}

export function publishFrame(frame, rawBuf = null) {
  latest = frame;
  latestRaw = rawBuf;
  runtime.renderer.lastFramePublishedAt = Date.now();

  // 1. High-performance raw video stream (zero JPEG encoding overhead)
  if (rawBuf && rawClients.size > 0) {
    for (const client of [...rawClients]) {
      if (client.closed || !client.res.writable) continue;
      // Allow up to 96MB TCP buffer (~26 raw frames) so encoding keyframe bursts never drop frames
      if (client.res.writableLength > 96_000_000) {
        if (runtime.encoder?.connectedHint) {
          runtime.renderer.dropped++;
        }
        continue;
      }
      try {
        client.res.write(rawBuf);
        runtime.encoder.lastInputFrameAt = Date.now();
      } catch {
        client.closed = true;
        try { client.res.destroy(); } catch {}
        rawClients.delete(client);
        runtime.encoder.inputClients = clients.size + rawClients.size;
      }
    }
  }

  // 2. Fallback MJPEG stream for browsers/MJPEG encoder
  if (frame && clients.size > 0) {
    for (const client of [...clients]) send(client, frame);
  }
}

export function stopFrameServer() {
  for (const client of [...rawClients]) {
    client.closed = true;
    try { client.res.destroy(); } catch {}
  }
  rawClients.clear();

  for (const client of [...clients]) {
    client.closed = true;
    if (client.drainTimer) clearTimeout(client.drainTimer);
    try { client.res.destroy(); } catch {}
  }
  clients.clear();

  for (const client of [...audioClients]) {
    client.closed = true;
    try { client.res.destroy(); } catch {}
  }
  audioClients.clear();
  audioWallClockStart = 0;
  totalAudioSamplesSent = 0;
  if (audioHeartbeatTimer) {
    clearInterval(audioHeartbeatTimer);
    audioHeartbeatTimer = null;
  }

  runtime.encoder.inputClients = 0;
  latest = null;
  latestRaw = null;
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
}
