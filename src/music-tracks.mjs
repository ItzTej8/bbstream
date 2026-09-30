import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { isMainThread, Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

export const AUDIO_SAMPLE_RATE = 44100;

function sine(freq, t) {
  return Math.sin(2 * Math.PI * freq * t);
}

function softClip(x) {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

// -------------------------------------------------------------------------
// Pre-rendered Warm & Punchy Lo-Fi Percussion Elements
// -------------------------------------------------------------------------
function createKickSample(dur = 0.22, startFreq = 95, endFreq = 40, decay = 18) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const f = startFreq + (endFreq - startFreq) * (t / dur);
    buf[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * decay);
  }
  return buf;
}

function createSnareSample(dur = 0.20, toneFreq = 240, decay = 24) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const noise = (Math.random() * 2 - 1) * 0.22;
    const tone = Math.sin(2 * Math.PI * toneFreq * t) * 0.18;
    buf[i] = (noise + tone) * Math.exp(-t * decay);
  }
  return buf;
}

function createRimshotSample(dur = 0.12, decay = 38) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const wood = Math.sin(2 * Math.PI * 680 * t) * 0.35 + Math.sin(2 * Math.PI * 1420 * t) * 0.20;
    const click = (Math.random() * 2 - 1) * 0.18;
    buf[i] = (wood + click) * Math.exp(-t * decay);
  }
  return buf;
}

function createHatSample(dur = 0.045, decay = 200) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    buf[i] = (Math.random() * 2 - 1) * Math.exp(-t * decay) * 0.14;
  }
  return buf;
}

function createShakerSample(dur = 0.08, decay = 55) {
  const len = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    buf[i] = (Math.random() * 2 - 1) * Math.exp(-t * decay) * 0.12;
  }
  return buf;
}

const kickLofi = createKickSample(0.22, 92, 38, 16);
const snareLofi = createSnareSample(0.20, 230, 22);
const rimshotLofi = createRimshotSample(0.12, 36);
const hatLofi = createHatSample(0.045, 190);
const shakerLofi = createShakerSample(0.08, 50);

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
// TRACK 1: "Rainy Tokyo Coffeehouse" (120.0s / 2 Minutes Chillhop Lofi)
// 60 bars @ 75 bpm (2.0s per bar)
// Progression: Fmaj9 -> Em11 -> Dm9 -> G13 -> Cmaj9 -> Bdim7 -> Am9 -> D7
// Instruments: Fender Rhodes with stereo tremolo, rain/vinyl texture,
// warm sub-bass, sleepy jazz piano solos, relaxed swung beat.
// -------------------------------------------------------------------------
function generateTrack1() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chordProg = [
    [174.61, 220.00, 261.63, 329.63, 392.00], // Fmaj9
    [164.81, 196.00, 246.94, 293.66, 349.23], // Em11
    [146.83, 220.00, 261.63, 329.63, 349.23], // Dm9
    [196.00, 246.94, 293.66, 329.63, 369.99], // G13
    [130.81, 164.81, 196.00, 246.94, 293.66], // Cmaj9
    [123.47, 146.83, 174.61, 220.00, 261.63], // Bdim7
    [110.00, 164.81, 220.00, 261.63, 329.63], // Am9
    [146.83, 220.00, 293.66, 369.99, 440.00], // D7
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chordProg[bar % chordProg.length];

    // Gentle low-pass envelope evolving across the track
    let filterCutoff = 0.85;
    if (bar >= 42 && bar < 50) filterCutoff = 0.45; // breakdown filter sweep
    else if (bar < 8) filterCutoff = 0.55 + (bar / 8) * 0.30;

    // Fender Rhodes Piano with Stereo Tremolo & Tape Warmth
    const tremoloL = 0.85 + 0.15 * Math.sin(2 * Math.PI * 3.8 * t);
    const tremoloR = 0.85 + 0.15 * Math.cos(2 * Math.PI * 3.8 * t);
    let rhodesL = 0, rhodesR = 0;
    for (let c = 0; c < chord.length; c++) {
      const f = chord[c];
      const tone = (sine(f, t) * 0.08 + sine(f * 2, t) * 0.025 + sine(f * 3, t) * 0.008);
      rhodesL += tone * tremoloL;
      rhodesR += tone * tremoloR;
    }
    rhodesL *= filterCutoff;
    rhodesR *= filterCutoff;

    // Deep Mellow Upright Sub-Bass
    let bass = 0;
    if ((bar >= 6 && bar < 42) || bar >= 50) {
      const bFreq = chord[0] / 2;
      bass = sine(bFreq, t) * 0.28 * (0.92 + 0.08 * Math.sin(2 * Math.PI * 1.2 * t));
    }

    // Melodic Electric Piano Lead Solos (bars 16-30 and 50-58)
    let leadL = 0, leadR = 0;
    if ((bar >= 16 && bar < 30) || (bar >= 50 && bar < 58)) {
      const pentatonic = [329.63, 392.00, 440.00, 523.25, 659.25, 783.99];
      const mStep = Math.floor(t / 0.5) % pentatonic.length;
      const mT = t % 0.5;
      const mf = pentatonic[mStep];
      const lTone = (sine(mf, mT) * 0.10 + sine(mf * 2, mT) * 0.03) * Math.exp(-mT * 3.2);
      leadL = lTone * 0.7;
      leadR = lTone * 1.1;
    }

    // Soft rainy cafe texture & subtle vinyl crackle
    const vinyl = (Math.random() > 0.996 ? (Math.random() * 2 - 1) * 0.035 : 0) + (Math.random() * 2 - 1) * 0.008;

    tempL[i] = rhodesL * 1.1 + bass + leadL + vinyl;
    tempR[i] = rhodesR * 1.1 + bass + leadR + vinyl;
  }

  // Laid-back, lazy swung Lofi drums (bars 8-42, 50-58)
  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 8; bar < 58; bar++) {
    if (bar >= 42 && bar < 50) continue; // Ambient breakdown
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    // Kick on beat 1 and swung beat 3+
    addHit(tempL, barStart, total, kickLofi, 0.40, 0.40);
    addHit(tempR, barStart, total, kickLofi, 0.40, 0.40);
    addHit(tempL, barStart + Math.floor(beatSamples * 2.3), total, kickLofi, 0.34, 0.34);
    addHit(tempR, barStart + Math.floor(beatSamples * 2.3), total, kickLofi, 0.34, 0.34);
    // Soft snare / rimshot on beats 2 & 4
    addHit(tempL, barStart + beatSamples, total, snareLofi, 0.28, 0.30);
    addHit(tempR, barStart + beatSamples, total, snareLofi, 0.30, 0.28);
    addHit(tempL, barStart + beatSamples * 3, total, rimshotLofi, 0.32, 0.35);
    addHit(tempR, barStart + beatSamples * 3, total, rimshotLofi, 0.35, 0.32);
    // Swung Hi-Hats with gentle velocity variation
    for (let h = 0; h < 4; h++) {
      const swingOffset = (h % 2 === 1) ? Math.floor(beatSamples * 0.08) : 0;
      const hPos = barStart + Math.floor(h * beatSamples * 0.5) + swingOffset;
      addHit(tempL, hPos, total, hatLofi, 0.12, 0.15);
      addHit(tempR, hPos, total, hatLofi, 0.15, 0.12);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 2: "Midnight Study Sanctuary" (120.0s Acoustic Guitar & Cozy Beats)
// 60 bars @ 72 bpm (2.0s per bar)
// Progression: Cmaj7 -> G/B -> Am9 -> Fmaj7 -> Dm9 -> Em7 -> Fmaj9 -> Gsus4
// Instruments: Fingerstyle nylon guitar arpeggios, warm mellow upright bass,
// sleepy flute counterpoint, lazy relaxed hip hop drum rhythm.
// -------------------------------------------------------------------------
function generateTrack2() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [130.81, 164.81, 196.00, 246.94], // Cmaj7
    [123.47, 146.83, 196.00, 246.94], // G/B
    [110.00, 164.81, 220.00, 261.63], // Am9
    [174.61, 220.00, 261.63, 329.63], // Fmaj7
    [146.83, 220.00, 261.63, 329.63], // Dm9
    [164.81, 196.00, 246.94, 293.66], // Em7
    [174.61, 220.00, 261.63, 349.23], // Fmaj9
    [196.00, 261.63, 293.66, 392.00], // Gsus4
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    // Plucked Nylon Guitar Fingerstyle Arpeggio
    const gStep = Math.floor(t / 0.25) % chord.length;
    const gT = t % 0.25;
    const gFreq = chord[gStep] * 2;
    const guitarNote = (sine(gFreq, gT) * 0.16 + sine(gFreq * 2, gT) * 0.05 + sine(gFreq * 3, gT) * 0.015) * Math.exp(-gT * 7.5);
    const pan = (gStep % 2 === 0) ? 0.7 : 1.3;

    // Warm Ambient Pad Swell
    let pad = 0;
    for (let c = 0; c < chord.length; c++) {
      pad += sine(chord[c], t) * 0.022;
    }

    // Gentle Acoustic Upright Bass (bars 6-44, 48-60)
    let bass = 0;
    if ((bar >= 6 && bar < 44) || bar >= 48) {
      const bFreq = chord[0] / 2;
      bass = (sine(bFreq, t) * 0.26 + sine(bFreq * 2, t) * 0.06) * (0.95 + 0.05 * Math.sin(2 * Math.PI * 1.5 * t));
    }

    // Sleepy Bamboo Flute Melody (bars 16-28 and 48-56)
    let flute = 0;
    if ((bar >= 16 && bar < 28) || (bar >= 48 && bar < 56)) {
      const scale = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25];
      const fStep = Math.floor(t / 0.66) % scale.length;
      const fT = t % 0.66;
      const vibrato = 1 + 0.02 * Math.sin(2 * Math.PI * 4.5 * fT);
      flute = (sine(scale[fStep] * vibrato, fT) * 0.12 + sine(scale[fStep] * 2 * vibrato, fT) * 0.03) * Math.exp(-fT * 2.2);
    }

    const vinyl = (Math.random() > 0.997 ? (Math.random() * 2 - 1) * 0.03 : 0);

    tempL[i] = guitarNote * (2 - pan) + pad + bass + flute * 0.8 + vinyl;
    tempR[i] = guitarNote * pan + pad + bass + flute * 1.2 + vinyl;
  }

  // Chill Study Drum Beat
  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 6; bar < 58; bar++) {
    if (bar >= 44 && bar < 48) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.38, 0.38);
    addHit(tempR, barStart, total, kickLofi, 0.38, 0.38);
    addHit(tempL, barStart + beatSamples * 2, total, kickLofi, 0.30, 0.30);
    addHit(tempR, barStart + beatSamples * 2, total, kickLofi, 0.30, 0.30);
    addHit(tempL, barStart + beatSamples, total, rimshotLofi, 0.30, 0.32);
    addHit(tempR, barStart + beatSamples, total, rimshotLofi, 0.32, 0.30);
    addHit(tempL, barStart + beatSamples * 3, total, snareLofi, 0.28, 0.30);
    addHit(tempR, barStart + beatSamples * 3, total, snareLofi, 0.30, 0.28);
    // Soft Shaker & Hat groove
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, shakerLofi, 0.15, 0.18);
      addHit(tempR, hPos, total, shakerLofi, 0.18, 0.15);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 3: "Golden Hour Sakura Garden" (120.0s Oriental Zen Lofi / Koto & Flute)
// 60 bars @ 80 bpm (2.0s per bar)
// Progression: Gmaj7 -> Bm7 -> Cmaj7 -> D6 -> Em9 -> Bm7 -> Am9 -> D7
// Instruments: Delicate plucked Japanese Koto arpeggios, airy bamboo flute whispers,
// soft warm analog synth pad, gentle brushed hi-hats, soothing wind chimes.
// -------------------------------------------------------------------------
function generateTrack3() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [196.00, 246.94, 293.66, 369.99], // Gmaj7
    [123.47, 146.83, 220.00, 246.94], // Bm7
    [130.81, 164.81, 196.00, 246.94], // Cmaj7
    [146.83, 220.00, 246.94, 293.66], // D6
    [164.81, 196.00, 246.94, 293.66], // Em9
    [123.47, 146.83, 220.00, 246.94], // Bm7
    [110.00, 164.81, 220.00, 261.63], // Am9
    [146.83, 220.00, 293.66, 369.99], // D7
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    // Japanese Koto / Guzheng Plucks
    const kStep = Math.floor(t / 0.33) % chord.length;
    const kT = t % 0.33;
    const kFreq = chord[kStep] * 2;
    const koto = (sine(kFreq, kT) * 0.18 + sine(kFreq * 2.02, kT) * 0.08 + sine(kFreq * 3.01, kT) * 0.02) * Math.exp(-kT * 6.5);

    // Warm Analog Silk Pad
    let pad = 0;
    for (let c = 0; c < chord.length; c++) {
      pad += sine(chord[c], t) * 0.025;
    }

    // Sub-Bass
    let bass = 0;
    if ((bar >= 8 && bar < 42) || bar >= 50) {
      bass = sine(chord[0] / 2, t) * 0.25;
    }

    // Shakuhachi Flute Melody (bars 16-32, 50-58)
    let flute = 0;
    if ((bar >= 16 && bar < 32) || (bar >= 50 && bar < 58)) {
      const pentatonic = [392.00, 440.00, 493.88, 587.33, 659.25, 783.99];
      const fStep = Math.floor(t / 0.5) % pentatonic.length;
      const fT = t % 0.5;
      const breath = (Math.random() * 2 - 1) * 0.015;
      flute = (sine(pentatonic[fStep], fT) * 0.12 + breath) * Math.exp(-fT * 2.8);
    }

    // Crystalline Zen Wind Chimes
    const chime = (Math.sin(2 * Math.PI * 1864 * t) * 0.03 + Math.sin(2 * Math.PI * 2349 * t) * 0.02) * (0.5 + 0.5 * Math.sin(t * 0.8));

    tempL[i] = koto * 1.1 + pad + bass + flute * 0.8 + chime * 0.5;
    tempR[i] = koto * 0.9 + pad + bass + flute * 1.2 + chime * 0.8;
  }

  // Gentle Zen Percussion
  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 8; bar < 58; bar++) {
    if (bar >= 42 && bar < 50) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.36, 0.36);
    addHit(tempR, barStart, total, kickLofi, 0.36, 0.36);
    addHit(tempL, barStart + beatSamples, total, rimshotLofi, 0.30, 0.32);
    addHit(tempR, barStart + beatSamples, total, rimshotLofi, 0.32, 0.30);
    addHit(tempL, barStart + beatSamples * 3, total, rimshotLofi, 0.30, 0.32);
    addHit(tempR, barStart + beatSamples * 3, total, rimshotLofi, 0.32, 0.30);
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, hatLofi, 0.11, 0.14);
      addHit(tempR, hPos, total, hatLofi, 0.14, 0.11);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 4: "Lavender Clouds Sunset" (120.0s Chill Dreamhop / Kalimba & Tape Synth)
// 60 bars @ 76 bpm (2.0s per bar)
// Progression: Ebmaj7 -> Cm7 -> Fm9 -> Bb13 -> Gm7 -> C7 -> Fm9 -> Bb7
// Instruments: Crystalline kalimba / music box bell patterns, lush warm analog tape pads,
// slow heartbeat kick, deep gentle bassline, dreamy drifting chords.
// -------------------------------------------------------------------------
function generateTrack4() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [155.56, 196.00, 233.08, 293.66], // Ebmaj7
    [130.81, 155.56, 196.00, 233.08], // Cm7
    [174.61, 207.65, 261.63, 311.13], // Fm9
    [116.54, 185.00, 233.08, 293.66], // Bb13
    [196.00, 233.08, 293.66, 349.23], // Gm7
    [130.81, 164.81, 196.00, 233.08], // C7
    [174.61, 207.65, 261.63, 311.13], // Fm9
    [116.54, 146.83, 207.65, 233.08], // Bb7
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    // Dreamy Crystalline Kalimba Chimes
    const kalStep = Math.floor(t / 0.25) % chord.length;
    const kalT = t % 0.25;
    const kalFreq = chord[kalStep] * 3;
    const kalimba = (sine(kalFreq, kalT) * 0.14 + sine(kalFreq * 2.76, kalT) * 0.05) * Math.exp(-kalT * 8.0);
    const kalPan = (kalStep % 2 === 0) ? 0.6 : 1.4;

    // Analog Tape Pad Chorus Swell
    const chorus = Math.sin(2 * Math.PI * 0.25 * t);
    let pad = 0;
    for (let c = 0; c < chord.length; c++) {
      pad += (sine(chord[c] * 1.5, t) * 0.03 + sine(chord[c] * 3, t + 0.002) * 0.01) * (0.8 + 0.2 * chorus);
    }

    // Warm sub-bass
    let bass = 0;
    if ((bar >= 6 && bar < 42) || bar >= 50) {
      bass = sine(chord[0] / 2, t) * 0.27;
    }

    // Distant dream harp flutter
    const harp = (Math.sin(2 * Math.PI * (chord[1] * 4) * t) * 0.03) * Math.exp(-(t % 1.0) * 3);

    const vinyl = (Math.random() > 0.996 ? (Math.random() * 2 - 1) * 0.035 : 0);

    tempL[i] = kalimba * (2 - kalPan) + pad + bass + harp * 0.7 + vinyl;
    tempR[i] = kalimba * kalPan + pad + bass + harp * 1.3 + vinyl;
  }

  // Heartbeat Dream Drum Pattern
  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 6; bar < 58; bar++) {
    if (bar >= 42 && bar < 50) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    // Double heartbeat kick on 1
    addHit(tempL, barStart, total, kickLofi, 0.40, 0.40);
    addHit(tempR, barStart, total, kickLofi, 0.40, 0.40);
    addHit(tempL, barStart + Math.floor(beatSamples * 0.4), total, kickLofi, 0.28, 0.28);
    addHit(tempR, barStart + Math.floor(beatSamples * 0.4), total, kickLofi, 0.28, 0.28);
    // Snare on 2 & 4
    addHit(tempL, barStart + beatSamples, total, snareLofi, 0.30, 0.32);
    addHit(tempR, barStart + beatSamples, total, snareLofi, 0.32, 0.30);
    addHit(tempL, barStart + beatSamples * 3, total, snareLofi, 0.30, 0.32);
    addHit(tempR, barStart + beatSamples * 3, total, snareLofi, 0.32, 0.30);
    // Shaker ticks
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, shakerLofi, 0.14, 0.16);
      addHit(tempR, hPos, total, shakerLofi, 0.16, 0.14);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 5: "Midnight Bookshop & Warm Tea" (120.0s Nostalgic Jazzhop / Muted Horn & Bass)
// 60 bars @ 74 bpm (2.0s per bar)
// Progression: Dm9 -> G13 -> Cmaj9 -> A7b9 -> Dm9 -> G7#9 -> Em7 -> A13
// Instruments: Romantic melancholic jazz progression, warm acoustic upright walking bass,
// soft muted jazz trumpet lead, sweet vibraphone counter-melodies, cozy vinyl crackle.
// -------------------------------------------------------------------------
function generateTrack5() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [146.83, 220.00, 261.63, 329.63], // Dm9
    [196.00, 246.94, 293.66, 369.99], // G13
    [130.81, 164.81, 196.00, 246.94], // Cmaj9
    [110.00, 174.61, 220.00, 277.18], // A7b9
    [146.83, 220.00, 261.63, 329.63], // Dm9
    [196.00, 246.94, 311.13, 392.00], // G7#9
    [164.81, 196.00, 246.94, 293.66], // Em7
    [110.00, 164.81, 220.00, 329.63], // A13
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    // Vintage Jazz Electric Piano Chords
    let piano = 0;
    for (let c = 0; c < chord.length; c++) {
      piano += (sine(chord[c], t) * 0.07 + sine(chord[c] * 2, t) * 0.02);
    }

    // Walking Acoustic Upright Bass (swinging 4 notes per bar)
    let bass = 0;
    if ((bar >= 6 && bar < 42) || bar >= 48) {
      const bStep = Math.floor(t / 0.5) % chord.length;
      const bT = t % 0.5;
      const bFreq = chord[bStep] / 2;
      bass = (sine(bFreq, bT) * 0.28 + sine(bFreq * 2, bT) * 0.08) * Math.exp(-bT * 2.2);
    }

    // Muted Jazz Trumpet Lead (bars 16-30 and 48-56)
    let trumpet = 0;
    if ((bar >= 16 && bar < 30) || (bar >= 48 && bar < 56)) {
      const scale = [293.66, 329.63, 349.23, 392.00, 440.00, 523.25];
      const mStep = Math.floor(t / 0.66) % scale.length;
      const mT = t % 0.66;
      const vibrato = 1 + 0.025 * Math.sin(2 * Math.PI * 5.0 * mT);
      const tone = (sine(scale[mStep] * vibrato, mT) * 0.12 + sine(scale[mStep] * 2 * vibrato, mT) * 0.04) * Math.exp(-mT * 2.0);
      trumpet = tone;
    }

    // Cozy bookshop vinyl hiss & soft pops
    const vinyl = (Math.random() > 0.995 ? (Math.random() * 2 - 1) * 0.04 : 0);

    tempL[i] = piano * 1.05 + bass + trumpet * 0.8 + vinyl;
    tempR[i] = piano * 0.95 + bass + trumpet * 1.2 + vinyl;
  }

  // Smooth Swung Jazzhop Drum Rhythm
  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 6; bar < 58; bar++) {
    if (bar >= 42 && bar < 48) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.38, 0.38);
    addHit(tempR, barStart, total, kickLofi, 0.38, 0.38);
    addHit(tempL, barStart + beatSamples, total, rimshotLofi, 0.32, 0.34);
    addHit(tempR, barStart + beatSamples, total, rimshotLofi, 0.34, 0.32);
    addHit(tempL, barStart + beatSamples * 2, total, kickLofi, 0.28, 0.28);
    addHit(tempR, barStart + beatSamples * 2, total, kickLofi, 0.28, 0.28);
    addHit(tempL, barStart + beatSamples * 3, total, rimshotLofi, 0.32, 0.34);
    addHit(tempR, barStart + beatSamples * 3, total, rimshotLofi, 0.34, 0.32);
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, hatLofi, 0.12, 0.15);
      addHit(tempR, hPos, total, hatLofi, 0.15, 0.12);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 6: "Starry Night Sleepscape" (120.0s Deep Ambient Lofi / Celestial Piano)
// 60 bars @ 66 bpm (2.0s per bar - ultra slow and peaceful)
// Progression: Dbmaj7 -> Bbm9 -> Gbmaj7 -> Ab7 -> Ebm9 -> Fm7 -> Gbmaj9 -> Abadd9
// Instruments: Ultra-slow soothing grand piano chords with long dreamy reverb decays,
// ethereal choir/celestial pads, gentle sleepy kick and rimshot, starry sparkle chimes.
// -------------------------------------------------------------------------
function generateTrack6() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [138.59, 174.61, 207.65, 261.63], // Dbmaj7
    [116.54, 138.59, 174.61, 207.65], // Bbm9
    [185.00, 233.08, 277.18, 349.23], // Gbmaj7
    [207.65, 261.63, 311.13, 369.99], // Ab7
    [155.56, 185.00, 233.08, 277.18], // Ebm9
    [174.61, 207.65, 261.63, 311.13], // Fm7
    [185.00, 233.08, 277.18, 369.99], // Gbmaj9
    [207.65, 261.63, 311.13, 415.30], // Abadd9
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    // Grand Piano Slow Arpeggio with Long Decays
    const pStep = Math.floor(t / 0.5) % chord.length;
    const pT = t % 0.5;
    const pFreq = chord[pStep] * 1.5;
    const piano = (sine(pFreq, pT) * 0.15 + sine(pFreq * 2, pT) * 0.05 + sine(pFreq * 3, pT) * 0.015) * Math.exp(-pT * 4.0);

    // Ethereal Celestial Choir Pad
    let choir = 0;
    for (let c = 0; c < chord.length; c++) {
      choir += (sine(chord[c] * 2, t) * 0.02 + sine(chord[c] * 4, t + 0.005) * 0.008);
    }

    // Warm deep ambient bass
    let bass = 0;
    if ((bar >= 6 && bar < 44) || bar >= 48) {
      bass = sine(chord[0] / 2, t) * 0.25;
    }

    // Starry Night Sparkle Chimes
    const sparkle = (Math.sin(2 * Math.PI * 2793 * t) * 0.03 + Math.sin(2 * Math.PI * 3729 * t) * 0.02) * Math.exp(-(t % 2.0) * 2.5);

    tempL[i] = piano * 1.1 + choir + bass + sparkle * 0.7;
    tempR[i] = piano * 0.9 + choir + bass + sparkle * 1.3;
  }

  // Soft Sleepy Beats
  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 8; bar < 58; bar++) {
    if (bar >= 44 && bar < 48) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.32, 0.32);
    addHit(tempR, barStart, total, kickLofi, 0.32, 0.32);
    addHit(tempL, barStart + beatSamples * 2, total, rimshotLofi, 0.25, 0.28);
    addHit(tempR, barStart + beatSamples * 2, total, rimshotLofi, 0.28, 0.25);
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, hatLofi, 0.10, 0.12);
      addHit(tempR, hPos, total, hatLofi, 0.12, 0.10);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 7: "Cozy Fireside Solitude" (120.0s Warm Acoustic Lofi / Fingerstyle & Melodica)
// 60 bars @ 78 bpm (2.0s per bar)
// Progression: Am9 -> Fmaj7 -> Cmaj9 -> G6 -> Dm9 -> Fmaj7 -> Em7 -> E7
// Instruments: Warm fingerstyle acoustic guitar chords, mellow vintage melodica/flute lead,
// soothing crackling fireplace warmth, lazy swung drum pattern with brushed rimshots.
// -------------------------------------------------------------------------
function generateTrack7() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [110.00, 164.81, 220.00, 261.63], // Am9
    [174.61, 220.00, 261.63, 329.63], // Fmaj7
    [130.81, 164.81, 196.00, 246.94], // Cmaj9
    [196.00, 246.94, 293.66, 329.63], // G6
    [146.83, 220.00, 261.63, 329.63], // Dm9
    [174.61, 220.00, 261.63, 349.23], // Fmaj7
    [164.81, 196.00, 246.94, 293.66], // Em7
    [164.81, 207.65, 246.94, 293.66], // E7
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    // Acoustic Guitar Fingerstyle Strum
    const gStep = Math.floor(t / 0.25) % chord.length;
    const gT = t % 0.25;
    const gFreq = chord[gStep] * 2;
    const guitar = (sine(gFreq, gT) * 0.16 + sine(gFreq * 2, gT) * 0.05) * Math.exp(-gT * 8.0);

    // Warm Melodica / Flute Lead (bars 16-32, 48-58)
    let melodica = 0;
    if ((bar >= 16 && bar < 32) || (bar >= 48 && bar < 58)) {
      const scale = [220.00, 261.63, 293.66, 329.63, 392.00, 440.00];
      const mStep = Math.floor(t / 0.5) % scale.length;
      const mT = t % 0.5;
      const vibrato = 1 + 0.02 * Math.sin(2 * Math.PI * 4.2 * mT);
      melodica = (sine(scale[mStep] * vibrato, mT) * 0.12 + sine(scale[mStep] * 2 * vibrato, mT) * 0.03) * Math.exp(-mT * 2.5);
    }

    // Bass
    let bass = 0;
    if ((bar >= 6 && bar < 42) || bar >= 48) {
      bass = sine(chord[0] / 2, t) * 0.26;
    }

    // Cozy crackling fireplace warmth
    const crackle = (Math.random() > 0.995 ? (Math.random() * 2 - 1) * 0.04 : 0);

    tempL[i] = guitar * 1.1 + melodica * 0.8 + bass + crackle;
    tempR[i] = guitar * 0.9 + melodica * 1.2 + bass + crackle;
  }

  // Fireside Drums
  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 6; bar < 58; bar++) {
    if (bar >= 42 && bar < 48) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.36, 0.36);
    addHit(tempR, barStart, total, kickLofi, 0.36, 0.36);
    addHit(tempL, barStart + beatSamples, total, snareLofi, 0.28, 0.30);
    addHit(tempR, barStart + beatSamples, total, snareLofi, 0.30, 0.28);
    addHit(tempL, barStart + beatSamples * 2, total, kickLofi, 0.28, 0.28);
    addHit(tempR, barStart + beatSamples * 2, total, kickLofi, 0.28, 0.28);
    addHit(tempL, barStart + beatSamples * 3, total, rimshotLofi, 0.30, 0.32);
    addHit(tempR, barStart + beatSamples * 3, total, rimshotLofi, 0.32, 0.30);
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, shakerLofi, 0.14, 0.16);
      addHit(tempR, hPos, total, shakerLofi, 0.16, 0.14);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 8: "Distant Ocean Memories" (120.0s Ethereal Seaside Lofi / Soft Rhodes Swells)
// 60 bars @ 70 bpm (2.0s per bar)
// Progression: Abmaj9 -> Fm9 -> Bbm9 -> Eb13 -> Cm7 -> Fm7 -> Bbm9 -> Eb7
// Instruments: Gentle wave-like pad swells, sparkling electric piano arpeggios,
// subtle tape flutter and pitch vibrato, soft ocean chillhop beat, peaceful harmonic resolution.
// -------------------------------------------------------------------------
function generateTrack8() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [207.65, 261.63, 311.13, 392.00], // Abmaj9
    [174.61, 207.65, 261.63, 311.13], // Fm9
    [116.54, 138.59, 174.61, 207.65], // Bbm9
    [155.56, 196.00, 233.08, 311.13], // Eb13
    [130.81, 155.56, 196.00, 233.08], // Cm7
    [174.61, 207.65, 261.63, 311.13], // Fm7
    [116.54, 138.59, 174.61, 233.08], // Bbm9
    [155.56, 196.00, 233.08, 277.18], // Eb7
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    // Ocean Wave-like Ambient Swell
    const wave = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.15 * t);
    let pad = 0;
    for (let c = 0; c < chord.length; c++) {
      pad += sine(chord[c] * 1.5, t) * 0.025 * wave;
    }

    // Electric Piano Sparkling Arpeggio
    const pStep = Math.floor(t / 0.25) % chord.length;
    const pT = t % 0.25;
    const pFreq = chord[pStep] * 2;
    const rhodes = (sine(pFreq, pT) * 0.14 + sine(pFreq * 2, pT) * 0.04) * Math.exp(-pT * 6.0);

    // Deep Gentle Sub-Bass
    let bass = 0;
    if ((bar >= 6 && bar < 44) || bar >= 48) {
      bass = sine(chord[0] / 2, t) * 0.27;
    }

    // Distant seaside chime
    const chime = (Math.sin(2 * Math.PI * 3322 * t) * 0.02) * Math.exp(-(t % 3.0) * 2.0);

    const vinyl = (Math.random() > 0.996 ? (Math.random() * 2 - 1) * 0.035 : 0);

    tempL[i] = rhodes * 1.1 + pad + bass + chime * 0.7 + vinyl;
    tempR[i] = rhodes * 0.9 + pad + bass + chime * 1.3 + vinyl;
  }

  // Soft Seaside Chillhop Beat
  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 6; bar < 58; bar++) {
    if (bar >= 44 && bar < 48) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.36, 0.36);
    addHit(tempR, barStart, total, kickLofi, 0.36, 0.36);
    addHit(tempL, barStart + beatSamples, total, snareLofi, 0.28, 0.30);
    addHit(tempR, barStart + beatSamples, total, snareLofi, 0.30, 0.28);
    addHit(tempL, barStart + beatSamples * 3, total, rimshotLofi, 0.30, 0.32);
    addHit(tempR, barStart + beatSamples * 3, total, rimshotLofi, 0.32, 0.30);
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, hatLofi, 0.11, 0.13);
      addHit(tempR, hPos, total, hatLofi, 0.13, 0.11);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 9: "Moonlit Forest Canopy" (120.0s Deep Ambient Flute & Nature Chimes)
// -------------------------------------------------------------------------
function generateTrack9() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [164.81, 196.00, 246.94, 293.66], // Em9
    [130.81, 164.81, 196.00, 246.94], // Cmaj7
    [110.00, 164.81, 220.00, 261.63], // Am9
    [123.47, 146.83, 185.00, 220.00], // Bm7
    [130.81, 164.81, 196.00, 293.66], // Cmaj9
    [146.83, 185.00, 220.00, 293.66], // D6
    [164.81, 196.00, 246.94, 329.63], // Em9
    [123.47, 155.56, 185.00, 246.94], // B7
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    const wind = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.12 * t);
    let pad = 0;
    for (let c = 0; c < chord.length; c++) {
      pad += sine(chord[c] * 1.5, t) * 0.022 * wind;
    }

    let flute = 0;
    if ((bar >= 12 && bar < 36) || (bar >= 44 && bar < 58)) {
      const pentatonic = [329.63, 392.00, 440.00, 493.88, 587.33, 659.25];
      const fStep = Math.floor(t / 0.5) % pentatonic.length;
      const fT = t % 0.5;
      const vib = 1 + 0.015 * Math.sin(2 * Math.PI * 5.0 * fT);
      flute = (sine(pentatonic[fStep] * vib, fT) * 0.13 + sine(pentatonic[fStep] * 2 * vib, fT) * 0.03) * Math.exp(-fT * 2.2);
    }

    let bass = 0;
    if ((bar >= 6 && bar < 44) || bar >= 48) {
      bass = sine(chord[0] / 2, t) * 0.26;
    }

    const chimes = (Math.sin(2 * Math.PI * 2637 * t) * 0.02 + Math.sin(2 * Math.PI * 3951 * t) * 0.015) * Math.exp(-(t % 2.5) * 3.0);
    const leaves = (Math.random() > 0.997 ? (Math.random() * 2 - 1) * 0.03 : 0);

    tempL[i] = pad + flute * 1.1 + bass + chimes * 0.7 + leaves;
    tempR[i] = pad + flute * 0.9 + bass + chimes * 1.3 + leaves;
  }

  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 6; bar < 58; bar++) {
    if (bar >= 40 && bar < 44) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.35, 0.35);
    addHit(tempR, barStart, total, kickLofi, 0.35, 0.35);
    addHit(tempL, barStart + beatSamples, total, rimshotLofi, 0.28, 0.30);
    addHit(tempR, barStart + beatSamples, total, rimshotLofi, 0.30, 0.28);
    addHit(tempL, barStart + beatSamples * 2, total, kickLofi, 0.25, 0.25);
    addHit(tempR, barStart + beatSamples * 2, total, kickLofi, 0.25, 0.25);
    addHit(tempL, barStart + beatSamples * 3, total, rimshotLofi, 0.28, 0.30);
    addHit(tempR, barStart + beatSamples * 3, total, rimshotLofi, 0.30, 0.28);
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, shakerLofi, 0.12, 0.14);
      addHit(tempR, hPos, total, shakerLofi, 0.14, 0.12);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 10: "Midnight Rooftop Breeze" (120.0s Jazzy Lo-Fi EP & Velvet Bass)
// -------------------------------------------------------------------------
function generateTrack10() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [146.83, 185.00, 220.00, 277.18], // Dmaj9
    [138.59, 164.81, 207.65, 246.94], // C#m7
    [123.47, 146.83, 185.00, 220.00], // Bm9
    [110.00, 164.81, 220.00, 277.18], // A13
    [98.00,  146.83, 196.00, 246.94], // Gmaj9
    [92.50,  138.59, 174.61, 220.00], // F#m7
    [82.41,  123.47, 164.81, 196.00], // Em9
    [110.00, 138.59, 164.81, 220.00], // A7
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    const compT = t % 1.0;
    let rhodes = 0;
    if (compT < 0.85) {
      for (let c = 0; c < chord.length; c++) {
        const tremolo = 1 + 0.08 * Math.sin(2 * Math.PI * 4.5 * t + c);
        rhodes += (sine(chord[c] * 1.5 * tremolo, compT) * 0.07 + sine(chord[c] * 3.0, compT) * 0.015) * Math.exp(-compT * 3.2);
      }
    }

    let bass = 0;
    if ((bar >= 4 && bar < 42) || bar >= 46) {
      const bStep = Math.floor(t / 0.5) % chord.length;
      const bFreq = chord[bStep] / 2;
      bass = sine(bFreq, t) * 0.28;
    }

    const vinyl = (Math.random() > 0.995 ? (Math.random() * 2 - 1) * 0.035 : 0);

    tempL[i] = rhodes * 1.1 + bass + vinyl;
    tempR[i] = rhodes * 0.9 + bass + vinyl;
  }

  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 4; bar < 58; bar++) {
    if (bar >= 42 && bar < 46) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.36, 0.36);
    addHit(tempR, barStart, total, kickLofi, 0.36, 0.36);
    addHit(tempL, barStart + beatSamples, total, snareLofi, 0.30, 0.32);
    addHit(tempR, barStart + beatSamples, total, snareLofi, 0.32, 0.30);
    addHit(tempL, barStart + beatSamples * 2, total, kickLofi, 0.26, 0.26);
    addHit(tempR, barStart + beatSamples * 2, total, kickLofi, 0.26, 0.26);
    addHit(tempL, barStart + beatSamples * 3, total, rimshotLofi, 0.28, 0.30);
    addHit(tempR, barStart + beatSamples * 3, total, rimshotLofi, 0.30, 0.28);
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, hatLofi, 0.12, 0.14);
      addHit(tempR, hPos, total, hatLofi, 0.14, 0.12);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 11: "Floating in Aurora" (120.0s Ethereal Ambient Synth & Velvet Pads)
// -------------------------------------------------------------------------
function generateTrack11() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [174.61, 220.00, 261.63, 329.63], // Fmaj7
    [196.00, 261.63, 293.66, 392.00], // Gsus4
    [220.00, 261.63, 329.63, 392.00], // Am7
    [164.81, 196.00, 246.94, 329.63], // Em7
    [174.61, 220.00, 261.63, 349.23], // Fmaj9
    [146.83, 220.00, 261.63, 329.63], // Dm9
    [196.00, 246.94, 293.66, 329.63], // G6
    [130.81, 164.81, 196.00, 246.94], // Cmaj7
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.10 * t);
    let choir = 0;
    for (let c = 0; c < chord.length; c++) {
      choir += sine(chord[c], t) * 0.035 * env;
    }

    const mStep = Math.floor(t / 0.25) % chord.length;
    const mT = t % 0.25;
    const marimba = (sine(chord[mStep] * 2.0, mT) * 0.12 + sine(chord[mStep] * 4.0, mT) * 0.04) * Math.exp(-mT * 7.0);

    const drone = sine(chord[0] / 2, t) * 0.24;
    const glint = (Math.sin(2 * Math.PI * 3492 * t) * 0.02) * Math.exp(-(t % 2.0) * 3.0);

    tempL[i] = choir * 1.1 + marimba * 0.8 + drone + glint;
    tempR[i] = choir * 0.9 + marimba * 1.2 + drone + glint;
  }

  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 8; bar < 56; bar++) {
    if (bar >= 38 && bar < 42) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.30, 0.30);
    addHit(tempR, barStart, total, kickLofi, 0.30, 0.30);
    addHit(tempL, barStart + beatSamples * 2, total, rimshotLofi, 0.22, 0.25);
    addHit(tempR, barStart + beatSamples * 2, total, rimshotLofi, 0.25, 0.22);
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, hatLofi, 0.08, 0.10);
      addHit(tempR, hPos, total, hatLofi, 0.10, 0.08);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// TRACK 12: "Warm Rainy Window" (120.0s Rain Drops & Gentle Acoustic Nylon Guitar)
// -------------------------------------------------------------------------
function generateTrack12() {
  const dur = 120.0;
  const total = Math.floor(AUDIO_SAMPLE_RATE * dur);
  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);

  const chords = [
    [146.83, 185.00, 220.00, 293.66], // D
    [123.47, 146.83, 185.00, 220.00], // Bm7
    [98.00,  146.83, 196.00, 246.94], // Gmaj7
    [110.00, 146.83, 164.81, 220.00], // A7sus4
    [146.83, 185.00, 220.00, 277.18], // Dmaj7
    [82.41,  123.47, 164.81, 196.00], // Em7
    [98.00,  146.83, 196.00, 246.94], // G6
    [146.83, 185.00, 220.00, 293.66], // D
  ];

  for (let i = 0; i < total; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    const bar = Math.floor(t / 2.0);
    const chord = chords[bar % chords.length];

    const gStep = Math.floor(t / 0.25) % chord.length;
    const gT = t % 0.25;
    const gFreq = chord[gStep] * 1.5;
    const guitar = (sine(gFreq, gT) * 0.15 + sine(gFreq * 2, gT) * 0.04) * Math.exp(-gT * 7.5);

    let piano = 0;
    if (bar >= 8) {
      const melody = [293.66, 329.63, 369.99, 440.00, 493.88, 587.33];
      const mStep = Math.floor(t / 0.5) % melody.length;
      const mT = t % 0.5;
      piano = (sine(melody[mStep], mT) * 0.10 + sine(melody[mStep] * 2, mT) * 0.03) * Math.exp(-mT * 3.0);
    }

    let bass = 0;
    if ((bar >= 4 && bar < 42) || bar >= 46) {
      bass = sine(chord[0] / 2, t) * 0.25;
    }

    const rain = (Math.random() > 0.993 ? (Math.random() * 2 - 1) * 0.04 : 0);

    tempL[i] = guitar * 1.1 + piano * 0.8 + bass + rain;
    tempR[i] = guitar * 0.9 + piano * 1.2 + bass + rain;
  }

  const beatSamples = Math.floor(AUDIO_SAMPLE_RATE * 0.5);
  for (let bar = 4; bar < 58; bar++) {
    if (bar >= 42 && bar < 46) continue;
    const barStart = Math.floor(bar * 2.0 * AUDIO_SAMPLE_RATE);
    addHit(tempL, barStart, total, kickLofi, 0.34, 0.34);
    addHit(tempR, barStart, total, kickLofi, 0.34, 0.34);
    addHit(tempL, barStart + beatSamples, total, rimshotLofi, 0.26, 0.28);
    addHit(tempR, barStart + beatSamples, total, rimshotLofi, 0.28, 0.26);
    addHit(tempL, barStart + beatSamples * 2, total, kickLofi, 0.24, 0.24);
    addHit(tempR, barStart + beatSamples * 2, total, kickLofi, 0.24, 0.24);
    addHit(tempL, barStart + beatSamples * 3, total, rimshotLofi, 0.28, 0.30);
    addHit(tempR, barStart + beatSamples * 3, total, rimshotLofi, 0.30, 0.28);
    for (let h = 0; h < 4; h++) {
      const hPos = barStart + Math.floor(h * beatSamples * 0.5);
      addHit(tempL, hPos, total, shakerLofi, 0.12, 0.14);
      addHit(tempR, hPos, total, shakerLofi, 0.14, 0.12);
    }
  }

  const out = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempL[i]) * 24000)));
    out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(softClip(tempR[i]) * 24000)));
  }
  return out;
}

// -------------------------------------------------------------------------
// Built-in Calm Lo-Fi Track Playlist
// -------------------------------------------------------------------------
export const BUILTIN_TRACKS = [
  { id: 1, name: "Rainy Tokyo Coffeehouse", genre: "Chillhop & Rhodes (120s)", generate: generateTrack1, pcm: null },
  { id: 2, name: "Midnight Study Sanctuary", genre: "Acoustic Lofi & Bass (120s)", generate: generateTrack2, pcm: null },
  { id: 3, name: "Golden Hour Sakura Garden", genre: "Oriental Zen Lofi (120s)", generate: generateTrack3, pcm: null },
  { id: 4, name: "Lavender Clouds Sunset", genre: "Dreamhop & Kalimba (120s)", generate: generateTrack4, pcm: null },
  { id: 5, name: "Midnight Bookshop & Tea", genre: "Nostalgic Jazzhop (120s)", generate: generateTrack5, pcm: null },
  { id: 6, name: "Starry Night Sleepscape", genre: "Deep Ambient Piano (120s)", generate: generateTrack6, pcm: null },
  { id: 7, name: "Cozy Fireside Solitude", genre: "Warm Acoustic Lofi (120s)", generate: generateTrack7, pcm: null },
  { id: 8, name: "Distant Ocean Memories", genre: "Ethereal Seaside Lofi (120s)", generate: generateTrack8, pcm: null },
  { id: 9, name: "Moonlit Forest Canopy", genre: "Ambient Flute & Chimes (120s)", generate: generateTrack9, pcm: null },
  { id: 10, name: "Midnight Rooftop Breeze", genre: "Jazzy Lo-Fi EP & Bass (120s)", generate: generateTrack10, pcm: null },
  { id: 11, name: "Floating in Aurora", genre: "Ethereal Ambient Synth (120s)", generate: generateTrack11, pcm: null },
  { id: 12, name: "Warm Rainy Window", genre: "Rain & Nylon Guitar (120s)", generate: generateTrack12, pcm: null },
];

export const generators = {
  1: generateTrack1,
  2: generateTrack2,
  3: generateTrack3,
  4: generateTrack4,
  5: generateTrack5,
  6: generateTrack6,
  7: generateTrack7,
  8: generateTrack8,
  9: generateTrack9,
  10: generateTrack10,
  11: generateTrack11,
  12: generateTrack12,
};

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export function getTrackPcm(track) {
  if (!track) return null;
  if (track.pcm) return track.pcm;

  // 1. Check disk cache (loads in 2ms!)
  const cachePath = resolve(`data/audio-cache/track-${track.id}.pcm`);
  if (existsSync(cachePath)) {
    try {
      const buf = readFileSync(cachePath);
      track.pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      console.log(`[audio] loaded Track ${track.id}: "${track.name}" from disk cache in <2ms`);
      return track.pcm;
    } catch (e) {
      console.warn(`[audio] disk cache read error for Track ${track.id}:`, e.message);
    }
  }

  // 2. Non-blocking safeguard: if running in live stream, return Track 1 so event loop NEVER freezes
  if (BUILTIN_TRACKS[0]?.pcm) {
    console.warn(`[audio] Track ${track.id} not in memory; playing Track 1 (zero drop safeguard)`);
    return BUILTIN_TRACKS[0].pcm;
  }

  // 3. Fallback generation (initial startup only)
  if (track.generate) {
    const t0 = performance.now();
    track.pcm = track.generate();
    console.log(`[audio] synthesized 120s track ${track.id}: "${track.name}" in ${(performance.now() - t0).toFixed(0)}ms`);
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
    let queue = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    function next() {
      if (queue.length === 0) {
        worker.terminate();
        console.log("[audio] all background music tracks verified on background worker thread");
        return;
      }
      const nextId = queue.shift();
      const cached = resolve(`data/audio-cache/track-${nextId}.pcm`);
      if (existsSync(cached)) {
        try {
          const track = BUILTIN_TRACKS.find(t => t.id === nextId);
          if (track && !track.pcm) {
            const buf = readFileSync(cached);
            track.pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
          }
        } catch {}
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
          track.pcm = new Int16Array(msg.pcm);
          console.log(`[audio] background worker ready: Track ${track.id} ("${track.name}")`);
          try {
            const cacheDir = resolve("data/audio-cache");
            if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
            writeFileSync(resolve(`data/audio-cache/track-${track.id}.pcm`), Buffer.from(msg.pcm));
          } catch {}
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

  // Pre-load remaining tracks from cache
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
