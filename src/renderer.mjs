import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainThread, Worker } from "node:worker_threads";
import { config } from "./config.mjs";
import { state, stats, getStateSnapshot, getCardLayoutForRank } from "./state.mjs";
import { runtime } from "./runtime.mjs";
import { on } from "./events.mjs";
let frameServerModule = null;
async function getFrameServer() {
  if (!frameServerModule && isMainThread) {
    frameServerModule = await import("./frame-server.mjs");
  }
  return frameServerModule;
}
function publishFrame(frame, rawBuf = null) {
  if (frameServerModule) frameServerModule.publishFrame(frame, rawBuf);
}
function stopFrameServer() {
  if (frameServerModule) frameServerModule.stopFrameServer();
}
function setSnapshotGenerator(fn) {
  if (frameServerModule) frameServerModule.setSnapshotGenerator(fn);
}
function getAudioVisualizerLevels(now = Date.now()) {
  if (frameServerModule) return frameServerModule.getAudioVisualizerLevels(now);
  const t = (now % 4000) / 1000;
  const beat = (t % 0.5) / 0.5;
  const pulse = Math.exp(-beat * 4);
  const levels = [];
  for (let i = 0; i < 8; i++) {
    const bandPhase = (t * (1.2 + i * 0.4) + i * 0.75) % (Math.PI * 2);
    const wave = 0.5 + 0.5 * Math.sin(bandPhase);
    const beatSens = (i < 3) ? pulse * 0.55 : (i < 6) ? pulse * 0.32 : pulse * 0.18;
    const base = 0.22 + 0.42 * wave + beatSens;
    levels.push(Math.max(0.12, Math.min(1.0, base)));
  }
  return levels;
}
function getMusicTrackInfo() {
  if (frameServerModule) return frameServerModule.getMusicTrackInfo();
  return null;
}
import {
  getEvents,
  interactiveState,
  getTopViewers,
  prune,
  tickScreens,
  getScreenTransition,
  screenLabel,
  getSelectedContestant,
  isMenuVisible,
  getActiveConfession,
  getContestantBuff,
  getActiveQuiz,
  getInteractiveSnapshot
} from "./interactive.mjs";
import { LIKE_MAGIC_THEMES } from "./likes-monitor.mjs";

const BASE_W = 1080, BASE_H = 1920;
const W = config.renderWidth, H = config.renderHeight;
const sx = W / BASE_W, sy = H / BASE_H, sc = Math.min(sx, sy);
const px = v => v * sx, py = v => v * sy, ps = v => v * sc;

const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d", { alpha: false });
const oldSceneCanvas = createCanvas(W, H);
const oldCtx = oldSceneCanvas.getContext("2d", { alpha: false });
const newSceneCanvas = createCanvas(W, H);
const newCtx = newSceneCanvas.getContext("2d", { alpha: false });

const SCREEN_ORDER = ["main", "race", "stats", "supporters", "menu", "events"];
let running = false;
let bgImage = null;
let contestantImages = new Map();

const circularAvatarCache = new Map();
function getCircularAvatar(no, img, targetDiam = 56) {
  const sz = Math.max(20, Math.round(ps(targetDiam)));
  const key = `${no}_${sz}`;
  let cached = circularAvatarCache.get(key);
  if (cached) return cached;
  const actualImg = img || contestantImages.get(Number(no));
  if (!actualImg) return null;
  const ac = createCanvas(sz, sz);
  const actx = ac.getContext("2d");
  actx.beginPath();
  actx.arc(sz / 2, sz / 2, sz / 2, 0, Math.PI * 2);
  actx.clip();
  const iw = actualImg.width || 1;
  const ih = actualImg.height || 1;
  const s = Math.max(sz / iw, sz / ih);
  const dw = iw * s, dh = ih * s;
  actx.drawImage(actualImg, (sz - dw) / 2, (sz - dh) / 2, dw, dh);
  circularAvatarCache.set(key, ac);
  return ac;
}

function warmAvatarCache() {
  const sizes = [56, 60, 72, 80, 124];
  for (const [no, img] of contestantImages) {
    for (const sz of sizes) {
      getCircularAvatar(no, img, sz);
    }
  }
}

let lastDraw = Date.now();
let currentFrameDt = 1 / config.renderFps;
let lastFrameAnimTime = 0;
let capturedTransitionKey = "";
const shownVotes = new Map();
const shownRaceVotes = new Map();
const seeded = new Set();
const contestantAnimPositions = new Map();
const raceAnimPositions = new Map();
const overtakeParticles = [];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (k, dt) => 1 - Math.exp(-k * clamp(dt || 0, 0, 0.1));

function getAnimatedVotes(item, now) {
  const votes = item?.votes || 0;
  if (state.chatVoteFlashContestant === item?.no && state.chatVoteFlashAt && (now - state.chatVoteFlashAt < 800)) {
    const p = Math.min(1, Math.max(0, (now - state.chatVoteFlashAt) / 800));
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    return (votes - 1) + 1 * e;
  }
  return votes;
}

// Damped Harmonic Spring Physics Engine (tuned for 30FPS broadcast)
const springStates = new Map();
function spring(key, target, stiffness = 160, damping = 18, dt = null) {
  let s = springStates.get(key);
  if (!s) {
    s = { pos: target, vel: 0 };
    springStates.set(key, s);
    return target;
  }
  const stepDt = dt !== null ? dt : (currentFrameDt || 0.0333);
  const f = -stiffness * (s.pos - target) - damping * s.vel;
  s.vel += f * stepDt;
  s.pos += s.vel * stepDt;
  if (Math.abs(s.pos - target) < 0.005 && Math.abs(s.vel) < 0.01) {
    s.pos = target;
    s.vel = 0;
  }
  return s.pos;
}

function safeWeight(w) {
  if (typeof w === "number") return Math.min(900, Math.max(100, Math.round(w / 100) * 100));
  const str = String(w ?? "").toLowerCase().trim();
  if (str === "bold" || str === "normal") return str;
  const num = parseInt(str, 10);
  if (!isNaN(num)) return Math.min(900, Math.max(100, Math.round(num / 100) * 100));
  return 700;
}

function rr(c, x, y, w, h, r = 14) {
  c.beginPath();
  c.roundRect(px(x), py(y), ps(w), ps(h), ps(r));
}

function text(v, x, y, size, color, weight = 700, align = "left") {
  textC(ctx, v, x, y, size, color, weight, align);
}

// 1. Register bundled universal Latin typeface (Roboto 400/700/900) so Debian,
// Ubuntu, Docker, and Windows always have crisp text without depending on OS-specific fonts.
const BUNDLED_FONTS = [
  { path: fileURLToPath(new URL("../assets/fonts/Roboto-Regular.ttf", import.meta.url)), family: "Roboto" },
  { path: fileURLToPath(new URL("../assets/fonts/Roboto-Bold.ttf", import.meta.url)), family: "Roboto" },
  { path: fileURLToPath(new URL("../assets/fonts/Roboto-Black.ttf", import.meta.url)), family: "Roboto" }
];

// 2. Also register common Linux & Windows system Latin typefaces if present
const SYSTEM_LATIN_FONTS = [
  { path: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", family: "DejaVu Sans" },
  { path: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", family: "DejaVu Sans" },
  { path: "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", family: "Liberation Sans" },
  { path: "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", family: "Liberation Sans" },
  { path: "/usr/share/fonts/truetype/freefont/FreeSans.ttf", family: "FreeSans" },
  { path: "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf", family: "FreeSans" },
  { path: "C:/Windows/Fonts/segoeui.ttf", family: "Segoe UI" },
  { path: "C:/Windows/Fonts/segoeuib.ttf", family: "Segoe UI" }
];

// 3. Register native color emoji typeface for zero-tofu rendering
const EMOJI_FONT_PATHS = [
  "C:/Windows/Fonts/seguiemj.ttf", // Windows 10/11 Segoe UI Emoji
  "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", // Linux Debian / Ubuntu
  "/usr/share/fonts/google-noto-color-emoji/NotoColorEmoji.ttf", // Linux RedHat / Fedora / CentOS
  "/usr/share/fonts/noto/NotoColorEmoji.ttf", // Arch Linux
  "/System/Library/Fonts/Apple Color Emoji.ttc" // macOS
];

export function registerAllFonts() {
  for (const f of BUNDLED_FONTS) {
    try {
      if (existsSync(f.path)) {
        GlobalFonts.registerFromPath(f.path, f.family);
      }
    } catch {}
  }

  // Set universal aliases so ANY font reference (sans-serif, Arial, Segoe UI) resolves to bundled Roboto on Linux VPS
  try {
    GlobalFonts.setAlias("Roboto", "sans-serif");
    GlobalFonts.setAlias("Roboto", "Segoe UI");
    GlobalFonts.setAlias("Roboto", "Arial");
  } catch {}

  for (const f of SYSTEM_LATIN_FONTS) {
    try {
      if (existsSync(f.path)) {
        GlobalFonts.registerFromPath(f.path, f.family);
      }
    } catch {}
  }

  for (const p of EMOJI_FONT_PATHS) {
    try {
      if (existsSync(p)) {
        GlobalFonts.registerFromPath(p, "Segoe UI Emoji");
        break;
      }
    } catch {}
  }
}

registerAllFonts();

const fontCache = new Map();
// Bundled Roboto is prioritized so Debian Linux VPS, Docker, Ubuntu & Windows always render text
const SYSTEM_FONT_FAMILY = 'Roboto, sans-serif';
// Emoji font family includes Segoe UI Emoji / Noto Color Emoji, falling back to Roboto
const EMOJI_FONT_FAMILY = '"Segoe UI Emoji", "Noto Color Emoji", Roboto, sans-serif';
function getFontStr(w, sz) {
  const key = (w << 12) | sz;
  let str = fontCache.get(key);
  if (!str) {
    str = `${w} ${sz}px ${SYSTEM_FONT_FAMILY}`;
    fontCache.set(key, str);
  }
  return str;
}
const emojiFontCache = new Map();
function getEmojiFontStr(sz) {
  let str = emojiFontCache.get(sz);
  if (!str) {
    str = `400 ${sz}px ${EMOJI_FONT_FAMILY}`;
    emojiFontCache.set(sz, str);
  }
  return str;
}
// Draw a single emoji centered at canvas pixel (cpx, cpy) at given pixel size
function drawEmoji(c, emoji, cpx, cpy, sizePx) {
  const f = getEmojiFontStr(Math.max(8, Math.round(sizePx)));
  if (c._curFont !== f) { c.font = f; c._curFont = f; }
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = "#ffffff";
  c.fillText(String(emoji ?? ""), cpx, cpy);
}

function textC(c, v, x, y, size, color, weight = 700, align = "left") {
  const w = safeWeight(weight);
  const sz = Math.max(8, Math.round(ps(size)));
  const f = getFontStr(w, sz);
  if (c._curFont !== f) { c.font = f; c._curFont = f; }
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = "alphabetic";
  c.fillText(String(v ?? ""), px(x), py(y));
}

function fit(v, n) {
  const s = String(v ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function palette(themeName = state.theme) {
  if (themeName === "light") {
    return {
      theme: "light",
      bg: "#f8f9fa",
      bgTop: "#fff8ea",
      bgBot: "#f3f5f8",
      panel: "rgba(255, 255, 255, 0.96)",
      card: "#ffffff",
      cardBorder: "#e2e8f0",
      cardShadow: "rgba(15, 23, 42, 0.08)",
      text: "#0f172a",
      titleText: "#10203b",
      muted: "#64748b",
      line: "#e2e8f0",
      gold: "#d49a18",
      goldBright: "#f59e0b",
      goldMetallic: "#eab308",
      gold3dDark: "#a16207",
      navyPill: "#0b1a30",
      barBg: "#e2e8f0",
      cyan: "#0284c7",
      pink: "#db2777",
      green: "#16a34a",
      red: "#dc2626",
      purple: "#9333ea",
      rankGradients: [
        ["#facc15", "#eab308"], // 1 Gold
        ["#38bdf8", "#0284c7"], // 2 Blue
        ["#f472b6", "#db2777"], // 3 Pink
        ["#4ade80", "#16a34a"], // 4 Green
        ["#c084fc", "#9333ea"], // 5 Purple
        ["#f87171", "#dc2626"]  // 6 Red
      ]
    };
  }
  return {
    theme: "dark",
    bg: "#030712",
    bgTop: "#081325",
    bgBot: "#02050c",
    panel: "rgba(8, 17, 33, 0.96)",
    card: "rgba(10, 20, 38, 0.95)",
    cardBorder: "rgba(148, 163, 184, 0.18)",
    cardShadow: "rgba(0, 0, 0, 0.6)",
    text: "#f8fafc",
    titleText: "#ffffff",
    muted: "#94a3b8",
    line: "rgba(148, 163, 184, 0.2)",
    gold: "#f5c542",
    goldBright: "#fbbf24",
    goldMetallic: "#ffd700",
    gold3dDark: "#b45309",
    navyPill: "#081528",
    barBg: "#17263c",
    cyan: "#38bdf8",
    pink: "#f472b6",
    green: "#4ade80",
    red: "#f87171",
    purple: "#c084fc",
    rankGradients: [
      ["#fbbf24", "#d97706"], // 1 Gold
      ["#38bdf8", "#0284c7"], // 2 Blue
      ["#f472b6", "#db2777"], // 3 Pink
      ["#4ade80", "#16a34a"], // 4 Green
      ["#c084fc", "#9333ea"], // 5 Purple
      ["#f87171", "#dc2626"]  // 6 Red
    ]
  };
}

let bgDarkCanvas = null;
let bgLightCanvas = null;

function buildPreRenderedBackdrop(theme) {
  const p = palette(theme);
  const cv = createCanvas(W, H);
  const cx = cv.getContext("2d", { alpha: false });

  cx.fillStyle = p.bg;
  cx.fillRect(0, 0, W, H);

  // Gradient backdrop
  const grad = cx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, p.bgTop);
  grad.addColorStop(0.45, p.bg);
  grad.addColorStop(1, p.bgBot);
  cx.fillStyle = grad;
  cx.fillRect(0, 0, W, H);

  // Background photo pre-scaled and pre-composited
  if (bgImage) {
    const s = Math.max(W / bgImage.width, H / bgImage.height);
    const dw = bgImage.width * s, dh = bgImage.height * s;
    cx.save();
    cx.globalAlpha = theme === "light" ? 0.08 : 0.20;
    cx.drawImage(bgImage, (W - dw) / 2, (H - dh) / 2, dw, dh);
    cx.restore();
  }

  // Radiant golden glow behind top/hero
  const rad = cx.createRadialGradient(px(540), py(210), ps(20), px(540), py(210), ps(550));
  if (theme === "light") {
    rad.addColorStop(0, "rgba(251, 191, 36, 0.25)");
    rad.addColorStop(0.5, "rgba(245, 158, 11, 0.08)");
    rad.addColorStop(1, "rgba(0, 0, 0, 0)");
  } else {
    rad.addColorStop(0, "rgba(245, 197, 66, 0.22)");
    rad.addColorStop(0.5, "rgba(217, 119, 6, 0.08)");
    rad.addColorStop(1, "rgba(0, 0, 0, 0)");
  }
  cx.fillStyle = rad;
  cx.fillRect(0, 0, W, py(700));

  return cv;
}

async function loadBackground() {
  for (const path of [config.backgroundImage, "assets/bb20_bg.jpg"].filter(Boolean)) {
    try {
      bgImage = await loadImage(await readFile(path));
      break;
    } catch {}
  }
  bgDarkCanvas = buildPreRenderedBackdrop("dark");
  bgLightCanvas = buildPreRenderedBackdrop("light");
}

export function setContestantImages(m) {
  contestantImages = m;
  circularAvatarCache.clear();
  warmAvatarCache();
}

let mandalaCanvas = null;
function buildMandalaCanvas() {
  const sz = 300;
  const cv = createCanvas(sz, sz);
  const cx = cv.getContext("2d");
  cx.translate(sz / 2, sz / 2);

  cx.strokeStyle = "rgba(251, 191, 36, 0.24)";
  cx.lineWidth = 1.3;
  cx.beginPath();
  for (let mi = 0; mi < 12; mi++) {
    const ma = (mi * Math.PI) / 6;
    cx.moveTo(Math.cos(ma) * 55 + 55, Math.sin(ma) * 55);
    cx.arc(Math.cos(ma) * 55, Math.sin(ma) * 55, 55, 0, Math.PI * 2);
  }
  cx.stroke();

  cx.strokeStyle = "rgba(56, 189, 248, 0.22)";
  cx.lineWidth = 1.2;
  cx.beginPath();
  cx.arc(0, 0, 130, 0, Math.PI * 2);
  cx.stroke();

  cx.fillStyle = "#fbbf24";
  cx.beginPath();
  for (let si = 0; si < 20; si++) {
    const sa = (si * Math.PI) / 10;
    const sr = 130;
    const sSize = (si % 2 === 0) ? 2.4 : 1.3;
    cx.moveTo(Math.cos(sa) * sr + sSize, Math.sin(sa) * sr);
    cx.arc(Math.cos(sa) * sr, Math.sin(sa) * sr, sSize, 0, Math.PI * 2);
  }
  cx.fill();
  return cv;
}

function drawBackground(c, p, now) {
  const bg = p.theme === "light" ? bgLightCanvas : bgDarkCanvas;
  if (bg) {
    c.drawImage(bg, 0, 0);
  } else {
    c.fillStyle = p.bg;
    c.fillRect(0, 0, W, H);
  }

  // Floating ambient bokeh orbs
  for (let i = 0; i < 3; i++) {
    const bx = (i * 357 + Math.sin(now * 0.0004 + i) * 60) % 1080;
    const by = (i * 411 + Math.cos(now * 0.0003 + i) * 70 + 400) % 1400;
    const bRad = ps(20 + i * 8);
    const bAlpha = 0.04 + 0.03 * Math.sin(now * 0.001 + i);
    c.fillStyle = p.theme === "light" ? `rgba(245, 158, 11, ${bAlpha})` : `rgba(251, 191, 36, ${bAlpha})`;
    c.beginPath();
    c.arc(px(bx), py(by), bRad, 0, Math.PI * 2);
    c.fill();
  }

  // Cinematic rising golden stardust & ember particle field (24 ambient particles)
  c.save();
  c.fillStyle = p.theme === "light" ? "#d97706" : "#fde68a";
  c.beginPath();
  for (let i = 0; i < 24; i++) {
    const seed = i * 137.5;
    const speed = 18 + (i % 5) * 12;
    const pX = (seed * 19 + Math.sin(now * 0.0008 + i) * 35) % 1080;
    const pY = 1920 - ((now * 0.001 * speed + seed * 23) % 1920);
    const pSize = ps(1.8 + (i % 4) * 0.9);
    c.moveTo(px(pX) + pSize, py(pY));
    c.arc(px(pX), py(pY), pSize, 0, Math.PI * 2);
  }
  c.fill();
  c.restore();
}

function drawTopBar(c, p, now) {
  const y = 24, h = 52;

  // 1. Pulsing glow behind LIVE pill
  const livePulse = 0.5 + 0.5 * Math.sin(now * 0.006);
  c.fillStyle = "#ef233c";
  rr(c, 44, y, 145, h, h / 2);
  c.fill();
  c.strokeStyle = `rgba(239, 35, 60, ${0.3 + 0.5 * livePulse})`;
  c.lineWidth = ps(2 + livePulse * 2);
  rr(c, 44, y, 145, h, h / 2);
  c.stroke();

  // Play triangle
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.moveTo(px(64), py(y + 16));
  c.lineTo(px(64), py(y + 36));
  c.lineTo(px(82), py(y + 26));
  c.closePath();
  c.fill();
  textC(c, "LIVE", 88, y + 34, 21, "#ffffff", 800);

  // Expanding dual live broadcast radar rings
  const radarPhase1 = (now * 0.0012) % 1;
  const radarPhase2 = (now * 0.0012 + 0.5) % 1;
  c.save();
  c.beginPath();
  c.arc(px(73), py(y + 26), ps(16 + radarPhase1 * 24), 0, Math.PI * 2);
  c.strokeStyle = `rgba(239, 35, 60, ${Math.max(0, 0.55 * (1 - radarPhase1))})`;
  c.lineWidth = ps(1.8);
  c.stroke();

  c.beginPath();
  c.arc(px(73), py(y + 26), ps(16 + radarPhase2 * 24), 0, Math.PI * 2);
  c.strokeStyle = `rgba(239, 35, 60, ${Math.max(0, 0.45 * (1 - radarPhase2))})`;
  c.lineWidth = ps(1.4);
  c.stroke();
  c.restore();

  // Stream Duration counter next to LIVE logo
  const uptime = Math.max(0, Math.floor((now - runtime.startedAt) / 1000));
  const hh = String(Math.floor(uptime / 3600)).padStart(2, "0");
  const mm = String(Math.floor(uptime / 60) % 60).padStart(2, "0");
  const ss = String(uptime % 60).padStart(2, "0");
  textC(c, `${hh}:${mm}:${ss}`, 202, y + 34, 22, p.text, 700);

  // 2. Telemetry metrics placed directly UNDER LIVE LOGO (Watching, Views, Subs)
  const rawViewers = runtime.chat.viewerCount;
  const viewersCount = (typeof rawViewers === "number" && rawViewers >= 0) ? rawViewers : 0;
  const countStr = viewersCount >= 1000000
    ? `${(viewersCount / 1000000).toFixed(1)}M`
    : viewersCount >= 1000
    ? `${(viewersCount / 1000).toFixed(1)}K`
    : String(viewersCount);

  const rawViews = (runtime.chat.viewCount !== undefined && runtime.chat.viewCount !== null && runtime.chat.viewCount >= 0)
    ? runtime.chat.viewCount
    : (state.totalViews || 0);
  const viewsCount = rawViews;
  const viewsStr = viewsCount >= 1000000
    ? `${(viewsCount / 1000000).toFixed(1)}M`
    : viewsCount >= 1000
    ? `${(viewsCount / 1000).toFixed(1)}K`
    : Number(viewsCount).toLocaleString();

  const rawSubs = runtime.chat?.subscriberCount || state?.subscriberCount || (process.env.SUBSCRIBER_COUNT ? Number(process.env.SUBSCRIBER_COUNT) : 54925);
  const subsCount = (typeof rawSubs === "number" && rawSubs > 0) ? rawSubs : 54925;
  const subsFormatted = subsCount >= 1000000
    ? `${(subsCount / 1000000).toFixed(2)}M`
    : subsCount >= 10000
    ? `${(subsCount / 1000).toFixed(1)}K`
    : subsCount >= 1000
    ? `${(subsCount / 1000).toFixed(2)}K`
    : Number(subsCount).toLocaleString();

  const pillX = 44, pillW = 188, pillH = 34, pillR = pillH / 2;
  const pill1Y = 82;
  const pill2Y = 122;
  const pill3Y = 162;
  const pill4Y = 202;

  // Batch fill all 4 telemetry pill backgrounds in a single Skia draw call
  c.fillStyle = p.theme === "light" ? "rgba(255, 255, 255, 0.94)" : "rgba(10, 20, 38, 0.92)";
  c.beginPath();
  c.roundRect(px(pillX), py(pill1Y), ps(pillW), ps(pillH), ps(pillR));
  c.roundRect(px(pillX), py(pill2Y), ps(pillW), ps(pillH), ps(pillR));
  c.roundRect(px(pillX), py(pill3Y), ps(pillW), ps(pillH), ps(pillR));
  c.roundRect(px(pillX), py(pill4Y), ps(pillW), ps(pillH), ps(pillR));
  c.fill();

  // Row A: LIVE VIEWERS / WATCHING (under LIVE logo at Y = 82)
  c.strokeStyle = p.theme === "light" ? "#38bdf8" : "rgba(56, 189, 248, 0.55)";
  c.lineWidth = ps(1.5);
  rr(c, pillX, pill1Y, pillW, pillH, pillR);
  c.stroke();

  // Pulsing green beacon dot
  const beaconPulse = 0.5 + 0.5 * Math.sin(now * 0.008);
  c.fillStyle = "#22c55e";
  c.beginPath();
  c.arc(px(pillX + 18), py(pill1Y + pillH / 2), ps(3.5 + beaconPulse * 1.5), 0, Math.PI * 2);
  c.fill();
  textC(c, `${countStr} Watching`, pillX + 32, pill1Y + 23, 15.5, p.cyan, 800);

  // Row B: TOTAL VIEWS (under Watching at Y = 122)
  c.strokeStyle = p.theme === "light" ? "#f87171" : "rgba(239, 68, 68, 0.55)";
  c.lineWidth = ps(1.5);
  rr(c, pillX, pill2Y, pillW, pillH, pillR);
  c.stroke();

  // Red play badge
  c.fillStyle = "#ef4444";
  rr(c, pillX + 9, pill2Y + 8, 18, 18, 4);
  c.fill();
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.moveTo(px(pillX + 15), py(pill2Y + 12));
  c.lineTo(px(pillX + 15), py(pill2Y + 22));
  c.lineTo(px(pillX + 23), py(pill2Y + 17));
  c.closePath();
  c.fill();
  textC(c, `${viewsStr} Views`, pillX + 32, pill2Y + 23, 15.5, "#ef4444", 800);

  // Row C: SUBSCRIBERS (under Views at Y = 162)
  c.strokeStyle = p.theme === "light" ? "#f59e0b" : "rgba(245, 197, 66, 0.55)";
  c.lineWidth = ps(1.5);
  rr(c, pillX, pill3Y, pillW, pillH, pillR);
  c.stroke();

  // Red YouTube pill + play triangle
  c.fillStyle = "#ff0000";
  rr(c, pillX + 8, pill3Y + 8, 20, 18, 4);
  c.fill();
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.moveTo(px(pillX + 14), py(pill3Y + 12));
  c.lineTo(px(pillX + 14), py(pill3Y + 22));
  c.lineTo(px(pillX + 22), py(pill3Y + 17));
  c.closePath();
  c.fill();
  textC(c, `${subsFormatted} Subs`, pillX + 32, pill3Y + 23, 15.5, p.goldBright, 800);

  // Row D: LIKES (under Subs at Y = 202)
  const rawLikes = (state.liveLikes !== undefined && state.liveLikes !== null && state.liveLikes >= 0)
    ? state.liveLikes
    : (runtime.chat?.likeCount || 0);
  const likesFormatted = rawLikes >= 1000000
    ? `${(rawLikes / 1000000).toFixed(1)}M`
    : rawLikes >= 1000
    ? `${(rawLikes / 1000).toFixed(1)}K`
    : Number(rawLikes).toLocaleString();

  c.strokeStyle = p.theme === "light" ? "#ec4899" : "rgba(236, 72, 153, 0.65)";
  c.lineWidth = ps(1.5);
  rr(c, pillX, pill4Y, pillW, pillH, pillR);
  c.stroke();

  // Pulsing neon pink heart
  const heartBeat = 1 + 0.15 * Math.sin(now * 0.012);
  c.save();
  c.translate(px(pillX + 18), py(pill4Y + pillH / 2));
  c.scale(heartBeat, heartBeat);
  drawEmoji(c, "💖", 0, 0, ps(17));
  c.restore();
  textC(c, `${likesFormatted} Likes`, pillX + 34, pill4Y + 23, 15.5, "#ec4899", 800);

  // --- 1. ANIMATED SUBSCRIBE BUTTON ARROW CARD (Points directly to YouTube's native Subscribe button) ---
  const subCardX = 720, subCardY = 142, subCardW = 320, subCardH = 64, subCardR = 14;
  const subBounce = Math.sin(now * 0.008) * 4;
  const arrowX = 785; // Aligns directly with center of YouTube's native Subscribe button
  const arrowTipY = 82 + subBounce;

  c.save();
  // Upward radiating sonar wave beams targeting YouTube's Subscribe button
  for (let w = 0; w < 3; w++) {
    const wavePhase = ((now * 0.0024 + w * 0.33) % 1);
    const waveY = arrowTipY - 4 - wavePhase * 18;
    const waveAlpha = (1 - wavePhase) * 0.9;
    const waveW = 16 + wavePhase * 24;
    c.strokeStyle = `rgba(239, 68, 68, ${waveAlpha})`;
    c.lineWidth = ps(2.2);
    c.beginPath();
    c.arc(px(arrowX), py(waveY), ps(waveW / 2), Math.PI * 1.15, Math.PI * 1.85);
    c.stroke();
  }

  // Dark shield backdrop behind arrow for extreme contrast
  c.fillStyle = "rgba(10, 16, 32, 0.92)";
  c.beginPath();
  c.arc(px(arrowX), py(arrowTipY + 13), ps(18), 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "rgba(251, 191, 36, 0.6)";
  c.lineWidth = ps(1.5);
  c.stroke();

  // Upward Pointing 3D Neon Arrow Head + Stem (crisp, elegant proportions)
  const arrowW = 16, arrowHeadH = 16, stemW = 8, stemH = 10;
  c.beginPath();
  c.moveTo(px(arrowX), py(arrowTipY)); // Top point
  c.lineTo(px(arrowX - arrowW), py(arrowTipY + arrowHeadH)); // Left wing
  c.lineTo(px(arrowX - stemW / 2), py(arrowTipY + arrowHeadH - 2)); // Left inner notch
  c.lineTo(px(arrowX - stemW / 2), py(arrowTipY + arrowHeadH + stemH)); // Left stem base
  c.lineTo(px(arrowX + stemW / 2), py(arrowTipY + arrowHeadH + stemH)); // Right stem base
  c.lineTo(px(arrowX + stemW / 2), py(arrowTipY + arrowHeadH - 2)); // Right inner notch
  c.lineTo(px(arrowX + arrowW), py(arrowTipY + arrowHeadH)); // Right wing
  c.closePath();

  // Outer radiant red/gold aura
  const arrowPulse = 0.5 + 0.5 * Math.sin(now * 0.01);
  c.strokeStyle = `rgba(255, 0, 0, ${0.5 + 0.45 * arrowPulse})`;
  c.lineWidth = ps(5 + arrowPulse * 2.5);
  c.stroke();

  // Arrow gradient fill (White tip to YouTube Red to Gold Glow)
  const arrowGrad = c.createLinearGradient(px(arrowX), py(arrowTipY), px(arrowX), py(arrowTipY + arrowHeadH + stemH));
  arrowGrad.addColorStop(0, "#ffffff");
  arrowGrad.addColorStop(0.25, "#ff0000");
  arrowGrad.addColorStop(0.75, "#f59e0b");
  arrowGrad.addColorStop(1, "#fbbf24");
  c.fillStyle = arrowGrad;
  c.fill();

  c.strokeStyle = "#ffffff";
  c.lineWidth = ps(1.8);
  c.stroke();
  drawMagicSparkle(c, arrowX, arrowTipY - 2, 6.5, now, "#ffffff");

  // Premium Dark Glass Card Base (positioned with generous breathing distance below the arrow)
  c.fillStyle = "rgba(10, 16, 32, 0.96)";
  rr(c, subCardX, subCardY, subCardW, subCardH, subCardR);
  c.fill();

  const subCardBg = c.createLinearGradient(px(subCardX), 0, px(subCardX + subCardW), 0);
  subCardBg.addColorStop(0, "rgba(239, 68, 68, 0.32)");
  subCardBg.addColorStop(0.5, "rgba(245, 158, 11, 0.25)");
  subCardBg.addColorStop(1, "rgba(239, 68, 68, 0.28)");
  c.fillStyle = subCardBg;
  rr(c, subCardX, subCardY, subCardW, subCardH, subCardR);
  c.fill();

  // Animated gradient border
  const subBorder = c.createLinearGradient(px(subCardX), 0, px(subCardX + subCardW), 0);
  subBorder.addColorStop(0, "#ff0000");
  subBorder.addColorStop(0.5, "#fbbf24");
  subBorder.addColorStop(1, "#ff0000");
  c.strokeStyle = subBorder;
  c.lineWidth = ps(1.8);
  rr(c, subCardX, subCardY, subCardW, subCardH, subCardR);
  c.stroke();

  // Swinging Bell Icon + Text
  const bellSwing = Math.sin(now * 0.012) * 0.18;
  c.save();
  c.translate(px(subCardX + 22), py(subCardY + 24));
  c.rotate(bellSwing);
  drawEmoji(c, "🔔", 0, 0, ps(17));
  c.restore();

  textC(c, "TAP TO SUBSCRIBE", subCardX + 44, subCardY + 27, 14.5, "#ffffff", 950);
  drawEmoji(c, "👆", px(subCardX + subCardW - 22), py(subCardY + 24), ps(16));
  textC(c, "Support your favorite contestant!", subCardX + 44, subCardY + 49, 11.5, "#fbbf24", 800);
  drawMagicSparkle(c, subCardX + subCardW - 14, subCardY + 49, 6, now, "#fbbf24");
  c.restore();

  // --- 2. UPGRADED HIGH-IMPACT "DOUBLE TAP FOR MAGIC ✨" BUTTON (Top Right Y = 218) ---
  const isDtHighlighted = Boolean(state.highlightDoubleTapUntil && now < state.highlightDoubleTapUntil);
  const dtW = 320, dtH = 38, dtR = dtH / 2;
  const dtX = 720, dtY = 218;
  const dtPulse = 0.5 + 0.5 * Math.sin(now * (isDtHighlighted ? 0.024 : 0.009));

  c.save();
  if (isDtHighlighted) {
    const scalePop = 1.0 + 0.04 * Math.sin(now * 0.02);
    c.translate(px(dtX + dtW / 2), py(dtY + dtH / 2));
    c.scale(scalePop, scalePop);
    c.translate(-px(dtX + dtW / 2), -py(dtY + dtH / 2));

    // Outer Electric Golden Radiance
    c.strokeStyle = `rgba(251, 191, 36, ${0.55 + 0.45 * dtPulse})`;
    c.lineWidth = ps(7 + dtPulse * 5);
    rr(c, dtX - 3, dtY - 3, dtW + 6, dtH + 6, dtR + 3);
    c.stroke();
  } else {
    // Normal rich neon aura (prevents dull/washed out look)
    c.strokeStyle = `rgba(236, 72, 153, ${0.35 + 0.3 * dtPulse})`;
    c.lineWidth = ps(4 + dtPulse * 3);
    rr(c, dtX - 2, dtY - 2, dtW + 4, dtH + 4, dtR + 2);
    c.stroke();
  }

  // Deep High-Contrast Cosmic Glass Base (ensures 100% readability over any background)
  c.fillStyle = "rgba(18, 10, 32, 0.96)";
  rr(c, dtX, dtY, dtW, dtH, dtR);
  c.fill();

  // Rich Inner Vibrant Neon Gradient
  const dtBg = c.createLinearGradient(px(dtX), 0, px(dtX + dtW), 0);
  if (isDtHighlighted) {
    dtBg.addColorStop(0, "rgba(255, 0, 127, 0.95)");
    dtBg.addColorStop(0.35, "rgba(245, 158, 11, 0.95)");
    dtBg.addColorStop(0.7, "rgba(236, 72, 153, 0.95)");
    dtBg.addColorStop(1, "rgba(139, 92, 246, 0.95)");
  } else {
    dtBg.addColorStop(0, "rgba(236, 72, 153, 0.65)");
    dtBg.addColorStop(0.5, "rgba(245, 158, 11, 0.55)");
    dtBg.addColorStop(1, "rgba(56, 189, 248, 0.55)");
  }
  c.fillStyle = dtBg;
  rr(c, dtX, dtY, dtW, dtH, dtR);
  c.fill();

  // Multi-Color Cycling Animated Neon Border
  const dtBorder = c.createLinearGradient(px(dtX), 0, px(dtX + dtW), 0);
  dtBorder.addColorStop(0, isDtHighlighted ? "#ffffff" : "#ec4899");
  dtBorder.addColorStop(0.5, "#fbbf24");
  dtBorder.addColorStop(1, isDtHighlighted ? "#ffffff" : "#38bdf8");
  c.strokeStyle = dtBorder;
  c.lineWidth = ps(isDtHighlighted ? 3.0 : 2.2 + dtPulse * 0.8);
  rr(c, dtX, dtY, dtW, dtH, dtR);
  c.stroke();

  // Interactive Double Tap Gesture (Tapping rhythm + ripple pulse)
  const tapPhase = (now * 0.005) % 1;
  const isTapDown = (tapPhase < 0.18) || (tapPhase > 0.28 && tapPhase < 0.46);
  const dtTapY = isTapDown ? -3 : 0;

  // Expanding click ripple circle from fingertip
  if (tapPhase < 0.6) {
    const ripR = (tapPhase / 0.6) * 14;
    const ripAlpha = (1 - tapPhase / 0.6) * 0.75;
    c.strokeStyle = `rgba(255, 255, 255, ${ripAlpha})`;
    c.lineWidth = ps(1.5);
    c.beginPath();
    c.arc(px(dtX + 22), py(dtY + dtH / 2 - 4), ps(ripR), 0, Math.PI * 2);
    c.stroke();
  }

  drawEmoji(c, isDtHighlighted ? "👉" : "👆", px(dtX + 22), py(dtY + dtH / 2 + dtTapY), ps(isDtHighlighted ? 20 : 18));

  // Ultra-Crisp High-Legibility Title (No raw emoji in textC string to avoid glyph boxes)
  const dtText = "DOUBLE TAP FOR MAGIC";
  const dtTextColor = isDtHighlighted ? "#ffffff" : "#ffffff";
  textC(c, dtText, dtX + 44, dtY + 25, isDtHighlighted ? 15 : 14.5, dtTextColor, 950);

  // Twinkling Magic Sparkles (Using canvas diamond graphics for crisp stars)
  drawMagicSparkle(c, dtX + dtW - 16, dtY + dtH / 2, isDtHighlighted ? 11 : 8, now, isDtHighlighted ? "#ffffff" : "#fbbf24");
  drawMagicSparkle(c, dtX + dtW - 32, dtY + 12, isDtHighlighted ? 8 : 6, now + 350, "#fde047");
  if (isDtHighlighted) {
    drawMagicSparkle(c, dtX + 38, dtY + 10, 8, now + 600, "#ffffff");
  }
  c.restore();

  // 3. Studio EQ Visualizer + ON AIR on Top-Right (X = 870, Y = y)
  const eqX = 870, eqY = y + 36;
  const eqColors = [p.cyan, "#38bdf8", p.goldBright, "#f59e0b", p.pink, "#ec4899", p.goldBright, p.cyan];
  const visLevels = getAudioVisualizerLevels(now);
  for (let i = 0; i < 8; i++) {
    const rawTarget = visLevels[i] || 0.25;
    const smoothLvl = spring(`eq_band_${i}`, rawTarget, 160, 16);
    const bh = 5 + smoothLvl * 24;
    c.fillStyle = eqColors[i];
    rr(c, eqX + i * 8, eqY - bh, 5, bh, 2.5);
    c.fill();
  }
  const onAirPulse = 0.5 + 0.5 * Math.sin(now * 0.005);
  c.save();
  c.fillStyle = "#ef4444";
  c.beginPath();
  c.arc(px(eqX + 78), py(y + 26), ps(3.5 + onAirPulse * 1.5), 0, Math.PI * 2);
  c.fill();
  c.fillStyle = p.goldBright;
  c.globalAlpha = 0.8 + 0.2 * onAirPulse;
  textC(c, "ON AIR", eqX + 88, y + 32, 14, p.goldBright, 800);
  c.restore();
}

function drawEye(c, p, cx, cy, scale = 1, now = Date.now()) {
  c.save();
  c.translate(px(cx), py(cy));
  c.scale(sc * scale, sc * scale);

  const pulse = 1 + Math.sin(now * 0.003) * 0.025;
  c.scale(pulse, pulse);

  // 60FPS natural breathing and eyelid blink physics
  const blinkCycle = (now * 0.00022) % 1;
  const isBlink = blinkCycle > 0.965;
  const blinkRatio = isBlink ? Math.sin(((blinkCycle - 0.965) / 0.035) * Math.PI) : 0;
  const eyeSquishY = 1 - blinkRatio * 0.90;
  c.scale(1, eyeSquishY);

  // Rotating sci-fi cyber HUD tech rings around eye
  c.save();
  // Outer tech ring (counter-clockwise)
  c.strokeStyle = "rgba(245, 197, 66, 0.28)";
  c.lineWidth = 1.8;
  c.setLineDash([12, 10, 4, 10]);
  c.beginPath();
  c.arc(0, 0, 126, -now * 0.0007, -now * 0.0007 + Math.PI * 2);
  c.stroke();

  // Inner tech ring (clockwise)
  c.strokeStyle = "rgba(56, 189, 248, 0.32)";
  c.lineWidth = 1.5;
  c.setLineDash([8, 8]);
  c.beginPath();
  c.arc(0, 0, 105, now * 0.0011, now * 0.0011 + Math.PI * 2);
  c.stroke();
  c.setLineDash([]);

  // 4 Corner holographic target brackets [ + ]
  const brDist = 125, brLen = 12;
  c.strokeStyle = "rgba(245, 197, 66, 0.45)";
  c.lineWidth = 2;
  // Top-left
  c.beginPath(); c.moveTo(-brDist, -brDist + brLen); c.lineTo(-brDist, -brDist); c.lineTo(-brDist + brLen, -brDist); c.stroke();
  // Top-right
  c.beginPath(); c.moveTo(brDist - brLen, -brDist); c.lineTo(brDist, -brDist); c.lineTo(brDist, -brDist + brLen); c.stroke();
  // Bottom-left
  c.beginPath(); c.moveTo(-brDist, brDist - brLen); c.lineTo(-brDist, brDist); c.lineTo(-brDist + brLen, brDist); c.stroke();
  // Bottom-right
  c.beginPath(); c.moveTo(brDist - brLen, brDist); c.lineTo(brDist, brDist); c.lineTo(brDist, brDist - brLen); c.stroke();
  c.restore();

  // Sacred Solar Geometry Mandala & Celestial Astrolabe Rings
  c.save();
  const mandalaRot = now * 0.00035;
  c.rotate(mandalaRot);
  if (!mandalaCanvas) mandalaCanvas = buildMandalaCanvas();
  c.drawImage(mandalaCanvas, -150, -150);
  c.restore();

  // Outer glowing aura
  const aura = c.createRadialGradient(0, 0, 30, 0, 0, 132);
  aura.addColorStop(0, "rgba(245, 197, 66, 0.35)");
  aura.addColorStop(1, "rgba(0, 0, 0, 0)");
  c.fillStyle = aura;
  c.beginPath();
  c.arc(0, 0, 132, 0, Math.PI * 2);
  c.fill();

  // Outer golden eyelid shape
  c.beginPath();
  c.moveTo(-160, 0);
  c.quadraticCurveTo(0, -115, 160, 0);
  c.quadraticCurveTo(0, 115, -160, 0);
  c.closePath();
  c.strokeStyle = p.goldBright;
  c.lineWidth = 10;
  c.stroke();

  // Secondary inner eyelid ring
  c.beginPath();
  c.moveTo(-138, 0);
  c.quadraticCurveTo(0, -90, 138, 0);
  c.quadraticCurveTo(0, 90, -138, 0);
  c.closePath();
  c.strokeStyle = p.gold3dDark;
  c.lineWidth = 4;
  c.stroke();

  // Golden eyelash rays radiating outwards
  c.strokeStyle = p.goldBright;
  c.lineWidth = 3.5;
  c.beginPath();
  for (let a = -70; a <= 70; a += 14) {
    const rad = (a * Math.PI) / 180;
    const lenTop = 18 + Math.cos(rad) * 12;
    const x0 = Math.sin(rad) * 135;
    const y0 = -Math.cos(rad) * 80;
    c.moveTo(x0, y0);
    c.lineTo(x0 * 1.15, y0 - lenTop);
  }
  c.stroke();

  // Sentient Bigg Boss scanning eye gaze (autonomous 3D parallax tracking)
  const gazeX = Math.sin(now * 0.0012) * 8.5;
  const gazeY = Math.cos(now * 0.0017) * 4.2;

  // Iris circle with subtle gaze shift
  c.beginPath();
  c.arc(gazeX * 0.35, gazeY * 0.35, 68, 0, Math.PI * 2);
  const irisGrad = c.createRadialGradient(-10 + gazeX * 0.35, -10 + gazeY * 0.35, 4, gazeX * 0.35, gazeY * 0.35, 70);
  irisGrad.addColorStop(0, "#a5f3fc");
  irisGrad.addColorStop(0.25, "#38bdf8");
  irisGrad.addColorStop(0.65, "#0284c7");
  irisGrad.addColorStop(1, "#082f49");
  c.fillStyle = irisGrad;
  c.fill();
  c.strokeStyle = p.goldMetallic;
  c.lineWidth = 6;
  c.stroke();

  // Geometric radial lines inside iris with parallax shift
  c.strokeStyle = "rgba(255, 255, 255, 0.35)";
  c.lineWidth = 1.5;
  c.beginPath();
  for (let i = 0; i < 16; i++) {
    const ang = (i * Math.PI) / 8;
    c.moveTo(gazeX * 0.35 + Math.cos(ang) * 22, gazeY * 0.35 + Math.sin(ang) * 22);
    c.lineTo(gazeX * 0.35 + Math.cos(ang) * 64, gazeY * 0.35 + Math.sin(ang) * 64);
  }
  c.stroke();

  // Sweeping holographic biometric retina laser scan
  const scanPhase = (now * 0.0009) % 1;
  const scanY = -70 + scanPhase * 140;
  const scanAlpha = Math.sin(scanPhase * Math.PI);
  if (scanAlpha > 0.05) {
    c.save();
    c.beginPath();
    c.arc(gazeX * 0.35, gazeY * 0.35, 68, 0, Math.PI * 2);
    c.clip();
    const scanGrad = c.createLinearGradient(0, scanY - 6, 0, scanY + 6);
    scanGrad.addColorStop(0, "rgba(56, 189, 248, 0)");
    scanGrad.addColorStop(0.5, `rgba(56, 189, 248, ${0.85 * scanAlpha})`);
    scanGrad.addColorStop(1, "rgba(56, 189, 248, 0)");
    c.fillStyle = scanGrad;
    c.fillRect(-70, scanY - 6, 140, 12);

    // Intense laser core line
    c.strokeStyle = `rgba(255, 255, 255, ${0.95 * scanAlpha})`;
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(-65, scanY);
    c.lineTo(65, scanY);
    c.stroke();
    c.restore();
  }

  // Dynamic pupil dilation reacting to sound energy and chat votes
  const visLevels = getAudioVisualizerLevels(now);
  const audioEnergy = visLevels.reduce((a, b) => a + b, 0) / 8;
  const targetPupilR = 23 + audioEnergy * 7;
  const pupilR = spring("eye_pupil_r", targetPupilR, 140, 15);

  // Audio-reactive radiating cyber energy pulse waves
  if (audioEnergy > 0.12) {
    const waveProgress = ((now * 0.0012) % 1);
    c.strokeStyle = `rgba(245, 197, 66, ${(1 - waveProgress) * 0.35 * audioEnergy})`;
    c.lineWidth = 1.6;
    c.beginPath();
    c.arc(0, 0, 95 + waveProgress * 42, 0, Math.PI * 2);
    c.stroke();
  }

  // Dark pupil with gaze tracking
  c.beginPath();
  c.arc(gazeX, gazeY, pupilR, 0, Math.PI * 2);
  c.fillStyle = "#020617";
  c.fill();

  // Central golden starburst inside pupil with dynamic rotation
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI) / 4 + now * 0.0018;
    c.beginPath();
    c.moveTo(gazeX, gazeY);
    c.lineTo(gazeX + Math.cos(ang) * 16, gazeY + Math.sin(ang) * 16);
    c.strokeStyle = "#fbbf24";
    c.lineWidth = 2.5;
    c.stroke();
  }

  // Specular light reflection glint with subtle micro-bob
  const glintBob = Math.sin(now * 0.003) * 1.5;
  c.beginPath();
  c.arc(gazeX - 14 + glintBob, gazeY - 14 - glintBob, 9, 0, Math.PI * 2);
  c.fillStyle = "rgba(255, 255, 255, 0.92)";
  c.fill();

  // Lateral ocular corner energy flares
  const flarePulse = 0.5 + 0.5 * Math.sin(now * 0.004);
  c.fillStyle = `rgba(245, 197, 66, ${0.65 * flarePulse})`;
  c.beginPath();
  c.arc(-160, 0, 5 + flarePulse * 2, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.arc(160, 0, 5 + flarePulse * 2, 0, Math.PI * 2);
  c.fill();

  c.restore();
}

const sparkleSprites = new Map();
function getSparkleSprite(col) {
  const key = String(col || "#ffffff").toLowerCase();
  let s = sparkleSprites.get(key);
  if (s) return s;
  const spCanvas = createCanvas(64, 64);
  const sctx = spCanvas.getContext("2d");
  const sGrad = sctx.createRadialGradient(32, 32, 2, 32, 32, 28);
  sGrad.addColorStop(0, "#ffffff");
  sGrad.addColorStop(0.35, key.startsWith("#") ? key + "88" : "rgba(255, 255, 255, 0.45)");
  sGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  sctx.fillStyle = sGrad;
  sctx.beginPath();
  sctx.arc(32, 32, 28, 0, Math.PI * 2);
  sctx.fill();

  sctx.fillStyle = key;
  sctx.beginPath();
  sctx.moveTo(32, 4);
  sctx.quadraticCurveTo(32, 32, 44, 32);
  sctx.quadraticCurveTo(32, 32, 32, 60);
  sctx.quadraticCurveTo(32, 32, 20, 32);
  sctx.quadraticCurveTo(32, 32, 32, 4);
  sctx.fill();

  sctx.beginPath();
  sctx.moveTo(4, 32);
  sctx.quadraticCurveTo(32, 32, 32, 44);
  sctx.quadraticCurveTo(32, 32, 60, 32);
  sctx.quadraticCurveTo(32, 32, 32, 20);
  sctx.quadraticCurveTo(32, 32, 4, 32);
  sctx.fill();

  sparkleSprites.set(key, spCanvas);
  return spCanvas;
}

function drawMagicSparkle(c, x, y, size, now, color = "#ffffff") {
  const sprite = getSparkleSprite(color);
  const rot = now * 0.0028;
  const pulse = 0.85 + 0.3 * Math.sin(now * 0.005 + x * 0.1);
  const curSize = ps(size * pulse * 3.2);
  const half = curSize / 2;

  c.save();
  c.translate(px(x), py(y));
  c.rotate(rot);
  c.drawImage(sprite, -half, -half, curSize, curSize);
  c.restore();
}

const drawGlint = drawMagicSparkle;

let voteBloomSprite = null;
function getVoteBloomSprite() {
  if (voteBloomSprite) return voteBloomSprite;
  const bw = 512, bh = 280;
  const bc = createCanvas(bw, bh);
  const bctx = bc.getContext("2d");
  const cx = bw / 2, cy = bh / 2;
  const grad = bctx.createRadialGradient(cx, cy, 20, cx, cy, bw / 2);
  grad.addColorStop(0, "rgba(251, 191, 36, 0.42)");
  grad.addColorStop(0.5, "rgba(236, 72, 153, 0.20)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  bctx.fillStyle = grad;
  bctx.fillRect(0, 0, bw, bh);
  voteBloomSprite = bc;
  return bc;
}

const NAV_SCREENS = [
  { id: "main", num: "1", label: "VOTING" },
  { id: "race", num: "2", label: "RACE" },
  { id: "stats", num: "3", label: "STATS" },
  { id: "supporters", num: "4", label: "FANS" },
  { id: "menu", num: "5", label: "MENU" },
  { id: "events", num: "6", label: "EVENTS" }
];

function drawNavTabs(c, p, now, currentScreen, tr = null) {
  const tabY = 320, tabH = 34, tabW = 152, gap = 8;
  const totalW = NAV_SCREENS.length * tabW + (NAV_SCREENS.length - 1) * gap; // 952
  const startX = 540 - totalW / 2; // 64

  let activeIdx = NAV_SCREENS.findIndex(s => s.id === currentScreen);
  if (activeIdx < 0) activeIdx = 0;

  // Compute smooth animated indicator position during screen transition
  let indicatorX = startX + activeIdx * (tabW + gap);
  if (tr && tr.from !== tr.to) {
    const fromIdx = NAV_SCREENS.findIndex(s => s.id === tr.from);
    const toIdx = NAV_SCREENS.findIndex(s => s.id === tr.to);
    if (fromIdx >= 0 && toIdx >= 0) {
      const t = clamp(tr?.t ?? 0, 0, 1);
      const eased = 0.5 * (1 - Math.cos(Math.PI * t));
      const fromX = startX + fromIdx * (tabW + gap);
      const toX = startX + toIdx * (tabW + gap);
      indicatorX = fromX + (toX - fromX) * eased;
    }
  }
  if (isNaN(indicatorX)) indicatorX = startX + activeIdx * (tabW + gap);

  // Draw background containers for all 6 tabs
  NAV_SCREENS.forEach((s, idx) => {
    const tx = startX + idx * (tabW + gap);
    c.fillStyle = p.theme === "light" ? "rgba(255, 255, 255, 0.82)" : "rgba(15, 23, 42, 0.65)";
    rr(c, tx, tabY, tabW, tabH, tabH / 2);
    c.fill();
    c.strokeStyle = p.theme === "light" ? "#e2e8f0" : "rgba(148, 163, 184, 0.22)";
    c.lineWidth = ps(1.2);
    rr(c, tx, tabY, tabW, tabH, tabH / 2);
    c.stroke();
  });

  // Draw sliding active golden pill
  const gStart = px(indicatorX);
  const gEnd = Math.max(gStart + ps(2), px(indicatorX + tabW));
  const aGrad = c.createLinearGradient(gStart, 0, gEnd, 0);
  if (p.theme === "light") {
    aGrad.addColorStop(0, "#f59e0b");
    aGrad.addColorStop(1, "#d97706");
  } else {
    aGrad.addColorStop(0, "#fbbf24");
    aGrad.addColorStop(1, "#d97706");
  }
  c.save();
  c.fillStyle = aGrad;
  rr(c, indicatorX, tabY, tabW, tabH, tabH / 2);
  c.fill();

  // Glowing outline on active tab
  c.strokeStyle = p.theme === "light" ? "#b45309" : "rgba(254, 240, 138, 0.85)";
  c.lineWidth = ps(1.8);
  rr(c, indicatorX, tabY, tabW, tabH, tabH / 2);
  c.stroke();

  // Subtle sparkle glint on active tab
  drawGlint(c, indicatorX + tabW - 14, tabY + 8, 5, now * 2, "#ffffff");
  c.restore();

  // Draw text labels for all tabs
  NAV_SCREENS.forEach((s, idx) => {
    const tx = startX + idx * (tabW + gap);
    const cx = tx + tabW / 2;
    const dist = Math.abs(indicatorX - tx);
    const activeFraction = Math.max(0, 1 - dist / (tabW + gap));
    const isLit = activeFraction > 0.45;

    const label = `${s.num}: ${s.label}`;
    if (isLit) {
      const textColor = p.theme === "light" ? "#ffffff" : "#0a1426";
      textC(c, label, cx, tabY + 23, 14, textColor, 900, "center");
    } else {
      const textColor = p.theme === "light" ? "#475569" : "#94a3b8";
      textC(c, label, cx, tabY + 23, 14, textColor, 700, "center");
    }
  });
}

function drawHero(c, p, now, subtitle = "LIVE VOTING", tr = null) {
  // Eye in center (perfectly proportioned, prominent & sharp)
  drawEye(c, p, 540, 138, 0.58, now);

  // 3D Metallic "BIGG BOSS" Title (Y = 224, size = 44)
  const titleY = 224;
  c.save();
  const textVal = "BIGG BOSS";
  const size = 44;
  const layers = [
    { dy: 3, col: p.gold3dDark },
    { dy: 2, col: "#92400e" },
    { dy: 1, col: "#b45309" }
  ];
  for (const l of layers) {
    textC(c, textVal, 540, titleY + l.dy, size, l.col, 900, "center");
  }
  const tGrad = c.createLinearGradient(0, py(titleY - size), 0, py(titleY));
  tGrad.addColorStop(0, "#fffbeb");
  tGrad.addColorStop(0.35, "#fde68a");
  tGrad.addColorStop(0.7, "#f59e0b");
  tGrad.addColorStop(1, "#b45309");
  textC(c, textVal, 540, titleY, size, tGrad, 900, "center");

  // Rotating diamond star glints on Bigg Boss title corners
  const glintAlpha = 0.4 + 0.6 * Math.abs(Math.sin(now * 0.003));
  c.save();
  c.globalAlpha = glintAlpha;
  drawGlint(c, 290, titleY - 20, 7, now, p.goldBright);
  drawGlint(c, 790, titleY - 20, 7, now + 1200, p.goldBright);
  c.restore();

  // Smooth specular sparkle moving across BIGG BOSS title
  const sheenCycle = 3600;
  const sheenT = (now % sheenCycle) / 1200;
  if (sheenT <= 1.0) {
    const sxPos = 260 + sheenT * 560;
    drawGlint(c, sxPos, titleY - size / 2, 6, now * 2, "#ffffff");
  }
  c.restore();

  // "LIVE VOTING" Blue Pill with circulating gold dashed outline
  const pillW = 280, pillH = 32, pillX = 540 - pillW / 2, pillY = 244;
  c.fillStyle = p.navyPill;
  rr(c, pillX, pillY, pillW, pillH, pillH / 2);
  c.fill();

  c.save();
  c.strokeStyle = p.goldBright;
  c.lineWidth = ps(1.6);
  c.setLineDash([ps(10), ps(5)]);
  c.lineDashOffset = -now * 0.04;
  rr(c, pillX, pillY, pillW, pillH, pillH / 2);
  c.stroke();
  c.restore();

  textC(c, subtitle, 540, pillY + 22, 17, p.goldBright, 800, "center");

  // Subtitle: "WATCH • VOTE • SUPPORT YOUR FAVORITE!"
  const subColor = p.theme === "light" ? p.titleText : p.muted;
  textC(c, "WATCH • VOTE • SUPPORT YOUR FAVORITE!", 540, 296, 15, subColor, 750, "center");

  // Screen Navigation Tabs Bar
  drawNavTabs(c, p, now, interactiveState().screen, tr);
}

function drawAvatar(c, no, x, y, r, p, img) {
  const targetDiam = Math.round(r * 2);
  const pre = getCircularAvatar(no, img, targetDiam);
  if (pre) {
    c.drawImage(pre, px(x - r), py(y - r));
    return;
  }
  c.save();
  c.beginPath();
  c.arc(px(x), py(y), ps(r), 0, Math.PI * 2);
  c.clip();

  const actualImg = img || contestantImages.get(Number(no));
  if (actualImg) {
    const iw = actualImg.width || 1;
    const ih = actualImg.height || 1;
    const s = Math.max((r * 2) / iw, (r * 2) / ih);
    const dw = iw * s, dh = ih * s;
    c.drawImage(actualImg, px(x - dw / 2), py(y - dh / 2), ps(dw), ps(dh));
  } else {
    // High quality procedural portrait
    const skins = ["#f5d0b5", "#e8b894", "#dfa680", "#f3cfb3", "#d99d75", "#efc29e"];
    const hairs = ["#171717", "#261c14", "#1c1917", "#2e2118", "#18181b", "#27272a"];
    const shirts = ["#1e293b", "#334155", "#0f172a", "#1e1b4b", "#312e81", "#1e3a8a"];

    const skin = skins[(no - 1) % skins.length];
    const hair = hairs[(no - 1) % hairs.length];
    const shirt = shirts[(no - 1) % shirts.length];
    const isFemale = (no === 2 || no === 3 || no === 4 || no === 9 || no === 12 || no === 13 || no === 15 || no === 16);

    // Shirt background
    c.fillStyle = shirt;
    c.fillRect(px(x - r), py(y), ps(r * 2), ps(r));

    // Face
    c.fillStyle = skin;
    c.beginPath();
    c.arc(px(x), py(y - 4), ps(r * 0.58), 0, Math.PI * 2);
    c.fill();

    // Neck
    c.fillRect(px(x - r * 0.22), py(y + 8), ps(r * 0.44), ps(r * 0.35));

    // Hair
    c.fillStyle = hair;
    if (isFemale) {
      c.beginPath();
      c.arc(px(x), py(y - 10), ps(r * 0.65), Math.PI * 0.8, Math.PI * 2.2);
      c.fill();
      c.fillRect(px(x - r * 0.62), py(y - 6), ps(r * 0.24), ps(r * 0.85));
      c.fillRect(px(x + r * 0.38), py(y - 6), ps(r * 0.24), ps(r * 0.85));
    } else {
      c.beginPath();
      c.arc(px(x), py(y - 12), ps(r * 0.6), Math.PI * 0.85, Math.PI * 2.15);
      c.fill();
      c.fillStyle = "rgba(0, 0, 0, 0.25)";
      c.beginPath();
      c.arc(px(x), py(y + 2), ps(r * 0.48), 0, Math.PI);
      c.fill();
    }

    // Eyes
    c.fillStyle = "#0f172a";
    c.beginPath();
    c.arc(px(x - r * 0.2), py(y - 5), ps(2.8), 0, Math.PI * 2);
    c.arc(px(x + r * 0.2), py(y - 5), ps(2.8), 0, Math.PI * 2);
    c.fill();

    // Smile
    c.strokeStyle = "#0f172a";
    c.lineWidth = ps(2);
    c.beginPath();
    c.arc(px(x), py(y + 3), ps(6), 0.15 * Math.PI, 0.85 * Math.PI);
    c.stroke();
  }

  c.restore();

  // Rim border
  c.strokeStyle = p.theme === "light" ? "#cbd5e1" : p.goldBright;
  c.lineWidth = ps(2);
  c.beginPath();
  c.arc(px(x), py(y), ps(r + 1), 0, Math.PI * 2);
  c.stroke();
}

function drawVoteRow(c, p, item, rank, totalVotes, maxVotes, now, y, slideX = 0, alpha = 1, scale = 1, isEntry = false) {
  const h = 132, w = 1000, x = 40;
  const colors = p.rankGradients[rank % p.rankGradients.length];
  const hasAnim = (slideX !== 0 || alpha < 1 || scale !== 1);

  if (hasAnim) {
    c.save();
    if (alpha < 1) c.globalAlpha = Math.max(0, Math.min(1, alpha));
    c.translate(px(540 + slideX), py(y + h / 2));
    c.scale(scale, scale);
    c.translate(-px(540), -py(y + h / 2));
  }

  // Card drop shadow (instant geometric Skia fill)
  c.fillStyle = p.cardShadow;
  rr(c, x, y + 4, w, h, 20);
  c.fill();

  // Card background
  c.fillStyle = p.card;
  rr(c, x, y, w, h, 20);
  c.fill();

  // Card outline border + Buff Auras
  const isLeadCard = (rank === 0);
  const isVotedCard = (state.chatVoteFlashContestant === item.no && (now - state.chatVoteFlashAt < 5000));
  const buff = getContestantBuff(item.no, now);

  if (buff?.buff === "immunity") {
    const immPulse = 0.6 + 0.4 * Math.sin(now * 0.007);
    c.strokeStyle = `rgba(251, 191, 36, ${0.85 + 0.15 * immPulse})`;
    c.lineWidth = ps(3.2);
    rr(c, x, y, w, h, 20);
    c.stroke();
    c.fillStyle = `rgba(251, 191, 36, ${0.12 * immPulse})`;
    rr(c, x, y, w, h, 20);
    c.fill();
    c.fillStyle = "#fbbf24";
    rr(c, x + w - 165, y + 8, 145, 24, 12);
    c.fill();
    textC(c, "🛡️ IMMUNITY", x + w - 92, y + 25, 12, "#0f172a", 900, "center");
  } else if (buff?.buff === "danger") {
    const dangerPulse = 0.5 + 0.5 * Math.sin(now * 0.012);
    c.strokeStyle = `rgba(239, 68, 68, ${0.85 + 0.15 * dangerPulse})`;
    c.lineWidth = ps(3.0);
    rr(c, x, y, w, h, 20);
    c.stroke();
    c.fillStyle = `rgba(239, 68, 68, ${0.14 * dangerPulse})`;
    rr(c, x, y, w, h, 20);
    c.fill();
    c.fillStyle = "#ef4444";
    rr(c, x + w - 165, y + 8, 145, 24, 12);
    c.fill();
    textC(c, "⚠️ DANGER ZONE", x + w - 92, y + 25, 12, "#ffffff", 900, "center");
  } else if (buff?.buff === "supervote") {
    const svPulse = 0.5 + 0.5 * Math.sin(now * 0.010);
    c.strokeStyle = `rgba(168, 85, 247, ${0.85 + 0.15 * svPulse})`;
    c.lineWidth = ps(3.0);
    rr(c, x, y, w, h, 20);
    c.stroke();
    c.fillStyle = "#a855f7";
    rr(c, x + w - 165, y + 8, 145, 24, 12);
    c.fill();
    textC(c, "💥 5X SUPERVOTE", x + w - 92, y + 25, 12, "#ffffff", 900, "center");
  } else {
    c.strokeStyle = isLeadCard ? p.goldBright : isVotedCard ? p.cyan : p.cardBorder;
    c.lineWidth = ps(isLeadCard || isVotedCard ? 2.2 : 1.5);
    rr(c, x, y, w, h, 20);
    c.stroke();
  }

  // Traveling holographic neon laser streak along card top edge
  if (isLeadCard || isVotedCard) {
    const laserW = 160;
    const laserSpeed = isLeadCard ? 0.35 : 0.65;
    const laserPos = x + ((now * laserSpeed + rank * 90) % (w + laserW * 2)) - laserW;
    c.save();
    c.beginPath();
    c.roundRect(px(x), py(y), ps(w), ps(h), ps(20));
    c.clip();
    const lGrad = c.createLinearGradient(px(laserPos), 0, px(laserPos + laserW), 0);
    lGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
    lGrad.addColorStop(0.5, isLeadCard ? "rgba(255, 255, 255, 0.92)" : "rgba(56, 189, 248, 0.95)");
    lGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    c.fillStyle = lGrad;
    c.fillRect(px(laserPos), py(y), ps(laserW), ps(3.5));
    c.restore();
  }

  // 1. Rank Circle Badge (Left)
  const rankX = x + 54, rankY = y + h / 2, rankR = 33;
  const rGrad = c.createLinearGradient(px(rankX), py(rankY - rankR), px(rankX), py(rankY + rankR));
  rGrad.addColorStop(0, colors[0]);
  rGrad.addColorStop(1, colors[1]);
  c.fillStyle = rGrad;
  c.beginPath();
  c.arc(px(rankX), py(rankY), ps(rankR), 0, Math.PI * 2);
  c.fill();
  const rankNumColor = (rank === 0 && p.theme === "light") ? "#78350f" : "#ffffff";
  textC(c, String(rank + 1), rankX, rankY + 11, 30, rankNumColor, 800, "center");

  if (rank === 0) {
    drawGlint(c, rankX + 22, rankY - 22, 8, now, p.goldBright);
  }

  // 2. Contestant Avatar with rank-specific auras for Top 3
  const avX = x + 146, avY = y + h / 2, avR = 42;
  if (rank === 0) {
    const wavePhase = (now * 0.0018) % 1;
    const r1 = avR + wavePhase * 16;
    c.save();
    c.strokeStyle = p.goldBright;
    c.globalAlpha = Math.max(0, 0.75 * (1 - wavePhase));
    c.lineWidth = ps(2);
    c.beginPath();
    c.arc(px(avX), py(avY), ps(r1), 0, Math.PI * 2);
    c.stroke();
    // Radiant breathing golden halo
    const haloPulse = 0.5 + 0.5 * Math.sin(now * 0.004);
    const aGrad = c.createRadialGradient(px(avX), py(avY), ps(avR * 0.8), px(avX), py(avY), ps(avR + 22));
    aGrad.addColorStop(0, `rgba(245, 197, 66, ${0.45 * haloPulse})`);
    aGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    c.fillStyle = aGrad;
    c.beginPath();
    c.arc(px(avX), py(avY), ps(avR + 22), 0, Math.PI * 2);
    c.fill();
    c.restore();
  } else if (rank === 1) {
    // Silver/Cyan Frost breathing halo for #2
    const haloPulse = 0.5 + 0.5 * Math.sin(now * 0.004 + 1);
    c.save();
    const aGrad = c.createRadialGradient(px(avX), py(avY), ps(avR * 0.8), px(avX), py(avY), ps(avR + 18));
    aGrad.addColorStop(0, `rgba(56, 189, 248, ${0.35 * haloPulse})`);
    aGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    c.fillStyle = aGrad;
    c.beginPath();
    c.arc(px(avX), py(avY), ps(avR + 18), 0, Math.PI * 2);
    c.fill();
    c.restore();
  } else if (rank === 2) {
    // Rose/Bronze breathing halo for #3
    const haloPulse = 0.5 + 0.5 * Math.sin(now * 0.004 + 2);
    c.save();
    const aGrad = c.createRadialGradient(px(avX), py(avY), ps(avR * 0.8), px(avX), py(avY), ps(avR + 18));
    aGrad.addColorStop(0, `rgba(244, 114, 182, ${0.32 * haloPulse})`);
    aGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    c.fillStyle = aGrad;
    c.beginPath();
    c.arc(px(avX), py(avY), ps(avR + 18), 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  const img = contestantImages.get(item.no);
  drawAvatar(c, item.no, avX, avY, avR, p, img);

  // 3. Vote Command Badge in front of Contestant Name with liquid shimmer
  const cmdW = 104, cmdH = 30, cmdX = x + 210, cmdY = y + 25;
  const isLead = (rank === 0);
  const cmdPulse = 0.5 + 0.5 * Math.sin(now * 0.007 + rank);

  c.save();
  if (isLead) {
    const cg = c.createLinearGradient(px(cmdX), 0, px(cmdX + cmdW), 0);
    cg.addColorStop(0, "#fbbf24");
    cg.addColorStop(1, "#f59e0b");
    c.fillStyle = cg;
    rr(c, cmdX, cmdY, cmdW, cmdH, 9);
    c.fill();
    c.strokeStyle = `rgba(255, 255, 255, ${0.75 + 0.25 * cmdPulse})`;
    c.lineWidth = ps(1.6 + cmdPulse * 0.6);
    rr(c, cmdX, cmdY, cmdW, cmdH, 9);
    c.stroke();
    textC(c, `!vote ${item.no}`, cmdX + cmdW / 2, cmdY + 21, 16.5, "#0f172a", 950, "center");
  } else {
    c.fillStyle = p.theme === "light" ? "rgba(2, 132, 199, 0.12)" : "rgba(14, 165, 233, 0.20)";
    rr(c, cmdX, cmdY, cmdW, cmdH, 9);
    c.fill();
    c.strokeStyle = p.theme === "light" ? "#0284c7" : `rgba(56, 189, 248, ${0.65 + 0.35 * cmdPulse})`;
    c.lineWidth = ps(1.5 + cmdPulse * 0.5);
    rr(c, cmdX, cmdY, cmdW, cmdH, 9);
    c.stroke();
    textC(c, `!vote ${item.no}`, cmdX + cmdW / 2, cmdY + 21, 16.5, p.theme === "light" ? "#0369a1" : "#38bdf8", 900, "center");
  }

  // Liquid gloss shimmer passing across command badge
  const cSweep = ((now * 0.14 + rank * 55) % (cmdW + 60)) - 30;
  c.beginPath();
  c.roundRect(px(cmdX), py(cmdY), ps(cmdW), ps(cmdH), ps(9));
  c.clip();
  const cGloss = c.createLinearGradient(px(cmdX + cSweep), 0, px(cmdX + cSweep + 28), 0);
  cGloss.addColorStop(0, "rgba(255, 255, 255, 0)");
  cGloss.addColorStop(0.5, "rgba(255, 255, 255, 0.42)");
  cGloss.addColorStop(1, "rgba(255, 255, 255, 0)");
  c.fillStyle = cGloss;
  c.fillRect(px(cmdX + cSweep), py(cmdY), ps(28), ps(cmdH));
  c.restore();

  // Contestant Name placed right next to command badge
  const nameX = cmdX + cmdW + 12;
  const nameStr = fit(item.displayName || item.name, 16);
  textC(c, nameStr, nameX, y + 49, 27, p.text, 800);

  // Smooth vote number animation with analytical easing
  const curV = getAnimatedVotes(item, now);
  shownVotes.set(item.no, curV);

  // 4. Vote Count & Live Badge
  const votesStr = Math.round(curV).toLocaleString();
  textC(c, votesStr, x + 760, y + 52, 26, p.text, 700, "right");

  // Dynamic "HOT" tag if recently voted
  const isRecentVote = (state.chatVoteFlashContestant === item.no && (now - state.chatVoteFlashAt < 5000));
  if (isRecentVote) {
    const hotPulse = 0.6 + 0.4 * Math.sin(now * 0.008);
    c.save();
    c.font = getFontStr(800, Math.max(8, Math.round(ps(27))));
    c._curFont = c.font;
    const nameMeasure = c.measureText(nameStr).width / sx;
    const hotX = Math.min(nameX + nameMeasure + 12, x + 680);
    c.fillStyle = `rgba(239, 68, 68, ${0.85 * hotPulse})`;
    rr(c, hotX, y + 29, 66, 22, 11);
    c.fill();
    textC(c, "HOT 🔥", hotX + 33, y + 45, 12, "#ffffff", 900, "center");
    c.restore();
  }

  // 5. Percentage Box & Risk Indicator (Far Right)
  const pct = totalVotes > 0 ? (item.votes / totalVotes) * 100 : (item.pct || 0);
  const boxW = 120, boxH = 56, boxX = x + w - boxW - 20, boxY = y + (h - boxH) / 2;
  c.strokeStyle = p.line;
  c.lineWidth = ps(1.8);
  rr(c, boxX, boxY, boxW, boxH, 12);
  c.stroke();

  textC(c, `${pct.toFixed(1)}%`, boxX + boxW / 2, boxY + 37, 26, p.text, 800, "center");

  // Eviction danger indicator for bottom 2 contestants
  const totalCount = config.contestants?.length || 17;
  const isDangerRank = (rank >= Math.max(4, totalCount - 2));
  if (isDangerRank) {
    const dangerPulse = 0.7 + 0.3 * Math.sin(now * 0.006 + rank);
    c.save();
    c.fillStyle = `rgba(239, 68, 68, ${0.18 * dangerPulse})`;
    c.strokeStyle = "#ef4444";
    c.lineWidth = ps(1.2);
    rr(c, boxX - 88, boxY + 12, 80, 32, 8);
    c.fill();
    c.stroke();
    textC(c, "⚠️ RISK", boxX - 48, boxY + 33, 12.5, "#ef4444", 900, "center");
    c.restore();
  }

  // 6. Colored Progress Bar (Below Name & Count)
  const barX = x + 215, barY = y + 76, barW = 545, barH = 17;
  c.fillStyle = p.barBg;
  rr(c, barX, barY, barW, barH, barH / 2);
  c.fill();
  const ratio = maxVotes > 0 ? clamp(curV / maxVotes, 0.04, 1) : clamp((pct || 0) / 100, 0.04, 1);
  const fillW = Math.max(barH, Math.min(barW, barW * (isNaN(ratio) ? 0.04 : ratio)));
  const gradEnd = Math.max(px(barX + 2), px(barX + fillW));
  const pGrad = c.createLinearGradient(px(barX), 0, gradEnd, 0);
  pGrad.addColorStop(0, colors[0]);
  pGrad.addColorStop(1, colors[1]);
  c.fillStyle = pGrad;
  rr(c, barX, barY, fillW, barH, barH / 2);
  c.fill();

  // Animated specular gloss wave across progress bar
  if (fillW > 24) {
    const sweepW = 60;
    const sweepPos = barX + ((now * 0.18 + rank * 40) % (fillW + sweepW * 2)) - sweepW;
    c.save();
    c.beginPath();
    c.roundRect(px(barX), py(barY), ps(fillW), ps(barH), ps(barH / 2));
    c.clip();

    // Sinusoidal liquid ripple wave along upper crest
    const waveH = 2.2;
    const waveFreq = 0.035;
    const waveSpeed = now * 0.007 + rank * 1.5;
    c.fillStyle = "rgba(255, 255, 255, 0.22)";
    c.beginPath();
    c.moveTo(px(barX), py(barY));
    for (let wx = 0; wx <= fillW; wx += 8) {
      const wy = barY + Math.sin(wx * waveFreq + waveSpeed) * waveH;
      c.lineTo(px(barX + wx), py(wy));
    }
    c.lineTo(px(barX + fillW), py(barY));
    c.closePath();
    c.fill();

    const gloss = c.createLinearGradient(px(sweepPos), 0, px(sweepPos + sweepW), 0);
    gloss.addColorStop(0, "rgba(255, 255, 255, 0)");
    gloss.addColorStop(0.5, "rgba(255, 255, 255, 0.55)");
    gloss.addColorStop(1, "rgba(255, 255, 255, 0)");
    c.fillStyle = gloss;
    c.fillRect(px(sweepPos), py(barY), ps(sweepW), ps(barH));
    c.restore();

    // Radiant pulsating energy corona tip pearl
    const tipX = barX + fillW;
    const tipY = barY + barH / 2;
    const tipPulse = 0.8 + 0.3 * Math.sin(now * 0.008 + rank * 2);
    const coronaRad = ps(barH * 0.7 * tipPulse);
    const corona = c.createRadialGradient(px(tipX), py(tipY), ps(1), px(tipX), py(tipY), Math.max(ps(2), coronaRad));
    corona.addColorStop(0, "#ffffff");
    corona.addColorStop(0.4, colors[1]);
    corona.addColorStop(1, "rgba(0, 0, 0, 0)");
    c.fillStyle = corona;
    c.beginPath();
    c.arc(px(tipX), py(tipY), Math.max(ps(2), coronaRad), 0, Math.PI * 2);
    c.fill();

    // Tip micro-sparkle
    if ((now + rank * 700) % 2400 < 600) {
      drawMagicSparkle(c, tipX, tipY, 4, now, "#ffffff");
    }
  }

  // Leader breathing golden aura & floating crown
  if (rank === 0) {
    const leadPulse = 0.5 + 0.5 * Math.sin(now * 0.005);
    c.strokeStyle = p.goldBright;
    c.lineWidth = ps(2.2 + leadPulse * 1.5);
    rr(c, x, y, w, h, 20);
    c.stroke();

    // Floating bobbing crown above avatar
    const bob = Math.sin(now * 0.004) * 3.5;
    drawCrown(c, avX, avY - avR - 11 + bob, 12, p.goldBright);
    drawGlint(c, avX, avY - avR - 22 + bob, 6, now + 600, "#ffffff");
  } else if (rank === 1) {
    drawGlint(c, rankX + 22, rankY - 22, 6, now + 300, "#38bdf8");
  } else if (rank === 2) {
    drawGlint(c, rankX + 22, rankY - 22, 6, now + 600, "#f472b6");
  }

  // Live vote flash notification
  const isFlashing = (state.chatVoteFlashContestant === item.no && (now - state.chatVoteFlashAt < 2200));
  if (isFlashing) {
    const age = now - state.chatVoteFlashAt;
    const fade = Math.max(0, 1 - age / 2200);

    // Golden glow halo on the entire card (crisp layered glow without Gaussian convolution)
    c.save();
    c.strokeStyle = `rgba(251, 191, 36, ${0.45 * fade})`;
    c.lineWidth = ps(7 * fade);
    rr(c, x, y, w, h, 20);
    c.stroke();

    c.strokeStyle = `rgba(56, 189, 248, ${0.9 * fade})`;
    c.lineWidth = ps(3 * fade);
    rr(c, x, y, w, h, 20);
    c.stroke();
    c.restore();

    // Rising floating +1 VOTE badge with layered glow
    const floatY = y + 22 - (age / 2200) * 40;
    c.save();
    c.globalAlpha = fade;
    // Layered glow behind badge
    c.fillStyle = "rgba(56, 189, 248, 0.35)";
    rr(c, x + 653, floatY - 20, 102, 32, 16);
    c.fill();
    const badgeGrad = c.createLinearGradient(px(x + 655), 0, px(x + 753), 0);
    badgeGrad.addColorStop(0, p.cyan);
    badgeGrad.addColorStop(1, p.goldBright);
    c.fillStyle = badgeGrad;
    rr(c, x + 655, floatY - 18, 98, 28, 14);
    c.fill();
    c.strokeStyle = "#ffffff";
    c.lineWidth = ps(1.2);
    rr(c, x + 655, floatY - 18, 98, 28, 14);
    c.stroke();
    textC(c, "+1 VOTE ⚡", x + 704, floatY + 1, 15, "#ffffff", 900, "center");
    c.restore();
  }

  // Holographic arrival blade flash across card
  if (isEntry) {
    c.save();
    c.beginPath();
    c.roundRect(px(x), py(y), ps(w), ps(h), ps(20));
    c.clip();
    const entryGrad = c.createLinearGradient(px(x), 0, px(x + w), 0);
    entryGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
    entryGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.7)");
    entryGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    c.fillStyle = entryGrad;
    c.fillRect(px(x), py(y), ps(w), ps(3));
    c.restore();
  }

  if (hasAnim) {
    c.restore();
  }
}

// Sunday 9:00 PM IST Elimination Countdown Timer
function getSundayCountdown(now = Date.now()) {
  const istOffset = 5.5 * 3600 * 1000;
  const istDate = new Date(now + istOffset);
  const day = istDate.getUTCDay(); // 0 is Sunday
  const hour = istDate.getUTCHours();
  const min = istDate.getUTCMinutes();
  const sec = istDate.getUTCSeconds();

  let daysUntilSunday = (7 - day) % 7;
  if (daysUntilSunday === 0 && (hour > 21 || (hour === 21 && (min > 0 || sec > 0)))) {
    daysUntilSunday = 7;
  }

  const targetYear = istDate.getUTCFullYear();
  const targetMonth = istDate.getUTCMonth();
  const targetDate = istDate.getUTCDate() + daysUntilSunday;
  const targetMs = Date.UTC(targetYear, targetMonth, targetDate, 21, 0, 0, 0) - istOffset;

  const diffMs = Math.max(0, targetMs - now);
  const d = Math.floor(diffMs / 86400000);
  const h = Math.floor((diffMs % 86400000) / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  const s = Math.floor((diffMs % 60000) / 1000);

  if (d > 0) {
    return `${d}D ${h}H ${m}M`;
  }
  return `${h}H ${m}M ${s}S`;
}

function drawBottomStats(c, p, now = Date.now(), customY = 1350, customH = 130) {
  const y = customY, h = customH;
  const w = 232, gap = 24;
  const totalVotes = state.totalAcceptedVotes || 44344;
  const uniqueVoters = state.uniqueVoters || 0;
  const votePace = recentVoteRate();
  const timeLeft = getSundayCountdown(now);

  const cards = [
    { x: 40, label: "TOTAL VOTES", val: Number(totalVotes).toLocaleString(), icon: "chart", col: p.goldBright },
    { x: 40 + w + gap, label: "UNIQUE VOTERS", val: Number(uniqueVoters).toLocaleString(), icon: "users", col: p.cyan },
    { x: 40 + (w + gap) * 2, label: "VOTES / MINUTE", val: String(votePace), icon: "rate", col: p.green },
    { x: 40 + (w + gap) * 3, label: "SUN 9PM EVICTION", val: timeLeft, icon: "clock", col: p.pink }
  ];

  cards.forEach(cd => {
    c.fillStyle = p.card;
    rr(c, cd.x, y, w, h, 20);
    c.fill();
    c.strokeStyle = p.cardBorder;
    c.lineWidth = ps(1.5);
    rr(c, cd.x, y, w, h, 20);
    c.stroke();

    // Subtle colored bottom accent bar
    c.fillStyle = cd.col;
    c.fillRect(px(cd.x + 20), py(y + h - 6), ps(w - 40), ps(3));

    const icX = cd.x + 36, icY = y + h / 2 - 4;
    if (cd.icon === "chart") {
      const b1 = 10 + Math.abs(Math.sin(now * 0.005)) * 14;
      const b2 = 14 + Math.abs(Math.sin(now * 0.006 + 1)) * 18;
      const b3 = 18 + Math.abs(Math.sin(now * 0.004 + 2)) * 16;
      c.fillStyle = p.goldBright;
      rr(c, icX - 12, icY + 18 - b1, 6, b1, 2);
      c.fill();
      rr(c, icX - 3, icY + 18 - b2, 6, b2, 2);
      c.fill();
      rr(c, icX + 6, icY + 18 - b3, 6, b3, 2);
      c.fill();
    } else if (cd.icon === "users") {
      c.fillStyle = p.cyan;
      // Primary person head & shoulder
      c.beginPath();
      c.arc(px(icX - 4), py(icY - 6), ps(5.5), 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.arc(px(icX - 4), py(icY + 10), ps(9), Math.PI, 0);
      c.fill();
      // Secondary person silhouette behind
      c.fillStyle = "rgba(56, 189, 248, 0.65)";
      c.beginPath();
      c.arc(px(icX + 8), py(icY - 9), ps(4.5), 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.arc(px(icX + 8), py(icY + 5), ps(7), Math.PI, 0);
      c.fill();
    } else if (cd.icon === "rate") {
      // Pulse / Speedometer / Heartbeat wave
      c.strokeStyle = p.green;
      c.lineWidth = ps(2.2);
      c.beginPath();
      c.moveTo(px(icX - 14), py(icY));
      c.lineTo(px(icX - 6), py(icY));
      c.lineTo(px(icX - 2), py(icY - 10));
      c.lineTo(px(icX + 3), py(icY + 10));
      c.lineTo(px(icX + 7), py(icY - 4));
      c.lineTo(px(icX + 14), py(icY));
      c.stroke();
      const dotPulse = 0.5 + 0.5 * Math.sin(now * 0.01);
      c.fillStyle = "#22c55e";
      c.beginPath();
      c.arc(px(icX + 14), py(icY), ps(3 + dotPulse * 1.5), 0, Math.PI * 2);
      c.fill();
    } else {
      c.strokeStyle = p.theme === "light" ? p.text : "#f43f5e";
      c.lineWidth = ps(2.2);
      c.beginPath();
      c.arc(px(icX), py(icY), ps(16), 0, Math.PI * 2);
      c.stroke();
      // Hour hand
      c.beginPath();
      c.moveTo(px(icX), py(icY));
      c.lineTo(px(icX - 6), py(icY - 7));
      c.stroke();
      // Rotating minute hand
      const clockAngle = (now * 0.002) % (Math.PI * 2);
      c.strokeStyle = p.goldBright;
      c.lineWidth = ps(1.8);
      c.beginPath();
      c.moveTo(px(icX), py(icY));
      c.lineTo(px(icX + Math.cos(clockAngle - Math.PI / 2) * 11), py(icY + Math.sin(clockAngle - Math.PI / 2) * 11));
      c.stroke();
      c.fillStyle = p.goldBright;
      c.beginPath();
      c.arc(px(icX), py(icY), ps(2.5), 0, Math.PI * 2);
      c.fill();
    }

    textC(c, cd.label, cd.x + 58, y + 38, 14, p.theme === "light" ? "#334155" : p.muted, 800);
    textC(c, cd.val, cd.x + 58, y + 76, 21.5, p.theme === "light" ? "#0f172a" : p.text, 900);
  });
}

function drawCrown(c, x, y, size = 12, color = "#f59e0b") {
  c.save();
  const left = px(x - size), right = px(x + size), bottom = py(y + size * 0.7);
  const topMid = py(y - size * 0.7), topL = py(y - size * 0.4), topR = py(y - size * 0.4);
  const dipL = py(y + size * 0.1), dipR = py(y + size * 0.1);

  // Metallic golden gradient body
  const cGrad = c.createLinearGradient(left, topMid, right, bottom);
  cGrad.addColorStop(0, "#fde68a");
  cGrad.addColorStop(0.3, "#fbbf24");
  cGrad.addColorStop(0.7, "#d97706");
  cGrad.addColorStop(1, "#92400e");
  c.fillStyle = cGrad;

  c.beginPath();
  c.moveTo(left, bottom);
  c.lineTo(left, topL);
  c.lineTo(px(x - size * 0.45), dipL);
  c.lineTo(px(x), topMid);
  c.lineTo(px(x + size * 0.45), dipR);
  c.lineTo(right, topR);
  c.lineTo(right, bottom);
  c.closePath();
  c.fill();

  // Golden outline
  c.strokeStyle = "#fef08a";
  c.lineWidth = ps(1.4);
  c.stroke();

  // Crown base jeweled band
  c.fillStyle = "#92400e";
  c.fillRect(left, bottom - ps(size * 0.28), ps(size * 2), ps(size * 0.28));
  c.strokeStyle = "#fde68a";
  c.strokeRect(left, bottom - ps(size * 0.28), ps(size * 2), ps(size * 0.28));

  // 3 Royal Tip Jewels (Left: Ruby Red, Mid: Diamond Brilliant, Right: Sapphire Cyan)
  const jewels = [
    { x: px(x - size), y: topL, col: "#ef4444" },
    { x: px(x), y: topMid, col: "#ffffff" },
    { x: px(x + size), y: topR, col: "#38bdf8" }
  ];
  jewels.forEach((jw, ji) => {
    c.fillStyle = jw.col;
    c.beginPath();
    c.arc(jw.x, jw.y, ps(size * 0.22), 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#ffffff";
    c.lineWidth = ps(0.8);
    c.stroke();
  });

  // Radiant diamond sparkle glint on center peak jewel
  drawMagicSparkle(c, x, y - size * 0.7, size * 0.6, Date.now(), "#ffffff");
  c.restore();
}

function drawFooter(c, p, now = Date.now(), customY = null) {
  const y = (customY !== null) ? customY : (interactiveState().screen === "main" ? 1735 : 1515);

  c.strokeStyle = p.line;
  c.lineWidth = ps(1);
  c.beginPath();
  c.moveTo(px(40), py(y));
  c.lineTo(px(1040), py(y));
  c.stroke();

  const midY = y + 24;
  textC(c, "BIGG BOSS 24/7 LIVE", 160, midY, 17, p.text, 800, "center");
  drawCrown(c, 375, midY - 6, 11, p.goldBright);
  textC(c, "\"BADI BAATEIN, BADA SHOW!\"", 540, midY, 17, p.goldBright, 800, "center");
  textC(c, "STAY TUNED!", 920, midY, 17, p.text, 800, "center");

  // Command prompt strip / Live Vote Alert Ribbon
  const tipY = y + 42;
  const ribW = 1000, ribH = 44, ribX = 40;
  const trkInfo = (typeof getMusicTrackInfo === "function") ? getMusicTrackInfo() : null;
  const isMusicPhase = Math.floor(now / 5000) % 2 === 1 && trkInfo;

    if (isMusicPhase) {
      const mGrad = c.createLinearGradient(px(ribX), 0, px(ribX + ribW), 0);
      mGrad.addColorStop(0, "#1e1b4b");
      mGrad.addColorStop(0.5, "#3b0764");
      mGrad.addColorStop(1, "#082f49");
      c.fillStyle = mGrad;
      rr(c, ribX, tipY, ribW, ribH, 12);
      c.fill();

      const mbGrad = c.createLinearGradient(px(ribX), 0, px(ribX + ribW), 0);
      mbGrad.addColorStop(0, "#8b5cf6");
      mbGrad.addColorStop(0.5, "#ec4899");
      mbGrad.addColorStop(1, "#00f0ff");
      c.strokeStyle = mbGrad;
      c.lineWidth = ps(1.8);
      rr(c, ribX, tipY, ribW, ribH, 12);
      c.stroke();

      // Equalizer mini-bars on left
      const eqColors = ["#8b5cf6", "#ec4899", "#f59e0b", "#00f0ff"];
      for (let mi = 0; mi < 4; mi++) {
        const mh = 6 + Math.abs(Math.sin(now * 0.008 + mi * 1.2)) * 14;
        c.fillStyle = eqColors[mi];
        c.fillRect(px(ribX + 18 + mi * 7), py(tipY + 28 - mh), ps(4), ps(mh));
      }

      const modeIcon = trkInfo.loopMode === "loop" ? "AUTO-LOOP" : "REPEAT";
      textC(c, `NOW PLAYING: #${trkInfo.id} "${trkInfo.name}" (${trkInfo.genre})`, ribX + 56, tipY + 28, 15, "#f472b6", 800);
      textC(c, `${modeIcon} • Chat: !track <1-40>`, ribX + ribW - 18, tipY + 28, 14, "#38bdf8", 800, "right");
    } else {
      c.fillStyle = p.theme === "light" ? "rgba(241, 245, 249, 0.94)" : "rgba(15, 23, 42, 0.90)";
      rr(c, ribX, tipY, ribW, ribH, 12);
      c.fill();

      const cbGrad = c.createLinearGradient(px(ribX), 0, px(ribX + ribW), 0);
      cbGrad.addColorStop(0, "rgba(56, 189, 248, 0.5)");
      cbGrad.addColorStop(0.5, "rgba(251, 191, 36, 0.5)");
      cbGrad.addColorStop(1, "rgba(244, 114, 182, 0.5)");
      c.strokeStyle = cbGrad;
      c.lineWidth = ps(1.4);
      rr(c, ribX, tipY, ribW, ribH, 12);
      c.stroke();

      textC(c, "🎮 CHAT COMMANDS: !vote <1-17> • !track <1-40> • !buzzer • !clash • !fortune • !spotlight • !magic • !shield", 540, tipY + 28, 14.5, p.text, 800, "center");
    }

  const noteY = tipY + 46 + 26;
  textC(c, "HOW TO VOTE: Type !vote followed by contestant name or number in live chat (e.g. !vote Mary)", 540, noteY, 14, p.theme === "light" ? "#475569" : p.muted, 750, "center");
  textC(c, "BB20 OFFICIAL VOTING DESK • 100% SECURE & ACCREDITED • AUTOMATED LIVE STREAM", 540, noteY + 22, 12, p.theme === "light" ? "#64748b" : "#475569", 600, "center");
}

// ---------------------- SCREENS ---------------------- //

function drawLeaderCard(c, p, leader, totalVotes, secondVotes, now, x = 40, y = 368, w = 1000, h = 94, anim = null) {
  const isVotedCard = (state.chatVoteFlashContestant === leader.no && (now - state.chatVoteFlashAt < 6000));
  const curV = getAnimatedVotes(leader, now);
  shownVotes.set(leader.no, curV);

  c.save();
  if (anim && anim.scale && anim.scale !== 1.0) {
    const cx = x + w / 2, cy = y + h / 2;
    c.translate(px(cx), py(cy));
    c.scale(anim.scale, anim.scale);
    c.translate(-px(cx), -py(cy));
  }

  // 1. Leader Card Background
  c.fillStyle = p.card;
  rr(c, x, y, w, h, 18);
  c.fill();

  // Overtake or voted glowing border (Fast crisp layered border without Gaussian shadowBlur)
  const isElevated = (anim?.elevation > 0 || anim?.overtaking);
  if (isElevated) {
    c.strokeStyle = p.goldBright;
    c.lineWidth = ps(3.2);
    rr(c, x, y, w, h, 18);
    c.stroke();
    c.strokeStyle = anim.flashGlow > 0.4 ? "rgba(251, 191, 36, 0.45)" : "rgba(56, 189, 248, 0.45)";
    c.lineWidth = ps(6.5);
    rr(c, x, y, w, h, 18);
    c.stroke();
  } else if (isVotedCard) {
    const pulseGlow = (Math.sin(now * 0.012) > 0) ? p.cyan : p.goldBright;
    c.strokeStyle = pulseGlow;
    c.lineWidth = ps(3.0);
    rr(c, x, y, w, h, 18);
    c.stroke();
    c.strokeStyle = pulseGlow === p.cyan ? "rgba(56, 189, 248, 0.35)" : "rgba(251, 191, 36, 0.35)";
    c.lineWidth = ps(6.0);
    rr(c, x, y, w, h, 18);
    c.stroke();
  } else {
    c.strokeStyle = p.goldBright;
    c.lineWidth = ps(2.4);
    rr(c, x, y, w, h, 18);
    c.stroke();
  }

  // Dynamic Specular Laser Sheen Sweep across the leader card
  const cardSheenT = ((now + 1000) % 4500) / 1200;
  if (cardSheenT <= 1.0) {
    const sheenX = x + cardSheenT * (w + 140) - 70;
    c.save();
    c.beginPath();
    rr(c, x, y, w, h, 18);
    c.clip();
    const sGrad = c.createLinearGradient(px(sheenX), py(y), px(sheenX + 70), py(y + h));
    sGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
    sGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.22)");
    sGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    c.fillStyle = sGrad;
    c.fillRect(px(sheenX - 40), py(y), ps(150), ps(h));
    c.restore();
  }

  // 2. Leader Avatar with Golden Halo Ring & Orbiting Starlight
  const avX = x + 58, avY = y + h / 2, avR = 34;
  c.save();
  c.strokeStyle = p.goldBright;
  c.lineWidth = ps(2.6);
  c.beginPath();
  c.arc(px(avX), py(avY), ps(avR + 2), 0, Math.PI * 2);
  c.stroke();
  c.restore();

  // Floating bobbing 3D Royal Crown right above avatar's head
  const crownBob = Math.sin(now * 0.004) * 3;
  drawCrown(c, avX, avY - avR - 10 + crownBob, 12, p.goldBright);
  drawMagicSparkle(c, avX, avY - avR - 14 + crownBob, 5, now * 2, "#ffffff");

  // Orbiting diamond stars revolving around the leader avatar
  for (let oi = 0; oi < 3; oi++) {
    const ang = (now * 0.0022) + (oi * Math.PI * 2 / 3);
    const ox = avX + Math.cos(ang) * (avR + 8);
    const oy = avY + Math.sin(ang) * (avR + 8);
    drawMagicSparkle(c, ox, oy, 4.2, now + oi * 400, (oi % 2 === 0) ? p.goldBright : "#ffffff");
  }

  const img = contestantImages.get(leader.no);
  drawAvatar(c, leader.no, avX, avY, avR, p, img);

  // Sparkles around leader avatar when voted
  if (isVotedCard) {
    const pulseRot = now * 0.007;
    drawMagicSparkle(c, avX + Math.cos(pulseRot) * (avR + 8), avY + Math.sin(pulseRot) * (avR + 8), 5.5, now, p.goldBright);
    drawMagicSparkle(c, avX + Math.cos(pulseRot + Math.PI) * (avR + 8), avY + Math.sin(pulseRot + Math.PI) * (avR + 8), 5.5, now + 300, "#ffffff");
  }

  // 3. Rank #1 Crown Badge
  const rankX = x + 24, rankY = y + 24, rankR = 15;
  c.fillStyle = "#fbbf24";
  c.beginPath();
  c.arc(px(rankX), py(rankY), ps(rankR), 0, Math.PI * 2);
  c.fill();
  drawCrown(c, rankX, rankY - 1, 10, "#0f172a");

  // 4. Command Pill (!vote 1) — Enlarged & bold for high mobile readability
  const cmdW = 108, cmdH = 30, cmdX = x + 108, cmdY = y + 14;
  c.fillStyle = "#fbbf24";
  rr(c, cmdX, cmdY, cmdW, cmdH, 9);
  c.fill();
  c.strokeStyle = "#f59e0b";
  c.lineWidth = ps(1.4);
  rr(c, cmdX, cmdY, cmdW, cmdH, 9);
  c.stroke();
  textC(c, `!vote ${leader.no}`, cmdX + cmdW / 2, cmdY + 21, 16.5, "#0f172a", 900, "center");

  // 5. Leader Name & Tag — Enlarged & bold
  textC(c, fit(leader.displayName || leader.name, 20), cmdX + cmdW + 14, y + 38, 28, p.text, 800);
  if (anim?.overtaking) {
    textC(c, "NEW LEADER! ⚡", cmdX + cmdW + 14, y + 58, 14.5, p.goldBright, 900);
  } else {
    textC(c, "CURRENT LEADER", cmdX + cmdW + 14, y + 58, 14.5, p.goldBright, 800);
  }

  // 6. Votes, Percentage & Lead Gap (Right) — Enlarged & bold
  const pct = totalVotes > 0 ? ((leader.votes / totalVotes) * 100) : 0;
  textC(c, `${Math.round(curV).toLocaleString()} votes`, x + w - 210, y + 38, 26, p.goldBright, 800, "right");
  textC(c, `${pct.toFixed(1)}%`, x + w - 30, y + 38, 26, p.text, 800, "right");

  const leadGap = Math.max(0, leader.votes - (secondVotes || 0));
  textC(c, `+${leadGap.toLocaleString()} lead over #2`, x + w - 30, y + 60, 15, p.cyan, 750, "right");

  // Floating +1 VOTE celebratory badge on leader card
  if (isVotedCard) {
    const age = now - state.chatVoteFlashAt;
    const fade = Math.max(0, 1 - age / 6000);
    const badgeW = 98, badgeH = 26;
    const badgeX = x + w - 210, badgeY = y + 10 - (1 - fade) * 16;
    c.save();
    c.globalAlpha = Math.min(1, fade * 1.5);
    const bgG = c.createLinearGradient(px(badgeX), 0, px(badgeX + badgeW), 0);
    bgG.addColorStop(0, p.cyan);
    bgG.addColorStop(1, p.goldBright);
    c.fillStyle = bgG;
    rr(c, badgeX, badgeY, badgeW, badgeH, 13);
    c.fill();
    c.strokeStyle = "#ffffff";
    c.lineWidth = ps(1.1);
    rr(c, badgeX, badgeY, badgeW, badgeH, 13);
    c.stroke();
    textC(c, "+1 VOTE ⚡", badgeX + badgeW / 2, badgeY + 17, 13.5, "#0f172a", 950, "center");
    drawMagicSparkle(c, badgeX - 6, badgeY + badgeH / 2, 6, now + 150, p.goldBright);
    drawMagicSparkle(c, badgeX + badgeW + 6, badgeY + badgeH / 2, 6, now + 350, "#ffffff");
    c.restore();
  }

  // 7. Golden Progress Bar with Specular Sweep
  const barX = cmdX, barY = y + 70, barW = w - (cmdX - x) - 30, barH = 14;
  c.fillStyle = p.barBg;
  rr(c, barX, barY, barW, barH, barH / 2);
  c.fill();
  c.fillStyle = p.goldBright;
  rr(c, barX, barY, barW, barH, barH / 2);
  c.fill();

  const lSweepW = 80;
  const lSweepPos = barX + ((now * 0.2) % (barW + lSweepW * 2)) - lSweepW;
  const lStartX = Math.max(barX, lSweepPos);
  const lEndX = Math.min(barX + barW, lSweepPos + lSweepW);
  if (lEndX > lStartX) {
    c.fillStyle = "rgba(255, 255, 255, 0.45)";
    c.fillRect(px(lStartX), py(barY), ps(lEndX - lStartX), ps(barH));
  }

  // Confetti burst on leader profile card when voted
  if (isVotedCard) {
    const age = now - state.chatVoteFlashAt;
    const fade = Math.max(0, 1 - age / 4000);
    const confettiColors = ["#fbbf24", "#38bdf8", "#ec4899", "#4ade80", "#f97316", "#ffffff", "#a855f7"];
    c.save();
    c.globalAlpha = Math.min(1, fade * 1.4);
    for (let ci = 0; ci < 24; ci++) {
      const pTime = (age * 0.001) + ci * 0.10;
      const seedX = (Math.sin(ci * 4.3) * 0.5 + 0.5) * w;
      const swayX = Math.sin(pTime * 4 + ci) * 16;
      const confX = x + seedX + swayX;
      const confY = y + h * 0.35 - Math.sin(Math.min(1.5, pTime) * Math.PI * 0.5) * 25 + Math.pow(pTime, 1.3) * 65;
      const rot = pTime * 6 + ci;
      const col = confettiColors[ci % confettiColors.length];
      const sz = 5 + (ci % 4);
      c.save();
      c.translate(px(confX), py(confY));
      c.rotate(rot);
      c.scale(1, Math.cos(rot * 2));
      c.fillStyle = col;
      c.fillRect(px(-sz), py(-sz * 0.6), ps(sz * 2), ps(sz * 1.2));
      c.restore();
    }
    c.restore();
  }

  c.restore();
}

// High-performance Card Base Cache for compact contestant cards
const compactCardCache = new Map();

function getCompactCardStatic(item, p) {
  const key = `${item.no}_${p.theme}_${W}_${H}`;
  let cached = compactCardCache.get(key);
  if (cached) return cached;

  const cardW = 490, cardH = 96;
  const pw = Math.round(px(cardW)), ph = Math.round(py(cardH));
  const sc = createCanvas(pw, ph);
  const sctx = sc.getContext("2d");

  // 1. Card Background
  sctx.fillStyle = p.card;
  rr(sctx, 0, 0, cardW, cardH, 16);
  sctx.fill();

  // 2. Card Border
  sctx.strokeStyle = p.cardBorder;
  sctx.lineWidth = ps(1.3);
  rr(sctx, 0, 0, cardW, cardH, 16);
  sctx.stroke();

  // 3. Avatar
  const avX = 44, avY = cardH / 2 - 2, avR = 28;
  const img = contestantImages.get(item.no);
  drawAvatar(sctx, item.no, avX, avY, avR, p, img);

  // 4. Command Pill (!vote X)
  const cmdX = 82, cmdY = 10, cmdW = 92, cmdH = 26;
  sctx.fillStyle = p.theme === "light" ? "rgba(2, 132, 199, 0.12)" : "rgba(56, 189, 248, 0.18)";
  rr(sctx, cmdX, cmdY, cmdW, cmdH, 7);
  sctx.fill();
  sctx.strokeStyle = p.cyan;
  sctx.lineWidth = ps(1.4);
  rr(sctx, cmdX, cmdY, cmdW, cmdH, 7);
  sctx.stroke();
  textC(sctx, `!vote ${item.no}`, cmdX + cmdW / 2, cmdY + 18, 15.5, p.theme === "light" ? "#0369a1" : "#38bdf8", 900, "center");

  // 5. Contestant Display Name
  textC(sctx, fit(item.displayName || item.name, 16), cmdX + cmdW + 10, 30, 23, p.text, 800);

  // 6. Progress Bar Track
  const barX = cmdX, barY = 65, barW = cardW - cmdX - 16, barH = 11;
  sctx.fillStyle = p.barBg;
  rr(sctx, barX, barY, barW, barH, barH / 2);
  sctx.fill();

  // 7. Subtitles
  textC(sctx, fit(item.name, 22), barX, 91, 14, p.muted, 600);
  textC(sctx, `#${item.no} in BB20`, cardW - 16, 91, 14, p.muted, 700, "right");

  compactCardCache.set(key, sc);
  return sc;
}

function drawCompactContestantCard(c, p, item, rank, totalVotes, leaderVotes, now, x, y, w, h, anim = null) {
  // Rank-based color tier
  const colors = (rank === 1) ? ["#38bdf8", "#0284c7"] :
                 (rank === 2) ? ["#f472b6", "#db2777"] :
                 (rank <= 5)  ? ["#4ade80", "#16a34a"] :
                 (rank >= 13) ? ["#f87171", "#dc2626"] :
                 ["#94a3b8", "#64748b"];
  const rankColor = colors[0];
  const isVotedCard = (state.chatVoteFlashContestant === item.no && (now - state.chatVoteFlashAt < 6000));
  const isElevated = (anim?.elevation > 0 || anim?.overtaking);
  const isDanger = (rank >= 13); // Bottom eviction risk
  const isSafe = (rank <= 5);

  // Smooth vote number animation with analytical easing
  const curV = getAnimatedVotes(item, now);
  shownVotes.set(item.no, curV);

  c.save();
  if (anim && anim.scale && anim.scale !== 1.0) {
    const cx = x + w / 2, cy = y + h / 2;
    c.translate(px(cx), py(cy));
    c.scale(anim.scale, anim.scale);
    c.translate(-px(cx), -py(cy));
  }

  // 1. Draw pre-rendered static card base (instant blit < 0.05ms)
  const staticCard = getCompactCardStatic(item, p);
  c.drawImage(staticCard, px(x), py(y));

  // 2. Dynamic Border Highlights
  if (isElevated) {
    c.strokeStyle = anim.flashGlow > 0.4 ? p.goldBright : p.cyan;
    c.lineWidth = ps(2.8);
    rr(c, x, y, w, h, 16);
    c.stroke();
    c.strokeStyle = "rgba(255, 255, 255, 0.4)";
    c.lineWidth = ps(1.2);
    rr(c, x + 1, y + 1, w - 2, h - 2, 15);
    c.stroke();
  } else if (isVotedCard) {
    const pulseGlow = (Math.sin(now * 0.012) > 0) ? p.cyan : p.goldBright;
    c.strokeStyle = pulseGlow;
    c.lineWidth = ps(2.8);
    rr(c, x, y, w, h, 16);
    c.stroke();
    c.strokeStyle = "rgba(255, 255, 255, 0.45)";
    c.lineWidth = ps(1.1);
    rr(c, x + 1.2, y + 1.2, w - 2.4, h - 2.4, 15);
    c.stroke();
  } else if (isDanger) {
    const dangerPulse = 0.5 + 0.5 * Math.sin(now * 0.006 + rank * 0.8);
    c.strokeStyle = `rgba(239, 68, 68, ${0.40 + dangerPulse * 0.40})`;
    c.lineWidth = ps(1.4 + dangerPulse * 0.8);
    rr(c, x, y, w, h, 16);
    c.stroke();
  }

  // 3. Dynamic Avatar Rank Ring
  const avX = x + 44, avY = y + h / 2 - 2, avR = 28;
  c.strokeStyle = rankColor;
  c.lineWidth = ps(2.0);
  c.beginPath();
  c.arc(px(avX), py(avY), ps(avR + 1.5), 0, Math.PI * 2);
  c.stroke();

  if (isVotedCard) {
    drawMagicSparkle(c, avX + avR + 4, avY - avR + 4, 5, now, p.goldBright);
    drawMagicSparkle(c, avX - avR - 2, avY + avR - 4, 4.5, now + 300, "#ffffff");
  }

  // 4. Rank Badge on avatar shoulder — Enlarged & bold with Top 3 metallic finishes
  const rankX = x + 18, rankY = y + 18, rankR = 14;
  if (rank === 1) { // #2 Silver/Platinum Medal
    const silverGrad = c.createLinearGradient(px(rankX - rankR), py(rankY - rankR), px(rankX + rankR), py(rankY + rankR));
    silverGrad.addColorStop(0, "#ffffff");
    silverGrad.addColorStop(0.5, "#cbd5e1");
    silverGrad.addColorStop(1, "#94a3b8");
    c.fillStyle = silverGrad;
    c.beginPath();
    c.arc(px(rankX), py(rankY), ps(rankR), 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#ffffff";
    c.lineWidth = ps(1.2);
    c.stroke();
    textC(c, "2", rankX, rankY + 5, 14, "#0f172a", 900, "center");
    drawMagicSparkle(c, rankX + 7, rankY - 7, 4, now * 2, "#ffffff");
  } else if (rank === 2) { // #3 Bronze/Copper Medal
    const bronzeGrad = c.createLinearGradient(px(rankX - rankR), py(rankY - rankR), px(rankX + rankR), py(rankY + rankR));
    bronzeGrad.addColorStop(0, "#fde68a");
    bronzeGrad.addColorStop(0.5, "#d97706");
    bronzeGrad.addColorStop(1, "#92400e");
    c.fillStyle = bronzeGrad;
    c.beginPath();
    c.arc(px(rankX), py(rankY), ps(rankR), 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#fde68a";
    c.lineWidth = ps(1.2);
    c.stroke();
    textC(c, "3", rankX, rankY + 5, 14, "#ffffff", 900, "center");
    drawMagicSparkle(c, rankX + 7, rankY - 7, 3.8, now * 2, "#fde68a");
  } else if (isDanger) { // Bottom eviction threat
    const dangerPulse = 0.5 + 0.5 * Math.sin(now * 0.008 + rank);
    c.fillStyle = rankColor;
    c.beginPath();
    c.arc(px(rankX), py(rankY), ps(rankR), 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = `rgba(239, 68, 68, ${0.4 + 0.6 * dangerPulse})`;
    c.lineWidth = ps(2 + dangerPulse * 1.5);
    c.beginPath();
    c.arc(px(rankX), py(rankY), ps(rankR + 2), 0, Math.PI * 2);
    c.stroke();
    textC(c, String(rank + 1), rankX, rankY + 5, 14, "#ffffff", 900, "center");
  } else {
    c.fillStyle = rankColor;
    c.beginPath();
    c.arc(px(rankX), py(rankY), ps(rankR), 0, Math.PI * 2);
    c.fill();
    textC(c, String(rank + 1), rankX, rankY + 5, 14, "#ffffff", 900, "center");
  }

  // 5. Dynamic Status Tag (Far Right)
  if (isElevated) {
    const ovW = 104, ovH = 24;
    const ovX = x + w - ovW - 12, ovY = y + 14;
    const ovGrad = c.createLinearGradient(px(ovX), 0, px(ovX + ovW), 0);
    ovGrad.addColorStop(0, "#f59e0b");
    ovGrad.addColorStop(0.5, "#ef4444");
    ovGrad.addColorStop(1, "#ec4899");
    c.fillStyle = ovGrad;
    rr(c, ovX, ovY, ovW, ovH, 12);
    c.fill();
    c.strokeStyle = "#ffffff";
    c.lineWidth = ps(1.2);
    rr(c, ovX, ovY, ovW, ovH, 12);
    c.stroke();
    textC(c, "⚡ OVERTAKE ⚡", ovX + ovW / 2, ovY + 16, 12, "#ffffff", 950, "center");
    drawMagicSparkle(c, ovX - 6, ovY + ovH / 2, 5, now, "#fbbf24");
  } else if (isVotedCard) {
    const age = now - state.chatVoteFlashAt;
    const fade = Math.max(0, 1 - age / 6000);
    const bW = 86, bH = 22;
    const bX = x + w - bW - 12;
    const bY = y + 15 - (1 - fade) * 8;
    c.save();
    c.globalAlpha = Math.min(1, fade * 1.5);
    const bgG = c.createLinearGradient(px(bX), 0, px(bX + bW), 0);
    bgG.addColorStop(0, p.cyan);
    bgG.addColorStop(1, p.goldBright);
    c.fillStyle = bgG;
    rr(c, bX, bY, bW, bH, 11);
    c.fill();
    c.strokeStyle = "#ffffff";
    c.lineWidth = ps(1.0);
    rr(c, bX, bY, bW, bH, 11);
    c.stroke();
    textC(c, "+1 VOTE ⚡", bX + bW / 2, bY + 15, 12.5, "#0f172a", 950, "center");
    drawMagicSparkle(c, bX - 7, bY + bH / 2, 5, now + 150, p.goldBright);
    c.restore();
  } else if (isDanger) {
    const dangerPulse = 0.5 + 0.5 * Math.sin(now * 0.008 + rank);
    c.save();
    c.fillStyle = `rgba(239, 68, 68, ${0.15 + 0.20 * dangerPulse})`;
    rr(c, x + w - 74, y + 14, 62, 20, 6);
    c.fill();
    c.strokeStyle = `rgba(239, 68, 68, ${0.60 + 0.40 * dangerPulse})`;
    c.lineWidth = ps(1.2);
    rr(c, x + w - 74, y + 14, 62, 20, 6);
    c.stroke();
    textC(c, "⚠️ RISK", x + w - 43, y + 28, 12, "#ef4444", 900, "center");
    c.restore();
  } else if (isSafe) {
    textC(c, "SAFE", x + w - 14, y + 28, 13, "#4ade80", 800, "right");
  }

  // 6. Dynamic Votes + Percentage — Bigger fonts
  const cmdX = x + 82;
  const pct = totalVotes > 0 ? (item.votes / totalVotes) * 100 : 0;
  textC(c, `${Math.round(curV).toLocaleString()} votes`, cmdX, y + 55, 19, p.text, 700);
  textC(c, `${pct.toFixed(1)}%`, x + w - 14, y + 55, 20, rankColor, 900, "right");

  // 7. Dynamic Progress Bar Fill
  const barX = cmdX, barY = y + 65, barW = w - (cmdX - x) - 16, barH = 11;
  const ratio = leaderVotes > 0 ? Math.max(0.04, Math.min(1.0, curV / leaderVotes)) : 0.04;
  const fillW = Math.max(barH, barW * ratio);
  c.fillStyle = rankColor;
  rr(c, barX, barY, fillW, barH, barH / 2);
  c.fill();

  // Progress Bar Specular Glint (only compute on active or top ranks for crisp 30fps CFR)
  if (fillW > 24 && (rank <= 3 || isVotedCard || isElevated)) {
    const sweepW = 42;
    const sweepPos = barX + ((now * 0.16 + rank * 35) % (fillW + sweepW * 2)) - sweepW;
    const startX = Math.max(barX, sweepPos);
    const endX = Math.min(barX + fillW, sweepPos + sweepW);
    if (endX > startX) {
      c.fillStyle = "rgba(255, 255, 255, 0.4)";
      c.fillRect(px(startX), py(barY), ps(endX - startX), ps(barH));
    }
  }

  // Confetti celebration particles over contestant profile card when voted
  if (isVotedCard) {
    const age = now - state.chatVoteFlashAt;
    const fade = Math.max(0, 1 - age / 4000);
    const confettiColors = ["#fbbf24", "#38bdf8", "#ec4899", "#4ade80", "#f97316", "#ffffff", "#a855f7"];
    c.save();
    c.globalAlpha = Math.min(1, fade * 1.4);
    for (let ci = 0; ci < 18; ci++) {
      const pTime = (age * 0.001) + ci * 0.12;
      const seedX = (Math.sin(ci * 3.7) * 0.5 + 0.5) * w;
      const swayX = Math.sin(pTime * 4 + ci) * 14;
      const confX = px(x + seedX + swayX);
      const confY = py(y + h * 0.35 - Math.sin(Math.min(1.5, pTime) * Math.PI * 0.5) * 20 + Math.pow(pTime, 1.3) * 60);
      const rot = pTime * 6 + ci;
      const col = confettiColors[ci % confettiColors.length];
      const sz = ps(4 + (ci % 4));
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const scaleY = Math.cos(rot * 2);
      c.setTransform(cosR, sinR, -sinR * scaleY, cosR * scaleY, confX, confY);
      c.fillStyle = col;
      c.fillRect(-sz, -sz * 0.6, sz * 2, sz * 1.2);
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.restore();
  }

  c.restore();
}

function formatTimeAgo(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 5) return "Just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) {
    return remM > 0 ? `${h}h ${remM}m ago` : `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `${d}d ${remH}h ago` : `${d}d ago`;
}

function drawLiveVoteFeed(c, p, now, y = 1445, h = 270) {
  // Translucent backdrop panel
  c.fillStyle = p.theme === "light" ? "rgba(255, 255, 255, 0.98)" : "rgba(12, 21, 38, 0.96)";
  rr(c, 40, y, 1000, h, 20);
  c.fill();
  c.strokeStyle = p.theme === "light" ? "#cbd5e1" : p.cardBorder;
  c.lineWidth = ps(1.5);
  rr(c, 40, y, 1000, h, 20);
  c.stroke();

  // Header of Feed — Dynamic Broadcast News Marquee & Vote Streak Pill
  c.fillStyle = p.theme === "light" ? "rgba(2, 132, 199, 0.08)" : "rgba(245, 158, 11, 0.12)";
  rr(c, 56, y + 14, 968, 34, 17);
  c.fill();
  c.strokeStyle = p.theme === "light" ? "#0284c7" : p.goldBright;
  c.lineWidth = ps(1.2);
  rr(c, 56, y + 14, 968, 34, 17);
  c.stroke();

  // Left Tag: Pulsing Red LIVE BREAKING Pill
  const livePulse = 0.5 + 0.5 * Math.sin(now * 0.008);
  c.fillStyle = `rgba(239, 68, 68, ${0.85 + 0.15 * livePulse})`;
  rr(c, 62, y + 18, 118, 26, 13);
  c.fill();
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.arc(px(76), py(y + 31), ps(3.5 + livePulse * 1.2), 0, Math.PI * 2);
  c.fill();
  textC(c, "BREAKING", 122, y + 36, 12.5, "#ffffff", 950, "center");

  // Rotating Live Ticker Items
  const leaderItem = stats()[0] || { displayName: "Leader", votes: 0 };
  const lastV = state.lastVote;
  const lastCandidate = lastV ? (config.contestants.find(x => x.no === lastV.contestant)?.displayName || `#${lastV.contestant}`) : null;
  const tickerItems = [
    lastV ? `⚡ LATEST VOTE: @${lastV.name || "Viewer"} voted for ${lastCandidate}!` : `⚡ VOTING ACTIVE: Type !vote <1-17> in live chat to support!`,
    `👑 LEADER STANDINGS: ${leaderItem.displayName || leaderItem.name} leads with ${Number(leaderItem.votes || 0).toLocaleString()} votes!`,
    `⚠️ EVICTION WARNING: Bottom 3 contestants are currently in the Danger Zone!`,
    `🎮 CHAT COMMANDS: !vote <1-17> • !track <1-40> • !magic • !drop • !bomb`,
    `💎 PRO-TIP: Double-tap the video on YouTube for special celebration magic!`
  ];
  const tickerCycle = 4000;
  const tickerIdx = Math.floor(now / tickerCycle) % tickerItems.length;
  const tickerPhase = (now % tickerCycle) / tickerCycle;
  const tickerFade = tickerPhase < 0.1 ? (tickerPhase / 0.1) : tickerPhase > 0.9 ? ((1 - tickerPhase) / 0.1) : 1;

  c.save();
  c.globalAlpha = Math.max(0, Math.min(1, tickerFade));
  const headerCol = p.theme === "light" ? "#0369a1" : p.goldBright;
  textC(c, tickerItems[tickerIdx], 530, y + 36, 14.5, headerCol, 850, "center");
  c.restore();

  // Active Vote Streak Pill (Right Side)
  const streak = (state.recentVotes || []).filter(v => (now - (v.at || 0)) < 15000).length;
  if (streak >= 2) {
    const stW = 126, stH = 26;
    const stX = 56 + 968 - stW - 6, stY = y + 18;
    const stGrad = c.createLinearGradient(px(stX), 0, px(stX + stW), 0);
    stGrad.addColorStop(0, "#ef4444");
    stGrad.addColorStop(0.5, "#f97316");
    stGrad.addColorStop(1, "#fbbf24");
    c.fillStyle = stGrad;
    rr(c, stX, stY, stW, stH, 13);
    c.fill();
    c.strokeStyle = "#ffffff";
    c.lineWidth = ps(1.2);
    rr(c, stX, stY, stW, stH, 13);
    c.stroke();
    textC(c, `🔥 ${streak}x STREAK!`, stX + stW / 2, stY + 18, 13, "#ffffff", 950, "center");
    drawMagicSparkle(c, stX - 6, stY + stH / 2, 5, now, "#fbbf24");
    drawMagicSparkle(c, stX + stW + 6, stY + stH / 2, 5, now + 300, "#ffffff");
  }

  // Get recent votes
  const recent = state.recentVotes.slice(-4).reverse();
  const rows = [];
  if (recent.length > 0) {
    recent.forEach(v => {
      const cItem = config.contestants.find(x => x.no === v.contestant);
      const cName = cItem?.displayName || cItem?.name || `Contestant #${v.contestant}`;
      const elapsed = Math.max(0, Math.floor((now - (v.at || now)) / 1000));
      const timeStr = formatTimeAgo(elapsed);
      const isLeader = stats()[0]?.no === v.contestant;
      rows.push({
        user: fit(v.name || "Live Voter", 16),
        text: `voted for #${v.contestant} ${cName}`,
        tag: isLeader ? "👑 LEADER" : "+1 VOTE ⚡",
        col: isLeader ? p.goldBright : p.cyan,
        time: timeStr
      });
    });
  }

  // If fewer than 4 votes, supplement with recent chat or prompt rows
  if (rows.length < 4) {
    const chatItems = state.recentChat.slice(-(4 - rows.length)).reverse();
    chatItems.forEach(ch => {
      const elapsed = Math.max(0, Math.floor((now - (ch.at || now)) / 1000));
      rows.push({
        user: fit(ch.name || "Viewer", 16),
        text: fit(ch.text || "", 44),
        tag: "CHAT 💬",
        col: p.muted,
        time: formatTimeAgo(elapsed)
      });
    });
  }

  // Fallback defaults if brand new session
  while (rows.length < 4) {
    const defaultIdx = rows.length;
    const defaults = [
      { user: "Live_Streamer", text: "Voting is OPEN! Vote via chat (e.g. !vote Mary)", tag: "LIVE", col: p.goldBright, time: "Active" },
      { user: "BB20_Viewer", text: "Track rank overtakes live with smooth animations", tag: "INFO", col: p.cyan, time: "Active" },
      { user: "Chat_Bot", text: "Use !track <1-40> or !track loop to change music", tag: "MUSIC", col: "#ec4899", time: "Active" },
      { user: "Vote_Counter", text: "Every accepted vote updates scores in real-time", tag: "VERIFIED", col: "#22c55e", time: "Active" }
    ];
    rows.push(defaults[defaultIdx]);
  }

  // Draw 4 activity rows
  rows.slice(0, 4).forEach((row, i) => {
    const rowY = y + 58 + i * 48;
    c.fillStyle = (p.theme === "light")
      ? (i % 2 === 0 ? "rgba(15, 23, 42, 0.04)" : "rgba(15, 23, 42, 0.02)")
      : (i % 2 === 0 ? "rgba(255, 255, 255, 0.03)" : "rgba(255, 255, 255, 0.015)");
    rr(c, 56, rowY, 968, 42, 10);
    c.fill();
    c.strokeStyle = (p.theme === "light") ? "rgba(203, 213, 225, 0.5)" : "rgba(255, 255, 255, 0.04)";
    c.lineWidth = ps(1);
    rr(c, 56, rowY, 968, 42, 10);
    c.stroke();

    const actionCol = (p.theme === "light") ? "#b45309" : p.goldBright;
    c.fillStyle = row.col;
    c.beginPath();
    c.arc(px(76), py(rowY + 21), ps(4), 0, Math.PI * 2);
    c.fill();

    textC(c, fit(row.user, 14), 96, rowY + 28, 16, p.text, 800);
    textC(c, fit(row.text, 40), 285, rowY + 28, 16, actionCol, 700);

    // Tag pill on right
    const tagBg = (p.theme === "light")
      ? (row.col === p.cyan ? "rgba(2, 132, 199, 0.14)" : (row.col === p.goldBright ? "rgba(217, 119, 6, 0.14)" : "rgba(100, 116, 139, 0.14)"))
      : (row.col === p.cyan ? "rgba(56, 189, 248, 0.18)" : (row.col === p.goldBright ? "rgba(245, 158, 11, 0.18)" : "rgba(148, 163, 184, 0.18)"));
    const tagTextCol = (p.theme === "light")
      ? (row.col === p.goldBright ? "#b45309" : row.col === p.cyan ? "#0369a1" : "#334155")
      : row.col;
    rr(c, 890, rowY + 9, 115, 25, 7);
    c.fillStyle = tagBg;
    c.fill();
    textC(c, row.tag, 947, rowY + 26, 13, tagTextCol, 900, "center");

    textC(c, row.time, 860, rowY + 28, 13.5, p.muted, 650, "right");
  });
}

function drawVoteScreenContent(c, p, now) {
  const ranking = stats();
  const total = Math.max(1, state.totalAcceptedVotes);
  const leader = ranking[0] || { no: 1, name: "Leader", votes: 0 };
  const second = ranking[1] || { votes: 0 };
  const leaderVotes = Math.max(1, leader.votes || 1);

  const colW = 490, cardH = 96, rowGap = 8, colGap = 20;

  // 1. Analytical, deterministic card positions based on state.rankTransitions (Smooth sliding across workers)
  const renderList = ranking.map((item, r) => {
    let targetX, targetY, targetW, targetH;
    if (r === 0) {
      targetX = 40;
      targetY = 368;
      targetW = 1000;
      targetH = 94;
    } else {
      const isLeft = (r <= 8);
      const rowIndex = isLeft ? (r - 1) : (r - 9);
      targetX = isLeft ? 40 : (40 + colW + colGap);
      targetY = 472 + rowIndex * (cardH + rowGap);
      targetW = colW;
      targetH = cardH;
    }

    let x = targetX, y = targetY, w = targetW, h = targetH;
    let scale = 1.0, elevation = 0, flashGlow = 0, isOvertaking = false;
    let displayRank = r;
    const trans = state.rankTransitions?.[String(item.no)] || state.rankTransitions?.[item.no];

    if (trans) {
      if (now < trans.startMs) {
        // Vote alert still showing in mid: keep card held at original from position and old rank!
        x = trans.fromX;
        y = trans.fromY;
        w = trans.fromW;
        h = trans.fromH;
        displayRank = trans.oldRank;
        if (trans.isOvertake) {
          // Subtle anticipation glow while the vote alert plays in middle
          elevation = 1;
          flashGlow = 0.4 + 0.3 * Math.sin(now * 0.015);
        }
      } else if (now - trans.startMs < trans.durationMs) {
        // Vote alert has completed! Now smoothly execute the surpassing animation!
        const pRatio = Math.min(1, Math.max(0, (now - trans.startMs) / trans.durationMs));
        const ease = pRatio < 0.5 ? 4 * pRatio * pRatio * pRatio : 1 - Math.pow(-2 * pRatio + 2, 3) / 2;
        x = trans.fromX + (trans.toX - trans.fromX) * ease;
        y = trans.fromY + (trans.toY - trans.fromY) * ease;
        w = trans.fromW + (trans.toW - trans.fromW) * ease;
        h = trans.fromH + (trans.toH - trans.fromH) * ease;
        displayRank = (pRatio < 0.5) ? trans.oldRank : trans.newRank;
        if (trans.isOvertake) {
          elevation = 2; // Glides smoothly ON TOP of other cards
          scale = 1.0 + Math.sin(pRatio * Math.PI) * 0.045; // 3D lift pop
          flashGlow = Math.sin(pRatio * Math.PI);
          isOvertaking = true;
          if (overtakeParticles.length < 60 && Math.random() < 0.35) {
            const ang = Math.random() * Math.PI * 2;
            const sp = 40 + Math.random() * 90;
            overtakeParticles.push({
              x: x + w * Math.random(),
              y: y + h * Math.random(),
              vx: Math.cos(ang) * sp,
              vy: Math.sin(ang) * sp - 25,
              born: now,
              maxLife: 800 + Math.random() * 600,
              size: 4 + Math.random() * 4,
              color: p.goldBright
            });
          }
        } else {
          elevation = 0;
          scale = 1.0 - Math.sin(pRatio * Math.PI) * 0.015;
        }
      }
    }

    return {
      item,
      targetRank: r,
      displayRank,
      anim: {
        x, y, w, h, scale, elevation, flashGlow,
        targetRank: r,
        currentRank: displayRank,
        overtaking: isOvertaking
      }
    };
  }).sort((a, b) => (a.anim.elevation || 0) - (b.anim.elevation || 0));

  renderList.forEach(({ item, targetRank, displayRank, anim }) => {
    if (displayRank === 0) {
      drawLeaderCard(c, p, item, total, second.votes, now, anim.x, anim.y, anim.w, anim.h, anim);
    } else {
      drawCompactContestantCard(c, p, item, displayRank, total, leaderVotes, now, anim.x, anim.y, anim.w, anim.h, anim);
    }
  });

  // Render overtake stardust particles
  if (overtakeParticles.length > 0) {
    c.save();
    for (let i = overtakeParticles.length - 1; i >= 0; i--) {
      const q = overtakeParticles[i];
      const age = now - q.born;
      if (age > q.maxLife) {
        overtakeParticles.splice(i, 1);
        continue;
      }
      const t = age / q.maxLife;
      const alpha = 1 - t;
      const dtSec = currentFrameDt || 0.033;
      q.x += q.vx * dtSec;
      q.y += q.vy * dtSec;
      c.globalAlpha = alpha;
      c.fillStyle = q.color;
      c.beginPath();
      c.arc(px(q.x), py(q.y), ps(q.size * (1 - t * 0.5)), 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  // 3. Bottom Stats Telemetry Cards (Y = 1315, H = 110)
  drawBottomStats(c, p, now, 1315, 110);

  // 4. Dedicated Live Vote Feed & Chat Interaction Panel (Y = 1445, H = 270)
  drawLiveVoteFeed(c, p, now, 1445, 270);
}

function drawVoteScreen(c, p, now) {
  drawHero(c, p, now, "LIVE VOTING");
  drawVoteScreenContent(c, p, now);
  drawFooter(c, p, now, 1735);
}

function drawRaceScreenContent(c, p, now) {
  const ranking = stats();
  const max = Math.max(1, ranking[0]?.votes || 1);
  const top8 = ranking.slice(0, 8);

  const rowY = 428, rowH = 80, gap = 6;
  const dt = currentFrameDt;
  const factor = 1 - Math.exp(-14.0 * dt);

  // Update animated row positions for each racer
  top8.forEach((item, i) => {
    const targetY = rowY + i * (rowH + gap);
    let rAnim = raceAnimPositions.get(item.no);
    if (!rAnim) {
      rAnim = { no: item.no, y: targetY, targetY, rank: i, scale: 1.0, overtaking: false, flashGlow: 0 };
      raceAnimPositions.set(item.no, rAnim);
    } else {
      if (i < rAnim.rank) {
        rAnim.overtaking = true;
        rAnim.scale = 1.03;
        rAnim.flashGlow = 1.0;
      }
      rAnim.rank = i;
      rAnim.targetY = targetY;
    }
    rAnim.y += (rAnim.targetY - rAnim.y) * factor;
    rAnim.scale += (1.0 - rAnim.scale) * factor * 0.7;
    rAnim.flashGlow = Math.max(0, rAnim.flashGlow - dt * 2.5);
    if (Math.abs(rAnim.targetY - rAnim.y) < 1.0) {
      rAnim.y = rAnim.targetY;
      rAnim.overtaking = false;
    }
  });

  // Sort by overtaking elevation before drawing
  const raceList = top8.map((item, i) => ({
    item,
    i,
    anim: raceAnimPositions.get(item.no)
  })).sort((a, b) => (a.anim?.overtaking ? 1 : 0) - (b.anim?.overtaking ? 1 : 0));

  raceList.forEach(({ item, i, anim }) => {
    const y = anim ? anim.y : (rowY + i * (rowH + gap));
    const colors = p.rankGradients[i % p.rankGradients.length];

    c.save();
    if (anim?.overtaking) {
      c.strokeStyle = "rgba(251, 191, 36, 0.4)";
      c.lineWidth = ps(6);
      rr(c, 40, y, 1000, rowH, 16);
      c.stroke();
    }
    c.fillStyle = p.card;
    rr(c, 40, y, 1000, rowH, 16);
    c.fill();
    c.strokeStyle = (anim?.overtaking || i === 0) ? p.goldBright : p.cardBorder;
    c.lineWidth = ps((anim?.overtaking || i === 0) ? 2.4 : 1.2);
    rr(c, 40, y, 1000, rowH, 16);
    c.stroke();
    c.restore();

    // Rank
    textC(c, `#${i + 1}`, 82, y + 48, 24, i === 0 ? p.goldBright : p.text, 800, "center");

    // Avatar
    drawAvatar(c, item.no, 150, y + rowH / 2, 26, p, contestantImages.get(item.no));

    // Command pill badge in front of name
    const cmdW = 92, cmdH = 24, cmdX = 195, cmdY = y + 14;
    c.save();
    if (i === 0) {
      const cg = c.createLinearGradient(px(cmdX), 0, px(cmdX + cmdW), 0);
      cg.addColorStop(0, "#fbbf24");
      cg.addColorStop(1, "#f59e0b");
      c.fillStyle = cg;
      rr(c, cmdX, cmdY, cmdW, cmdH, 8);
      c.fill();
      textC(c, `!vote ${item.no}`, cmdX + cmdW / 2, cmdY + 17, 14, "#0f172a", 950, "center");
    } else {
      c.fillStyle = p.theme === "light" ? "rgba(2, 132, 199, 0.12)" : "rgba(14, 165, 233, 0.20)";
      rr(c, cmdX, cmdY, cmdW, cmdH, 8);
      c.fill();
      c.strokeStyle = p.theme === "light" ? "#0284c7" : "#38bdf8";
      c.lineWidth = ps(1.2);
      rr(c, cmdX, cmdY, cmdW, cmdH, 8);
      c.stroke();
      textC(c, `!vote ${item.no}`, cmdX + cmdW / 2, cmdY + 17, 14, p.theme === "light" ? "#0369a1" : "#38bdf8", 900, "center");
    }
    c.restore();

    // Name placed right after command badge
    textC(c, fit(item.displayName || item.name, 15), cmdX + cmdW + 10, y + 33, 21, p.text, 800);

    // Smooth race vote interpolation
    const oldV = shownRaceVotes.get(item.no) ?? (item.votes || 0);
    const curV = isNaN(oldV) ? (item.votes || 0) : (oldV + ((item.votes || 0) - oldV) * ease(8, dt));
    shownRaceVotes.set(item.no, curV);

    const votesStr = Math.round(curV).toLocaleString();
    textC(c, `${votesStr} votes`, 880, y + 36, 20, p.text, 700, "right");

    if (i === 0) {
      drawCrown(c, 925, y + 30, 10, p.goldBright);
      drawGlint(c, 925, y + 20, 5, now, "#ffffff");
      textC(c, "LEADER", 1005, y + 36, 15, p.goldBright, 800, "right");
    } else if (anim?.overtaking) {
      textC(c, "OVERTAKE! ⚡", 1005, y + 36, 14, p.goldBright, 900, "right");
    } else {
      const gapToLead = Math.max(0, (ranking[0]?.votes || 0) - (item.votes || 0));
      textC(c, `-${gapToLead.toLocaleString()}`, 1005, y + 36, 15, p.red, 700, "right");
    }

    // Mini progress bar with smooth eased length
    const barW = 790, barH = 11;
    c.fillStyle = p.barBg;
    rr(c, 195, y + 50, barW, barH, barH / 2);
    c.fill();
    const pct = Math.min(1, Math.max(0.02, curV / max));
    const fillW = Math.max(barH, barW * pct);
    c.fillStyle = colors[0];
    rr(c, 195, y + 50, fillW, barH, barH / 2);
    c.fill();
    if (i < 3 && fillW > 40) {
      const sw = 40;
      const sp = 195 + ((now * (0.14 + i * 0.02)) % (fillW + sw * 2)) - sw;
      c.save();
      c.beginPath();
      c.roundRect(px(195), py(y + 50), ps(fillW), ps(barH), ps(barH / 2));
      c.clip();
      const rGlint = c.createLinearGradient(px(sp), 0, px(sp + sw), 0);
      rGlint.addColorStop(0, "rgba(255, 255, 255, 0)");
      rGlint.addColorStop(0.5, "rgba(255, 255, 255, 0.4)");
      rGlint.addColorStop(1, "rgba(255, 255, 255, 0)");
      c.fillStyle = rGlint;
      c.fillRect(px(sp), py(y + 50), ps(sw), ps(barH));
      c.restore();
    }
  });

  // More contestants summary box
  const rest = ranking.slice(8);
  if (rest.length) {
    const boxY = 1120, boxH = 46;
    c.fillStyle = p.card;
    rr(c, 40, boxY, 1000, boxH, 14);
    c.fill();
    c.strokeStyle = p.cardBorder;
    rr(c, 40, boxY, 1000, boxH, 14);
    c.stroke();
    const listStr = rest.slice(0, 5).map((x, idx) => `#${idx + 9} ${fit(x.displayName || x.name, 9)} (!vote ${x.no})`).join("   •   ");
    textC(c, listStr, 540, boxY + 29, 16, p.muted, 700, "center");
  }

  // Dual Viewers, Views, Votes & Time Left Telemetry Cards on Race Screen!
  drawBottomStats(c, p, now, 1178, 122);
}

function drawRaceScreen(c, p, now) {
  drawHero(c, p, now, "RANK RACE");
  drawRaceScreenContent(c, p, now);
}

function recentVoteRate() {
  const now = Date.now();
  return state.recentVotes.filter(v => now - (v.at || 0) < 60000).length;
}

function drawStatsScreenContent(c, p, now) {
  const rawViewers = runtime.chat.viewerCount;
  const viewersCount = (typeof rawViewers === "number" && rawViewers >= 0) ? rawViewers : 0;
  const vCountStr = viewersCount >= 1000000 ? `${(viewersCount / 1000000).toFixed(1)}M` : viewersCount >= 1000 ? `${(viewersCount / 1000).toFixed(1)}K` : String(viewersCount);
  const rawViews = runtime.chat.viewCount || state.totalViews || 0;
  const viewsCount = rawViews > 0 ? rawViews : viewersCount;
  const viewsStr = viewsCount >= 1000000 ? `${(viewsCount / 1000000).toFixed(1)}M` : viewsCount >= 1000 ? `${(viewsCount / 1000).toFixed(1)}K` : Number(viewsCount).toLocaleString();

  const rawSubs = runtime.chat?.subscriberCount || state?.subscriberCount || 54925;
  const subsCount = (typeof rawSubs === "number" && rawSubs > 0) ? rawSubs : 54925;
  const subsStr = subsCount >= 10000 ? `${(subsCount / 1000).toFixed(1)}K` : Number(subsCount).toLocaleString();

  const cards = [
    { x: 40, y: 428, w: 316, h: 115, label: "TOTAL VOTES", val: Number(state.totalAcceptedVotes || 0).toLocaleString(), col: p.goldBright },
    { x: 382, y: 428, w: 316, h: 115, label: "UNIQUE VOTERS", val: Number(state.uniqueVoters || 0).toLocaleString(), col: p.cyan },
    { x: 724, y: 428, w: 316, h: 115, label: "VOTES / MINUTE", val: String(recentVoteRate()), col: p.green },
    { x: 40, y: 555, w: 316, h: 115, label: "CHAT MESSAGES", val: Number(state.totalChatMessages || 0).toLocaleString(), col: p.pink },
    { x: 382, y: 555, w: 316, h: 115, label: "CONTESTANTS", val: String(config.contestants?.length || 17), col: p.goldBright },
    { x: 724, y: 555, w: 316, h: 115, label: "VOTING STATUS", val: state.votingOpen ? "OPEN ●" : "PAUSED", col: state.votingOpen ? "#22c55e" : "#ef4444" }
  ];


  cards.forEach(cd => {
    c.fillStyle = p.card;
    rr(c, cd.x, cd.y, cd.w, cd.h, 18);
    c.fill();
    c.strokeStyle = p.cardBorder;
    rr(c, cd.x, cd.y, cd.w, cd.h, 18);
    c.stroke();

    textC(c, cd.label, cd.x + 24, cd.y + 36, 16, p.muted, 700);
    textC(c, cd.val, cd.x + 24, cd.y + 84, 32, p.text, 800);

    c.fillStyle = cd.col;
    c.fillRect(px(cd.x + 24), py(cd.y + cd.h - 7), ps(cd.w - 48), ps(3));
  });

  // Leader Spotlight & Lead Margin
  const ranking = stats(), leader = ranking[0], second = ranking[1];
  const spotY = 688, spotH = 250;
  c.fillStyle = p.card;
  rr(c, 40, spotY, 1000, spotH, 20);
  c.fill();
  c.strokeStyle = p.goldBright;
  c.lineWidth = ps(2);
  rr(c, 40, spotY, 1000, spotH, 20);
  c.stroke();

  drawCrown(c, 75, spotY + 38, 12, p.goldBright);
  textC(c, "CURRENT LEADER", 100, spotY + 45, 18, p.goldBright, 800);
  if (leader) drawAvatar(c, leader.no, 125, spotY + 115, 44, p);

  // Command badge in front of leader name
  const lCmdW = 96, lCmdH = 28;
  const lCmdX = 185, lCmdY = spotY + 84;
  c.save();
  const lcg = c.createLinearGradient(px(lCmdX), 0, px(lCmdX + lCmdW), 0);
  lcg.addColorStop(0, "#fbbf24");
  lcg.addColorStop(1, "#f59e0b");
  c.fillStyle = lcg;
  rr(c, lCmdX, lCmdY, lCmdW, lCmdH, 8);
  c.fill();
  textC(c, `!vote ${leader?.no || 1}`, lCmdX + lCmdW / 2, lCmdY + 20, 15, "#0f172a", 950, "center");
  c.restore();

  textC(c, leader?.displayName || leader?.name || "Contestant", lCmdX + lCmdW + 12, spotY + 107, 34, p.text, 900);
  textC(c, `${Number(leader?.votes || 0).toLocaleString()} votes`, 185, spotY + 144, 22, p.muted, 700);

  const leadGap = Math.max(0, (leader?.votes || 0) - (second?.votes || 0));
  textC(c, "LEAD OVER #2", 640, spotY + 45, 18, p.muted, 800);
  textC(c, `+${leadGap.toLocaleString()}`, 640, spotY + 105, 42, p.goldBright, 900);
  const secondCmd = second?.no ? `(!vote ${second.no})` : "";
  textC(c, `vs ${second?.displayName || second?.name || "2nd"} ${secondCmd}`, 640, spotY + 148, 20, p.cyan, 700);

  // Chat Energy Meter
  const energy = clamp(Math.round(Math.min(100, recentVoteRate() * 10 + (state.totalChatMessages % 50) * 2)), 8, 100);
  textC(c, `CHAT ENERGY: ${energy}%`, 75, spotY + 198, 17, p.text, 800);
  c.fillStyle = p.barBg;
  rr(c, 75, spotY + 211, 890, 18, 9);
  c.fill();
  const eg = c.createLinearGradient(px(75), 0, px(75 + 890 * (energy / 100)), 0);
  eg.addColorStop(0, p.pink);
  eg.addColorStop(1, p.cyan);
  c.fillStyle = eg;
  rr(c, 75, spotY + 211, Math.max(18, 890 * (energy / 100)), 18, 9);
  c.fill();

  // Recent Live Activity Ticker
  const actY = 952, actH = 260;
  c.fillStyle = p.card;
  rr(c, 40, actY, 1000, actH, 20);
  c.fill();
  c.strokeStyle = p.cardBorder;
  rr(c, 40, actY, 1000, actH, 20);
  c.stroke();

  textC(c, "LIVE CHAT ACTIVITY", 75, actY + 44, 18, p.goldBright, 800);
  const recent = state.recentChat.slice(-4).reverse();
  if (!recent.length) {
    textC(c, "Waiting for chat messages...", 540, actY + 150, 22, p.muted, 700, "center");
  } else {
    recent.forEach((m, idx) => {
      const cy = actY + 84 + idx * 42;
      textC(c, fit(m.name, 16), 75, cy, 20, p.goldBright, 800);
      textC(c, fit(m.text, 54), 260, cy, 20, p.text, 600);
    });
  }

  drawBottomStats(c, p, now);
}

function drawStatsScreen(c, p, now) {
  drawHero(c, p, now, "LIVE STATS");
  drawStatsScreenContent(c, p, now);
}

function drawSupportersScreenContent(c, p, now) {
  const top = getTopViewers();

  const boardY = 428, boardH = 690;
  c.fillStyle = p.card;
  rr(c, 40, boardY, 1000, boardH, 20);
  c.fill();
  c.strokeStyle = p.cardBorder;
  rr(c, 40, boardY, 1000, boardH, 20);
  c.stroke();

  drawCrown(c, 75, boardY + 42, 12, p.goldBright);
  textC(c, "CHAT SUPPORTER LEADERBOARD", 100, boardY + 48, 20, p.goldBright, 800);
  textC(c, "Most active voters and chat participants", 75, boardY + 80, 16, p.muted, 600);

  if (!top.length) {
    textC(c, "Waiting for viewer interactions...", 540, boardY + 340, 24, p.muted, 700, "center");
    textC(c, "Type !vote <1-6> in live chat to appear here!", 540, boardY + 390, 20, p.goldBright, 700, "center");
  } else {
    top.slice(0, 5).forEach((v, idx) => {
      const y = boardY + 115 + idx * 105;

      c.fillStyle = idx === 0 ? (p.theme === "light" ? "#fffbeb" : "rgba(245, 197, 66, 0.08)") : p.theme === "light" ? "#f8fafc" : "rgba(255, 255, 255, 0.02)";
      rr(c, 65, y, 950, 88, 16);
      c.fill();
      c.strokeStyle = idx === 0 ? p.goldBright : p.line;
      rr(c, 65, y, 950, 88, 16);
      c.stroke();

      // Medal circle badge
      const mCol = p.rankGradients[idx % p.rankGradients.length];
      const mGrad = c.createLinearGradient(px(86), py(y + 20), px(134), py(y + 68));
      mGrad.addColorStop(0, mCol[0]);
      mGrad.addColorStop(1, mCol[1]);
      c.fillStyle = mGrad;
      c.beginPath();
      c.arc(px(110), py(y + 44), ps(22), 0, Math.PI * 2);
      c.fill();
      textC(c, String(idx + 1), 110, y + 52, 22, "#ffffff", 800, "center");

      textC(c, fit(v.name, 22), 170, y + 42, 24, p.text, 800);
      textC(c, `${v.interactions} interactions`, 170, y + 70, 16, p.muted, 600);

      const maxInter = Math.max(1, top[0].interactions);
      const pct = v.interactions / maxInter;
      const barW = 380, barH = 14;
      c.fillStyle = p.barBg;
      rr(c, 560, y + 38, barW, barH, barH / 2);
      c.fill();
      c.fillStyle = idx === 0 ? p.goldBright : p.cyan;
      rr(c, 560, y + 38, Math.max(barH, barW * pct), barH, barH / 2);
      c.fill();

      textC(c, `${Math.round(pct * 100)}%`, 985, y + 51, 19, p.text, 800, "right");
    });
  }

  // MVP Spotlight
  const mvpY = 1145, mvpH = 175;
  c.fillStyle = p.card;
  rr(c, 40, mvpY, 1000, mvpH, 20);
  c.fill();
  c.strokeStyle = p.goldBright;
  c.lineWidth = ps(2);
  rr(c, 40, mvpY, 1000, mvpH, 20);
  c.stroke();

  const mvp = top[0];
  drawCrown(c, 75, mvpY + 36, 12, p.goldBright);
  textC(c, "CHAT MVP OF THE STREAM", 100, mvpY + 44, 18, p.goldBright, 800);
  textC(c, mvp ? mvp.name : "Bigg Boss Fan Club", 75, mvpY + 95, 36, p.text, 900);
  textC(c, mvp ? `${mvp.interactions} total interactions recorded` : "Vote & participate in chat to win the MVP crown!", 75, mvpY + 138, 20, p.muted, 700);

  drawBottomStats(c, p, now);
}

function drawSupportersScreen(c, p, now) {
  drawHero(c, p, now, "TOP SUPPORTERS");
  drawSupportersScreenContent(c, p, now);
}

function drawMenuScreenContent(c, p, now) {
  const curScreen = interactiveState().screen;

  const menuItems = [
    { id: "main", num: "1", title: "LIVE VOTING", desc: "Top 6 live voting board & percentages", cmd: "!screen main" },
    { id: "race", num: "2", title: "RANK RACE", desc: "Full contestant ranking & live gaps", cmd: "!screen race" },
    { id: "stats", num: "3", title: "LIVE STATS", desc: "Vote rate, chat energy & analytics", cmd: "!screen stats" },
    { id: "supporters", num: "4", title: "TOP SUPPORTERS", desc: "Chat MVP & active viewer leaderboard", cmd: "!screen supporters" },
    { id: "events", num: "5", title: "LIVE EVENTS", desc: "Real-time interactions & milestones", cmd: "!screen events" },
    { id: "theme", num: "6", title: "THEME SWITCH", desc: `Current: ${state.theme.toUpperCase()} (switch with !dark / !light)`, cmd: "!theme dark" }
  ];

  const startY = 428, itemH = 120, gap = 12;
  menuItems.forEach((item, i) => {
    const y = startY + i * (itemH + gap);
    const isActive = (item.id === curScreen);

    c.fillStyle = isActive ? (p.theme === "light" ? "#fffbeb" : "rgba(245, 197, 66, 0.12)") : p.card;
    rr(c, 40, y, 1000, itemH, 18);
    c.fill();

    c.strokeStyle = isActive ? p.goldBright : p.cardBorder;
    c.lineWidth = ps(isActive ? 2.5 : 1.2);
    rr(c, 40, y, 1000, itemH, 18);
    c.stroke();

    // Colored circle badge with number
    const bColor = p.rankGradients[i % p.rankGradients.length];
    c.fillStyle = bColor[0];
    c.beginPath();
    c.arc(px(88), py(y + itemH / 2), ps(24), 0, Math.PI * 2);
    c.fill();
    textC(c, item.num, 88, y + itemH / 2 + 9, 24, "#ffffff", 800, "center");

    // Title & description
    textC(c, item.title, 140, y + 48, 24, isActive ? p.goldBright : p.text, 800);
    textC(c, item.desc, 140, y + 84, 18, p.muted, 600);

    // Command box
    const cmdW = 200, cmdH = 46, cmdX = 1000 - cmdW;
    c.fillStyle = p.barBg;
    rr(c, cmdX, y + (itemH - cmdH) / 2, cmdW, cmdH, 10);
    c.fill();
    textC(c, item.cmd, cmdX + cmdW / 2, y + (itemH - cmdH) / 2 + 30, 18, p.cyan, 800, "center");

    if (isActive) {
      const actPulse = 0.5 + 0.5 * Math.sin(now * 0.008);
      c.save();
      c.fillStyle = p.goldBright;
      c.beginPath();
      c.arc(px(cmdX - 85), py(y + (itemH / 2)), ps(5 + actPulse * 2.5), 0, Math.PI * 2);
      c.fill();
      textC(c, "ACTIVE", cmdX - 18, y + 68, 16, p.goldBright, 800, "right");
      c.restore();
    }
  });

  // Auto carousel indicator
  const autoY = 1250, autoH = 68;
  c.fillStyle = p.card;
  rr(c, 40, autoY, 1000, autoH, 16);
  c.fill();
  c.strokeStyle = p.cardBorder;
  rr(c, 40, autoY, 1000, autoH, 16);
  c.stroke();

  const isAuto = interactiveState().screenAuto;
  textC(c, `Auto Rotation: ${isAuto ? "ENABLED (slides every 20s)" : "MANUAL CONTROL"}  •  Toggle with !auto on / !auto off`, 540, autoY + 42, 19, isAuto ? p.green : p.muted, 700, "center");

  drawBottomStats(c, p, now);
}

function drawMenuScreen(c, p, now) {
  drawHero(c, p, now, "STREAM MENU");
  drawMenuScreenContent(c, p, now);
}

function drawEventsScreenContent(c, p, now) {
  const events = getEvents(now).slice(-6).reverse();

  const feedY = 428, feedH = 890;
  c.fillStyle = p.card;
  rr(c, 40, feedY, 1000, feedH, 20);
  c.fill();
  c.strokeStyle = p.cardBorder;
  rr(c, 40, feedY, 1000, feedH, 20);
  c.stroke();

  drawCrown(c, 75, feedY + 44, 12, p.goldBright);
  textC(c, "LIVE INTERACTION FEED", 100, feedY + 50, 20, p.goldBright, 800);

  if (!events.length) {
    textC(c, "Waiting for the next Bigg Boss live event...", 540, feedY + 420, 24, p.muted, 700, "center");
    textC(c, "Type !drop, !heart, !gift, !boom, or !vote in chat!", 540, feedY + 470, 20, p.goldBright, 700, "center");
  } else {
    events.forEach((e, idx) => {
      const y = feedY + 80 + idx * 125;
      const age = Math.max(0, now - e.createdAt);
      const remain = Math.max(0, e.durationMs - age);

      c.fillStyle = idx === 0 ? (p.theme === "light" ? "#fffbeb" : "rgba(245, 197, 66, 0.08)") : "rgba(255, 255, 255, 0.02)";
      rr(c, 65, y, 950, 108, 16);
      c.fill();
      c.strokeStyle = idx === 0 ? p.goldBright : p.line;
      rr(c, 65, y, 950, 108, 16);
      c.stroke();

      const icon = {
        vote: "⚡", combo: "🔥", milestone: "🎉", battle: "⚔",
        boom: "💥", gift: "🎁", heart: "❤️", rain: "🌧",
        crown: "👑", zap: "⚡", fire: "🔥", star: "⭐",
        dice: "🎲", coin: "🪙", slot: "🎰", mvp: "🏆", shoutout: "👋"
      }[e.type] || "✨";

      textC(c, icon, 115, y + 66, 36, p.text, 700, "center");
      textC(c, e.type.toUpperCase(), 175, y + 42, 16, p.goldBright, 800);
      textC(c, fit(e.name || e.candidateName || "Bigg Boss", 26), 175, y + 76, 28, p.text, 800);
      textC(c, `${Math.ceil(remain / 1000)}s`, 985, y + 62, 16, p.muted, 700, "right");
    });
  }

  drawBottomStats(c, p, now);
}

function drawEventsScreen(c, p, now) {
  drawHero(c, p, now, "LIVE EVENTS");
  drawEventsScreenContent(c, p, now);
}

function drawScreenContent(screen, targetCtx, p, now) {
  if (screen === "main") drawVoteScreenContent(targetCtx, p, now);
  else if (screen === "race") drawRaceScreenContent(targetCtx, p, now);
  else if (screen === "stats") drawStatsScreenContent(targetCtx, p, now);
  else if (screen === "supporters") drawSupportersScreenContent(targetCtx, p, now);
  else if (screen === "menu") drawMenuScreenContent(targetCtx, p, now);
  else if (screen === "events") drawEventsScreenContent(targetCtx, p, now);
  else drawVoteScreenContent(targetCtx, p, now);
}

function drawScene(screen, now, targetCtx = ctx) {
  const p = palette();
  drawBackground(targetCtx, p, now);
  drawTopBar(targetCtx, p, now);
  drawHero(targetCtx, p, now, screenLabel(screen));
  drawScreenContent(screen, targetCtx, p, now);
  drawFooter(targetCtx, p, now);
  drawInteractive(targetCtx, p, now);
}

function seedParticles(e, now) {
  if (!isMainThread) return;
  if (seeded.has(e.id)) return;
  if (seeded.size > 2000) seeded.clear();
  seeded.add(e.id);
  const s = interactiveState();

  if (e.type === "vote") {
    seedVoteCelebration(e.contestant || 1, e.name || "Viewer", now);
    return;
  }

  // Type-specific spawn configs
  const cfg = {
    drop:        { count: 40, colors: ["#fbbf24", "#f59e0b", "#38bdf8", "#f472b6", "#ffffff"], cx: 540, cy: 1340, spread: 400, speedMin: 90, speedMax: 300, maxLife: 2400, gravity: 85, sizeMin: 6, sizeMax: 16, shape: "star" },
    rain:        { count: 55, colors: ["#38bdf8", "#a5f3fc", "#7dd3fc", "#e0f2fe", "#f472b6"], cx: 540, cy: 100,  spread: 500, speedMin: 60,  speedMax: 220, maxLife: 2800, gravity: 90,  sizeMin: 6,  sizeMax: 14, shape: "drop"   },
    boom:        { count: 65, colors: ["#ef4444", "#f97316", "#fbbf24", "#ffffff", "#fb923c"], cx: 540, cy: 900,  spread: 60,  speedMin: 180, speedMax: 500, maxLife: 1600, gravity: 120, sizeMin: 5,  sizeMax: 16, shape: "spark"  },
    heart:       { count: 36, colors: ["#f472b6", "#fb7185", "#fda4af", "#ff4d6d", "#fbbf24"], cx: 540, cy: 960,  spread: 340, speedMin: 30,  speedMax: 150, maxLife: 2400, gravity: -40, sizeMin: 10, sizeMax: 20, shape: "heart"  },
    like_magic:  { count: 80, colors: ["#ff007f", "#ec4899", "#fbbf24", "#f43f5e", "#ffffff", "#a855f7"], cx: 540, cy: 960, spread: 450, speedMin: 120, speedMax: 420, maxLife: 3200, gravity: -40, sizeMin: 8, sizeMax: 22, shape: "heart" },
    milestone:   { count: 80, colors: ["#fbbf24", "#f472b6", "#38bdf8", "#4ade80", "#c084fc", "#ffffff"], cx: 540, cy: 750, spread: 400, speedMin: 100, speedMax: 400, maxLife: 3000, gravity: 95,  sizeMin: 6,  sizeMax: 18, shape: "star"   },
    vote:        { count: 45, colors: ["#fbbf24", "#ffffff", "#38bdf8", "#f59e0b", "#fde68a", "#f472b6"], cx: 540, cy: 860,  spread: 360, speedMin: 90,  speedMax: 320, maxLife: 2200, gravity: 75,  sizeMin: 6,  sizeMax: 14, shape: "star"   },
    wheel:       { count: 40, colors: ["#fbbf24", "#c084fc", "#38bdf8", "#4ade80", "#f472b6"], cx: 540, cy: 860,  spread: 300, speedMin: 100, speedMax: 360, maxLife: 2400, gravity: 85,  sizeMin: 6,  sizeMax: 16, shape: "star"   },
    bomb:        { count: 70, colors: ["#ef4444", "#fbbf24", "#fb923c", "#1e293b", "#ffffff"], cx: 540, cy: 900,  spread: 40,  speedMin: 250, speedMax: 620, maxLife: 1800, gravity: 150, sizeMin: 4,  sizeMax: 14, shape: "spark"  },
    hype:        { count: 45, colors: ["#ef4444", "#f97316", "#fbbf24", "#ec4899", "#ffffff"], cx: 540, cy: 820,  spread: 380, speedMin: 80,  speedMax: 300, maxLife: 2200, gravity: 60,  sizeMin: 7,  sizeMax: 18, shape: "star"   },
    confetti:    { count: 90, colors: ["#fbbf24", "#38bdf8", "#f472b6", "#4ade80", "#c084fc", "#ef4444", "#fb923c"], cx: 540, cy: 0, spread: 680, speedMin: 60, speedMax: 280, maxLife: 3400, gravity: 120, sizeMin: 5, sizeMax: 15, shape: "rect"  },
    fireworks:   { count: 60, colors: ["#fbbf24", "#38bdf8", "#f472b6", "#4ade80", "#ffffff"], cx: 540, cy: 500, spread: 500, speedMin: 120, speedMax: 420, maxLife: 2400, gravity: 70,  sizeMin: 4,  sizeMax: 12, shape: "spark"  },
    lightning:   { count: 30, colors: ["#38bdf8", "#7dd3fc", "#bfdbfe", "#ffffff", "#fbbf24"], cx: 540, cy: 960,  spread: 120, speedMin: 60,  speedMax: 280, maxLife: 1200, gravity: 20,  sizeMin: 4,  sizeMax: 10, shape: "spark"  },
    laser:       { count: 45, colors: ["#00f0ff", "#ff007f", "#39ff14", "#ffe600", "#ffffff"], cx: 540, cy: 960,  spread: 400, speedMin: 120, speedMax: 350, maxLife: 2000, gravity: 30,  sizeMin: 4,  sizeMax: 10, shape: "spark"  },
    magic:       { count: 65, colors: ["#fbbf24", "#fef08a", "#c084fc", "#e879f9", "#38bdf8", "#ffffff"], cx: 540, cy: 960, spread: 400, speedMin: 80, speedMax: 320, maxLife: 2600, gravity: -30, sizeMin: 5, sizeMax: 14, shape: "star" },
    shield:      { count: 40, colors: ["#00f0ff", "#38bdf8", "#a5f3fc", "#ffffff", "#0284c7"], cx: 540, cy: 960, spread: 450, speedMin: 50, speedMax: 200, maxLife: 2200, gravity: 20, sizeMin: 4, sizeMax: 10, shape: "spark" },
    meteor:      { count: 75, colors: ["#ff4500", "#ff8c00", "#ffd700", "#ffffff", "#dc2626"], cx: 540, cy: 960, spread: 250, speedMin: 180, speedMax: 550, maxLife: 2000, gravity: 120, sizeMin: 5, sizeMax: 16, shape: "spark" },
    boost:       { count: 50, colors: ["#38bdf8", "#00f0ff", "#fbbf24", "#f97316", "#ffffff"], cx: 540, cy: 960, spread: 300, speedMin: 150, speedMax: 420, maxLife: 1800, gravity: 40, sizeMin: 4, sizeMax: 12, shape: "spark" },
    vortex:      { count: 70, colors: ["#38bdf8", "#818cf8", "#c084fc", "#f472b6", "#ffffff"], cx: 540, cy: 960, spread: 320, speedMin: 120, speedMax: 380, maxLife: 2800, gravity: 0, sizeMin: 4, sizeMax: 12, shape: "star" },
    dragon:      { count: 80, colors: ["#ef4444", "#f97316", "#fbbf24", "#ffd700", "#7f1d1d"], cx: 540, cy: 1100, spread: 220, speedMin: 140, speedMax: 480, maxLife: 2600, gravity: -120, sizeMin: 6, sizeMax: 18, shape: "spark" },
    matrix:      { count: 60, colors: ["#22c55e", "#4ade80", "#86efac", "#00ffcc", "#ffffff"], cx: 540, cy: 80, spread: 800, speedMin: 150, speedMax: 400, maxLife: 3200, gravity: 140, sizeMin: 8, sizeMax: 16, shape: "rect" },
    supernova:   { count: 90, colors: ["#ffffff", "#fef08a", "#fbbf24", "#f472b6", "#38bdf8"], cx: 540, cy: 900, spread: 120, speedMin: 220, speedMax: 650, maxLife: 3000, gravity: 40, sizeMin: 5, sizeMax: 16, shape: "star" },
    champion:    { count: 70, colors: ["#fbbf24", "#f59e0b", "#fef08a", "#ffffff", "#ffd700"], cx: 540, cy: 850, spread: 380, speedMin: 80, speedMax: 320, maxLife: 3000, gravity: -35, sizeMin: 6, sizeMax: 16, shape: "star" },
    aurora:      { count: 65, colors: ["#10b981", "#06b6d4", "#8b5cf6", "#d946ef", "#ffffff"], cx: 540, cy: 480, spread: 500, speedMin: 40, speedMax: 160, maxLife: 3200, gravity: -15, sizeMin: 5, sizeMax: 14, shape: "star" },
    phoenix:     { count: 80, colors: ["#fbbf24", "#f97316", "#ef4444", "#ffd700", "#ffffff"], cx: 540, cy: 1100, spread: 260, speedMin: 120, speedMax: 450, maxLife: 2800, gravity: -90, sizeMin: 6, sizeMax: 18, shape: "spark" },
    disco:       { count: 70, colors: ["#00f0ff", "#ff007f", "#ffe600", "#39ff14", "#ffffff"], cx: 540, cy: 500, spread: 600, speedMin: 80, speedMax: 320, maxLife: 2600, gravity: 40, sizeMin: 4, sizeMax: 12, shape: "star" },
    tornado:     { count: 75, colors: ["#38bdf8", "#0284c7", "#fbbf24", "#ffffff"], cx: 540, cy: 800, spread: 240, speedMin: 150, speedMax: 480, maxLife: 2600, gravity: 0, sizeMin: 4, sizeMax: 12, shape: "spark" },
    clap:        { count: 40, colors: ["#fbbf24", "#ffd700", "#ffffff", "#f59e0b"], cx: 540, cy: 880, spread: 320, speedMin: 90, speedMax: 280, maxLife: 2000, gravity: 60, sizeMin: 6, sizeMax: 14, shape: "star" },
    confess:     { count: 40, colors: ["#fef08a", "#fbbf24", "#f472b6", "#c084fc", "#ffffff"], cx: 540, cy: 800, spread: 360, speedMin: 50, speedMax: 200, maxLife: 2400, gravity: -20, sizeMin: 4, sizeMax: 12, shape: "star" },
    quiz:        { count: 45, colors: ["#fbbf24", "#38bdf8", "#4ade80", "#ffffff"], cx: 540, cy: 750, spread: 350, speedMin: 70, speedMax: 260, maxLife: 2400, gravity: 50, sizeMin: 5, sizeMax: 14, shape: "star" },
    combo:       { count: 30, colors: ["#fbbf24", "#f472b6", "#38bdf8", "#ffffff"], cx: 540, cy: 900, spread: 180, speedMin: 60, speedMax: 240, maxLife: 1600, gravity: 75, sizeMin: 5, sizeMax: 12, shape: "star" },
    gift:        { count: 28, colors: ["#fbbf24", "#f472b6", "#4ade80", "#38bdf8", "#ffffff"], cx: 540, cy: 700, spread: 200, speedMin: 50, speedMax: 200, maxLife: 2000, gravity: 70, sizeMin: 6, sizeMax: 14, shape: "star" },
    buzzer:      { count: 60, colors: ["#fbbf24", "#ef4444", "#ffd700", "#f59e0b", "#ffffff"], cx: 540, cy: 840, spread: 350, speedMin: 120, speedMax: 420, maxLife: 2400, gravity: 80, sizeMin: 6, sizeMax: 16, shape: "star" },
    clash:       { count: 50, colors: ["#38bdf8", "#f43f5e", "#fbbf24", "#ffffff"], cx: 540, cy: 860, spread: 400, speedMin: 100, speedMax: 360, maxLife: 2200, gravity: 50, sizeMin: 5, sizeMax: 14, shape: "spark" },
    fortune:     { count: 45, colors: ["#c084fc", "#a855f7", "#fbbf24", "#38bdf8", "#ffffff"], cx: 540, cy: 850, spread: 380, speedMin: 60, speedMax: 240, maxLife: 2600, gravity: -20, sizeMin: 5, sizeMax: 14, shape: "star" },
    spotlight:   { count: 40, colors: ["#fbbf24", "#fef08a", "#ffffff", "#38bdf8"], cx: 540, cy: 750, spread: 450, speedMin: 40, speedMax: 180, maxLife: 2800, gravity: 20, sizeMin: 4, sizeMax: 10, shape: "star" },
    freeze:      { count: 40, colors: ["#e0f2fe", "#bae6fd", "#7dd3fc", "#38bdf8", "#ffffff"], cx: 540, cy: 960, spread: 450, speedMin: 40, speedMax: 180, maxLife: 2600, gravity: 15, sizeMin: 5, sizeMax: 15, shape: "spark" },
    galaxy:      { count: 45, colors: ["#a855f7", "#818cf8", "#38bdf8", "#fbbf24", "#ffffff"], cx: 540, cy: 960, spread: 350, speedMin: 80, speedMax: 260, maxLife: 3000, gravity: 0, sizeMin: 4, sizeMax: 12, shape: "star" },
    tsunami:     { count: 45, colors: ["#0284c7", "#38bdf8", "#7dd3fc", "#ffffff", "#0369a1"], cx: 540, cy: 1200, spread: 600, speedMin: 120, speedMax: 360, maxLife: 2400, gravity: 110, sizeMin: 5, sizeMax: 16, shape: "drop" },
    diamond:     { count: 40, colors: ["#ffffff", "#f0f9ff", "#e0f2fe", "#fbcfe8", "#fde047"], cx: 540, cy: 960, spread: 380, speedMin: 90, speedMax: 320, maxLife: 2800, gravity: 20, sizeMin: 5, sizeMax: 14, shape: "star" },
    cheer:       { count: 35, colors: ["#10b981", "#34d399", "#6ee7b7", "#fbbf24", "#ffffff"], cx: 540, cy: 900, spread: 300, speedMin: 70, speedMax: 260, maxLife: 2200, gravity: 45, sizeMin: 5, sizeMax: 14, shape: "star" },
  };

  const def = cfg[e.type] || { count: 20, colors: ["#fbbf24", "#38bdf8", "#f472b6", "#ffffff", "#f59e0b"], cx: 540, cy: 900, spread: 260, speedMin: 50, speedMax: 240, maxLife: 1600, gravity: 80, sizeMin: 6, sizeMax: 12, shape: "star" };

  for (let i = 0; i < def.count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = def.speedMin + Math.random() * (def.speedMax - def.speedMin);
    const cx = def.cx + (Math.random() - 0.5) * def.spread;
    const cy = def.cy + (Math.random() - 0.5) * (def.spread * 0.4);
    s.particles.push({
      eventId: e.id,
      born: now,
      originX: cx,
      originY: cy,
      x: cx,
      y: cy,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - (def.gravity * 0.5),
      gravity: def.gravity,
      life: 0,
      max: def.maxLife * (0.7 + Math.random() * 0.6),
      size: def.sizeMin + Math.random() * (def.sizeMax - def.sizeMin),
      color: def.colors[i % def.colors.length],
      shape: def.shape,
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.2
    });
  }
  if (s.particles.length > 120) s.particles.splice(0, s.particles.length - 120);
}

function getContestantBounds(no) {
  const anim = contestantAnimPositions.get(Number(no));
  if (anim && anim.w && anim.h) {
    return { x: anim.x, y: anim.y, w: anim.w, h: anim.h };
  }
  const rAnim = raceAnimPositions.get(Number(no));
  if (rAnim && rAnim.y) {
    return { x: 40, y: rAnim.y, w: 1000, h: 80 };
  }
  const ranking = stats();
  const rank = ranking.findIndex(item => item.no === Number(no));
  const colW = 490, cardH = 96, rowGap = 8, colGap = 20;
  if (rank === 0) {
    return { x: 40, y: 368, w: 1000, h: 94 };
  } else if (rank > 0) {
    const isLeft = (rank <= 8);
    const rowIndex = isLeft ? (rank - 1) : (rank - 9);
    const targetX = isLeft ? 40 : (40 + colW + colGap);
    const targetY = 472 + rowIndex * (cardH + rowGap);
    return { x: targetX, y: targetY, w: colW, h: cardH };
  }
  return { x: 295, y: 750, w: colW, h: cardH };
}

export function seedVoteCelebration(contestantNo, voterName = "Viewer", now = Date.now()) {
  if (!isMainThread) return;
  const s = interactiveState();
  const cNo = Number(contestantNo) || 1;
  const key = `vceleb-${cNo}-${Math.round(now / 1500)}`;
  if (seeded.has(key)) return;
  seeded.add(key);
  if (seeded.size > 2000) seeded.clear();

  const bounds = getContestantBounds(cNo);
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const avX = bounds.x + (bounds.w > 600 ? 58 : 44);
  const avY = bounds.y + bounds.h / 2;
  const badgeX = bounds.x + bounds.w - (bounds.w > 600 ? 210 : 35);
  const badgeY = bounds.y + (bounds.w > 600 ? 36 : 28);

  const sparkleColors = ["#fbbf24", "#ffffff", "#38bdf8", "#f59e0b", "#fde68a", "#e879f9", "#4ade80"];
  const confettiColors = [
    "#fbbf24", "#f59e0b", "#38bdf8", "#0ea5e9", "#f472b6",
    "#ec4899", "#4ade80", "#22c55e", "#a855f7", "#ffffff", "#facc15"
  ];

  // 1. Dazzling Star Sparkles exploding around card avatar, center, and badge (20 particles)
  const sparkleOrigins = [
    { x: avX, y: avY, count: 8 },
    { x: cx, y: cy, count: 6 },
    { x: badgeX, y: badgeY, count: 6 }
  ];

  for (const orig of sparkleOrigins) {
    for (let i = 0; i < orig.count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 190;
      const ox = orig.x + (Math.random() - 0.5) * 20;
      const oy = orig.y + (Math.random() - 0.5) * 16;
      s.particles.push({
        born: now,
        originX: ox,
        originY: oy,
        x: ox,
        y: oy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        gravity: -10 + (Math.random() - 0.5) * 24,
        life: 0,
        max: 1300 + Math.random() * 800,
        size: 5 + Math.random() * 7,
        color: sparkleColors[Math.floor(Math.random() * sparkleColors.length)],
        shape: "star",
        isMagic: true,
        rot: Math.random() * Math.PI * 2,
        rotV: (Math.random() - 0.5) * 0.16
      });
    }
  }

  // 2. High-energy Confetti Cannon Fountain bursting upwards from the card (24 particles)
  for (let i = 0; i < 24; i++) {
    const spreadX = bounds.x + 15 + Math.random() * (bounds.w - 30);
    const speedX = (Math.random() - 0.5) * 220;
    const speedY = -170 - Math.random() * 240;
    const ox = spreadX;
    const oy = bounds.y + bounds.h * 0.4 + (Math.random() - 0.5) * 14;
    s.particles.push({
      born: now,
      originX: ox,
      originY: oy,
      x: ox,
      y: oy,
      vx: speedX,
      vy: speedY,
      gravity: 110 + Math.random() * 60,
      life: 0,
      max: 2200 + Math.random() * 1000,
      size: 7 + Math.random() * 6,
      color: confettiColors[i % confettiColors.length],
      shape: "rect",
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.28,
      flutterFreq: 0.006 + Math.random() * 0.007,
      sway: 32 + Math.random() * 22,
      swayFreq: 0.004 + Math.random() * 0.003
    });
  }

  // 3. Screen Confetti Rain Cascade across stream (16 particles)
  for (let i = 0; i < 16; i++) {
    const isConfetti = Math.random() > 0.35;
    const dropX = 60 + Math.random() * 960;
    const dropY = 120 + Math.random() * 120;
    const ox = dropX;
    const oy = dropY;
    s.particles.push({
      born: now,
      originX: ox,
      originY: oy,
      x: ox,
      y: oy,
      vx: (Math.random() - 0.5) * 70,
      vy: 40 + Math.random() * 140,
      gravity: isConfetti ? (80 + Math.random() * 45) : (20 + Math.random() * 30),
      life: 0,
      max: 2400 + Math.random() * 1100,
      size: isConfetti ? (7 + Math.random() * 6) : (5 + Math.random() * 6),
      color: isConfetti ? confettiColors[i % confettiColors.length] : sparkleColors[i % sparkleColors.length],
      shape: isConfetti ? "rect" : "star",
      isMagic: !isConfetti,
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.20,
      flutterFreq: 0.007 + Math.random() * 0.006,
      sway: 28 + Math.random() * 18,
      swayFreq: 0.003 + Math.random() * 0.003
    });
  }

  if (s.particles.length > 120) s.particles.splice(0, s.particles.length - 120);
}

export const seedVoteSparkle = seedVoteCelebration;

const floatingReactions = [];
let lastReactionSpawn = 0;
const REACTION_EMOJIS = ["❤️", "🔥", "⚡", "👑", "💎", "🌟", "👏", "🎉", "✨", "🎈", "💯", "🚀", "😍", "🥳", "💫", "🌈"];
const REACTION_BG_COLORS = [
  "rgba(239, 68, 68, 0.65)",
  "rgba(245, 158, 11, 0.65)",
  "rgba(56, 189, 248, 0.65)",
  "rgba(236, 72, 153, 0.65)",
  "rgba(168, 85, 247, 0.65)",
  "rgba(34, 197, 94, 0.65)"
];

// High-performance Sprite Cache for pre-rendered glass reaction bubbles
const bubbleSpriteCache = new Map();

function getBubbleSprite(emoji, bgCol, diamPx) {
  const diam = Math.max(26, Math.round(diamPx));
  const key = `${emoji}_${bgCol}_${diam}`;
  let sprite = bubbleSpriteCache.get(key);
  if (sprite) return sprite;

  const pad = Math.ceil(diam * 0.45);
  const size = diam + pad * 2;
  const sc = createCanvas(size, size);
  const sctx = sc.getContext("2d");
  const cx = size / 2, cy = size / 2;
  const r = diam / 2;

  // 1. Radiant Outer Bloom Glow
  const bloomGrad = sctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.5);
  bloomGrad.addColorStop(0, bgCol.replace(/[^,]+\)$/, "0.45)"));
  bloomGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  sctx.fillStyle = bloomGrad;
  sctx.beginPath();
  sctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
  sctx.fill();

  // 2. 3D Spherical Glass Bubble Base
  const bodyGrad = sctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  bodyGrad.addColorStop(0, "rgba(255, 255, 255, 0.35)");
  bodyGrad.addColorStop(0.5, bgCol);
  bodyGrad.addColorStop(1, bgCol.replace(/[^,]+\)$/, "0.85)"));
  sctx.fillStyle = bodyGrad;
  sctx.beginPath();
  sctx.arc(cx, cy, r, 0, Math.PI * 2);
  sctx.fill();

  // 3. Crisp Glass Rim Stroke
  sctx.strokeStyle = "rgba(255, 255, 255, 0.70)";
  sctx.lineWidth = Math.max(1.2, r * 0.08);
  sctx.beginPath();
  sctx.arc(cx, cy, r, 0, Math.PI * 2);
  sctx.stroke();

  // 4. Specular Curved Reflection Highlight (Upper-Left)
  sctx.save();
  sctx.beginPath();
  sctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  sctx.clip();
  const specGrad = sctx.createRadialGradient(cx - r * 0.38, cy - r * 0.38, 0, cx - r * 0.38, cy - r * 0.38, r * 0.65);
  specGrad.addColorStop(0, "rgba(255, 255, 255, 0.75)");
  specGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  sctx.fillStyle = specGrad;
  sctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  sctx.restore();

  // 5. Crisp Emoji centered inside
  sctx.save();
  sctx.beginPath();
  sctx.arc(cx, cy, r * 0.88, 0, Math.PI * 2);
  sctx.clip();
  drawEmoji(sctx, emoji, cx, cy + 2, r * 1.25);
  sctx.restore();

  sprite = { canvas: sc, size };
  bubbleSpriteCache.set(key, sprite);
  return sprite;
}

// Reaction spawn area: dedicated live-stream reaction channel in lower-right interactive chat area
export function spawnReaction(emoji = null, startX = null, startY = null) {
  if (!isMainThread) return;
  const e = emoji || REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
  const sx0 = startX !== null ? startX : (820 + Math.random() * 200);
  const sy0 = startY !== null ? startY : (1720 + Math.random() * 80);
  const size = 34 + Math.random() * 16;
  const bgCol = REACTION_BG_COLORS[Math.floor(Math.random() * REACTION_BG_COLORS.length)];
  floatingReactions.push({
    id: Math.random(),
    born: Date.now(),
    duration: 4400 + Math.random() * 1200,
    startX: sx0,
    startY: sy0,
    speed: 155 + Math.random() * 45,
    swayAmp: 16 + Math.random() * 14,
    swayFreq: 0.0020 + Math.random() * 0.0014,
    seed: Math.random() * Math.PI * 2,
    emoji: e,
    size,
    bgCol
  });
  if (floatingReactions.length > 50) floatingReactions.splice(0, floatingReactions.length - 50);
}

export function setFloatingReactions(list) {
  floatingReactions.length = 0;
  if (list && list.length) {
    for (let i = 0; i < list.length; i++) floatingReactions.push(list[i]);
  }
}

export function getFloatingReactions() {
  return floatingReactions;
}

// Hook into vote event to spawn celebratory sparkles and confetti
on("vote", (vote) => {
  if (!isMainThread) return;
  const cNo = Number(vote?.contestant || 1);
  const vName = vote?.name || "Viewer";
  seedVoteCelebration(cNo, vName, Date.now());
});

// Hook into chat messages
on("chat", ({ text }) => {
  if (!isMainThread) return;
});

export function updateFloatingReactions(now) {
  // Floating bubbles removed per user request
}

function drawFloatingReactions(c, p, now) {
  // Floating bubbles removed per user request
}



function drawInteractive(targetCtx, p, now) {
  const events = getEvents(now), s = interactiveState();
  if (s.particles.length > 0) {
    s.particles = s.particles.filter(q => (now - (q.born || now)) <= q.max);
    if (s.particles.length > 60) s.particles = s.particles.slice(-60);
  }

  // Performance guardrail: render at most the 3 freshest active visual effects simultaneously
  // so visual quality is stunning without stacking 10+ fullscreen particle loops and blowing draw time past 33ms!
  const activeEvents = events.length > 3 ? events.slice(-3) : events;
  for (const e of activeEvents) {
    seedParticles(e, now);
    const age = now - e.createdAt, t = clamp(age / e.durationMs, 0, 1);
    if (e.type === "drop") {
      // Robust X position spread across entire screen (180 to 900)
      let hVal = 0;
      const hashStr = `${e.id}:${e.userId || ""}:${e.name || ""}:${e.contestant || 0}`;
      for (let ci = 0; ci < hashStr.length; ci++) hVal = (hVal * 37 + hashStr.charCodeAt(ci)) >>> 0;
      const baseX = 180 + (hVal % 720);
      const sway = Math.sin(t * Math.PI * 6) * 32;
      const x = baseX + sway;
      const y = 140 + Math.pow(t, 1.15) * 1240;
      const contestantNo = e.contestant || e.payload?.contestant || 0;
      const isLanded = t > 0.84;
      const tilt = Math.cos(t * Math.PI * 6) * 0.10;

      targetCtx.save();

      // 1. Landing touchdown shockwave + smoke/sparks
      if (isLanded) {
        const landT = (t - 0.84) / 0.16;
        const ringR = 25 + landT * 220;
        targetCtx.save();
        targetCtx.strokeStyle = `rgba(251, 191, 36, ${Math.max(0, 1 - landT)})`;
        targetCtx.lineWidth = ps(4 * (1 - landT));
        targetCtx.beginPath();
        targetCtx.ellipse(px(x), py(y + 44), ps(ringR), ps(ringR * 0.35), 0, 0, Math.PI * 2);
        targetCtx.stroke();

        // Upward golden light pillar beam on landing
        const bGrad = targetCtx.createLinearGradient(px(x - 30), 0, px(x + 30), 0);
        bGrad.addColorStop(0, "rgba(251, 191, 36, 0)");
        bGrad.addColorStop(0.5, `rgba(251, 191, 36, ${0.45 * (1 - landT)})`);
        bGrad.addColorStop(1, "rgba(251, 191, 36, 0)");
        targetCtx.fillStyle = bGrad;
        targetCtx.fillRect(px(x - 30), py(y - 300), ps(60), ps(344));
        targetCtx.restore();
      }

      targetCtx.translate(px(x), py(y));
      if (!isLanded) targetCtx.rotate(tilt);

      // 2. Billowing Parachute Canopy (above crate)
      if (!isLanded) {
        const paraW = 160, paraH = 85, paraY = -150;

        // Parachute suspension rigging cords
        targetCtx.strokeStyle = "rgba(255, 255, 255, 0.65)";
        targetCtx.lineWidth = ps(1.5);
        targetCtx.beginPath();
        targetCtx.moveTo(px(-paraW * 0.48), py(paraY + paraH));
        targetCtx.lineTo(px(-40), py(-42));
        targetCtx.moveTo(px(-paraW * 0.18), py(paraY + paraH));
        targetCtx.lineTo(px(-15), py(-42));
        targetCtx.moveTo(px(paraW * 0.18), py(paraY + paraH));
        targetCtx.lineTo(px(15), py(-42));
        targetCtx.moveTo(px(paraW * 0.48), py(paraY + paraH));
        targetCtx.lineTo(px(40), py(-42));
        targetCtx.stroke();

        // Canopy dome
        const cGrad = targetCtx.createLinearGradient(px(-paraW / 2), 0, px(paraW / 2), 0);
        cGrad.addColorStop(0, "#ef4444");
        cGrad.addColorStop(0.3, "#f59e0b");
        cGrad.addColorStop(0.7, "#fbbf24");
        cGrad.addColorStop(1, "#ef4444");
        targetCtx.fillStyle = cGrad;
        targetCtx.beginPath();
        targetCtx.moveTo(px(-paraW / 2), py(paraY + paraH));
        targetCtx.quadraticCurveTo(px(0), py(paraY - 15), px(paraW / 2), py(paraY + paraH));
        targetCtx.quadraticCurveTo(px(paraW * 0.25), py(paraY + paraH - 12), px(0), py(paraY + paraH));
        targetCtx.quadraticCurveTo(px(-paraW * 0.25), py(paraY + paraH - 12), px(-paraW / 2), py(paraY + paraH));
        targetCtx.closePath();
        targetCtx.fill();
        targetCtx.strokeStyle = "#ffffff";
        targetCtx.lineWidth = ps(2.2);
        targetCtx.stroke();

        drawGlint(targetCtx, 0, paraY + 8, 7, now, "#ffffff");
      }

      // 3. Golden Airdrop Supply Crate (88x88)
      const crateSize = 88;
      const crX = -crateSize / 2, crY = -crateSize / 2;

      // Drop shadow
      targetCtx.fillStyle = "rgba(0, 0, 0, 0.45)";
      rr(targetCtx, crX + 4, crY + 6, crateSize, crateSize, 18);
      targetCtx.fill();

      // Crate metallic golden body
      const crGrad = targetCtx.createLinearGradient(px(crX), py(crY), px(crX + crateSize), py(crY + crateSize));
      crGrad.addColorStop(0, "#fbbf24");
      crGrad.addColorStop(0.5, "#d97706");
      crGrad.addColorStop(1, "#92400e");
      targetCtx.fillStyle = crGrad;
      rr(targetCtx, crX, crY, crateSize, crateSize, 18);
      targetCtx.fill();

      // Border & metal rim
      targetCtx.strokeStyle = "#fef08a";
      targetCtx.lineWidth = ps(2.8);
      rr(targetCtx, crX, crY, crateSize, crateSize, 18);
      targetCtx.stroke();

      // Inner metal brackets
      targetCtx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      targetCtx.lineWidth = ps(1.5);
      targetCtx.beginPath();
      targetCtx.moveTo(px(crX + 12), py(crY + 12));
      targetCtx.lineTo(px(crX + crateSize - 12), py(crY + crateSize - 12));
      targetCtx.moveTo(px(crX + crateSize - 12), py(crY + 12));
      targetCtx.lineTo(px(crX + 12), py(crY + crateSize - 12));
      targetCtx.stroke();

      // Contestant avatar OR emoji in center of crate
      if (contestantNo > 0) {
        const cImg = contestantImages.get(contestantNo);
        drawAvatar(targetCtx, contestantNo, 0, 0, 30, p, cImg);
        // Golden name banner below crate
        const cName = fit(e.payload?.candidateName || config.contestants[contestantNo - 1]?.displayName || `#${contestantNo}`, 12);
        targetCtx.fillStyle = "#0f172a";
        rr(targetCtx, -55, crY + crateSize + 4, 110, 24, 12);
        targetCtx.fill();
        targetCtx.strokeStyle = p.goldBright;
        targetCtx.lineWidth = ps(1.5);
        rr(targetCtx, -55, crY + crateSize + 4, 110, 24, 12);
        targetCtx.stroke();
        textC(targetCtx, cName, 0, crY + crateSize + 21, 13.5, "#ffffff", 900, "center");
      } else {
        const dropIcon = e.payload?.emoji || e.emoji || "🎈";
        textC(targetCtx, dropIcon, 0, 15, 38, "#ffffff", 900, "center");
        // Label pill
        targetCtx.fillStyle = "#0f172a";
        rr(targetCtx, -50, crY + crateSize + 4, 100, 22, 11);
        targetCtx.fill();
        targetCtx.strokeStyle = p.goldBright;
        targetCtx.lineWidth = ps(1.5);
        rr(targetCtx, -50, crY + crateSize + 4, 100, 22, 11);
        targetCtx.stroke();
        textC(targetCtx, "AIRDROP", 0, crY + crateSize + 20, 13, p.goldBright, 900, "center");
      }

      // Viewer Name Tag (floating above crate)
      targetCtx.fillStyle = "rgba(15, 23, 42, 0.9)";
      rr(targetCtx, -65, crY - 30, 130, 24, 12);
      targetCtx.fill();
      targetCtx.strokeStyle = p.goldBright;
      targetCtx.lineWidth = ps(1.5);
      rr(targetCtx, -65, crY - 30, 130, 24, 12);
      targetCtx.stroke();
      textC(targetCtx, `🪂 ${fit(e.name || "Viewer", 12)}`, 0, crY - 14, 13, "#ffffff", 900, "center");

      drawGlint(targetCtx, crX + crateSize - 12, crY + 12, 7, now, "#ffffff");
      targetCtx.restore();
    } else if (e.type === "gift") {
      const sway = Math.sin(t * Math.PI * 3) * 14;
      const y = 240 + (t * t) * 980;

      targetCtx.save();
      // Fast geometric drop shadow
      targetCtx.fillStyle = "rgba(0, 0, 0, 0.4)";
      rr(targetCtx, 540 - 35 + sway, y - 35 + 4, 70, 70, 16);
      targetCtx.fill();
      targetCtx.fillStyle = p.goldBright;
      rr(targetCtx, 540 - 35 + sway, y - 35, 70, 70, 16);
      targetCtx.fill();
      targetCtx.strokeStyle = "#ffffff";
      targetCtx.lineWidth = ps(2.5);
      rr(targetCtx, 540 - 35 + sway, y - 35, 70, 70, 16);
      targetCtx.stroke();
      textC(targetCtx, "GIFT", 540 + sway, y + 7, 18, "#000000", 900, "center");
      drawGlint(targetCtx, 540 + sway + 20, y - 20, 7, now, "#ffffff");
      targetCtx.restore();
    } else if (e.type === "boom") {
      const r = 40 + t * 240;
      targetCtx.save();
      targetCtx.globalAlpha = 1 - t;
      targetCtx.strokeStyle = p.red;
      targetCtx.lineWidth = ps(10);
      targetCtx.beginPath();
      targetCtx.arc(px(540), py(950), ps(r), 0, Math.PI * 2);
      targetCtx.stroke();
      textC(targetCtx, "💥", 540, 970, 64, p.red, 700, "center");
    } else if (e.type === "battle") {
      const aNo = e.payload?.a || e.contestant || 1;
      const bNo = e.payload?.b || 2;
      const aCont = config.contestants[aNo - 1] || { displayName: `Contestant ${aNo}`, votes: 0 };
      const bCont = config.contestants[bNo - 1] || { displayName: `Contestant ${bNo}`, votes: 0 };
      const aVotes = state.contestants[String(aNo)]?.votes ?? aCont.votes ?? 0;
      const bVotes = state.contestants[String(bNo)]?.votes ?? bCont.votes ?? 0;
      const aPct = (aVotes + bVotes > 0) ? (aVotes / (aVotes + bVotes)) : 0.5;

      const cardW = 960, cardH = 370, cardX = 540 - cardW / 2, cardY = 680;
      const fade = t < 0.08 ? clamp(0.7 + (t / 0.08) * 0.3, 0, 1) : t > 0.88 ? clamp((1 - t) / 0.12, 0, 1) : 1;

      targetCtx.save();
      targetCtx.globalAlpha = fade;

      // Dimming backdrop
      targetCtx.fillStyle = "rgba(0, 0, 0, 0.65)";
      targetCtx.fillRect(0, 0, W, H);

      // Fast geometric card drop shadow
      targetCtx.fillStyle = "rgba(0, 0, 0, 0.55)";
      rr(targetCtx, cardX, cardY + 8, cardW, cardH, 24);
      targetCtx.fill();
      targetCtx.fillStyle = p.theme === "light" ? "#ffffff" : "#0d1322";
      rr(targetCtx, cardX, cardY, cardW, cardH, 24);
      targetCtx.fill();

      // Fiery Gold Border
      targetCtx.strokeStyle = p.goldBright;
      targetCtx.lineWidth = ps(3.5);
      rr(targetCtx, cardX, cardY, cardW, cardH, 24);
      targetCtx.stroke();

      drawGlint(targetCtx, 340, cardY + 42, 8, now, p.goldBright);
      drawGlint(targetCtx, 740, cardY + 42, 8, now + 800, p.goldBright);
      textC(targetCtx, "1v1 BATTLE ARENA", 540, cardY + 48, 28, p.goldBright, 950, "center");
      textC(targetCtx, "WHO DESERVES TO STAY IN BIGG BOSS?", 540, cardY + 76, 16, p.muted, 700, "center");

      // Left Fighter (A)
      drawAvatar(targetCtx, aNo, cardX + 130, cardY + 165, 52, p);
      textC(targetCtx, fit(aCont.displayName || aCont.name, 14), cardX + 130, cardY + 248, 22, p.text, 800, "center");
      textC(targetCtx, `${aVotes.toLocaleString()} VOTES`, cardX + 130, cardY + 276, 19, p.goldBright, 800, "center");
      textC(targetCtx, `!vote ${aNo}`, cardX + 130, cardY + 304, 18, p.cyan, 900, "center");

      // VS in middle
      const vsPulse = 1 + 0.1 * Math.sin(now * 0.01);
      targetCtx.save();
      textC(targetCtx, "VS", 540, cardY + 175, 42 * vsPulse, p.red, 950, "center");
      drawGlint(targetCtx, 540, cardY + 135, 9, now, p.goldBright);
      targetCtx.restore();

      // Right Fighter (B)
      drawAvatar(targetCtx, bNo, cardX + cardW - 130, cardY + 165, 52, p);
      textC(targetCtx, fit(bCont.displayName || bCont.name, 14), cardX + cardW - 130, cardY + 248, 22, p.text, 800, "center");
      textC(targetCtx, `${bVotes.toLocaleString()} VOTES`, cardX + cardW - 130, cardY + 276, 19, p.goldBright, 800, "center");
      textC(targetCtx, `!vote ${bNo}`, cardX + cardW - 130, cardY + 304, 18, p.cyan, 900, "center");

      // Tug-of-war meter
      const barW = 440, barH = 22, barX = 540 - barW / 2, barY = cardY + 215;
      targetCtx.fillStyle = p.barBg;
      rr(targetCtx, barX, barY, barW, barH, barH / 2);
      targetCtx.fill();

      const fillA = Math.max(barH / 2, Math.min(barW - barH / 2, barW * aPct));
      targetCtx.fillStyle = p.cyan;
      rr(targetCtx, barX, barY, fillA, barH, barH / 2);
      targetCtx.fill();

      targetCtx.fillStyle = p.pink;
      rr(targetCtx, barX + fillA, barY, barW - fillA, barH, barH / 2);
      targetCtx.fill();

      targetCtx.fillStyle = "#ffffff";
      targetCtx.beginPath();
      targetCtx.arc(px(barX + fillA), py(barY + barH / 2), ps(13), 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.strokeStyle = p.navyPill;
      targetCtx.lineWidth = ps(3);
      targetCtx.stroke();

      textC(targetCtx, `${Math.round(aPct * 100)}%`, barX - 15, barY + 17, 17, p.cyan, 800, "right");
      textC(targetCtx, `${Math.round((1 - aPct) * 100)}%`, barX + barW + 15, barY + 17, 17, p.pink, 800, "left");

      textC(targetCtx, "TYPE !vote <no> IN CHAT TO BACK YOUR FIGHTER!", 540, cardY + 342, 17, p.goldBright, 800, "center");
      targetCtx.restore();
    } else if (e.type === "dice") {
      const roll = e.payload?.roll || 6;
      const isRolling = age < 1200;
      const curVal = isRolling ? (1 + Math.floor((now / 80) % 6)) : roll;
      const cardW = 560, cardH = 290, cardX = 540 - cardW / 2, cardY = 740;
      const fade = t < 0.08 ? clamp(0.7 + (t / 0.08) * 0.3, 0, 1) : t > 0.88 ? clamp((1 - t) / 0.12, 0, 1) : 1;

      targetCtx.save();
      targetCtx.globalAlpha = fade;

      targetCtx.fillStyle = "rgba(0, 0, 0, 0.65)";
      targetCtx.fillRect(0, 0, W, H);

      // Fast geometric drop shadow
      targetCtx.fillStyle = "rgba(0, 0, 0, 0.55)";
      rr(targetCtx, cardX, cardY + 8, cardW, cardH, 22);
      targetCtx.fill();
      targetCtx.fillStyle = p.theme === "light" ? "#ffffff" : "#0d1322";
      rr(targetCtx, cardX, cardY, cardW, cardH, 22);
      targetCtx.fill();

      targetCtx.strokeStyle = p.goldBright;
      targetCtx.lineWidth = ps(2.5);
      rr(targetCtx, cardX, cardY, cardW, cardH, 22);
      targetCtx.stroke();

      drawGlint(targetCtx, cardX + 50, cardY + 38, 7, now, p.goldBright);
      drawGlint(targetCtx, cardX + cardW - 50, cardY + 38, 7, now + 600, p.goldBright);
      textC(targetCtx, "CHAT DICE ROLL", 540, cardY + 44, 24, p.goldBright, 800, "center");

      const diceSize = 100, diceX = 540 - diceSize / 2, diceY = cardY + 68;
      const rot = isRolling ? Math.sin(now * 0.03) * 0.25 : 0;
      targetCtx.save();
      targetCtx.translate(px(540), py(diceY + diceSize / 2));
      targetCtx.rotate(rot);
      targetCtx.translate(-px(540), -py(diceY + diceSize / 2));

      targetCtx.fillStyle = "#f8fafc";
      rr(targetCtx, diceX, diceY, diceSize, diceSize, 18);
      targetCtx.fill();
      targetCtx.strokeStyle = "#cbd5e1";
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, diceX, diceY, diceSize, diceSize, 18);
      targetCtx.stroke();

      const drawPip = (pxPos, pyPos) => {
        targetCtx.fillStyle = (curVal === 1 || curVal === 4) ? "#dc2626" : "#0f172a";
        targetCtx.beginPath();
        targetCtx.arc(px(pxPos), py(pyPos), ps(7.5), 0, Math.PI * 2);
        targetCtx.fill();
      };
      const mid = diceX + diceSize / 2, midY = diceY + diceSize / 2;
      const left = diceX + 26, right = diceX + diceSize - 26;
      const top = diceY + 26, bot = diceY + diceSize - 26;

      if (curVal % 2 === 1) drawPip(mid, midY);
      if (curVal > 1) { drawPip(left, top); drawPip(right, bot); }
      if (curVal >= 4) { drawPip(right, top); drawPip(left, bot); }
      if (curVal === 6) { drawPip(left, midY); drawPip(right, midY); }
      targetCtx.restore();

      textC(targetCtx, `${e.name || "Viewer"} rolled ${isRolling ? "..." : curVal}!`, 540, cardY + 215, 24, p.text, 800, "center");
      textC(targetCtx, isRolling ? "Rolling the dice..." : (curVal === 6 ? "LUCKY SIX!" : "Try your luck with !dice"), 540, cardY + 252, 17, p.goldBright, 700, "center");
      targetCtx.restore();
    } else if (e.type === "coin") {
      const flip = e.payload?.flip || "HEADS";
      const isSpinning = age < 1200;
      const cardW = 560, cardH = 290, cardX = 540 - cardW / 2, cardY = 740;
      const fade = t < 0.08 ? clamp(0.7 + (t / 0.08) * 0.3, 0, 1) : t > 0.88 ? clamp((1 - t) / 0.12, 0, 1) : 1;

      targetCtx.save();
      targetCtx.globalAlpha = fade;

      targetCtx.fillStyle = "rgba(0, 0, 0, 0.65)";
      targetCtx.fillRect(0, 0, W, H);

      // Fast geometric drop shadow
      targetCtx.fillStyle = "rgba(0, 0, 0, 0.55)";
      rr(targetCtx, cardX, cardY + 8, cardW, cardH, 22);
      targetCtx.fill();
      targetCtx.fillStyle = p.theme === "light" ? "#ffffff" : "#0d1322";
      rr(targetCtx, cardX, cardY, cardW, cardH, 22);
      targetCtx.fill();

      targetCtx.strokeStyle = p.goldBright;
      targetCtx.lineWidth = ps(2.5);
      rr(targetCtx, cardX, cardY, cardW, cardH, 22);
      targetCtx.stroke();

      drawGlint(targetCtx, cardX + 50, cardY + 38, 7, now, p.goldBright);
      drawGlint(targetCtx, cardX + cardW - 50, cardY + 38, 7, now + 600, p.goldBright);
      textC(targetCtx, "CHAT COIN FLIP", 540, cardY + 44, 24, p.goldBright, 800, "center");

      const coinR = 48, coinCx = 540, coinCy = cardY + 120;
      const scaleX = isSpinning ? Math.cos(age * 0.02) : 1;

      targetCtx.save();
      targetCtx.translate(px(coinCx), py(coinCy));
      targetCtx.scale(scaleX, 1);
      targetCtx.translate(-px(coinCx), -py(coinCy));

      const cGrad = targetCtx.createLinearGradient(px(coinCx - coinR), py(coinCy - coinR), px(coinCx + coinR), py(coinCy + coinR));
      cGrad.addColorStop(0, "#fbbf24");
      cGrad.addColorStop(0.5, "#d97706");
      cGrad.addColorStop(1, "#b45309");
      targetCtx.fillStyle = cGrad;
      targetCtx.beginPath();
      targetCtx.arc(px(coinCx), py(coinCy), ps(coinR), 0, Math.PI * 2);
      targetCtx.fill();

      targetCtx.strokeStyle = "#fef08a";
      targetCtx.lineWidth = ps(3);
      targetCtx.beginPath();
      targetCtx.arc(px(coinCx), py(coinCy), ps(coinR - 5), 0, Math.PI * 2);
      targetCtx.stroke();

      const letter = isSpinning ? (Math.sin(age * 0.02) > 0 ? "H" : "T") : (flip === "HEADS" ? "H" : "T");
      textC(targetCtx, letter, coinCx, coinCy + 14, 40, "#ffffff", 950, "center");
      targetCtx.restore();

      textC(targetCtx, `${e.name || "Viewer"} flipped ${isSpinning ? "..." : flip}!`, 540, cardY + 215, 24, p.text, 800, "center");
      textC(targetCtx, isSpinning ? "Flipping in the air..." : "Test your fate with !coin", 540, cardY + 252, 17, p.goldBright, 700, "center");
      targetCtx.restore();
    } else if (e.type === "slot") {
      const symbols = ["🍒", "🍋", "🔔", "💎", "7️⃣"];
      const s1 = (age < 600) ? symbols[Math.floor((now / 90) % symbols.length)] : (e.payload?.s1 || "7️⃣");
      const s2 = (age < 1100) ? symbols[Math.floor((now / 90) % symbols.length)] : (e.payload?.s2 || "7️⃣");
      const s3 = (age < 1600) ? symbols[Math.floor((now / 90) % symbols.length)] : (e.payload?.s3 || "7️⃣");
      const isDone = age >= 1600;
      const isWin = isDone && e.payload?.win;

      const cardW = 620, cardH = 310, cardX = 540 - cardW / 2, cardY = 730;
      const fade = t < 0.08 ? clamp(0.7 + (t / 0.08) * 0.3, 0, 1) : t > 0.88 ? clamp((1 - t) / 0.12, 0, 1) : 1;

      targetCtx.save();
      targetCtx.globalAlpha = fade;

      targetCtx.fillStyle = "rgba(0, 0, 0, 0.65)";
      targetCtx.fillRect(0, 0, W, H);

      // Fast geometric drop shadow
      targetCtx.fillStyle = "rgba(0, 0, 0, 0.55)";
      rr(targetCtx, cardX, cardY + 8, cardW, cardH, 22);
      targetCtx.fill();
      targetCtx.fillStyle = p.theme === "light" ? "#ffffff" : "#0d1322";
      rr(targetCtx, cardX, cardY, cardW, cardH, 22);
      targetCtx.fill();

      targetCtx.strokeStyle = isWin ? p.goldBright : p.cardBorder;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, cardX, cardY, cardW, cardH, 22);
      targetCtx.stroke();

      drawGlint(targetCtx, cardX + 60, cardY + 38, 7, now, p.goldBright);
      drawGlint(targetCtx, cardX + cardW - 60, cardY + 38, 7, now + 600, p.goldBright);
      textC(targetCtx, "VEGAS SLOT MACHINE", 540, cardY + 44, 24, p.goldBright, 800, "center");

      const reelW = 120, reelH = 90, reelY = cardY + 70;
      [s1, s2, s3].forEach((sym, rIdx) => {
        const rx = cardX + 70 + rIdx * 170;
        targetCtx.fillStyle = p.barBg;
        rr(targetCtx, rx, reelY, reelW, reelH, 14);
        targetCtx.fill();
        targetCtx.strokeStyle = p.line;
        targetCtx.lineWidth = ps(2);
        rr(targetCtx, rx, reelY, reelW, reelH, 14);
        targetCtx.stroke();
        textC(targetCtx, sym, rx + reelW / 2, reelY + 62, 44, p.text, 700, "center");
      });

      if (isWin) {
        textC(targetCtx, "JACKPOT WINNER!", 540, cardY + 215, 28, p.goldBright, 950, "center");
        textC(targetCtx, `Congratulations ${e.name || "Viewer"}!`, 540, cardY + 255, 20, p.text, 800, "center");
      } else {
        textC(targetCtx, `${e.name || "Viewer"} rolled the slots!`, 540, cardY + 215, 22, p.text, 800, "center");
        textC(targetCtx, isDone ? "Try again with !slot" : "Spinning reels...", 540, cardY + 252, 17, p.goldBright, 700, "center");
      }
      targetCtx.restore();
    } else if (e.type === "shoutout") {
      const msg = e.payload?.message || "BIGG BOSS 24/7 LIVE!";
      const cardW = 920, cardH = 220, cardX = 540 - cardW / 2, cardY = 770;
      const fade = t < 0.08 ? clamp(0.7 + (t / 0.08) * 0.3, 0, 1) : t > 0.88 ? clamp((1 - t) / 0.12, 0, 1) : 1;

      targetCtx.save();
      targetCtx.globalAlpha = fade;

      targetCtx.fillStyle = "rgba(0, 0, 0, 0.65)";
      targetCtx.fillRect(0, 0, W, H);

      // Fast geometric drop shadow
      targetCtx.fillStyle = "rgba(0, 0, 0, 0.55)";
      rr(targetCtx, cardX, cardY + 8, cardW, cardH, 20);
      targetCtx.fill();

      const sGrad = targetCtx.createLinearGradient(px(cardX), py(cardY), px(cardX + cardW), py(cardY + cardH));
      sGrad.addColorStop(0, p.theme === "light" ? "#fffbeb" : "#1e1b4b");
      sGrad.addColorStop(1, p.theme === "light" ? "#fef3c7" : "#0d1322");
      targetCtx.fillStyle = sGrad;
      rr(targetCtx, cardX, cardY, cardW, cardH, 20);
      targetCtx.fill();

      targetCtx.strokeStyle = p.goldBright;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, cardX, cardY, cardW, cardH, 20);
      targetCtx.stroke();

      drawCrown(targetCtx, cardX + 60, cardY + 44, 14, p.goldBright);
      textC(targetCtx, "VIP FAN SHOUTOUT", 540, cardY + 48, 24, p.goldBright, 800, "center");
      textC(targetCtx, `"${fit(msg, 55)}"`, 540, cardY + 115, 28, p.text, 900, "center");
      textC(targetCtx, `— ${fit(e.name || "Viewer", 24)}`, cardX + cardW - 60, cardY + 175, 20, p.goldBright, 800, "right");
      targetCtx.restore();
    } else if (e.type === "wheel") {
      const winner = e.payload?.winner || "🌟 2X VOTE";
      const options = e.payload?.options || ["🌟 2X VOTE", "💎 500 PTS", "👑 VIP FAN", "⚡ BOOST", "🔥 HYPE", "🎁 MYSTERY", "🎯 CROWN", "🏆 JACKPOT"];
      const spinDuration = 3200;
      const isSpinning = age < spinDuration;
      const spinProgress = Math.min(1, age / spinDuration);
      const easedSpin = 1 - Math.pow(1 - spinProgress, 3);
      const totalAngle = (e.payload?.finalAngle || (Math.PI * 8)) * easedSpin;

      const cardW = 660, cardH = 430, cardX = 540 - cardW / 2, cardY = 650;
      const fade = t < 0.08 ? clamp(0.7 + (t / 0.08) * 0.3, 0, 1) : t > 0.88 ? clamp((1 - t) / 0.12, 0, 1) : 1;

      targetCtx.save();
      targetCtx.globalAlpha = fade;

      targetCtx.fillStyle = "rgba(0, 0, 0, 0.65)";
      targetCtx.fillRect(0, 0, W, H);

      targetCtx.fillStyle = "rgba(0, 0, 0, 0.55)";
      rr(targetCtx, cardX, cardY + 8, cardW, cardH, 24);
      targetCtx.fill();

      targetCtx.fillStyle = p.theme === "light" ? "#ffffff" : "#0d1322";
      rr(targetCtx, cardX, cardY, cardW, cardH, 24);
      targetCtx.fill();

      targetCtx.strokeStyle = p.goldBright;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, cardX, cardY, cardW, cardH, 24);
      targetCtx.stroke();

      drawGlint(targetCtx, cardX + 50, cardY + 36, 7, now, p.goldBright);
      drawGlint(targetCtx, cardX + cardW - 50, cardY + 36, 7, now + 600, p.goldBright);
      textC(targetCtx, "LUCKY FORTUNE WHEEL", 540, cardY + 42, 25, p.goldBright, 900, "center");

      const wheelCx = 540, wheelCy = cardY + 200, wheelR = 120;
      const segAngle = (Math.PI * 2) / options.length;
      const wedgeColors = ["#ef4444", "#f59e0b", "#10b981", "#06b6d4", "#6366f1", "#ec4899", "#8b5cf6", "#f97316"];

      targetCtx.save();
      targetCtx.translate(px(wheelCx), py(wheelCy));
      targetCtx.rotate(totalAngle);

      for (let sIdx = 0; sIdx < options.length; sIdx++) {
        const aStart = sIdx * segAngle;
        const aEnd = aStart + segAngle;
        targetCtx.fillStyle = wedgeColors[sIdx % wedgeColors.length];
        targetCtx.beginPath();
        targetCtx.moveTo(0, 0);
        targetCtx.arc(0, 0, ps(wheelR), aStart, aEnd);
        targetCtx.closePath();
        targetCtx.fill();
        targetCtx.strokeStyle = "#ffffff";
        targetCtx.lineWidth = ps(1.5);
        targetCtx.stroke();
      }

      targetCtx.fillStyle = "#0f172a";
      targetCtx.beginPath();
      targetCtx.arc(0, 0, ps(26), 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.strokeStyle = p.goldBright;
      targetCtx.lineWidth = ps(3);
      targetCtx.stroke();
      targetCtx.restore();

      targetCtx.fillStyle = "#ef4444";
      targetCtx.beginPath();
      targetCtx.moveTo(px(wheelCx), py(wheelCy - wheelR + 10));
      targetCtx.lineTo(px(wheelCx - 14), py(wheelCy - wheelR - 18));
      targetCtx.lineTo(px(wheelCx + 14), py(wheelCy - wheelR - 18));
      targetCtx.closePath();
      targetCtx.fill();
      targetCtx.strokeStyle = "#ffffff";
      targetCtx.lineWidth = ps(2);
      targetCtx.stroke();

      if (!isSpinning) {
        textC(targetCtx, winner, 540, cardY + 355, 30, p.goldBright, 950, "center");
        textC(targetCtx, `Congratulations ${e.name || "Viewer"}! 🏆`, 540, cardY + 395, 20, p.text, 800, "center");
        drawGlint(targetCtx, 540, cardY + 355, 10, now, "#ffffff");
      } else {
        textC(targetCtx, "SPINNING THE WHEEL...", 540, cardY + 355, 24, p.cyan, 800, "center");
        textC(targetCtx, `${e.name || "Viewer"} is testing their luck!`, 540, cardY + 395, 18, p.muted, 700, "center");
      }
      targetCtx.restore();
    } else if (e.type === "bomb") {
      const targetNo = e.contestant;
      let bCx = 540, bCy = 900;
      let cName = "";
      if (targetNo) {
        const cItem = config.contestants.find(x => x.no === targetNo);
        cName = cItem?.displayName || cItem?.name || `Contestant #${targetNo}`;
        const ranking = stats();
        const rankIdx = ranking.findIndex(c => c.no === targetNo);
        const card = getCardLayoutForRank(rankIdx >= 0 ? rankIdx : 0);
        bCx = card.x + card.w / 2;
        bCy = card.y + card.h / 2;
      }

      const isDetonated = age >= 900;
      targetCtx.save();
      if (!isDetonated) {
        const shake = Math.sin(now * 0.08) * 8;
        const curCx = bCx + shake, curCy = bCy;

        // If targeted, draw red lock-on target crosshairs around contestant card!
        if (targetNo) {
          const crossSize = 46 + Math.sin(now * 0.03) * 6;
          targetCtx.save();
          targetCtx.strokeStyle = "#ef4444";
          targetCtx.lineWidth = ps(3);
          targetCtx.beginPath();
          targetCtx.arc(px(curCx), py(curCy), ps(crossSize), 0, Math.PI * 2);
          targetCtx.stroke();
          // Crosshair tick marks
          targetCtx.beginPath();
          targetCtx.moveTo(px(curCx - crossSize - 12), py(curCy));
          targetCtx.lineTo(px(curCx - crossSize + 4), py(curCy));
          targetCtx.moveTo(px(curCx + crossSize - 4), py(curCy));
          targetCtx.lineTo(px(curCx + crossSize + 12), py(curCy));
          targetCtx.moveTo(px(curCx), py(curCy - crossSize - 12));
          targetCtx.lineTo(px(curCx), py(curCy - crossSize + 4));
          targetCtx.moveTo(px(curCx), py(curCy + crossSize - 4));
          targetCtx.lineTo(px(curCx), py(curCy + crossSize + 12));
          targetCtx.stroke();
          targetCtx.restore();
        }

        targetCtx.fillStyle = "rgba(0, 0, 0, 0.45)";
        targetCtx.beginPath();
        targetCtx.arc(px(curCx), py(curCy), ps(38), 0, Math.PI * 2);
        targetCtx.fill();

        targetCtx.fillStyle = "#1e293b";
        targetCtx.beginPath();
        targetCtx.arc(px(curCx), py(curCy), ps(34), 0, Math.PI * 2);
        targetCtx.fill();
        targetCtx.strokeStyle = "#ef4444";
        targetCtx.lineWidth = ps(3);
        targetCtx.stroke();

        targetCtx.strokeStyle = "#f59e0b";
        targetCtx.lineWidth = ps(3.5);
        targetCtx.beginPath();
        targetCtx.moveTo(px(curCx), py(curCy - 34));
        targetCtx.quadraticCurveTo(px(curCx + 18), py(curCy - 54), px(curCx + 26), py(curCy - 62));
        targetCtx.stroke();
        drawGlint(targetCtx, curCx + 26, curCy - 62, 8, now * 3, "#fbbf24");
        drawMagicSparkle(targetCtx, curCx + 26, curCy - 62, 6, now * 2, "#ef4444");

        const warnText = targetNo ? `🎯 TARGET LOCKED: ${cName.toUpperCase()}!` : "💣 INCOMING BOMB!";
        textC(targetCtx, warnText, curCx, curCy + 56, 19, "#ef4444", 950, "center");
      } else {
        const blastAge = age - 900;
        const blastT = blastAge / (e.durationMs - 900);
        const blastFade = Math.max(0, 1 - blastT);
        const r1 = ps(blastT * (targetNo ? 360 : 540));
        const r2 = ps(blastT * (targetNo ? 220 : 360));

        targetCtx.globalAlpha = blastFade;
        targetCtx.strokeStyle = "#f59e0b";
        targetCtx.lineWidth = ps(8 * blastFade);
        targetCtx.beginPath();
        targetCtx.arc(px(bCx), py(bCy), r1, 0, Math.PI * 2);
        targetCtx.stroke();

        targetCtx.strokeStyle = "#ef4444";
        targetCtx.lineWidth = ps(14 * blastFade);
        targetCtx.beginPath();
        targetCtx.arc(px(bCx), py(bCy), r2, 0, Math.PI * 2);
        targetCtx.stroke();

        // Fire ember particles expanding from detonation point
        for (let fi = 0; fi < 14; fi++) {
          const fAng = fi * (Math.PI * 2 / 14) + (fi * 0.4);
          const fDist = blastT * (targetNo ? 180 : 320);
          const fx = bCx + Math.cos(fAng) * fDist;
          const fy = bCy + Math.sin(fAng) * fDist - blastT * 30;
          const col = (fi % 2 === 0) ? "#ef4444" : "#fbbf24";
          drawMagicSparkle(targetCtx, fx, fy, 7 * blastFade, now + fi * 150, col);
        }

        const bannerW = targetNo ? 460 : 540, bannerH = 72;
        targetCtx.fillStyle = "rgba(15, 23, 42, 0.88)";
        rr(targetCtx, bCx - bannerW / 2, bCy - 34, bannerW, bannerH, 16);
        targetCtx.fill();
        targetCtx.strokeStyle = "#ef4444";
        targetCtx.lineWidth = ps(2);
        rr(targetCtx, bCx - bannerW / 2, bCy - 34, bannerW, bannerH, 16);
        targetCtx.stroke();

        const kaboomTitle = targetNo ? `${cName.toUpperCase()} BOMBED!` : "KABOOM!";
        const kaboomSub = targetNo ? `💣 Detonated by @${e.name || "Viewer"}!` : `💣 Detonated by @${e.name || "Viewer"}!`;
        textC(targetCtx, kaboomTitle, bCx, bCy - 6, targetNo ? 26 : 40, "#ffffff", 950, "center");
        textC(targetCtx, kaboomSub, bCx, bCy + 22, targetNo ? 16 : 20, p.goldBright, 850, "center");
      }
      targetCtx.restore();
    } else if (e.type === "freeze") {
      const targetNo = e.contestant || 1;
      const ranking = stats();
      const rankIdx = ranking.findIndex(c => c.no === targetNo);
      const card = getCardLayoutForRank(rankIdx >= 0 ? rankIdx : 0);
      const cItem = config.contestants.find(x => x.no === targetNo);
      const cName = cItem?.displayName || cItem?.name || `Contestant #${targetNo}`;
      const bCx = card.x + card.w / 2, bCy = card.y + card.h / 2;
      const fFade = t < 0.1 ? (t / 0.1) : t > 0.85 ? ((1 - t) / 0.15) : 1;

      targetCtx.save();
      targetCtx.globalAlpha = clamp(fFade, 0, 1);
      targetCtx.fillStyle = "rgba(186, 230, 253, 0.45)";
      rr(targetCtx, card.x - 4, card.y - 4, card.w + 8, card.h + 8, 18);
      targetCtx.fill();
      targetCtx.strokeStyle = "#38bdf8";
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, card.x - 4, card.y - 4, card.w + 8, card.h + 8, 18);
      targetCtx.stroke();

      for (let ci = 0; ci < 8; ci++) {
        const ix = card.x + 20 + ci * ((card.w - 40) / 7);
        drawGlint(targetCtx, ix, card.y + 4, 6, now + ci * 250, "#ffffff");
      }
      textC(targetCtx, `${cName.toUpperCase()} FROZEN!`, bCx, bCy + 4, 22, "#0369a1", 950, "center");
      textC(targetCtx, `Frozen solid by @${e.name || "Viewer"}`, bCx, bCy + 26, 14, "#0284c7", 850, "center");
      targetCtx.restore();
    } else if (e.type === "laser") {
      const targetNo = e.contestant || 1;
      const ranking = stats();
      const rankIdx = ranking.findIndex(c => c.no === targetNo);
      const card = getCardLayoutForRank(rankIdx >= 0 ? rankIdx : 0);
      const cItem = config.contestants.find(x => x.no === targetNo);
      const cName = cItem?.displayName || cItem?.name || `Contestant #${targetNo}`;
      const bCx = card.x + card.w / 2, bCy = card.y + card.h / 2;
      const lFade = t < 0.15 ? (t / 0.15) : t > 0.8 ? ((1 - t) / 0.2) : 1;

      targetCtx.save();
      targetCtx.globalAlpha = clamp(lFade, 0, 1);
      const beamW = 28 + Math.sin(now * 0.04) * 8;
      const lGrad = targetCtx.createLinearGradient(px(bCx - beamW), 0, px(bCx + beamW), 0);
      lGrad.addColorStop(0, "rgba(0, 240, 255, 0.1)");
      lGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.95)");
      lGrad.addColorStop(1, "rgba(0, 240, 255, 0.1)");
      targetCtx.fillStyle = lGrad;
      targetCtx.fillRect(px(bCx - beamW), py(0), ps(beamW * 2), py(bCy));

      const impactR = ps(38 + Math.sin(now * 0.03) * 10);
      targetCtx.strokeStyle = "#00f0ff";
      targetCtx.lineWidth = ps(4);
      targetCtx.beginPath();
      targetCtx.arc(px(bCx), py(bCy), impactR, 0, Math.PI * 2);
      targetCtx.stroke();
      drawMagicSparkle(targetCtx, bCx, bCy, 14, now, "#ffffff");
      drawMagicSparkle(targetCtx, bCx - 20, bCy, 10, now + 200, "#00f0ff");
      drawMagicSparkle(targetCtx, bCx + 20, bCy, 10, now + 400, "#00f0ff");

      const laserCardW = 380, laserCardH = 46;
      targetCtx.fillStyle = "rgba(10, 20, 38, 0.90)";
      rr(targetCtx, bCx - laserCardW / 2, bCy - 48, laserCardW, laserCardH, 12);
      targetCtx.fill();
      targetCtx.strokeStyle = "#00f0ff";
      targetCtx.lineWidth = ps(1.5);
      rr(targetCtx, bCx - laserCardW / 2, bCy - 48, laserCardW, laserCardH, 12);
      targetCtx.stroke();
      textC(targetCtx, `ORBITAL STRIKE: ${cName.toUpperCase()}!`, bCx, bCy - 28, 17, "#ffffff", 950, "center");
      textC(targetCtx, `Called by @${e.name || "Viewer"}`, bCx, bCy - 11, 13, "#38bdf8", 800, "center");
      targetCtx.restore();
    } else if (e.type === "hype") {
      const cardW = 780, cardH = 140, cardX = 540 - cardW / 2, cardY = 820;
      const fade = t < 0.08 ? clamp(0.7 + (t / 0.08) * 0.3, 0, 1) : t > 0.88 ? clamp((1 - t) / 0.12, 0, 1) : 1;
      targetCtx.save();
      targetCtx.globalAlpha = fade;

      const hGrad = targetCtx.createLinearGradient(px(cardX), 0, px(cardX + cardW), 0);
      hGrad.addColorStop(0, "rgba(239, 68, 68, 0.95)");
      hGrad.addColorStop(0.5, "rgba(245, 158, 11, 0.95)");
      hGrad.addColorStop(1, "rgba(236, 72, 153, 0.95)");
      targetCtx.fillStyle = hGrad;
      rr(targetCtx, cardX, cardY, cardW, cardH, 20);
      targetCtx.fill();

      targetCtx.strokeStyle = "#ffffff";
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, cardX, cardY, cardW, cardH, 20);
      targetCtx.stroke();

      // Pulsing glow border on hype
      const hypePulse = 0.5 + 0.5 * Math.sin(now * 0.015);
      targetCtx.strokeStyle = `rgba(251, 191, 36, ${0.4 + 0.6 * hypePulse})`;
      targetCtx.lineWidth = ps(3 + hypePulse * 2);
      rr(targetCtx, cardX, cardY, cardW, cardH, 20);
      targetCtx.stroke();

      drawGlint(targetCtx, cardX + 60, cardY + 70, 10, now, "#ffffff");
      drawGlint(targetCtx, cardX + cardW - 60, cardY + 70, 10, now + 500, "#ffffff");
      textC(targetCtx, "🚀 HYPE TRAIN SURGE! 🔥", 540, cardY + 54, 32, "#ffffff", 950, "center");
      textC(targetCtx, `Activated by ${e.name || "Viewer"} • Vote multiplier active!`, 540, cardY + 102, 22, "#fef08a", 800, "center");
      targetCtx.restore();
    } else if (e.type === "confetti") {
      // Full-screen confetti shower - particles handle the visuals
      // Just show a brief banner at top
      if (age < 1200) {
        const cFade = age < 200 ? age / 200 : age > 900 ? (1200 - age) / 300 : 1;
        targetCtx.save();
        targetCtx.globalAlpha = cFade;
        const confW = 780, confH = 90, confX = 540 - confW / 2, confY = 160;
        const cg = targetCtx.createLinearGradient(px(confX), 0, px(confX + confW), 0);
        cg.addColorStop(0, "rgba(251, 191, 36, 0.9)");
        cg.addColorStop(0.5, "rgba(244, 114, 182, 0.9)");
        cg.addColorStop(1, "rgba(56, 189, 248, 0.9)");
        targetCtx.fillStyle = cg;
        rr(targetCtx, confX, confY, confW, confH, 20);
        targetCtx.fill();
        textC(targetCtx, `🎉 CONFETTI PARTY — ${e.name || "Viewer"} 🎉`, 540, confY + 58, 28, "#ffffff", 950, "center");
        targetCtx.restore();
      }
    } else if (e.type === "like_magic") {
      // 10 Random Celestial & Funny Magic Double-Tap Celebrations (center modal)
      if (age < 5000) {
        const theme = e.payload?.theme || LIKE_MAGIC_THEMES[0];
        const mFade = age < 300 ? (age / 300) : age > 4300 ? Math.max(0, (5000 - age) / 700) : 1;
        const pop = age < 350 ? Math.sin((age / 350) * Math.PI * 0.55) * 1.06 : (1.0 + Math.sin(age * 0.006) * 0.015);
        targetCtx.save();
        targetCtx.globalAlpha = mFade;

        const cx = 540, cy = 940;
        const cardW = 860, cardH = 236;
        const cardX = cx - cardW / 2, cardY = cy - cardH / 2;

        targetCtx.translate(px(cx), py(cy));
        targetCtx.scale(pop, pop);
        targetCtx.translate(-px(cx), -py(cy));

        // Atmospheric bloom
        const bloom = getVoteBloomSprite();
        targetCtx.drawImage(bloom, px(cardX - 80), py(cardY - 60), ps(cardW + 160), ps(cardH + 120));

        // Expanding Cosmic Shockwave
        const shockProgress = (age % 1200) / 1200;
        const shockR = ps(90 + shockProgress * 300);
        targetCtx.strokeStyle = `rgba(251, 191, 36, ${Math.max(0, (1 - shockProgress) * 0.85)})`;
        targetCtx.lineWidth = ps(3.5 * (1 - shockProgress));
        targetCtx.beginPath();
        targetCtx.arc(px(cx), py(cy), shockR, 0, Math.PI * 2);
        targetCtx.stroke();

        // Modal Card Background (Multi-Stop Dynamic Gradient based on Theme)
        const bgColors = theme.bgGrad || ["#2e1065", "#4c0519", "#0f172a"];
        const mBg = targetCtx.createLinearGradient(px(cardX), py(cardY), px(cardX + cardW), py(cardY + cardH));
        mBg.addColorStop(0, bgColors[0] || "#1e1b4b");
        mBg.addColorStop(0.5, bgColors[1] || "#2e1065");
        mBg.addColorStop(1, bgColors[2] || "#0f172a");
        targetCtx.fillStyle = mBg;
        rr(targetCtx, cardX, cardY, cardW, cardH, 26);
        targetCtx.fill();

        // Multi-Stop Vivid Neon Border based on Theme
        const borderColors = theme.borderGrad || ["#ff007f", "#fbbf24", "#ec4899"];
        const mbGrad = targetCtx.createLinearGradient(px(cardX), 0, px(cardX + cardW), 0);
        mbGrad.addColorStop(0, borderColors[0] || "#00f0ff");
        mbGrad.addColorStop(0.5, borderColors[1] || "#fbbf24");
        mbGrad.addColorStop(1, borderColors[2] || "#ff007f");
        targetCtx.strokeStyle = mbGrad;
        targetCtx.lineWidth = ps(3.6);
        rr(targetCtx, cardX, cardY, cardW, cardH, 26);
        targetCtx.stroke();

        // Animated Thematic Icon on left
        const hx = cardX + 90, hy = cy;
        const iconBeat = 1 + 0.16 * Math.sin(now * 0.015);
        targetCtx.save();
        targetCtx.translate(px(hx), py(hy));
        targetCtx.scale(iconBeat, iconBeat);
        drawEmoji(targetCtx, theme.icon || "✨", 0, 0, ps(68));
        targetCtx.restore();

        // Top Pill Badge with Tag
        const pillW = 390, pillH = 30, pillX = cardX + 175, pillY = cardY + 22;
        const pillGrad = targetCtx.createLinearGradient(px(pillX), 0, px(pillX + pillW), 0);
        pillGrad.addColorStop(0, borderColors[0] || "#ec4899");
        pillGrad.addColorStop(0.5, borderColors[1] || "#f59e0b");
        pillGrad.addColorStop(1, borderColors[2] || "#38bdf8");
        targetCtx.fillStyle = pillGrad;
        rr(targetCtx, pillX, pillY, pillW, pillH, 15);
        targetCtx.fill();
        targetCtx.strokeStyle = "#ffffff";
        targetCtx.lineWidth = ps(1.2);
        rr(targetCtx, pillX, pillY, pillW, pillH, 15);
        targetCtx.stroke();
        drawMagicSparkle(targetCtx, pillX + 16, pillY + pillH / 2, 7, now, "#fbbf24");
        textC(targetCtx, `✨ ${theme.tag || "DOUBLE TAP MAGIC"} ✨`, pillX + pillW / 2, pillY + 20, 14, "#ffffff", 950, "center");
        drawMagicSparkle(targetCtx, pillX + pillW - 16, pillY + pillH / 2, 7, now + 300, "#fbbf24");

        // Main Title (Thematic)
        textC(targetCtx, theme.title || "+1 NEW LIKE! MAGIC UNLOCKED!", cardX + 175, cardY + 98, 28, "#ffffff", 950);

        // Subtitle / Fun Comment + Live Total Likes
        const diffCount = e.payload?.diff || 1;
        const currentLikes = e.payload?.likes || state.liveLikes || 0;
        const sub = theme.subtitle || "Keep Double Tapping to cast magic!";
        textC(targetCtx, `${sub}`, cardX + 175, cardY + 140, 18, theme.textColor || "#fde047", 800);
        textC(targetCtx, `+${diffCount} LIKE • TOTAL LIKES: ${Number(currentLikes).toLocaleString()}`, cardX + 175, cardY + 175, 17, "#fbbf24", 900);

        // Thematic Magic sparkles
        const spCol = theme.sparkleColor || "#fbbf24";
        drawMagicSparkle(targetCtx, cardX + cardW - 40, cardY + 40, 12, now, spCol);
        drawMagicSparkle(targetCtx, cardX + cardW - 60, cardY + cardH - 40, 10, now + 300, borderColors[0] || "#ff007f");
        drawMagicSparkle(targetCtx, cardX + 40, cardY + 40, 10, now + 600, borderColors[1] || "#00f0ff");
        drawMagicSparkle(targetCtx, cardX + 40, cardY + cardH - 40, 9, now + 900, "#ffffff");

        targetCtx.restore();
      }
    } else if (e.type === "fireworks") {
      // Multiple firework bursts radiating from screen
      const fBase = 380 + Math.sin(now * 0.007) * 200;
      const fx = 540 + Math.cos(now * 0.005) * 250;
      targetCtx.save();
      const fFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.globalAlpha = fFade;
      for (let fi = 0; fi < 4; fi++) {
        const fRad = 30 + t * 160 + fi * 40;
        const fAlpha = Math.max(0, (0.7 - t) * (1 - fi * 0.2));
        const fColors = ["#fbbf24", "#f472b6", "#38bdf8", "#4ade80"];
        targetCtx.globalAlpha = fFade * fAlpha;
        targetCtx.strokeStyle = fColors[fi];
        targetCtx.lineWidth = ps(4 - fi);
        targetCtx.beginPath();
        targetCtx.arc(px(fx + fi * 18 - 27), py(fBase + fi * 12 - 18), ps(fRad), 0, Math.PI * 2);
        targetCtx.stroke();
      }
      targetCtx.globalAlpha = fFade;
      textC(targetCtx, `🎆 FIREWORKS — ${e.name || "Viewer"} 🎆`, 540, 240, 30, "#fbbf24", 950, "center");
      targetCtx.restore();
    } else if (e.type === "lightning") {
      // Electric lightning bolt animation
      const lFade = t < 0.1 ? t / 0.1 : t > 0.8 ? (1 - t) / 0.2 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = lFade;
      // Screen blue-white flash
      if (t < 0.15) {
        targetCtx.fillStyle = `rgba(148, 220, 255, ${0.12 * (1 - t / 0.15)})`;
        targetCtx.fillRect(0, 0, W, H);
      }
      // Draw zigzag lightning bolts
      const lColors = ["#38bdf8", "#bfdbfe", "#7dd3fc"];
      for (let li = 0; li < 3; li++) {
        const lx = 300 + li * 240;
        let cx2 = lx, cy2 = 180;
        const pts = [{ x: cx2, y: cy2 }];
        for (let seg = 0; seg < 7; seg++) {
          cx2 += (Math.random() - 0.5) * 60;
          cy2 += 100 + Math.random() * 80;
          pts.push({ x: cx2, y: cy2 });
        }
        // Outer glow bolt
        targetCtx.strokeStyle = "rgba(56, 189, 248, 0.4)";
        targetCtx.lineWidth = ps((3 - li) * 2.5);
        targetCtx.beginPath();
        targetCtx.moveTo(px(pts[0].x), py(pts[0].y));
        for (let j = 1; j < pts.length; j++) targetCtx.lineTo(px(pts[j].x), py(pts[j].y));
        targetCtx.stroke();
        // Inner core bolt
        targetCtx.strokeStyle = lColors[li];
        targetCtx.lineWidth = ps(3 - li);
        targetCtx.beginPath();
        targetCtx.moveTo(px(pts[0].x), py(pts[0].y));
        for (let j = 1; j < pts.length; j++) targetCtx.lineTo(px(pts[j].x), py(pts[j].y));
        targetCtx.stroke();
      }
      textC(targetCtx, `⚡ LIGHTNING STRIKE — ${e.name || "Viewer"} ⚡`, 540, 850, 28, "#38bdf8", 950, "center");
      targetCtx.restore();
    } else if (e.type === "laser") {
      // Stage concert laser show
      const lFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(lFade, 0, 0.95);

      const laserColors = ["#00f0ff", "#ff007f", "#39ff14", "#ffe600", "#9d00ff", "#00f0ff"];
      const origins = [
        { x: 0, y: 1920 },
        { x: 1080, y: 1920 },
        { x: 540, y: 0 },
        { x: 180, y: 1920 },
        { x: 900, y: 1920 },
        { x: 540, y: 1920 }
      ];

      origins.forEach((src, idx) => {
        const col = laserColors[idx % laserColors.length];
        const sweepAngle = Math.sin(now * 0.0024 + idx * 1.3) * 0.78;
        const baseAngle = idx === 2 ? Math.PI / 2 : idx === 0 ? -Math.PI / 4 : idx === 1 ? -3 * Math.PI / 4 : -Math.PI / 2;
        const angle = baseAngle + sweepAngle;
        const beamLen = 2400;
        const endX = src.x + Math.cos(angle) * beamLen;
        const endY = src.y + Math.sin(angle) * beamLen;

        // Volumetric glow beam
        targetCtx.strokeStyle = col;
        targetCtx.lineWidth = ps(14);
        targetCtx.globalAlpha = clamp(lFade * 0.28, 0, 1);
        targetCtx.beginPath();
        targetCtx.moveTo(px(src.x), py(src.y));
        targetCtx.lineTo(px(endX), py(endY));
        targetCtx.stroke();

        // Intense laser core
        targetCtx.strokeStyle = "#ffffff";
        targetCtx.lineWidth = ps(3.2);
        targetCtx.globalAlpha = clamp(lFade * 0.95, 0, 1);
        targetCtx.beginPath();
        targetCtx.moveTo(px(src.x), py(src.y));
        targetCtx.lineTo(px(endX), py(endY));
        targetCtx.stroke();

        // Origin lens flare
        targetCtx.fillStyle = col;
        targetCtx.beginPath();
        targetCtx.arc(px(src.x), py(src.y), ps(16), 0, Math.PI * 2);
        targetCtx.fill();
      });

      // Stage laser announcement badge
      const banY = 820;
      targetCtx.fillStyle = "rgba(15, 23, 42, 0.92)";
      rr(targetCtx, 220, banY, 640, 68, 20);
      targetCtx.fill();
      targetCtx.strokeStyle = "#00f0ff";
      targetCtx.lineWidth = ps(2.5);
      rr(targetCtx, 220, banY, 640, 68, 20);
      targetCtx.stroke();
      textC(targetCtx, `✨ STAGE LASERS — ${e.name || "Viewer"} ✨`, 540, banY + 43, 22, "#00f0ff", 950, "center");
      targetCtx.restore();
    } else if (e.type === "magic") {
      const mFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(mFade, 0, 1);

      const cx = 540, cy = 960;

      // 1. Ambient celestial cosmic stardust glow
      const mAtmosphere = targetCtx.createRadialGradient(px(cx), py(cy), ps(40), px(cx), py(cy), ps(680));
      mAtmosphere.addColorStop(0, "rgba(245, 197, 66, 0.25)");
      mAtmosphere.addColorStop(0.45, "rgba(192, 132, 252, 0.16)");
      mAtmosphere.addColorStop(0.8, "rgba(56, 189, 248, 0.08)");
      mAtmosphere.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = mAtmosphere;
      targetCtx.beginPath();
      targetCtx.arc(px(cx), py(cy), ps(680), 0, Math.PI * 2);
      targetCtx.fill();

      // 2. Expanding 360-degree celestial wave rings
      const wavePhase = (age * 0.0012) % 1;
      for (let wi = 0; wi < 3; wi++) {
        const wp = (wavePhase + wi * 0.33) % 1;
        const wRad = ps(60 + wp * 550);
        const wAlpha = Math.max(0, (1 - wp) * 0.65);
        targetCtx.strokeStyle = wi === 0 ? `rgba(251, 191, 36, ${wAlpha})` : `rgba(192, 132, 252, ${wAlpha})`;
        targetCtx.lineWidth = ps(3.5 * (1 - wp));
        targetCtx.beginPath();
        targetCtx.arc(px(cx), py(cy), wRad, 0, Math.PI * 2);
        targetCtx.stroke();
      }

      // 3. Rotating Sacred Geometry Magic Circles & Astrolabe
      targetCtx.save();
      targetCtx.translate(px(cx), py(cy));

      // Outer Runic Astrolabe Ring (Rotating clockwise)
      const ringRot = now * 0.001;
      targetCtx.rotate(ringRot);
      targetCtx.strokeStyle = "rgba(251, 191, 36, 0.75)";
      targetCtx.lineWidth = ps(2.5);
      targetCtx.beginPath();
      targetCtx.arc(0, 0, ps(260), 0, Math.PI * 2);
      targetCtx.stroke();

      targetCtx.strokeStyle = "rgba(192, 132, 252, 0.65)";
      targetCtx.lineWidth = ps(1.5);
      targetCtx.setLineDash([ps(14), ps(10)]);
      targetCtx.beginPath();
      targetCtx.arc(0, 0, ps(280), 0, Math.PI * 2);
      targetCtx.stroke();
      targetCtx.setLineDash([]);

      // 24 Runic celestial tick marks
      for (let ri = 0; ri < 24; ri++) {
        const ra = (ri * Math.PI) / 12;
        targetCtx.strokeStyle = (ri % 2 === 0) ? "#fbbf24" : "#c084fc";
        targetCtx.lineWidth = ps(ri % 6 === 0 ? 3 : 1.5);
        targetCtx.beginPath();
        targetCtx.moveTo(Math.cos(ra) * ps(246), Math.sin(ra) * ps(246));
        targetCtx.lineTo(Math.cos(ra) * ps(274), Math.sin(ra) * ps(274));
        targetCtx.stroke();
      }

      // Sacred Geometry Interlocking Triangles (Rotating counter-clockwise)
      targetCtx.rotate(-ringRot * 2.2);
      targetCtx.strokeStyle = "rgba(254, 240, 138, 0.65)";
      targetCtx.lineWidth = ps(2.2);
      for (let tri = 0; tri < 2; tri++) {
        const triAngle = tri * (Math.PI / 3);
        targetCtx.beginPath();
        for (let pt = 0; pt < 3; pt++) {
          const pa = triAngle + (pt * 2 * Math.PI) / 3;
          const px0 = Math.cos(pa) * ps(210);
          const py0 = Math.sin(pa) * ps(210);
          if (pt === 0) targetCtx.moveTo(px0, py0);
          else targetCtx.lineTo(px0, py0);
        }
        targetCtx.closePath();
        targetCtx.stroke();
      }

      // 12-Point Radiant Star in center
      targetCtx.strokeStyle = "rgba(56, 189, 248, 0.55)";
      targetCtx.lineWidth = ps(1.8);
      for (let si = 0; si < 12; si++) {
        const sa = (si * Math.PI) / 6;
        targetCtx.beginPath();
        targetCtx.moveTo(0, 0);
        targetCtx.lineTo(Math.cos(sa) * ps(130), Math.sin(sa) * ps(130));
        targetCtx.stroke();
      }

      targetCtx.restore();

      // 4. Swirling Stardust Spiral Arms
      for (let arm = 0; arm < 4; arm++) {
        for (let st = 0; st < 12; st++) {
          const sAngle = arm * (Math.PI / 2) + st * 0.28 + now * 0.0028;
          const sDist = 35 + st * 22;
          const sxPos = cx + Math.cos(sAngle) * sDist;
          const syPos = cy + Math.sin(sAngle) * sDist;
          const sCol = (st % 3 === 0) ? "#fbbf24" : (st % 3 === 1) ? "#e879f9" : "#38bdf8";
          drawMagicSparkle(targetCtx, sxPos, syPos, 3.5 + (st % 3), now + st * 120, sCol);
        }
      }

      // 5. Central Bigg Boss mystic golden starburst
      drawMagicSparkle(targetCtx, cx, cy, 22, now, "#fef08a");

      // 6. Magic Spell Announcement Banner
      const banW = 760, banH = 88, banX = 540 - banW / 2, banY = 660;
      targetCtx.fillStyle = "rgba(10, 20, 38, 0.95)";
      rr(targetCtx, banX, banY, banW, banH, 24);
      targetCtx.fill();

      const banGrad = targetCtx.createLinearGradient(px(banX), 0, px(banX + banW), 0);
      banGrad.addColorStop(0, "#fbbf24");
      banGrad.addColorStop(0.5, "#c084fc");
      banGrad.addColorStop(1, "#38bdf8");
      targetCtx.strokeStyle = banGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, banX, banY, banW, banH, 24);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, banX + 45, banY + 44, 9, now, "#fbbf24");
      drawMagicSparkle(targetCtx, banX + banW - 45, banY + 44, 9, now + 400, "#c084fc");
      textC(targetCtx, "✨ CELESTIAL MAGIC SPELL CAST! ✨", 540, banY + 39, 27, "#fbbf24", 950, "center");
      textC(targetCtx, `Cast by ${e.name || "Viewer"} • Blessings & 2x Luck Granted!`, 540, banY + 71, 19, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "shield") {
      const sFade = t < 0.08 ? t / 0.08 : t > 0.88 ? (1 - t) / 0.12 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(sFade, 0, 1);

      const targetNo = e.contestant || 1;
      const cItem = config.contestants.find(x => x.no === targetNo);
      const cName = cItem?.displayName || cItem?.name || `Contestant ${targetNo}`;

      const cardX = 40, cardW = 1000, cardH = 142;
      const cardIdx = (targetNo - 1) % 6;
      const cardY = 428 + cardIdx * 150;

      // 1. Neon Cyan Forcefield Aura around contestant card (crisp layered glow)
      const shPulse = 0.75 + 0.25 * Math.sin(now * 0.009);
      targetCtx.strokeStyle = `rgba(0, 240, 255, ${0.35 * shPulse})`;
      targetCtx.lineWidth = ps(10);
      rr(targetCtx, cardX - 4, cardY - 4, cardW + 8, cardH + 8, 24);
      targetCtx.stroke();
      targetCtx.strokeStyle = `rgba(0, 240, 255, ${0.9 * shPulse})`;
      targetCtx.lineWidth = ps(3.5);
      rr(targetCtx, cardX - 4, cardY - 4, cardW + 8, cardH + 8, 24);
      targetCtx.stroke();

      // 2. Hexagonal Forcefield Honeycomb Grid over the card
      targetCtx.save();
      targetCtx.beginPath();
      targetCtx.roundRect(px(cardX), py(cardY), ps(cardW), ps(cardH), ps(20));
      targetCtx.clip();

      const fSweep = ((now * 0.28) % (cardW + 200)) - 100;
      const fGrad = targetCtx.createLinearGradient(px(cardX + fSweep - 80), 0, px(cardX + fSweep + 80), 0);
      fGrad.addColorStop(0, "rgba(0, 240, 255, 0)");
      fGrad.addColorStop(0.5, `rgba(0, 240, 255, ${0.28 * shPulse})`);
      fGrad.addColorStop(1, "rgba(0, 240, 255, 0)");
      targetCtx.fillStyle = fGrad;
      targetCtx.fillRect(px(cardX), py(cardY), ps(cardW), ps(cardH));

      const hexR = 26;
      const hexW = hexR * Math.sqrt(3);
      const hexH = hexR * 1.5;
      for (let hy = cardY - hexR; hy < cardY + cardH + hexR; hy += hexH) {
        const rowIdx = Math.floor((hy - cardY) / hexH);
        const offsetX = (rowIdx % 2 === 0) ? 0 : hexW / 2;
        for (let hx = cardX - hexW; hx < cardX + cardW + hexW; hx += hexW) {
          const distSweep = Math.abs(hx - (cardX + fSweep));
          const hexAlpha = Math.max(0.15, Math.min(0.75, 1 - distSweep / 140));
          targetCtx.strokeStyle = `rgba(0, 240, 255, ${hexAlpha * shPulse})`;
          targetCtx.lineWidth = ps(1.2);
          targetCtx.beginPath();
          for (let pi = 0; pi < 6; pi++) {
            const ang = (pi * Math.PI) / 3;
            const px0 = px(hx + offsetX + Math.cos(ang) * hexR);
            const py0 = py(hy + Math.sin(ang) * hexR);
            if (pi === 0) targetCtx.moveTo(px0, py0); else targetCtx.lineTo(px0, py0);
          }
          targetCtx.closePath();
          targetCtx.stroke();
        }
      }
      targetCtx.restore();

      // 3. Electric energy arcs crackling around perimeter
      targetCtx.strokeStyle = "#ffffff";
      targetCtx.lineWidth = ps(1.6);
      for (let ai = 0; ai < 4; ai++) {
        const ax0 = cardX + Math.random() * cardW;
        const ay0 = (ai % 2 === 0) ? cardY : cardY + cardH;
        targetCtx.beginPath();
        targetCtx.moveTo(px(ax0), py(ay0));
        targetCtx.lineTo(px(ax0 + (Math.random() - 0.5) * 40), py(ay0 + (Math.random() - 0.5) * 20));
        targetCtx.stroke();
      }

      // 4. Forcefield Crest Badge & Status Pill
      const badgeW = 740, badgeH = 76, badgeX = 540 - badgeW / 2;
      const badgeY = (cardIdx <= 1) ? (cardY + cardH + 12) : (cardY - 86);
      targetCtx.fillStyle = "rgba(10, 20, 38, 0.95)";
      rr(targetCtx, badgeX, badgeY, badgeW, badgeH, 20);
      targetCtx.fill();
      targetCtx.strokeStyle = "#00f0ff";
      targetCtx.lineWidth = ps(2.5);
      rr(targetCtx, badgeX, badgeY, badgeW, badgeH, 20);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, badgeX + 45, badgeY + 38, 8, now, "#00f0ff");
      drawMagicSparkle(targetCtx, badgeX + badgeW - 45, badgeY + 38, 8, now + 400, "#00f0ff");
      textC(targetCtx, `🛡️ FORCEFIELD SHIELD ACTIVE — #${targetNo} ${cName} 🛡️`, 540, badgeY + 34, 23, "#00f0ff", 950, "center");
      textC(targetCtx, `Energy barrier deployed by ${e.name || "Viewer"} • Immunity shield online!`, 540, badgeY + 62, 17, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "meteor") {
      const mFade = t < 0.05 ? t / 0.05 : t > 0.90 ? (1 - t) / 0.10 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(mFade, 0, 1);

      const sx0 = 1180, sy0 = -100;
      const tx0 = 460, ty0 = 940;
      const impactT = 0.38;

      if (t < impactT) {
        // Atmospheric Flight Phase
        const fp = Math.pow(t / impactT, 1.4);
        const mx = sx0 + (tx0 - sx0) * fp;
        const my = sy0 + (ty0 - sy0) * fp;
        const trajAngle = Math.atan2(ty0 - sy0, tx0 - sx0);

        // Blazing supersonic plasma tail
        for (let pi = 40; pi >= 0; pi--) {
          const tp = pi / 40;
          const dist = tp * 340;
          const tailX = mx - Math.cos(trajAngle) * dist + (Math.random() - 0.5) * (tp * 24);
          const tailY = my - Math.sin(trajAngle) * dist + (Math.random() - 0.5) * (tp * 24);
          const tailRad = ps(18 * (1 - tp * 0.75));
          const tailAlpha = Math.max(0, (1 - tp) * 0.85);
          const tailCol = (pi < 10) ? "#ffffff" : (pi < 22) ? "#fbbf24" : (pi < 32) ? "#f97316" : "#dc2626";

          targetCtx.fillStyle = tailCol;
          targetCtx.globalAlpha = clamp(mFade * tailAlpha, 0, 1);
          targetCtx.beginPath();
          targetCtx.arc(px(tailX), py(tailY), tailRad, 0, Math.PI * 2);
          targetCtx.fill();
        }

        // Incandescent Meteor Core
        targetCtx.globalAlpha = clamp(mFade, 0, 1);
        const mGlow = targetCtx.createRadialGradient(px(mx), py(my), ps(4), px(mx), py(my), ps(55));
        mGlow.addColorStop(0, "#ffffff");
        mGlow.addColorStop(0.35, "#fde047");
        mGlow.addColorStop(0.7, "#f97316");
        mGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
        targetCtx.fillStyle = mGlow;
        targetCtx.beginPath();
        targetCtx.arc(px(mx), py(my), ps(55), 0, Math.PI * 2);
        targetCtx.fill();

        drawMagicSparkle(targetCtx, mx, my, 16, now, "#ffffff");
      } else {
        // Supernova Impact Phase
        const ip = (t - impactT) / (1 - impactT);

        if (ip < 0.15) {
          const flashAlpha = (1 - ip / 0.15) * 0.45;
          targetCtx.fillStyle = `rgba(255, 245, 230, ${flashAlpha})`;
          targetCtx.fillRect(0, 0, W, H);
        }

        // Triple-Ring Expanding Supernova Shockwave
        const blastColors = ["#ffffff", "#fbbf24", "#f97316", "#dc2626"];
        for (let bi = 0; bi < 4; bi++) {
          const bRad = ps(30 + ip * (750 - bi * 120));
          const bAlpha = Math.max(0, (1 - ip) * (0.85 - bi * 0.15));
          targetCtx.strokeStyle = blastColors[bi];
          targetCtx.lineWidth = ps(Math.max(2, (10 - bi * 2) * (1 - ip)));
          targetCtx.globalAlpha = clamp(mFade * bAlpha, 0, 1);
          targetCtx.beginPath();
          targetCtx.arc(px(tx0), py(ty0), bRad, 0, Math.PI * 2);
          targetCtx.stroke();
        }

        // Flying incandescent debris
        for (let deb = 0; deb < 10; deb++) {
          const dAngle = (deb * Math.PI * 2) / 10 + deb * 0.7;
          const dDist = ip * (250 + (deb % 4) * 80);
          const dx = tx0 + Math.cos(dAngle) * dDist;
          const dy = ty0 + Math.sin(dAngle) * dDist + ip * ip * 120;
          drawMagicSparkle(targetCtx, dx, dy, 5, now + deb * 200, "#f97316");
        }
      }

      // Meteor Announcement Badge
      const metW = 760, metH = 84, metX = 540 - metW / 2, metY = 720;
      targetCtx.globalAlpha = clamp(mFade, 0, 1);
      targetCtx.fillStyle = "rgba(10, 20, 38, 0.95)";
      rr(targetCtx, metX, metY, metW, metH, 22);
      targetCtx.fill();

      const metGrad = targetCtx.createLinearGradient(px(metX), 0, px(metX + metW), 0);
      metGrad.addColorStop(0, "#f97316");
      metGrad.addColorStop(0.5, "#fbbf24");
      metGrad.addColorStop(1, "#ef4444");
      targetCtx.strokeStyle = metGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, metX, metY, metW, metH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, metX + 45, metY + 42, 9, now, "#f97316");
      drawMagicSparkle(targetCtx, metX + metW - 45, metY + 42, 9, now + 300, "#ef4444");
      textC(targetCtx, "☄️ COSMIC METEOR STRIKE! ☄️", 540, metY + 38, 27, "#fbbf24", 950, "center");
      textC(targetCtx, `Summoned by ${e.name || "Viewer"} • Supernova Impact Energy!`, 540, metY + 68, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "boost") {
      const bFade = t < 0.08 ? t / 0.08 : t > 0.88 ? (1 - t) / 0.12 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(bFade, 0, 1);

      const targetNo = e.contestant || 1;
      const cItem = config.contestants.find(x => x.no === targetNo);
      const cName = cItem?.displayName || cItem?.name || `Contestant ${targetNo}`;

      const cardX = 40, cardW = 1000, cardH = 142;
      const cardIdx = (targetNo - 1) % 6;
      const cardY = 428 + cardIdx * 150;

      // 1. Hyper-speed warp motion lines rushing across screen
      targetCtx.strokeStyle = "rgba(56, 189, 248, 0.45)";
      targetCtx.lineWidth = ps(1.8);
      for (let li = 0; li < 14; li++) {
        const lineY = cardY - 40 + li * 16;
        const lineLen = 140 + (li % 5) * 60;
        const lineSpeed = ((now * 1.6 + li * 90) % (W + lineLen * 2)) - lineLen;
        targetCtx.beginPath();
        targetCtx.moveTo(px(lineSpeed), py(lineY));
        targetCtx.lineTo(px(lineSpeed + lineLen), py(lineY));
        targetCtx.stroke();
      }

      // 2. Dual Supersonic Nitro Rocket Thrusters mounted on card
      const thrusterY1 = cardY + 35, thrusterY2 = cardY + 95;
      const thrusterX = cardX + cardW + 8;
      const plumeLen = 160 + Math.sin(now * 0.04) * 35;

      [thrusterY1, thrusterY2].forEach((ty) => {
        // Metallic Rocket Housing Cylinder
        targetCtx.fillStyle = "#334155";
        rr(targetCtx, thrusterX - 24, ty - 14, 28, 28, 6);
        targetCtx.fill();
        targetCtx.strokeStyle = "#38bdf8";
        targetCtx.lineWidth = ps(2);
        rr(targetCtx, thrusterX - 24, ty - 14, 28, 28, 6);
        targetCtx.stroke();

        // Supersonic Nitro Flame Plume (Blue/Cyan/White)
        const fGrad = targetCtx.createLinearGradient(px(thrusterX), 0, px(thrusterX + plumeLen), 0);
        fGrad.addColorStop(0, "#ffffff");
        fGrad.addColorStop(0.2, "#00f0ff");
        fGrad.addColorStop(0.55, "#3b82f6");
        fGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
        targetCtx.fillStyle = fGrad;
        targetCtx.beginPath();
        targetCtx.moveTo(px(thrusterX), py(ty - 12));
        targetCtx.lineTo(px(thrusterX + plumeLen), py(ty));
        targetCtx.lineTo(px(thrusterX), py(ty + 12));
        targetCtx.closePath();
        targetCtx.fill();

        // Supersonic Shock Mach Diamonds along exhaust plume
        for (let md = 1; md <= 3; md++) {
          const mdx = thrusterX + md * 38;
          const mdSize = ps(7 - md * 1.5);
          targetCtx.fillStyle = "#ffffff";
          targetCtx.beginPath();
          targetCtx.moveTo(px(mdx), py(ty - mdSize));
          targetCtx.lineTo(px(mdx + mdSize * 1.4), py(ty));
          targetCtx.lineTo(px(mdx), py(ty + mdSize));
          targetCtx.lineTo(px(mdx - mdSize * 1.4), py(ty));
          targetCtx.closePath();
          targetCtx.fill();
        }
      });

      // 3. Golden Nitro Speed Arrows racing across card
      targetCtx.save();
      targetCtx.beginPath();
      targetCtx.roundRect(px(cardX + 215), py(cardY + 76), ps(545), ps(17), ps(8.5));
      targetCtx.clip();
      const arrowShift = (now * 0.4) % 60;
      targetCtx.fillStyle = "rgba(255, 255, 255, 0.45)";
      for (let ax = cardX + 200 + arrowShift; ax < cardX + 780; ax += 50) {
        textC(targetCtx, ">>", ax, cardY + 90, 15, "#ffffff", 950);
      }
      targetCtx.restore();

      // 4. Nitro Boost Announcement Badge
      const bstW = 760, bstH = 80, bstX = 540 - bstW / 2;
      const bstY = (cardIdx <= 1) ? (cardY + cardH + 12) : (cardY - 92);
      targetCtx.fillStyle = "rgba(10, 20, 38, 0.95)";
      rr(targetCtx, bstX, bstY, bstW, bstH, 22);
      targetCtx.fill();

      const bstGrad = targetCtx.createLinearGradient(px(bstX), 0, px(bstX + bstW), 0);
      bstGrad.addColorStop(0, "#38bdf8");
      bstGrad.addColorStop(0.5, "#00f0ff");
      bstGrad.addColorStop(1, "#fbbf24");
      targetCtx.strokeStyle = bstGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, bstX, bstY, bstW, bstH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, bstX + 45, bstY + 40, 9, now, "#00f0ff");
      drawMagicSparkle(targetCtx, bstX + bstW - 45, bstY + 40, 9, now + 300, "#fbbf24");
      textC(targetCtx, `🚀 NITRO ROCKET BOOST — #${targetNo} ${cName} 🚀`, 540, bstY + 36, 25, "#38bdf8", 950, "center");
      textC(targetCtx, `Supercharged by ${e.name || "Viewer"} • Vote Velocity Doubled!`, 540, bstY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "vortex") {
      const vFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(vFade, 0, 1);

      const cx = 540, cy = 920;
      const spin = (now * 0.003) % (Math.PI * 2);

      // 1. Warped Space-Time Distortion Ellipses
      targetCtx.save();
      targetCtx.translate(px(cx), py(cy));
      targetCtx.rotate(-0.32);
      for (let r = 4; r >= 1; r--) {
        const radX = ps(180 + r * 65 + Math.sin(now * 0.005 + r) * 15);
        const radY = ps(55 + r * 22 + Math.cos(now * 0.005 + r) * 6);
        targetCtx.strokeStyle = (r % 2 === 0) ? "rgba(168, 85, 247, 0.4)" : "rgba(56, 189, 248, 0.4)";
        targetCtx.lineWidth = ps(3 + r * 1.5);
        targetCtx.beginPath();
        targetCtx.ellipse(0, 0, radX, radY, 0, 0, Math.PI * 2);
        targetCtx.stroke();
      }

      // 2. Swirling Logarithmic Spiral Arms
      const armColors = ["#c084fc", "#38bdf8", "#ec4899"];
      for (let a = 0; a < 3; a++) {
        const armAngle = spin + (a * Math.PI * 2) / 3;
        targetCtx.strokeStyle = armColors[a];
        targetCtx.lineWidth = ps(3.5);
        targetCtx.beginPath();
        for (let step = 0; step < 36; step++) {
          const theta = armAngle + step * 0.18;
          const radius = ps(38 + step * 8.2);
          const x = Math.cos(theta) * radius;
          const y = Math.sin(theta) * (radius * 0.44);
          if (step === 0) targetCtx.moveTo(x, y);
          else targetCtx.lineTo(x, y);
        }
        targetCtx.stroke();
      }

      // 3. Blazing Event Horizon Photon Ring & Singularity Core
      const coreRadius = ps(52);
      const haloGrad = targetCtx.createRadialGradient(0, 0, coreRadius * 0.8, 0, 0, coreRadius * 1.6);
      haloGrad.addColorStop(0, "#ffffff");
      haloGrad.addColorStop(0.3, "#00f0ff");
      haloGrad.addColorStop(0.7, "#a855f7");
      haloGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = haloGrad;
      targetCtx.beginPath();
      targetCtx.arc(0, 0, coreRadius * 1.6, 0, Math.PI * 2);
      targetCtx.fill();

      // Pitch black core
      targetCtx.fillStyle = "#020617";
      targetCtx.beginPath();
      targetCtx.arc(0, 0, coreRadius, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.strokeStyle = "#38bdf8";
      targetCtx.lineWidth = ps(3);
      targetCtx.stroke();
      targetCtx.restore();

      // Announcement Badge
      const vW = 760, vH = 80, vX = 540 - vW / 2, vY = 720;
      targetCtx.fillStyle = "rgba(10, 20, 38, 0.95)";
      rr(targetCtx, vX, vY, vW, vH, 22);
      targetCtx.fill();

      const vGrad = targetCtx.createLinearGradient(px(vX), 0, px(vX + vW), 0);
      vGrad.addColorStop(0, "#a855f7");
      vGrad.addColorStop(0.5, "#38bdf8");
      vGrad.addColorStop(1, "#ec4899");
      targetCtx.strokeStyle = vGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, vX, vY, vW, vH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, vX + 45, vY + 40, 9, now, "#c084fc");
      drawMagicSparkle(targetCtx, vX + vW - 45, vY + 40, 9, now + 300, "#38bdf8");
      textC(targetCtx, "🌀 COSMIC SINGULARITY VORTEX! 🌀", 540, vY + 36, 25, "#c084fc", 950, "center");
      textC(targetCtx, `Summoned by ${e.name || "Viewer"} • Gravitational Well Activated!`, 540, vY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "dragon") {
      const dFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(dFade, 0, 1);

      // Sinuous Multi-layer Volumetric Dragon Flamethrower
      const flameLayers = [
        { color: "rgba(239, 68, 68, 0.75)", width: 85, freq: 0.012, amp: 28 },
        { color: "rgba(249, 115, 22, 0.85)", width: 55, freq: 0.016, amp: 22 },
        { color: "rgba(251, 191, 36, 0.95)", width: 30, freq: 0.02, amp: 14 },
        { color: "#ffffff", width: 12, freq: 0.024, amp: 8 }
      ];

      const startX = 140, startY = 1750;
      const targetX = 540, targetY = 750;

      for (const fl of flameLayers) {
        targetCtx.strokeStyle = fl.color;
        targetCtx.lineWidth = ps(fl.width);
        targetCtx.lineCap = "round";
        targetCtx.beginPath();
        for (let sStep = 0; sStep <= 24; sStep++) {
          const sp = sStep / 24;
          const baseX = startX + (targetX - startX) * sp;
          const baseY = startY + (targetY - startY) * sp;
          const wave = Math.sin(now * fl.freq + sp * 6.5) * fl.amp * (0.3 + 0.7 * sp);
          const pxCoord = baseX + wave;
          const pyCoord = baseY - Math.sin(sp * Math.PI) * 45;
          if (sStep === 0) targetCtx.moveTo(px(pxCoord), py(pyCoord));
          else targetCtx.lineTo(px(pxCoord), py(pyCoord));
        }
        targetCtx.stroke();
      }

      // Dragon Head / Glowing Eye Emblem
      targetCtx.save();
      targetCtx.translate(px(startX), py(startY));
      targetCtx.fillStyle = "#ef4444";
      targetCtx.beginPath();
      targetCtx.arc(0, 0, ps(36), 0, Math.PI * 2);
      targetCtx.fill();
      drawMagicSparkle(targetCtx, 0, 0, 14, now, "#fbbf24");
      targetCtx.restore();

      // Announcement Badge
      const dW = 760, dH = 80, dX = 540 - dW / 2, dY = 720;
      targetCtx.fillStyle = "rgba(10, 20, 38, 0.95)";
      rr(targetCtx, dX, dY, dW, dH, 22);
      targetCtx.fill();

      const dGrad = targetCtx.createLinearGradient(px(dX), 0, px(dX + dW), 0);
      dGrad.addColorStop(0, "#ef4444");
      dGrad.addColorStop(0.5, "#f97316");
      dGrad.addColorStop(1, "#fbbf24");
      targetCtx.strokeStyle = dGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, dX, dY, dW, dH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, dX + 45, dY + 40, 9, now, "#f97316");
      drawMagicSparkle(targetCtx, dX + dW - 45, dY + 40, 9, now + 300, "#ef4444");
      textC(targetCtx, "🐉 DRAGON FLAMETHROWER INFERNO! 🐉", 540, dY + 36, 25, "#f97316", 950, "center");
      textC(targetCtx, `Unleashed by ${e.name || "Viewer"} • Blazing Dragon Fire!`, 540, dY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "matrix") {
      const matFade = t < 0.08 ? t / 0.08 : t > 0.88 ? (1 - t) / 0.12 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(matFade, 0, 1);

      // Cascading Cyber Digital Rain Columns
      const glyphs = ["0", "1", "X", "9", "7", "Z", "F", "A", "3", "0", "8", "Y", "Q", "B"];
      const colCount = 18;
      const colSpacing = W / colCount;

      for (let ci = 0; ci < colCount; ci++) {
        const colX = colSpacing * (ci + 0.5);
        const colSpeed = 0.45 + (ci % 5) * 0.08;
        const headY = ((now * colSpeed + ci * 140) % (H + 400)) - 100;

        for (let gi = 0; gi < 12; gi++) {
          const gy = headY - gi * 28;
          if (gy < 60 || gy > H - 80) continue;

          let color = "#15803d";
          let weight = 700;
          let fontSize = 16;
          if (gi === 0) {
            color = "#ffffff";
            weight = 950;
            fontSize = 20;
          } else if (gi <= 3) {
            color = "#4ade80";
            weight = 900;
            fontSize = 18;
          } else if (gi <= 7) {
            color = "#22c55e";
          }

          const glyphChar = glyphs[(ci * 3 + gi + Math.floor(now * 0.008)) % glyphs.length];
          textC(targetCtx, glyphChar, colX, gy, fontSize, color, weight, "center");
        }
      }

      // Sweeping Laser Scanline
      const scanY = (now * 0.5) % H;
      targetCtx.fillStyle = "rgba(74, 222, 128, 0.25)";
      targetCtx.fillRect(0, py(scanY), px(W), ps(4));

      // Announcement Badge
      const matW = 760, matH = 80, matX = 540 - matW / 2, matY = 720;
      targetCtx.fillStyle = "rgba(4, 18, 10, 0.96)";
      rr(targetCtx, matX, matY, matW, matH, 22);
      targetCtx.fill();

      const matGrad = targetCtx.createLinearGradient(px(matX), 0, px(matX + matW), 0);
      matGrad.addColorStop(0, "#22c55e");
      matGrad.addColorStop(0.5, "#4ade80");
      matGrad.addColorStop(1, "#10b981");
      targetCtx.strokeStyle = matGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, matX, matY, matW, matH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, matX + 45, matY + 40, 9, now, "#4ade80");
      drawMagicSparkle(targetCtx, matX + matW - 45, matY + 40, 9, now + 300, "#22c55e");
      textC(targetCtx, "💾 THE MATRIX CYBER OVERRIDE! 💾", 540, matY + 36, 25, "#4ade80", 950, "center");
      textC(targetCtx, `Mainframe Hacked by ${e.name || "Viewer"} • Reality Decrypted!`, 540, matY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "supernova") {
      const snFade = t < 0.08 ? t / 0.08 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(snFade, 0, 1);

      const cx = 540, cy = 820;

      // 1. Triple Chromatic Shockwave Rings
      const shockColors = ["#ffffff", "#38bdf8", "#ec4899", "#fbbf24"];
      for (let si = 0; si < 4; si++) {
        const sRad = ps(40 + t * (680 - si * 100));
        const sAlpha = Math.max(0, (1 - t) * (0.9 - si * 0.18));
        targetCtx.strokeStyle = shockColors[si];
        targetCtx.lineWidth = ps(Math.max(2, (8 - si * 1.5) * (1 - t)));
        targetCtx.globalAlpha = clamp(snFade * sAlpha, 0, 1);
        targetCtx.beginPath();
        targetCtx.arc(px(cx), py(cy), sRad, 0, Math.PI * 2);
        targetCtx.stroke();
      }

      // 2. 8-Point Starlight Diffraction Spikes
      targetCtx.save();
      targetCtx.translate(px(cx), py(cy));
      targetCtx.rotate(now * 0.001);
      const spikeLen = ps(220 + Math.sin(now * 0.006) * 35);
      const spikeColors = ["#ffffff", "#fbbf24"];
      for (let spi = 0; spi < 8; spi++) {
        const spAngle = (spi * Math.PI) / 4;
        targetCtx.strokeStyle = spikeColors[spi % 2];
        targetCtx.lineWidth = ps(spi % 2 === 0 ? 3.5 : 2);
        targetCtx.beginPath();
        targetCtx.moveTo(0, 0);
        targetCtx.lineTo(Math.cos(spAngle) * spikeLen, Math.sin(spAngle) * spikeLen);
        targetCtx.stroke();
      }
      targetCtx.restore();

      // 3. Central Blinding Plasma Core
      const coreR = ps(45);
      const cGrad = targetCtx.createRadialGradient(px(cx), py(cy), 0, px(cx), py(cy), coreR * 1.5);
      cGrad.addColorStop(0, "#ffffff");
      cGrad.addColorStop(0.4, "#fbbf24");
      cGrad.addColorStop(0.8, "#f43f5e");
      cGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = cGrad;
      targetCtx.beginPath();
      targetCtx.arc(px(cx), py(cy), coreR * 1.5, 0, Math.PI * 2);
      targetCtx.fill();

      // Announcement Badge
      const snW = 760, snH = 80, snX = 540 - snW / 2, snY = 720;
      targetCtx.globalAlpha = clamp(snFade, 0, 1);
      targetCtx.fillStyle = "rgba(10, 20, 38, 0.95)";
      rr(targetCtx, snX, snY, snW, snH, 22);
      targetCtx.fill();

      const snGrad = targetCtx.createLinearGradient(px(snX), 0, px(snX + snW), 0);
      snGrad.addColorStop(0, "#fbbf24");
      snGrad.addColorStop(0.5, "#ec4899");
      snGrad.addColorStop(1, "#38bdf8");
      targetCtx.strokeStyle = snGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, snX, snY, snW, snH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, snX + 45, snY + 40, 9, now, "#fbbf24");
      drawMagicSparkle(targetCtx, snX + snW - 45, snY + 40, 9, now + 300, "#38bdf8");
      textC(targetCtx, "✨ STELLAR SUPERNOVA HYPERBLAST! ✨", 540, snY + 36, 25, "#fbbf24", 950, "center");
      textC(targetCtx, `Ignited by ${e.name || "Viewer"} • Cosmic Starlight Radiance!`, 540, snY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "champion") {
      const cFade = t < 0.08 ? t / 0.08 : t > 0.88 ? (1 - t) / 0.12 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(cFade, 0, 1);

      const cx = 540, cy = 760;

      // 1. Rotating Golden God-Rays / Sunburst
      targetCtx.save();
      targetCtx.translate(px(cx), py(cy));
      targetCtx.rotate(now * 0.001);
      const beamCount = 14;
      for (let bi = 0; bi < beamCount; bi++) {
        const bAng = (bi * Math.PI * 2) / beamCount;
        targetCtx.fillStyle = "rgba(251, 191, 36, 0.12)";
        targetCtx.beginPath();
        targetCtx.moveTo(0, 0);
        targetCtx.arc(0, 0, ps(320), bAng - 0.08, bAng + 0.08);
        targetCtx.closePath();
        targetCtx.fill();
      }
      targetCtx.restore();

      // 2. 3D Golden Trophy Cup
      targetCtx.save();
      targetCtx.translate(px(cx), py(cy));

      // Trophy Pedestal Base
      targetCtx.fillStyle = "#78350f";
      rr(targetCtx, -ps(60), ps(90), ps(120), ps(25), ps(6));
      targetCtx.fill();
      targetCtx.fillStyle = "#b45309";
      rr(targetCtx, -ps(45), ps(72), ps(90), ps(20), ps(5));
      targetCtx.fill();

      // Trophy Stem
      targetCtx.fillStyle = "#fbbf24";
      targetCtx.fillRect(-ps(12), ps(40), ps(24), ps(34));

      // Trophy Main Bowl
      const bowlGrad = targetCtx.createLinearGradient(-ps(65), 0, ps(65), 0);
      bowlGrad.addColorStop(0, "#d97706");
      bowlGrad.addColorStop(0.3, "#fef08a");
      bowlGrad.addColorStop(0.7, "#fbbf24");
      bowlGrad.addColorStop(1, "#b45309");
      targetCtx.fillStyle = bowlGrad;
      targetCtx.beginPath();
      targetCtx.moveTo(-ps(65), -ps(45));
      targetCtx.bezierCurveTo(-ps(65), ps(45), ps(65), ps(45), ps(65), -ps(45));
      targetCtx.closePath();
      targetCtx.fill();

      // Dual Handles
      targetCtx.strokeStyle = "#fbbf24";
      targetCtx.lineWidth = ps(6);
      targetCtx.beginPath();
      targetCtx.arc(-ps(65), -ps(15), ps(24), Math.PI * 0.5, Math.PI * 1.5);
      targetCtx.stroke();
      targetCtx.beginPath();
      targetCtx.arc(ps(65), -ps(15), ps(24), -Math.PI * 0.5, Math.PI * 0.5);
      targetCtx.stroke();

      // Floating Royal Crown with Jewels
      const crownY = -ps(75 + Math.sin(now * 0.006) * 8);
      targetCtx.fillStyle = "#fbbf24";
      targetCtx.beginPath();
      targetCtx.moveTo(-ps(45), crownY);
      targetCtx.lineTo(-ps(45), crownY - ps(30));
      targetCtx.lineTo(-ps(22), crownY - ps(15));
      targetCtx.lineTo(0, crownY - ps(38));
      targetCtx.lineTo(ps(22), crownY - ps(15));
      targetCtx.lineTo(ps(45), crownY - ps(30));
      targetCtx.lineTo(ps(45), crownY);
      targetCtx.closePath();
      targetCtx.fill();

      // Crown Jewels
      drawMagicSparkle(targetCtx, 0, crownY - ps(38), 6, now, "#ef4444");
      drawMagicSparkle(targetCtx, -ps(45), crownY - ps(30), 5, now + 150, "#3b82f6");
      drawMagicSparkle(targetCtx, ps(45), crownY - ps(30), 5, now + 300, "#10b981");

      targetCtx.restore();

      // Announcement Badge
      const chW = 760, chH = 80, chX = 540 - chW / 2, chY = 920;
      targetCtx.fillStyle = "rgba(10, 20, 38, 0.95)";
      rr(targetCtx, chX, chY, chW, chH, 22);
      targetCtx.fill();

      const chGrad = targetCtx.createLinearGradient(px(chX), 0, px(chX + chW), 0);
      chGrad.addColorStop(0, "#fbbf24");
      chGrad.addColorStop(0.5, "#f59e0b");
      chGrad.addColorStop(1, "#fef08a");
      targetCtx.strokeStyle = chGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, chX, chY, chW, chH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, chX + 45, chY + 40, 9, now, "#fbbf24");
      drawMagicSparkle(targetCtx, chX + chW - 45, chY + 40, 9, now + 300, "#fef08a");
      textC(targetCtx, "👑 ROYAL CHAMPION CORONATION! 👑", 540, chY + 36, 25, "#fbbf24", 950, "center");
      textC(targetCtx, `Crowned by ${e.name || "Viewer"} • Bigg Boss Supremacy!`, 540, chY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "aurora" || e.type === "borealis") {
      const aFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(aFade, 0, 1);

      // Undulating ethereal celestial ribbons
      const ribbons = [
        { color1: "rgba(16, 185, 129, 0.45)", color2: "rgba(6, 182, 212, 0.0)", speed: 0.0015, yBase: 380, amp: 75, freq: 0.005 },
        { color1: "rgba(56, 189, 248, 0.50)", color2: "rgba(168, 85, 247, 0.0)", speed: 0.0022, yBase: 440, amp: 90, freq: 0.004 },
        { color1: "rgba(192, 132, 252, 0.45)", color2: "rgba(236, 72, 153, 0.0)", speed: 0.0018, yBase: 500, amp: 80, freq: 0.006 },
        { color1: "rgba(52, 211, 153, 0.60)", color2: "rgba(56, 189, 248, 0.0)", speed: 0.0025, yBase: 560, amp: 95, freq: 0.0045 }
      ];

      for (const rib of ribbons) {
        const grad = targetCtx.createLinearGradient(0, py(rib.yBase - 80), 0, py(rib.yBase + 160));
        grad.addColorStop(0, rib.color2);
        grad.addColorStop(0.4, rib.color1);
        grad.addColorStop(1, rib.color2);
        targetCtx.fillStyle = grad;

        targetCtx.beginPath();
        targetCtx.moveTo(0, py(rib.yBase));
        for (let x = 0; x <= 1080; x += 30) {
          const wave = Math.sin(now * rib.speed + x * rib.freq) * rib.amp +
                       Math.cos(now * rib.speed * 0.7 + x * 0.003) * (rib.amp * 0.4);
          targetCtx.lineTo(px(x), py(rib.yBase + wave));
        }
        targetCtx.lineTo(px(1080), py(rib.yBase + 180));
        targetCtx.lineTo(0, py(rib.yBase + 180));
        targetCtx.closePath();
        targetCtx.fill();
      }

      // Shimmering stars across aurora sky
      for (let si = 0; si < 8; si++) {
        const starX = 80 + (si * 125 + Math.sin(now * 0.002 + si) * 20);
        const starY = 360 + Math.sin(now * 0.003 + si * 1.5) * 60;
        drawMagicSparkle(targetCtx, starX, starY, 6 + (si % 3) * 2.5, now + si * 200, (si % 2 === 0) ? "#38bdf8" : "#4ade80");
      }

      // Glassmorphic Aurora Announcement Badge
      const aW = 780, aH = 80, aX = 540 - aW / 2, aY = 720;
      targetCtx.fillStyle = "rgba(4, 18, 25, 0.95)";
      rr(targetCtx, aX, aY, aW, aH, 22);
      targetCtx.fill();

      const aGrad = targetCtx.createLinearGradient(px(aX), 0, px(aX + aW), 0);
      aGrad.addColorStop(0, "#10b981");
      aGrad.addColorStop(0.5, "#06b6d4");
      aGrad.addColorStop(1, "#c084fc");
      targetCtx.strokeStyle = aGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, aX, aY, aW, aH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, aX + 45, aY + 40, 9, now, "#06b6d4");
      drawMagicSparkle(targetCtx, aX + aW - 45, aY + 40, 9, now + 300, "#10b981");
      textC(targetCtx, "🌌 CELESTIAL AURORA BOREALIS! 🌌", 540, aY + 36, 25, "#38bdf8", 950, "center");
      textC(targetCtx, `Summoned by ${e.name || "Viewer"} • Cosmic Light Veil Activated!`, 540, aY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "phoenix" || e.type === "firebird") {
      const pFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(pFade, 0, 1);

      // Ascending Phoenix position (rises from bottom to top)
      const phY = 1350 - t * 750;
      const phX = 540 + Math.sin(t * Math.PI * 3) * 65;
      const wingFlap = Math.sin(now * 0.015) * 28;

      // Fiery aura behind phoenix
      const auraGrad = targetCtx.createRadialGradient(px(phX), py(phY), ps(20), px(phX), py(phY), ps(180));
      auraGrad.addColorStop(0, "rgba(255, 255, 255, 0.85)");
      auraGrad.addColorStop(0.3, "rgba(251, 191, 36, 0.6)");
      auraGrad.addColorStop(0.7, "rgba(239, 68, 68, 0.35)");
      auraGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = auraGrad;
      targetCtx.beginPath();
      targetCtx.arc(px(phX), py(phY), ps(180), 0, Math.PI * 2);
      targetCtx.fill();

      // Sweeping Left and Right Wings of Flame
      targetCtx.save();
      targetCtx.translate(px(phX), py(phY));

      // Left Wing
      const leftWingGrad = targetCtx.createLinearGradient(-ps(160), 0, 0, 0);
      leftWingGrad.addColorStop(0, "#fbbf24");
      leftWingGrad.addColorStop(0.5, "#f97316");
      leftWingGrad.addColorStop(1, "#ef4444");
      targetCtx.fillStyle = leftWingGrad;
      targetCtx.beginPath();
      targetCtx.moveTo(0, -ps(15));
      targetCtx.quadraticCurveTo(-ps(110), -ps(90 + wingFlap), -ps(210), -ps(40 + wingFlap));
      targetCtx.quadraticCurveTo(-ps(140), ps(10), -ps(170), ps(30));
      targetCtx.quadraticCurveTo(-ps(90), ps(35), 0, ps(25));
      targetCtx.closePath();
      targetCtx.fill();

      // Right Wing
      const rightWingGrad = targetCtx.createLinearGradient(0, 0, ps(160), 0);
      rightWingGrad.addColorStop(0, "#ef4444");
      rightWingGrad.addColorStop(0.5, "#f97316");
      rightWingGrad.addColorStop(1, "#fbbf24");
      targetCtx.fillStyle = rightWingGrad;
      targetCtx.beginPath();
      targetCtx.moveTo(0, -ps(15));
      targetCtx.quadraticCurveTo(ps(110), -ps(90 + wingFlap), ps(210), -ps(40 + wingFlap));
      targetCtx.quadraticCurveTo(ps(140), ps(10), ps(170), ps(30));
      targetCtx.quadraticCurveTo(ps(90), ps(35), 0, ps(25));
      targetCtx.closePath();
      targetCtx.fill();

      // Phoenix Head & Golden Crest
      targetCtx.fillStyle = "#ffffff";
      targetCtx.beginPath();
      targetCtx.arc(0, -ps(30), ps(16), 0, Math.PI * 2);
      targetCtx.fill();
      drawMagicSparkle(targetCtx, 0, -ps(30), 12, now, "#fbbf24");

      // Crown Feathers
      targetCtx.fillStyle = "#fbbf24";
      targetCtx.beginPath();
      targetCtx.moveTo(0, -ps(45));
      targetCtx.lineTo(-ps(8), -ps(65));
      targetCtx.lineTo(0, -ps(58));
      targetCtx.lineTo(ps(8), -ps(65));
      targetCtx.closePath();
      targetCtx.fill();

      targetCtx.restore();

      // Announcement Badge
      const phBadgeW = 780, phBadgeH = 80, phBadgeX = 540 - phBadgeW / 2, phBadgeY = 720;
      targetCtx.fillStyle = "rgba(25, 10, 5, 0.96)";
      rr(targetCtx, phBadgeX, phBadgeY, phBadgeW, phBadgeH, 22);
      targetCtx.fill();

      const phGrad = targetCtx.createLinearGradient(px(phBadgeX), 0, px(phBadgeX + phBadgeW), 0);
      phGrad.addColorStop(0, "#ef4444");
      phGrad.addColorStop(0.5, "#f97316");
      phGrad.addColorStop(1, "#fbbf24");
      targetCtx.strokeStyle = phGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, phBadgeX, phBadgeY, phBadgeW, phBadgeH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, phBadgeX + 45, phBadgeY + 40, 9, now, "#fbbf24");
      drawMagicSparkle(targetCtx, phBadgeX + phBadgeW - 45, phBadgeY + 40, 9, now + 300, "#ef4444");
      textC(targetCtx, "🔥 MYTHICAL PHOENIX ASCENSION! 🔥", 540, phBadgeY + 36, 25, "#fbbf24", 950, "center");
      textC(targetCtx, `Summoned by ${e.name || "Viewer"} • Reborn from the Flames!`, 540, phBadgeY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "disco" || e.type === "laserstorm" || e.type === "rave") {
      const dscFade = t < 0.08 ? t / 0.08 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(dscFade, 0, 1);

      // Sweeping Dual Concert Spotlight Cones
      const spotColors = [
        ["rgba(6, 182, 212, 0.28)", "rgba(6, 182, 212, 0.0)"],
        ["rgba(236, 72, 153, 0.28)", "rgba(236, 72, 153, 0.0)"],
        ["rgba(251, 191, 36, 0.28)", "rgba(251, 191, 36, 0.0)"],
        ["rgba(168, 85, 247, 0.28)", "rgba(168, 85, 247, 0.0)"]
      ];

      for (let sIdx = 0; sIdx < 4; sIdx++) {
        const originX = (sIdx % 2 === 0) ? 60 : 1020;
        const originY = 340;
        const sweepAngle = Math.sin(now * 0.003 + sIdx * 1.6) * 0.65 + (sIdx % 2 === 0 ? 0.7 : -0.7);
        const targetBeamX = originX + Math.cos(sweepAngle) * 950;
        const targetBeamY = originY + Math.sin(sweepAngle) * 950;

        const spotGrad = targetCtx.createRadialGradient(px(originX), py(originY), 0, px(originX), py(originY), ps(850));
        spotGrad.addColorStop(0, spotColors[sIdx][0]);
        spotGrad.addColorStop(1, spotColors[sIdx][1]);
        targetCtx.fillStyle = spotGrad;

        targetCtx.beginPath();
        targetCtx.moveTo(px(originX), py(originY));
        targetCtx.lineTo(px(targetBeamX - 110), py(targetBeamY));
        targetCtx.lineTo(px(targetBeamX + 110), py(targetBeamY));
        targetCtx.closePath();
        targetCtx.fill();
      }

      // Disco Mirror Ball at Top Center
      const ballX = 540, ballY = 380;
      targetCtx.fillStyle = "#e2e8f0";
      targetCtx.beginPath();
      targetCtx.arc(px(ballX), py(ballY), ps(28), 0, Math.PI * 2);
      targetCtx.fill();

      // Rotating faceted glints from disco ball
      for (let g = 0; g < 8; g++) {
        const glintAngle = (now * 0.004 + g * (Math.PI / 4));
        const glintDist = ps(34 + Math.sin(now * 0.008 + g) * 12);
        const gx = ballX + Math.cos(glintAngle) * glintDist;
        const gy = ballY + Math.sin(glintAngle) * glintDist;
        drawMagicSparkle(targetCtx, gx, gy, 7, now + g * 120, (g % 2 === 0) ? "#f472b6" : "#38bdf8");
      }

      // Announcement Badge
      const dscW = 780, dscH = 80, dscX = 540 - dscW / 2, dscY = 720;
      targetCtx.fillStyle = "rgba(18, 10, 30, 0.96)";
      rr(targetCtx, dscX, dscY, dscW, dscH, 22);
      targetCtx.fill();

      const dscGrad = targetCtx.createLinearGradient(px(dscX), 0, px(dscX + dscW), 0);
      dscGrad.addColorStop(0, "#06b6d4");
      dscGrad.addColorStop(0.5, "#ec4899");
      dscGrad.addColorStop(1, "#fbbf24");
      targetCtx.strokeStyle = dscGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, dscX, dscY, dscW, dscH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, dscX + 45, dscY + 40, 9, now, "#ec4899");
      drawMagicSparkle(targetCtx, dscX + dscW - 45, dscY + 40, 9, now + 300, "#06b6d4");
      textC(targetCtx, "🪩 NEON DISCO LASER PARTY! 🪩", 540, dscY + 36, 25, "#ec4899", 950, "center");
      textC(targetCtx, `Party Launched by ${e.name || "Viewer"} • Dance Beat Activated!`, 540, dscY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "tornado" || e.type === "twister" || e.type === "cyclone") {
      const tFade = t < 0.08 ? t / 0.08 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(tFade, 0, 1);

      // Swirling Funnel Cloud Rings
      const torCenterX = 540 + Math.sin(now * 0.004) * 45;
      const ringCount = 12;
      for (let ri = 0; ri < ringCount; ri++) {
        const rp = ri / ringCount;
        const ry = 420 + rp * 780;
        const rw = ps(18 + rp * 170 + Math.sin(now * 0.008 + ri) * 18);
        const rh = ps(8 + rp * 28);
        const ringSpin = (now * 0.006 * (1 + rp * 2)) % (Math.PI * 2);

        targetCtx.strokeStyle = (ri % 2 === 0) ? "rgba(56, 189, 248, 0.45)" : "rgba(251, 191, 36, 0.45)";
        targetCtx.lineWidth = ps(3 + rp * 2.5);
        targetCtx.beginPath();
        targetCtx.ellipse(px(torCenterX + Math.cos(ringSpin) * 12), py(ry), rw, rh, 0, 0, Math.PI * 2);
        targetCtx.stroke();
      }

      // Lightning crackles inside tornado funnel
      if (Math.sin(now * 0.02) > 0.4) {
        targetCtx.strokeStyle = "#ffffff";
        targetCtx.lineWidth = ps(3);
        targetCtx.beginPath();
        let lx = torCenterX;
        let ly = 450;
        targetCtx.moveTo(px(lx), py(ly));
        for (let seg = 0; seg < 6; seg++) {
          lx += (Math.random() - 0.5) * 45;
          ly += 110;
          targetCtx.lineTo(px(lx), py(ly));
        }
        targetCtx.stroke();
      }

      // Announcement Badge
      const torW = 780, torH = 80, torX = 540 - torW / 2, torY = 720;
      targetCtx.fillStyle = "rgba(8, 20, 32, 0.96)";
      rr(targetCtx, torX, torY, torW, torH, 22);
      targetCtx.fill();

      const torGrad = targetCtx.createLinearGradient(px(torX), 0, px(torX + torW), 0);
      torGrad.addColorStop(0, "#38bdf8");
      torGrad.addColorStop(0.5, "#fbbf24");
      torGrad.addColorStop(1, "#38bdf8");
      targetCtx.strokeStyle = torGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, torX, torY, torW, torH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, torX + 45, torY + 40, 9, now, "#38bdf8");
      drawMagicSparkle(targetCtx, torX + torW - 45, torY + 40, 9, now + 300, "#fbbf24");
      textC(targetCtx, "🌪️ COSMIC TWISTER CYCLONE! 🌪️", 540, torY + 36, 25, "#38bdf8", 950, "center");
      textC(targetCtx, `Summoned by ${e.name || "Viewer"} • High-Velocity Vortex Activated!`, 540, torY + 65, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "buzzer" || e.type === "goldenbuzzer" || e.type === "siren") {
      const bFade = t < 0.08 ? t / 0.08 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(bFade, 0, 1);

      const cx = 540, cy = 840;

      // 1. Stage Emergency & Gold Rotating Sirens
      const sirenAngle = now * 0.006;
      for (let si = 0; si < 2; si++) {
        const sx0 = (si === 0) ? 120 : 960;
        const sy0 = 360;
        const beamAngle = sirenAngle + si * Math.PI;
        const spotGrad = targetCtx.createRadialGradient(px(sx0), py(sy0), 0, px(sx0), py(sy0), ps(900));
        spotGrad.addColorStop(0, (si === 0) ? "rgba(239, 68, 68, 0.4)" : "rgba(251, 191, 36, 0.4)");
        spotGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
        targetCtx.fillStyle = spotGrad;
        targetCtx.beginPath();
        targetCtx.moveTo(px(sx0), py(sy0));
        targetCtx.arc(px(sx0), py(sy0), ps(900), beamAngle - 0.25, beamAngle + 0.25);
        targetCtx.closePath();
        targetCtx.fill();
      }

      // 2. Expanding Golden Sonic Shockwaves
      const shockAge = (age % 550) / 550;
      targetCtx.strokeStyle = `rgba(251, 191, 36, ${(1 - shockAge) * 0.75})`;
      targetCtx.lineWidth = ps(4 * (1 - shockAge));
      targetCtx.beginPath();
      targetCtx.arc(px(cx), py(cy), ps(60 + shockAge * 240), 0, Math.PI * 2);
      targetCtx.stroke();

      // 3. 3D Golden Buzzer Dome Button
      // Metal Base Ring
      targetCtx.fillStyle = "#1e293b";
      targetCtx.beginPath();
      targetCtx.arc(px(cx), py(cy + 18), ps(78), 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.strokeStyle = "#fbbf24";
      targetCtx.lineWidth = ps(4);
      targetCtx.stroke();

      // Gold Dome
      const domePress = Math.abs(Math.sin(now * 0.015)) * 6;
      const domeGrad = targetCtx.createRadialGradient(px(cx - 15), py(cy - 15 + domePress), ps(8), px(cx), py(cy + domePress), ps(62));
      domeGrad.addColorStop(0, "#ffffff");
      domeGrad.addColorStop(0.3, "#fef08a");
      domeGrad.addColorStop(0.7, "#fbbf24");
      domeGrad.addColorStop(1, "#b45309");
      targetCtx.fillStyle = domeGrad;
      targetCtx.beginPath();
      targetCtx.arc(px(cx), py(cy + domePress), ps(62), 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.strokeStyle = "#ffffff";
      targetCtx.lineWidth = ps(2);
      targetCtx.stroke();

      // Glints on Buzzer
      drawGlint(targetCtx, cx - 25, cy - 25 + domePress, 12, now, "#ffffff");
      drawGlint(targetCtx, cx + 25, cy + 25 + domePress, 8, now + 300, "#fde047");

      // 4. Golden Buzzer Announcement Banner
      const banW = 820, banH = 92, banX = 540 - banW / 2, banY = 680;
      targetCtx.fillStyle = "rgba(12, 18, 32, 0.95)";
      rr(targetCtx, banX, banY, banW, banH, 24);
      targetCtx.fill();

      const bGrad = targetCtx.createLinearGradient(px(banX), 0, px(banX + banW), 0);
      bGrad.addColorStop(0, "#ef4444");
      bGrad.addColorStop(0.5, "#fbbf24");
      bGrad.addColorStop(1, "#ef4444");
      targetCtx.strokeStyle = bGrad;
      targetCtx.lineWidth = ps(3.2);
      rr(targetCtx, banX, banY, banW, banH, 24);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, banX + 45, banY + 46, 12, now, "#fbbf24");
      drawMagicSparkle(targetCtx, banX + banW - 45, banY + 46, 12, now + 250, "#ef4444");
      textC(targetCtx, "🚨 GOLDEN BUZZER HIT! STAGE ILLUMINATED! 🚨", 540, banY + 42, 28, "#fbbf24", 950, "center");
      textC(targetCtx, `Triggered by ${e.name || "Viewer"} • Big Reality Moment!`, 540, banY + 72, 19, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "clash" || e.type === "duel") {
      const cFade = t < 0.08 ? t / 0.08 : t > 0.88 ? (1 - t) / 0.12 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(cFade, 0, 1);

      const cx = 540, cy = 860;
      const c1 = e.payload?.c1 || 1;
      const c2 = e.payload?.c2 || 2;
      const name1 = e.payload?.name1 || `#${c1}`;
      const name2 = e.payload?.name2 || `#${c2}`;
      const img1 = contestantImages.get(c1);
      const img2 = contestantImages.get(c2);

      const v1 = Math.round(shownVotes.get(c1) || 1);
      const v2 = Math.round(shownVotes.get(c2) || 1);
      const totalV = v1 + v2 || 2;
      const ratio1 = Math.max(0.1, Math.min(0.9, v1 / totalV));

      // 1. Clash Arena Backdrop
      const arenaW = 860, arenaH = 260, arenaX = cx - arenaW / 2, arenaY = cy - arenaH / 2;
      targetCtx.fillStyle = "rgba(10, 15, 30, 0.95)";
      rr(targetCtx, arenaX, arenaY, arenaW, arenaH, 26);
      targetCtx.fill();

      const aGrad = targetCtx.createLinearGradient(px(arenaX), 0, px(arenaX + arenaW), 0);
      aGrad.addColorStop(0, "#38bdf8");
      aGrad.addColorStop(0.5, "#fbbf24");
      aGrad.addColorStop(1, "#f43f5e");
      targetCtx.strokeStyle = aGrad;
      targetCtx.lineWidth = ps(3.5);
      rr(targetCtx, arenaX, arenaY, arenaW, arenaH, 26);
      targetCtx.stroke();

      // 2. Header
      textC(targetCtx, "⚔️ 1v1 HEAD-TO-HEAD BATTLE CLASH ⚔️", cx, arenaY + 36, 24, "#fbbf24", 950, "center");

      // 3. Contestant 1 (Left)
      const avR = 45;
      const av1X = arenaX + 110, av1Y = cy + 10;
      drawAvatar(targetCtx, c1, av1X, av1Y, avR, p, img1);
      targetCtx.strokeStyle = "#38bdf8";
      targetCtx.lineWidth = ps(3);
      targetCtx.beginPath();
      targetCtx.arc(px(av1X), py(av1Y), ps(avR + 3), 0, Math.PI * 2);
      targetCtx.stroke();
      textC(targetCtx, fit(name1, 14), av1X, av1Y + avR + 25, 20, "#38bdf8", 900, "center");
      textC(targetCtx, `${v1.toLocaleString()} votes`, av1X, av1Y + avR + 45, 15, "#ffffff", 700, "center");

      // 4. Contestant 2 (Right)
      const av2X = arenaX + arenaW - 110, av2Y = cy + 10;
      drawAvatar(targetCtx, c2, av2X, av2Y, avR, p, img2);
      targetCtx.strokeStyle = "#f43f5e";
      targetCtx.lineWidth = ps(3);
      targetCtx.beginPath();
      targetCtx.arc(px(av2X), py(av2Y), ps(avR + 3), 0, Math.PI * 2);
      targetCtx.stroke();
      textC(targetCtx, fit(name2, 14), av2X, av2Y + avR + 25, 20, "#f43f5e", 900, "center");
      textC(targetCtx, `${v2.toLocaleString()} votes`, av2X, av2Y + avR + 45, 15, "#ffffff", 700, "center");

      // 5. Central Glowing VS Emblem & Electric Sparks
      const vsPulse = 1.0 + Math.sin(now * 0.012) * 0.08;
      targetCtx.save();
      targetCtx.translate(px(cx), py(cy + 5));
      targetCtx.scale(vsPulse, vsPulse);
      targetCtx.fillStyle = "#fbbf24";
      targetCtx.beginPath();
      targetCtx.arc(0, 0, ps(32), 0, Math.PI * 2);
      targetCtx.fill();
      textC(targetCtx, "VS", 0, 11, 26, "#0f172a", 950, "center");
      targetCtx.restore();

      // Electric spark between them
      targetCtx.strokeStyle = "#ffffff";
      targetCtx.lineWidth = ps(2);
      targetCtx.beginPath();
      targetCtx.moveTo(px(av1X + avR + 10), py(cy + 5));
      targetCtx.lineTo(px(cx - 36), py(cy + 5 + (Math.random() - 0.5) * 15));
      targetCtx.stroke();
      targetCtx.beginPath();
      targetCtx.moveTo(px(cx + 36), py(cy + 5));
      targetCtx.lineTo(px(av2X - avR - 10), py(cy + 5 + (Math.random() - 0.5) * 15));
      targetCtx.stroke();

      // 6. Tug-of-War Gauge Bar
      const barX = arenaX + 220, barY = arenaY + arenaH - 34, barW = arenaW - 440, barH = 14;
      targetCtx.fillStyle = "#334155";
      rr(targetCtx, barX, barY, barW, barH, barH / 2);
      targetCtx.fill();

      // Left share (c1)
      const fillW1 = barW * ratio1;
      targetCtx.fillStyle = "#38bdf8";
      rr(targetCtx, barX, barY, fillW1, barH, barH / 2);
      targetCtx.fill();

      // Right share (c2)
      targetCtx.fillStyle = "#f43f5e";
      rr(targetCtx, barX + fillW1, barY, barW - fillW1, barH, barH / 2);
      targetCtx.fill();

      targetCtx.restore();
    } else if (e.type === "fortune" || e.type === "lucky" || e.type === "oracle") {
      const fFade = t < 0.08 ? t / 0.08 : t > 0.88 ? (1 - t) / 0.12 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(fFade, 0, 1);

      const cx = 540, cy = 850;
      const cardW = 820, cardH = 230, cardX = cx - cardW / 2, cardY = cy - cardH / 2;

      // 1. Tarot Cosmic Aura
      const fAtmosphere = targetCtx.createRadialGradient(px(cx), py(cy), ps(20), px(cx), py(cy), ps(450));
      fAtmosphere.addColorStop(0, "rgba(168, 85, 247, 0.35)");
      fAtmosphere.addColorStop(0.6, "rgba(56, 189, 248, 0.12)");
      fAtmosphere.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = fAtmosphere;
      targetCtx.beginPath();
      targetCtx.arc(px(cx), py(cy), ps(450), 0, Math.PI * 2);
      targetCtx.fill();

      // 2. Glassmorphic Tarot Card
      targetCtx.fillStyle = "rgba(15, 12, 32, 0.95)";
      rr(targetCtx, cardX, cardY, cardW, cardH, 26);
      targetCtx.fill();

      const fGrad = targetCtx.createLinearGradient(px(cardX), 0, px(cardX + cardW), 0);
      fGrad.addColorStop(0, "#c084fc");
      fGrad.addColorStop(0.5, "#fbbf24");
      fGrad.addColorStop(1, "#38bdf8");
      targetCtx.strokeStyle = fGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, cardX, cardY, cardW, cardH, 26);
      targetCtx.stroke();

      // 3. Rotating Astrolabe Rune Circle
      targetCtx.save();
      targetCtx.translate(px(cardX + 75), py(cy));
      targetCtx.rotate(now * 0.0015);
      targetCtx.strokeStyle = "rgba(251, 191, 36, 0.7)";
      targetCtx.lineWidth = ps(2);
      targetCtx.beginPath();
      targetCtx.arc(0, 0, ps(42), 0, Math.PI * 2);
      targetCtx.stroke();
      drawMagicSparkle(targetCtx, 0, 0, 16, now, "#fbbf24");
      targetCtx.restore();

      // 4. Tarot Card Header & Prophecy Text
      textC(targetCtx, "🔮 BIGG BOSS MYSTIC ORACLE PROPHECY 🔮", cx, cardY + 36, 24, "#fbbf24", 950, "center");

      const prophecy = e.payload?.prophecy || "🌟 A dramatic voting overtake is approaching!";
      textC(targetCtx, `"${prophecy}"`, cx + 30, cardY + 98, 24, "#ffffff", 800, "center");

      // Voter Credit
      textC(targetCtx, `Consulted by ${fit(e.name || "Live Viewer", 20)} • Fate Revealed Live on Stream!`, cx + 30, cardY + 148, 17, "#c084fc", 700, "center");

      drawMagicSparkle(targetCtx, cardX + cardW - 40, cardY + 40, 10, now, "#38bdf8");
      drawMagicSparkle(targetCtx, cardX + cardW - 60, cardY + cardH - 40, 9, now + 350, "#c084fc");

      targetCtx.restore();
    } else if (e.type === "spotlight" || e.type === "beam") {
      const sFade = t < 0.08 ? t / 0.08 : t > 0.88 ? (1 - t) / 0.12 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(sFade, 0, 1);

      const targetNo = e.contestant || 1;
      const cItem = config.contestants.find(x => x.no === targetNo);
      const cName = cItem?.displayName || cItem?.name || `Contestant #${targetNo}`;

      // Card location in compact grid
      const cardIdx = (targetNo - 1) % 6;
      const cardX = 40, cardW = 1000, cardH = 142;
      const cardY = 428 + cardIdx * 150;
      const cardCenterY = cardY + cardH / 2;

      // 1. Dual Sweeping Stage Spotlights Converging on Card
      const beamL = targetCtx.createRadialGradient(px(80), py(120), 0, px(cardX + 200), py(cardCenterY), ps(900));
      beamL.addColorStop(0, "rgba(251, 191, 36, 0.45)");
      beamL.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = beamL;
      targetCtx.beginPath();
      targetCtx.moveTo(px(80), py(120));
      targetCtx.lineTo(px(cardX - 40), py(cardCenterY + 120));
      targetCtx.lineTo(px(cardX + 450), py(cardCenterY - 120));
      targetCtx.closePath();
      targetCtx.fill();

      const beamR = targetCtx.createRadialGradient(px(1000), py(120), 0, px(cardX + cardW - 200), py(cardCenterY), ps(900));
      beamR.addColorStop(0, "rgba(56, 189, 248, 0.45)");
      beamR.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = beamR;
      targetCtx.beginPath();
      targetCtx.moveTo(px(1000), py(120));
      targetCtx.lineTo(px(cardX + cardW - 450), py(cardCenterY - 120));
      targetCtx.lineTo(px(cardX + cardW + 40), py(cardCenterY + 120));
      targetCtx.closePath();
      targetCtx.fill();

      // 2. Illuminated Golden Halo Ellipse on the Contestant Card
      targetCtx.strokeStyle = "#fbbf24";
      targetCtx.lineWidth = ps(3.5);
      rr(targetCtx, cardX - 3, cardY - 3, cardW + 6, cardH + 6, 22);
      targetCtx.stroke();

      targetCtx.strokeStyle = "rgba(255, 255, 255, 0.6)";
      targetCtx.lineWidth = ps(1.2);
      rr(targetCtx, cardX + 1, cardY + 1, cardW - 2, cardH - 2, 20);
      targetCtx.stroke();

      // Floating dust motes / stage sparkles
      for (let di = 0; di < 6; di++) {
        const dAngle = now * 0.003 + di * 1.1;
        const dx = cardX + 150 + di * 120 + Math.cos(dAngle) * 35;
        const dy = cardCenterY + Math.sin(dAngle) * 25;
        drawMagicSparkle(targetCtx, dx, dy, 5, now + di * 200, (di % 2 === 0) ? "#fbbf24" : "#ffffff");
      }

      // 3. Stage Spotlight Announcement Badge
      const spBadgeW = 760, spBadgeH = 80, spBadgeX = 540 - spBadgeW / 2;
      const spBadgeY = (cardIdx <= 1) ? (cardY + cardH + 14) : (cardY - 92);
      targetCtx.fillStyle = "rgba(10, 18, 32, 0.95)";
      rr(targetCtx, spBadgeX, spBadgeY, spBadgeW, spBadgeH, 22);
      targetCtx.fill();

      targetCtx.strokeStyle = "#fbbf24";
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, spBadgeX, spBadgeY, spBadgeW, spBadgeH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, spBadgeX + 40, spBadgeY + 40, 9, now, "#fbbf24");
      drawMagicSparkle(targetCtx, spBadgeX + spBadgeW - 40, spBadgeY + 40, 9, now + 300, "#38bdf8");
      textC(targetCtx, `🔦 THEATRICAL STAGE SPOTLIGHT — #${targetNo} ${cName} 🌟`, 540, spBadgeY + 36, 23, "#fbbf24", 950, "center");
      textC(targetCtx, `Spotlight Directed by ${e.name || "Viewer"} • All Eyes on #${targetNo}!`, 540, spBadgeY + 65, 17, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "combo" || e.type === "streak") {
      const sFade = t < 0.08 ? t / 0.08 : t > 0.88 ? (1 - t) / 0.12 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(sFade, 0, 1);

      const cx = 540, cy = 760;
      const stW = 760, stH = 88, stX = cx - stW / 2, stY = cy - stH / 2;

      // Fiery Glow Background
      const fGrad = targetCtx.createLinearGradient(px(stX), 0, px(stX + stW), 0);
      fGrad.addColorStop(0, "#ef4444");
      fGrad.addColorStop(0.5, "#f97316");
      fGrad.addColorStop(1, "#fbbf24");
      targetCtx.fillStyle = "rgba(20, 8, 4, 0.95)";
      rr(targetCtx, stX, stY, stW, stH, 22);
      targetCtx.fill();

      targetCtx.strokeStyle = fGrad;
      targetCtx.lineWidth = ps(3.2);
      rr(targetCtx, stX, stY, stW, stH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, stX + 45, cy, 10, now, "#fbbf24");
      drawMagicSparkle(targetCtx, stX + stW - 45, cy, 10, now + 250, "#ef4444");
      textC(targetCtx, "🔥 VOTE COMBO MULTIPLIER SURGE! 🔥", cx, stY + 38, 26, "#fbbf24", 950, "center");
      textC(targetCtx, "Consecutive Chat Voting Active • Keep The Energy Flowing!", cx, stY + 68, 18, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "freeze" || e.type === "ice" || e.type === "blizzard") {
      const fFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(fFade, 0, 1);

      const cx = 540, cy = 960;

      // 1. Ethereal Glacial Frost Mist
      const iceMist = targetCtx.createRadialGradient(px(cx), py(cy), ps(60), px(cx), py(cy), ps(650));
      iceMist.addColorStop(0, "rgba(224, 242, 254, 0.35)");
      iceMist.addColorStop(0.5, "rgba(56, 189, 248, 0.18)");
      iceMist.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = iceMist;
      targetCtx.beginPath();
      targetCtx.arc(px(cx), py(cy), ps(650), 0, Math.PI * 2);
      targetCtx.fill();

      // 2. Rotating 6-Fold Symmetry Arctic Snowflake Crystals
      targetCtx.save();
      targetCtx.translate(px(cx), py(cy));
      const sRot = now * 0.0008;
      targetCtx.rotate(sRot);
      targetCtx.strokeStyle = "rgba(224, 242, 254, 0.85)";
      targetCtx.lineWidth = ps(2.5);

      for (let arm = 0; arm < 6; arm++) {
        const aRad = (arm * Math.PI) / 3;
        targetCtx.save();
        targetCtx.rotate(aRad);
        // Main crystal spine
        targetCtx.beginPath();
        targetCtx.moveTo(0, 0);
        targetCtx.lineTo(0, -ps(240));
        // Side crystal branches
        for (let b = 1; b <= 3; b++) {
          const bY = -ps(b * 55);
          targetCtx.moveTo(0, bY);
          targetCtx.lineTo(-ps(25), bY - ps(25));
          targetCtx.moveTo(0, bY);
          targetCtx.lineTo(ps(25), bY - ps(25));
        }
        targetCtx.stroke();
        targetCtx.restore();
      }
      targetCtx.restore();

      // 3. Icy Frost Vignette Border
      targetCtx.strokeStyle = "rgba(186, 230, 253, 0.55)";
      targetCtx.lineWidth = ps(4);
      targetCtx.setLineDash([ps(20), ps(12)]);
      targetCtx.strokeRect(px(16), py(16), ps(1048), ps(1888));
      targetCtx.setLineDash([]);

      // 4. Glacial Frost Announcement Badge
      const fW = 760, fH = 84, fX = 540 - fW / 2, fY = 660;
      targetCtx.fillStyle = "rgba(3, 20, 36, 0.95)";
      rr(targetCtx, fX, fY, fW, fH, 22);
      targetCtx.fill();

      targetCtx.strokeStyle = "#38bdf8";
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, fX, fY, fW, fH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, fX + 45, fY + 42, 10, now, "#bae6fd");
      drawMagicSparkle(targetCtx, fX + fW - 45, fY + 42, 10, now + 250, "#ffffff");
      textC(targetCtx, "❄️ ARCTIC BLIZZARD FREEZE! ❄️", cx, fY + 36, 25, "#7dd3fc", 950, "center");
      textC(targetCtx, `Cast by ${e.name || "Viewer"} • Sub-Zero Temperatures in the House!`, cx, fY + 66, 17, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "galaxy" || e.type === "nebula" || e.type === "milkyway") {
      const gFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(gFade, 0, 1);

      const cx = 540, cy = 960;
      const gRot = now * 0.0018;

      // 1. Volumetric Cosmic Nebula Core Bloom
      const galBloom = targetCtx.createRadialGradient(px(cx), py(cy), ps(20), px(cx), py(cy), ps(480));
      galBloom.addColorStop(0, "rgba(168, 85, 247, 0.45)");
      galBloom.addColorStop(0.35, "rgba(56, 189, 248, 0.28)");
      galBloom.addColorStop(0.7, "rgba(251, 191, 36, 0.12)");
      galBloom.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = galBloom;
      targetCtx.beginPath();
      targetCtx.arc(px(cx), py(cy), ps(480), 0, Math.PI * 2);
      targetCtx.fill();

      // 2. Swirling Starlight Spiral Arms in World Coordinates
      for (let arm = 0; arm < 4; arm++) {
        const armBase = arm * (Math.PI / 2) + gRot;
        for (let pt = 0; pt < 18; pt++) {
          const dist = 32 + pt * 22;
          const a = armBase + pt * 0.22;
          const sx = cx + Math.cos(a) * dist;
          const sy = cy + Math.sin(a) * (dist * 0.72);
          const col = (pt % 3 === 0) ? "#c084fc" : (pt % 3 === 1) ? "#38bdf8" : "#fbbf24";
          drawMagicSparkle(targetCtx, sx, sy, 3.5 + (pt % 3) * 1.5, now + pt * 90, col);
        }
      }

      // Singularity starlight core
      drawMagicSparkle(targetCtx, cx, cy, 26, now, "#ffffff");

      // 3. Galaxy Announcement Badge
      const gW = 760, gH = 84, gX = 540 - gW / 2, gY = 660;
      targetCtx.fillStyle = "rgba(15, 6, 32, 0.95)";
      rr(targetCtx, gX, gY, gW, gH, 22);
      targetCtx.fill();

      const gGrad = targetCtx.createLinearGradient(px(gX), 0, px(gX + gW), 0);
      gGrad.addColorStop(0, "#a855f7");
      gGrad.addColorStop(0.5, "#38bdf8");
      gGrad.addColorStop(1, "#fbbf24");
      targetCtx.strokeStyle = gGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, gX, gY, gW, gH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, gX + 45, gY + 42, 10, now, "#a855f7");
      drawMagicSparkle(targetCtx, gX + gW - 45, gY + 42, 10, now + 250, "#38bdf8");
      textC(targetCtx, "🌌 COSMIC GALAXY SINGULARITY! 🌌", cx, gY + 36, 25, "#c084fc", 950, "center");
      textC(targetCtx, `Summoned by ${e.name || "Viewer"} • Interstellar Stardust Active!`, cx, gY + 66, 17, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "tsunami" || e.type === "ocean" || e.type === "wave") {
      const wFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(wFade, 0, 1);

      // Cresting sweeping tsunami wave across bottom half
      const waveY = 1500 - t * 650;
      const waveGrad = targetCtx.createLinearGradient(0, py(waveY - 140), 0, py(waveY + 200));
      waveGrad.addColorStop(0, "rgba(255, 255, 255, 0.85)");
      waveGrad.addColorStop(0.2, "rgba(56, 189, 248, 0.75)");
      waveGrad.addColorStop(0.6, "rgba(2, 132, 199, 0.85)");
      waveGrad.addColorStop(1, "rgba(12, 74, 110, 0.95)");
      targetCtx.fillStyle = waveGrad;

      targetCtx.beginPath();
      targetCtx.moveTo(0, py(waveY + 200));
      for (let wx = 0; wx <= 1080; wx += 40) {
        const crest = Math.sin((wx / 1080) * Math.PI * 2.5 + now * 0.005) * 55;
        targetCtx.lineTo(px(wx), py(waveY + crest));
      }
      targetCtx.lineTo(px(1080), py(1920));
      targetCtx.lineTo(0, py(1920));
      targetCtx.closePath();
      targetCtx.fill();

      // Sea spray foam line
      targetCtx.strokeStyle = "#ffffff";
      targetCtx.lineWidth = ps(4);
      targetCtx.beginPath();
      for (let wx = 0; wx <= 1080; wx += 30) {
        const crest = Math.sin((wx / 1080) * Math.PI * 2.5 + now * 0.005) * 55;
        if (wx === 0) targetCtx.moveTo(px(wx), py(waveY + crest));
        else targetCtx.lineTo(px(wx), py(waveY + crest));
      }
      targetCtx.stroke();

      // Tsunami Announcement Badge
      const tW = 760, tH = 84, tX = 540 - tW / 2, tY = 660;
      targetCtx.fillStyle = "rgba(4, 28, 48, 0.95)";
      rr(targetCtx, tX, tY, tW, tH, 22);
      targetCtx.fill();

      targetCtx.strokeStyle = "#0284c7";
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, tX, tY, tW, tH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, tX + 45, tY + 42, 10, now, "#38bdf8");
      drawMagicSparkle(targetCtx, tX + tW - 45, tY + 42, 10, now + 250, "#ffffff");
      textC(targetCtx, "🌊 MIGHTY OCEAN TSUNAMI SURGE! 🌊", 540, tY + 36, 25, "#38bdf8", 950, "center");
      textC(targetCtx, `Unleashed by ${e.name || "Viewer"} • Tidal Wave Cresting the Stage!`, 540, tY + 66, 17, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "diamond" || e.type === "gem" || e.type === "prism") {
      const dFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(dFade, 0, 1);

      const cx = 540, cy = 960;
      const dRot = now * 0.0022;

      // 1. Volumetric Prism Bloom Halo
      const dBloom = targetCtx.createRadialGradient(px(cx), py(cy), ps(20), px(cx), py(cy), ps(460));
      dBloom.addColorStop(0, "rgba(255, 255, 255, 0.55)");
      dBloom.addColorStop(0.4, "rgba(56, 189, 248, 0.28)");
      dBloom.addColorStop(0.7, "rgba(244, 114, 182, 0.14)");
      dBloom.addColorStop(1, "rgba(0, 0, 0, 0)");
      targetCtx.fillStyle = dBloom;
      targetCtx.beginPath();
      targetCtx.arc(px(cx), py(cy), ps(460), 0, Math.PI * 2);
      targetCtx.fill();

      // 2. 8 Radiant Rainbow Prismatic Light Beams
      const beamColors = ["#f43f5e", "#fb923c", "#fbbf24", "#4ade80", "#22d3ee", "#818cf8", "#c084fc", "#f472b6"];
      for (let bi = 0; bi < 8; bi++) {
        const bAngle = (bi * Math.PI) / 4 + dRot;
        const bLen = 420;
        const bx = cx + Math.cos(bAngle) * bLen;
        const by = cy + Math.sin(bAngle) * bLen;
        const beamGrad = targetCtx.createLinearGradient(px(cx), py(cy), px(bx), py(by));
        beamGrad.addColorStop(0, "rgba(255, 255, 255, 0.85)");
        beamGrad.addColorStop(0.5, beamColors[bi]);
        beamGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
        targetCtx.strokeStyle = beamGrad;
        targetCtx.lineWidth = ps(3);
        targetCtx.beginPath();
        targetCtx.moveTo(px(cx), py(cy));
        targetCtx.lineTo(px(bx), py(by));
        targetCtx.stroke();
      }

      // 3. Central Brilliant 3D Diamond Polyhedron Facets
      const dRad = 65;
      const topPt = { x: cx, y: cy - dRad };
      const botPt = { x: cx, y: cy + dRad };
      const leftPt = { x: cx - dRad * 0.95, y: cy };
      const rightPt = { x: cx + dRad * 0.95, y: cy };

      targetCtx.fillStyle = "rgba(224, 242, 254, 0.88)";
      targetCtx.beginPath();
      targetCtx.moveTo(px(cx), py(cy));
      targetCtx.lineTo(px(topPt.x), py(topPt.y));
      targetCtx.lineTo(px(leftPt.x), py(leftPt.y));
      targetCtx.closePath();
      targetCtx.fill();

      targetCtx.fillStyle = "rgba(255, 255, 255, 0.98)";
      targetCtx.beginPath();
      targetCtx.moveTo(px(cx), py(cy));
      targetCtx.lineTo(px(topPt.x), py(topPt.y));
      targetCtx.lineTo(px(rightPt.x), py(rightPt.y));
      targetCtx.closePath();
      targetCtx.fill();

      targetCtx.fillStyle = "rgba(56, 189, 248, 0.82)";
      targetCtx.beginPath();
      targetCtx.moveTo(px(cx), py(cy));
      targetCtx.lineTo(px(botPt.x), py(botPt.y));
      targetCtx.lineTo(px(leftPt.x), py(leftPt.y));
      targetCtx.closePath();
      targetCtx.fill();

      targetCtx.fillStyle = "rgba(251, 207, 232, 0.88)";
      targetCtx.beginPath();
      targetCtx.moveTo(px(cx), py(cy));
      targetCtx.lineTo(px(botPt.x), py(botPt.y));
      targetCtx.lineTo(px(rightPt.x), py(rightPt.y));
      targetCtx.closePath();
      targetCtx.fill();

      targetCtx.strokeStyle = "#ffffff";
      targetCtx.lineWidth = ps(3);
      targetCtx.beginPath();
      targetCtx.moveTo(px(topPt.x), py(topPt.y));
      targetCtx.lineTo(px(rightPt.x), py(rightPt.y));
      targetCtx.lineTo(px(botPt.x), py(botPt.y));
      targetCtx.lineTo(px(leftPt.x), py(leftPt.y));
      targetCtx.closePath();
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, cx, cy, 26, now, "#ffffff");
      drawMagicSparkle(targetCtx, topPt.x, topPt.y, 12, now + 150, "#38bdf8");
      drawMagicSparkle(targetCtx, botPt.x, botPt.y, 12, now + 300, "#f472b6");
      drawMagicSparkle(targetCtx, leftPt.x, leftPt.y, 12, now + 450, "#fef08a");
      drawMagicSparkle(targetCtx, rightPt.x, rightPt.y, 12, now + 600, "#38bdf8");

      // Diamond Badge
      const dW = 760, dH = 84, dX = 540 - dW / 2, dY = 660;
      targetCtx.fillStyle = "rgba(10, 18, 36, 0.95)";
      rr(targetCtx, dX, dY, dW, dH, 22);
      targetCtx.fill();

      targetCtx.strokeStyle = "#fef08a";
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, dX, dY, dW, dH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, dX + 45, dY + 42, 10, now, "#fef08a");
      drawMagicSparkle(targetCtx, dX + dW - 45, dY + 42, 10, now + 250, "#38bdf8");
      textC(targetCtx, "💎 PRISMATIC DIAMOND BRILLIANCE! 💎", cx, dY + 36, 25, "#fef08a", 950, "center");
      textC(targetCtx, `Refracted by ${e.name || "Viewer"} • Pure Flawless Radiance!`, cx, dY + 66, 17, "#ffffff", 800, "center");

      targetCtx.restore();
    } else if (e.type === "cheer") {
      const cFade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
      targetCtx.save();
      targetCtx.globalAlpha = clamp(cFade, 0, 1);

      const targetNo = e.contestant || 1;
      const cItem = config.contestants.find(x => x.no === targetNo);
      const cName = cItem?.displayName || cItem?.name || `Contestant #${targetNo}`;
      const bounds = getContestantBounds(targetNo);

      // 1. Stadium Fan Electric Green & Gold Aura around Contestant Card
      const cheerPulse = 0.5 + 0.5 * Math.sin(now * 0.016);
      targetCtx.strokeStyle = `rgba(16, 185, 129, ${0.45 + 0.45 * cheerPulse})`;
      targetCtx.lineWidth = ps(6 + cheerPulse * 3);
      rr(targetCtx, bounds.x - 5, bounds.y - 5, bounds.w + 10, bounds.h + 10, 20);
      targetCtx.stroke();

      targetCtx.strokeStyle = "#fbbf24";
      targetCtx.lineWidth = ps(2.5);
      rr(targetCtx, bounds.x - 2, bounds.y - 2, bounds.w + 4, bounds.h + 4, 18);
      targetCtx.stroke();

      // Corner celebration sparkles on the card
      drawMagicSparkle(targetCtx, bounds.x + 15, bounds.y + 15, 8, now, "#34d399");
      drawMagicSparkle(targetCtx, bounds.x + bounds.w - 15, bounds.y + 15, 8, now + 200, "#fbbf24");
      drawMagicSparkle(targetCtx, bounds.x + 15, bounds.y + bounds.h - 15, 8, now + 400, "#fbbf24");
      drawMagicSparkle(targetCtx, bounds.x + bounds.w - 15, bounds.y + bounds.h - 15, 8, now + 600, "#34d399");

      // 2. Stadium Megaphone Cheer Announcement Badge
      const cW = 760, cH = 84, cX = 540 - cW / 2;
      const cY = (bounds.y < 600) ? (bounds.y + bounds.h + 20) : (bounds.y - cH - 20);
      targetCtx.fillStyle = "rgba(4, 30, 18, 0.95)";
      rr(targetCtx, cX, cY, cW, cH, 22);
      targetCtx.fill();

      const cheerGrad = targetCtx.createLinearGradient(px(cX), 0, px(cX + cW), 0);
      cheerGrad.addColorStop(0, "#10b981");
      cheerGrad.addColorStop(0.5, "#fbbf24");
      cheerGrad.addColorStop(1, "#10b981");
      targetCtx.strokeStyle = cheerGrad;
      targetCtx.lineWidth = ps(3);
      rr(targetCtx, cX, cY, cW, cH, 22);
      targetCtx.stroke();

      drawMagicSparkle(targetCtx, cX + 45, cY + 42, 10, now, "#34d399");
      drawMagicSparkle(targetCtx, cX + cW - 45, cY + 42, 10, now + 250, "#fbbf24");
      textC(targetCtx, `📣 STADIUM FAN CHEER — #${targetNo} ${cName}! 📣`, 540, cY + 36, 24, "#34d399", 950, "center");
      textC(targetCtx, `Cheered on by ${e.name || "Viewer"} • Energy Levels Skyrocketing!`, 540, cY + 66, 17, "#ffffff", 800, "center");

      targetCtx.restore();
    }
  }

  // On low-end CPUs, process at most 70 particles per frame so Skia frame draw time stays <15ms
  const activeParticles = s.particles.length > 70 ? s.particles.slice(0, 70) : s.particles;
  for (const q of activeParticles) {
    if (!q.born) q.born = now;
    const age = now - q.born;
    q.life = age;
    if (age > q.max) continue;

    const ageSec = age / 1000;
    const ox = q.originX ?? q.x;
    const oy = q.originY ?? q.y;
    const curX = ox + q.vx * ageSec + (q.sway ? Math.sin(age * (q.swayFreq || 0.004)) * (q.sway * ageSec) : 0);
    const curY = oy + q.vy * ageSec + 0.5 * (q.gravity ?? 65) * ageSec * ageSec;

    // Smooth bell-curve alpha: smooth fade-in for first 15%, silky cubic fade-out for remaining 85%
    const normAge = clamp(age / q.max, 0, 1);
    const alpha = normAge < 0.15 ? (normAge / 0.15) : Math.pow(1 - (normAge - 0.15) / 0.85, 1.8);
    const sz = Math.max(2, q.size * (0.65 + 0.35 * Math.sin(normAge * Math.PI)));

    targetCtx.save();
    targetCtx.globalAlpha = Math.max(0, Math.min(1, alpha));

    const shape = q.shape || "star";
    if (shape === "star" || shape === "spark") {
      if (q.isMagic) {
        drawMagicSparkle(targetCtx, curX, curY, sz * 0.95, now + q.born, q.color || p.goldBright);
      } else {
        drawGlint(targetCtx, curX, curY, sz * 0.65, now + q.born, q.color || p.goldBright);
      }
    } else if (shape === "heart") {
      targetCtx.save();
      targetCtx.translate(px(curX), py(curY));
      targetCtx.fillStyle = q.color || "#f472b6";
      const hs = ps(sz * 0.55);
      targetCtx.beginPath();
      targetCtx.moveTo(0, -hs * 0.4);
      targetCtx.bezierCurveTo(hs * 0.6, -hs, hs, hs * 0.2, 0, hs);
      targetCtx.bezierCurveTo(-hs, hs * 0.2, -hs * 0.6, -hs, 0, -hs * 0.4);
      targetCtx.fill();
      targetCtx.restore();
    } else if (shape === "rect" || shape === "confetti") {
      // Confetti rectangle with 3D tumble flip
      targetCtx.save();
      targetCtx.translate(px(curX), py(curY));
      const rot = (q.rot || 0) + (q.rotV || 0) * (age / 16);
      targetCtx.rotate(rot);
      const flutter = Math.cos(age * (q.flutterFreq || 0.008));
      targetCtx.scale(1, flutter);
      targetCtx.fillStyle = q.color || p.goldBright;
      const rw = ps(sz * 0.55), rh = ps(sz * 1.25);
      targetCtx.fillRect(-rw / 2, -rh / 2, rw, rh);
      targetCtx.restore();
    } else if (shape === "drop") {
      targetCtx.fillStyle = q.color || "#38bdf8";
      targetCtx.beginPath();
      targetCtx.arc(px(curX), py(curY), ps(sz * 0.4), 0, Math.PI * 2);
      targetCtx.fill();
    } else {
      // Fallback circle with soft radial glow
      targetCtx.fillStyle = q.color || p.goldBright;
      targetCtx.beginPath();
      targetCtx.arc(px(curX), py(curY), ps(Math.max(2, sz * 0.4)), 0, Math.PI * 2);
      targetCtx.fill();
    }

    targetCtx.restore();
  }
}

function getAlertTheme(name = "", text = "") {
  const key = `${name} ${text}`.toLowerCase();
  if (key.includes("buzzer") || key.includes("siren") || key.includes("danger") || key.includes("risk") || key.includes("elimination")) {
    return {
      type: "danger",
      icon: "🚨",
      tag: "EMERGENCY ALERT",
      bgGrad: ["#450a0a", "#7f1d1d", "#260606"],
      borderGrad: ["#ef4444", "#f97316", "#fbbf24"],
      pillBg: "rgba(239, 68, 68, 0.45)",
      pillText: "#fef2f2",
      titleColor: "#fef08a",
      textColor: "#ffffff",
      glowColor: "#ef4444",
      sparkleColor: "#fbbf24"
    };
  }
  if (key.includes("clash") || key.includes("duel") || key.includes("battle") || key.includes("vs") || key.includes("overtake")) {
    return {
      type: "clash",
      icon: "⚔️",
      tag: "1v1 BATTLE CLASH",
      bgGrad: ["#082f49", "#2e1065", "#4a044e"],
      borderGrad: ["#00f0ff", "#a855f7", "#ec4899"],
      pillBg: "rgba(168, 85, 247, 0.40)",
      pillText: "#f5d0fe",
      titleColor: "#38bdf8",
      textColor: "#ffffff",
      glowColor: "#00f0ff",
      sparkleColor: "#ec4899"
    };
  }
  if (key.includes("shield") || key.includes("immunity") || key.includes("protect") || key.includes("forcefield")) {
    return {
      type: "shield",
      icon: "🛡️",
      tag: "FORCEFIELD SHIELD",
      bgGrad: ["#042f2e", "#0c4a6e", "#022c22"],
      borderGrad: ["#00f0ff", "#10b981", "#38bdf8"],
      pillBg: "rgba(16, 185, 129, 0.40)",
      pillText: "#a7f3d0",
      titleColor: "#00f0ff",
      textColor: "#ffffff",
      glowColor: "#10b981",
      sparkleColor: "#00f0ff"
    };
  }
  if (key.includes("oracle") || key.includes("fortune") || key.includes("magic") || key.includes("spell") || key.includes("aurora") || key.includes("vortex")) {
    return {
      type: "mystic",
      icon: "🔮",
      tag: "MYSTIC ORACLE",
      bgGrad: ["#2e1065", "#3b0764", "#0f172a"],
      borderGrad: ["#c084fc", "#e879f9", "#38bdf8"],
      pillBg: "rgba(192, 132, 252, 0.40)",
      pillText: "#fae8ff",
      titleColor: "#fde047",
      textColor: "#ffffff",
      glowColor: "#c084fc",
      sparkleColor: "#f0abfc"
    };
  }
  if (key.includes("champion") || key.includes("trophy") || key.includes("crown") || key.includes("mvp") || key.includes("coronation") || key.includes("winner")) {
    return {
      type: "champion",
      icon: "👑",
      tag: "ROYAL CHAMPION",
      bgGrad: ["#451a03", "#78350f", "#1c1917"],
      borderGrad: ["#ffd700", "#f59e0b", "#fef08a"],
      pillBg: "rgba(251, 191, 36, 0.40)",
      pillText: "#fef9c3",
      titleColor: "#ffd700",
      textColor: "#ffffff",
      glowColor: "#ffd700",
      sparkleColor: "#fde047"
    };
  }
  if (key.includes("boost") || key.includes("rocket") || key.includes("nitro") || key.includes("speed")) {
    return {
      type: "boost",
      icon: "🚀",
      tag: "NITRO ROCKET BOOST",
      bgGrad: ["#082f49", "#0c4a6e", "#172554"],
      borderGrad: ["#38bdf8", "#00f0ff", "#fbbf24"],
      pillBg: "rgba(56, 189, 248, 0.40)",
      pillText: "#e0f2fe",
      titleColor: "#38bdf8",
      textColor: "#ffffff",
      glowColor: "#00f0ff",
      sparkleColor: "#fbbf24"
    };
  }
  if (key.includes("meteor") || key.includes("fire") || key.includes("dragon") || key.includes("phoenix") || key.includes("supernova") || key.includes("hype") || key.includes("streak") || key.includes("supervote")) {
    return {
      type: "fire",
      icon: "🔥",
      tag: "SUPERNOVA SURGE",
      bgGrad: ["#450a0a", "#7c2d12", "#18181b"],
      borderGrad: ["#ff0055", "#f97316", "#fbbf24"],
      pillBg: "rgba(249, 115, 22, 0.40)",
      pillText: "#ffedd5",
      titleColor: "#fbbf24",
      textColor: "#ffffff",
      glowColor: "#ff0055",
      sparkleColor: "#f97316"
    };
  }
  if (key.includes("disco") || key.includes("party") || key.includes("rave") || key.includes("confetti") || key.includes("matrix")) {
    return {
      type: "party",
      icon: "🪩",
      tag: "NEON PARTY CELEBRATION",
      bgGrad: ["#1e1b4b", "#4a044e", "#042f2e"],
      borderGrad: ["#00f0ff", "#ec4899", "#22c55e"],
      pillBg: "rgba(236, 72, 153, 0.40)",
      pillText: "#fce7f3",
      titleColor: "#00f0ff",
      textColor: "#ffffff",
      glowColor: "#ec4899",
      sparkleColor: "#22c55e"
    };
  }
  if (key.includes("confess") || key.includes("gossip")) {
    return {
      type: "confess",
      icon: "🤫",
      tag: "ANONYMOUS CONFESSION",
      bgGrad: ["#2e1065", "#4a044e", "#18181b"],
      borderGrad: ["#d946ef", "#a855f7", "#fbbf24"],
      pillBg: "rgba(217, 70, 239, 0.40)",
      pillText: "#fae8ff",
      titleColor: "#f59e0b",
      textColor: "#ffffff",
      glowColor: "#d946ef",
      sparkleColor: "#fbbf24"
    };
  }
  if (key.includes("vote") || key.includes("voting")) {
    return {
      type: "vote",
      icon: "⚡",
      tag: "VOTING STATUS UPDATE",
      bgGrad: ["#082f49", "#1e1b4b", "#0f172a"],
      borderGrad: ["#38bdf8", "#fbbf24", "#4ade80"],
      pillBg: "rgba(56, 189, 248, 0.40)",
      pillText: "#e0f2fe",
      titleColor: "#fbbf24",
      textColor: "#ffffff",
      glowColor: "#38bdf8",
      sparkleColor: "#fbbf24"
    };
  }
  if (key.includes("music") || key.includes("track") || key.includes("audio") || key.includes("playlist") || key.includes("song")) {
    return {
      type: "audio",
      icon: "🎵",
      tag: "MUSIC & STUDIO AUDIO",
      bgGrad: ["#1e1b4b", "#4c1d95", "#0369a1"],
      borderGrad: ["#a855f7", "#ec4899", "#00f0ff"],
      pillBg: "rgba(168, 85, 247, 0.45)",
      pillText: "#f5d0fe",
      titleColor: "#00f0ff",
      textColor: "#ffffff",
      glowColor: "#a855f7",
      sparkleColor: "#ec4899"
    };
  }
  if (key.includes("theme") || key.includes("dark") || key.includes("light") || key.includes("mode")) {
    return {
      type: "theme",
      icon: "🎨",
      tag: "VISUAL THEME SWITCH",
      bgGrad: ["#18181b", "#3b0764", "#172554"],
      borderGrad: ["#fbbf24", "#ec4899", "#8b5cf6"],
      pillBg: "rgba(236, 72, 153, 0.40)",
      pillText: "#fce7f3",
      titleColor: "#fbbf24",
      textColor: "#ffffff",
      glowColor: "#ec4899",
      sparkleColor: "#fbbf24"
    };
  }
  if (key.includes("command") || key.includes("help") || key.includes("guide")) {
    return {
      type: "command",
      icon: "⚡",
      tag: "INTERACTIVE COMMANDS",
      bgGrad: ["#022c22", "#064e3b", "#0f172a"],
      borderGrad: ["#10b981", "#00f0ff", "#fbbf24"],
      pillBg: "rgba(16, 185, 129, 0.40)",
      pillText: "#d1fae5",
      titleColor: "#34d399",
      textColor: "#ffffff",
      glowColor: "#10b981",
      sparkleColor: "#00f0ff"
    };
  }
  if (key.includes("milestone") || key.includes("record") || key.includes("target")) {
    return {
      type: "milestone",
      icon: "🏆",
      tag: "HISTORIC MILESTONE",
      bgGrad: ["#451a03", "#78350f", "#4a044e"],
      borderGrad: ["#ffd700", "#f97316", "#ff007f"],
      pillBg: "rgba(251, 191, 36, 0.45)",
      pillText: "#fef9c3",
      titleColor: "#ffd700",
      textColor: "#ffffff",
      glowColor: "#ffd700",
      sparkleColor: "#ff007f"
    };
  }
  if (key.includes("sub") || key.includes("subscriber")) {
    return {
      type: "subscriber",
      icon: "🎉",
      tag: "NEW SUBSCRIBER CELEBRATION",
      bgGrad: ["#450a0a", "#7f1d1d", "#1c1917"],
      borderGrad: ["#ef4444", "#ffd700", "#ef4444"],
      pillBg: "rgba(239, 68, 68, 0.45)",
      pillText: "#fee2e2",
      titleColor: "#ffd700",
      textColor: "#ffffff",
      glowColor: "#ef4444",
      sparkleColor: "#ffd700"
    };
  }
  // Default vivid holographic rainbow broadcast

  return {
    type: "default",
    icon: "📢",
    tag: "LIVE BROADCAST ALERT",
    bgGrad: ["#0f172a", "#1e1b4b", "#0f233a"],
    borderGrad: ["#38bdf8", "#fbbf24", "#f472b6"],
    pillBg: "rgba(251, 191, 36, 0.35)",
    pillText: "#fef08a",
    titleColor: "#fbbf24",
    textColor: "#ffffff",
    glowColor: "#38bdf8",
    sparkleColor: "#fbbf24"
  };
}

function drawColorfulAnnouncement(targetCtx, p, now, a, t) {
  const info = getAlertTheme(a.name || "", a.text || "");
  const cardW = 920, cardH = 120;
  const cx = 540, cy = 960;
  // Bouncy entrance & exit float in middle of screen
  const enterScale = t < 0.12 ? (0.8 + 0.25 * Math.sin((t / 0.12) * Math.PI * 0.5)) : t > 0.88 ? Math.max(0, 1 - (t - 0.88) / 0.12) : 1.0;
  const floatBob = Math.sin(Math.min(1, t) * Math.PI) * 8;
  const cardY = cy - cardH / 2 - floatBob;
  const cardX = cx - cardW / 2;

  targetCtx.save();
  targetCtx.translate(px(cx), py(cardY + cardH / 2));
  targetCtx.scale(enterScale, enterScale);
  targetCtx.translate(-px(cx), -py(cardY + cardH / 2));

  // High-Grade Multi-Stop Background Gradient (clean border, no dark backdrop box)
  const bg = targetCtx.createLinearGradient(px(cardX), py(cardY), px(cardX + cardW), py(cardY + cardH));
  bg.addColorStop(0, info.bgGrad[0]);
  bg.addColorStop(0.5, info.bgGrad[1]);
  bg.addColorStop(1, info.bgGrad[2]);
  targetCtx.fillStyle = bg;
  rr(targetCtx, cardX, cardY, cardW, cardH, 22);
  targetCtx.fill();

  // 3. Multi-Stop Vivid Neon Gradient Border
  const bGrad = targetCtx.createLinearGradient(px(cardX), 0, px(cardX + cardW), 0);
  bGrad.addColorStop(0, info.borderGrad[0]);
  bGrad.addColorStop(0.5, info.borderGrad[1]);
  bGrad.addColorStop(1, info.borderGrad[2]);
  targetCtx.strokeStyle = bGrad;
  targetCtx.lineWidth = ps(3.5);
  rr(targetCtx, cardX, cardY, cardW, cardH, 22);
  targetCtx.stroke();

  // 4. Secondary Inner Neon Pulse Stroke
  const innerPulse = 0.5 + 0.5 * Math.sin(now * 0.012);
  targetCtx.strokeStyle = `rgba(255, 255, 255, ${0.45 * innerPulse})`;
  targetCtx.lineWidth = ps(1.2);
  rr(targetCtx, cardX + 2, cardY + 2, cardW - 4, cardH - 4, 20);
  targetCtx.stroke();

  // 5. Animated Traveling Laser Shimmer across top border
  const laserW = 160;
  const laserPos = cardX + ((now * 0.35) % (cardW + laserW * 2)) - laserW;
  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.roundRect(px(cardX), py(cardY), ps(cardW), ps(cardH), ps(22));
  targetCtx.clip();
  const lGrad = targetCtx.createLinearGradient(px(laserPos), 0, px(laserPos + laserW), 0);
  lGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
  lGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.95)");
  lGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  targetCtx.fillStyle = lGrad;
  targetCtx.fillRect(px(laserPos), py(cardY), ps(laserW), ps(4));
  targetCtx.restore();

  // 6. Alert Header Badge Pill (Top Center)
  const pillW = 280, pillH = 26;
  const pillX = cx - pillW / 2, pillY = cardY + 14;
  targetCtx.fillStyle = info.pillBg;
  rr(targetCtx, pillX, pillY, pillW, pillH, 13);
  targetCtx.fill();
  targetCtx.strokeStyle = info.borderGrad[1] || info.borderGrad[0];
  targetCtx.lineWidth = ps(1.4);
  rr(targetCtx, pillX, pillY, pillW, pillH, 13);
  targetCtx.stroke();
  textC(targetCtx, `${info.icon}  ${info.tag}  ${info.icon}`, cx, pillY + 18, 13, info.pillText, 950, "center");

  // 7. Title Header (Alert Name)
  textC(targetCtx, a.name.toUpperCase(), cx, cardY + 62, 19, info.titleColor, 900, "center");

  // 8. Main Announcement Message Text (Bold & High Contrast)
  textC(targetCtx, a.text, cx, cardY + 98, 23, info.textColor, 800, "center");

  // 9. Floating Orbiting Sparkles
  drawMagicSparkle(targetCtx, cardX + 32, cardY + 32, 10, now, info.sparkleColor);
  drawMagicSparkle(targetCtx, cardX + cardW - 32, cardY + 32, 10, now + 300, info.borderGrad[0]);
  drawMagicSparkle(targetCtx, cardX + 45, cardY + cardH - 26, 8, now + 600, info.borderGrad[1]);
  drawMagicSparkle(targetCtx, cardX + cardW - 45, cardY + cardH - 26, 8, now + 900, info.sparkleColor);

  targetCtx.restore();
}

let haloCanvas = null;
function buildHaloCanvas() {
  const sz = 200;
  const cv = createCanvas(sz, sz);
  const cx = cv.getContext("2d");
  cx.translate(sz / 2, sz / 2);
  const avR = 62;
  const haloGrad = cx.createRadialGradient(0, 0, avR * 0.8, 0, 0, avR * 1.5);
  haloGrad.addColorStop(0, "rgba(251, 191, 36, 0.85)");
  haloGrad.addColorStop(0.5, "rgba(249, 115, 22, 0.5)");
  haloGrad.addColorStop(1, "rgba(251, 191, 36, 0)");
  cx.fillStyle = haloGrad;
  cx.beginPath();
  cx.arc(0, 0, avR * 1.5, 0, Math.PI * 2);
  cx.fill();
  return cv;
}

function drawVoteAlertOverlay(targetCtx, p, now) {
  if (!state.lastVote || !state.lastVote.at) return;
  const age = now - state.lastVote.at;
  // Active for 4200ms (4.2s), tolerating slight clock/dispatch skew
  if (age < -600 || age >= 4200) return;

  const safeAge = Math.max(0, age);
  const t = safeAge / 4200;
  // 1. Snappy 3D Spring Pop entrance & smooth dissolve exit
  let scale = 1.0;
  let alpha = 1.0;
  if (t < 0.12) {
    const pRatio = t / 0.12;
    scale = pRatio < 0.65 ? (pRatio / 0.65) * 1.08 : 1.08 - ((pRatio - 0.65) / 0.35) * 0.08;
    alpha = Math.min(1, t / 0.06);
  } else if (t > 0.86) {
    const exitT = (t - 0.86) / 0.14;
    scale = 1.0 + exitT * 0.06;
    alpha = Math.max(0, 1 - exitT);
  }

  // Organic gentle floating hover
  const hoverY = Math.sin(age * 0.005) * 6;
  const cx = 540;
  const cy = 960 + hoverY; // Exactly in the middle of screen!

  const cardW = 950, cardH = 260;
  const cardX = cx - cardW / 2;
  const cardY = cy - cardH / 2;

  const contestantNo = Number(state.lastVote.contestant || 1);
  const cItem = config.contestants.find(x => x.no === contestantNo);
  const cName = cItem?.displayName || cItem?.name || `Contestant #${contestantNo}`;
  const voterName = fit(state.lastVote.name || "Viewer", 16);
  const candidateName = fit(cName, 18).toUpperCase();
  const cVotes = state.contestants?.[String(contestantNo)]?.votes ?? cItem?.votes ?? 0;

  targetCtx.save();
  targetCtx.globalAlpha = clamp(alpha, 0, 1);

  // Confetti celebration particles exploding around the middle vote alert card
  const confettiColors = ["#fbbf24", "#38bdf8", "#ec4899", "#4ade80", "#f97316", "#ffffff", "#a855f7", "#ffd700"];
  targetCtx.save();
  for (let ci = 0; ci < 28; ci++) {
    const confAngle = (ci / 28) * Math.PI * 2 + Math.sin(ci * 11) * 0.3;
    const confSpeed = 160 + (ci % 7) * 45;
    const pTime = age * 0.001;
    const cDist = confSpeed * Math.min(1.2, pTime);
    const swayX = Math.sin(pTime * 5 + ci * 2) * 22;
    const cpx = px(cx + Math.cos(confAngle) * (cardW * 0.44 + cDist * 0.6) + swayX);
    const cpy = py(cy + Math.sin(confAngle) * (cardH * 0.38 + cDist * 0.4) + Math.pow(pTime, 1.4) * 220);
    const cRot = pTime * (5 + (ci % 5)) + ci;
    const cFade = Math.max(0, 1 - Math.max(0, (t - 0.65) / 0.35));
    const cCol = confettiColors[ci % confettiColors.length];
    const cSz = ps(6 + (ci % 6));
    const cosR = Math.cos(cRot);
    const sinR = Math.sin(cRot);
    const scaleY = Math.cos(cRot * 2.2);

    targetCtx.globalAlpha = clamp(alpha * cFade, 0, 1);
    targetCtx.setTransform(cosR, sinR, -sinR * scaleY, cosR * scaleY, cpx, cpy);
    targetCtx.fillStyle = cCol;
    targetCtx.fillRect(-cSz, -cSz * 0.6, cSz * 2, cSz * 1.2);
  }
  targetCtx.setTransform(1, 0, 0, 1, 0, 0);
  targetCtx.restore();

  // Transform for scale pop & spring
  targetCtx.translate(px(cx), py(cy));
  targetCtx.scale(scale, scale);
  targetCtx.translate(-px(cx), -py(cy));

  // 4. Glassmorphic Metallic Card Body
  const cardBg = targetCtx.createLinearGradient(px(cardX), py(cardY), px(cardX + cardW), py(cardY + cardH));
  cardBg.addColorStop(0, "#090d16");
  cardBg.addColorStop(0.35, "#17122b");
  cardBg.addColorStop(0.7, "#1c0d22");
  cardBg.addColorStop(1, "#070b14");
  targetCtx.fillStyle = cardBg;
  rr(targetCtx, cardX, cardY, cardW, cardH, 28);
  targetCtx.fill();

  // 5. Chromatic Multi-Stop Flame/Neon Border
  const bGrad = targetCtx.createLinearGradient(px(cardX), 0, px(cardX + cardW), 0);
  bGrad.addColorStop(0, "#fbbf24");
  bGrad.addColorStop(0.25, "#f97316");
  bGrad.addColorStop(0.5, "#ec4899");
  bGrad.addColorStop(0.75, "#00f0ff");
  bGrad.addColorStop(1, "#fbbf24");
  targetCtx.strokeStyle = bGrad;
  targetCtx.lineWidth = ps(3.8);
  rr(targetCtx, cardX, cardY, cardW, cardH, 28);
  targetCtx.stroke();

  // 6. Secondary Inner Neon Pulse Stroke
  const innerPulse = 0.5 + 0.5 * Math.sin(now * 0.014);
  targetCtx.strokeStyle = `rgba(255, 255, 255, ${0.45 * innerPulse})`;
  targetCtx.lineWidth = ps(1.4);
  rr(targetCtx, cardX + 3, cardY + 3, cardW - 6, cardH - 6, 25);
  targetCtx.stroke();

  // 7. Animated Traveling Laser Perimeter Shine (without heavy clip mask)
  const laserW = 180;
  const rawLaserPos = cardX + ((now * 0.45) % (cardW + laserW * 2)) - laserW;
  const glintStart = Math.max(cardX + 28, rawLaserPos);
  const glintEnd = Math.min(cardX + cardW - 28, rawLaserPos + laserW);
  if (glintEnd > glintStart) {
    const lGrad = targetCtx.createLinearGradient(px(glintStart), 0, px(glintEnd), 0);
    lGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
    lGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.95)");
    lGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    targetCtx.fillStyle = lGrad;
    targetCtx.fillRect(px(glintStart), py(cardY), ps(glintEnd - glintStart), ps(5));
  }

  // 8. Contestant Hero Avatar on the Left (R = 62)
  const avCenterX = cardX + 135;
  const avCenterY = cy;
  const avDiam = 124;
  const avR = avDiam / 2;

  // Rotating golden sunburst halo behind avatar (fast cached blit)
  targetCtx.save();
  targetCtx.translate(px(avCenterX), py(avCenterY));
  targetCtx.rotate(now * 0.002);
  if (!haloCanvas) haloCanvas = buildHaloCanvas();
  targetCtx.drawImage(haloCanvas, -ps(100), -ps(100), ps(200), ps(200));
  targetCtx.restore();

  // Pre-clipped circular avatar
  const avCanvas = getCircularAvatar(contestantNo, null, avDiam);
  if (avCanvas) {
    targetCtx.drawImage(avCanvas, px(avCenterX - avR), py(avCenterY - avR));
  } else {
    targetCtx.fillStyle = "#3b82f6";
    targetCtx.beginPath();
    targetCtx.arc(px(avCenterX), py(avCenterY), ps(avR), 0, Math.PI * 2);
    targetCtx.fill();
    textC(targetCtx, `#${contestantNo}`, avCenterX, avCenterY + 12, 34, "#ffffff", 950, "center");
  }

  // Avatar Metallic Ring & Border
  targetCtx.strokeStyle = "#fbbf24";
  targetCtx.lineWidth = ps(4.0);
  targetCtx.beginPath();
  targetCtx.arc(px(avCenterX), py(avCenterY), ps(avR), 0, Math.PI * 2);
  targetCtx.stroke();

  // Floating Royal Crown right above head
  drawCrown(targetCtx, avCenterX, avCenterY - avR - 16, 15, "#fbbf24");
  drawMagicSparkle(targetCtx, avCenterX + 18, avCenterY - avR - 22, 7, now, "#ffffff");

  // Number Badge Pill attached at bottom of avatar: "#1" or "#4"
  const noPillW = 68, noPillH = 26;
  const noPillX = avCenterX - noPillW / 2, noPillY = avCenterY + avR - 13;
  targetCtx.fillStyle = "#ef4444";
  rr(targetCtx, noPillX, noPillY, noPillW, noPillH, 13);
  targetCtx.fill();
  targetCtx.strokeStyle = "#ffffff";
  targetCtx.lineWidth = ps(1.6);
  rr(targetCtx, noPillX, noPillY, noPillW, noPillH, 13);
  targetCtx.stroke();
  textC(targetCtx, `#${contestantNo}`, avCenterX, noPillY + 18, 15, "#ffffff", 950, "center");

  // 9. Right Content Block
  const textLeftX = cardX + 235;

  // Header Alert Pill (Top)
  const pillW = 320, pillH = 30;
  const pillX = textLeftX, pillY = cardY + 22;
  const pillGrad = targetCtx.createLinearGradient(px(pillX), 0, px(pillX + pillW), 0);
  pillGrad.addColorStop(0, "rgba(239, 68, 68, 0.90)");
  pillGrad.addColorStop(1, "rgba(249, 115, 22, 0.90)");
  targetCtx.fillStyle = pillGrad;
  rr(targetCtx, pillX, pillY, pillW, pillH, 15);
  targetCtx.fill();
  targetCtx.strokeStyle = "#fbbf24";
  targetCtx.lineWidth = ps(1.6);
  rr(targetCtx, pillX, pillY, pillW, pillH, 15);
  targetCtx.stroke();
  drawEmoji(targetCtx, "⭐", px(pillX + 22), py(pillY + 15), ps(15));
  textC(targetCtx, "OFFICIAL LIVE VOTE", pillX + pillW / 2 + 2, pillY + 21, 14, "#ffffff", 950, "center");
  drawEmoji(targetCtx, "⭐", px(pillX + pillW - 22), py(pillY + 15), ps(15));

  // Voter Announcement Line
  const vLineY = pillY + 56;
  drawEmoji(targetCtx, "⚡", px(textLeftX + 12), py(vLineY - 7), ps(20));
  textC(targetCtx, voterName, textLeftX + 30, vLineY, 22, "#38bdf8", 900, "left");
  const voterMeasure = voterName.length * 13;
  textC(targetCtx, "just voted for", textLeftX + voterMeasure + 45, vLineY, 19, "#cbd5e1", 700, "left");

  // Big Contestant Hero Name
  const heroNameY = vLineY + 44;
  textC(targetCtx, candidateName, textLeftX, heroNameY, 32, "#fbbf24", 950, "left");

  // Dynamic Tally / Impact Tag Ribbon
  const tagRibW = cardW - 275, tagRibH = 36;
  const tagRibX = textLeftX, tagRibY = heroNameY + 22;
  targetCtx.fillStyle = "rgba(15, 23, 42, 0.85)";
  rr(targetCtx, tagRibX, tagRibY, tagRibW, tagRibH, 14);
  targetCtx.fill();
  targetCtx.strokeStyle = "rgba(74, 222, 128, 0.65)";
  targetCtx.lineWidth = ps(1.5);
  rr(targetCtx, tagRibX, tagRibY, tagRibW, tagRibH, 14);
  targetCtx.stroke();

  drawEmoji(targetCtx, "🔥", px(tagRibX + 20), py(tagRibY + 18), ps(18));
  textC(targetCtx, `+1 VOTE CONFIRMED • TOTAL: ${cVotes.toLocaleString()} VOTES`, tagRibX + 38, tagRibY + 24, 15.5, "#4ade80", 900, "left");
  drawEmoji(targetCtx, "🔥", px(tagRibX + tagRibW - 20), py(tagRibY + 18), ps(18));

  // 10. Corner Sparkle Embellishments
  drawMagicSparkle(targetCtx, cardX + 28, cardY + 28, 10, now, "#fbbf24");
  drawMagicSparkle(targetCtx, cardX + cardW - 28, cardY + 28, 10, now + 350, "#00f0ff");
  drawMagicSparkle(targetCtx, cardX + 35, cardY + cardH - 24, 8, now + 700, "#f97316");
  drawMagicSparkle(targetCtx, cardX + cardW - 35, cardY + cardH - 24, 8, now + 1050, "#fbbf24");

  targetCtx.restore();
}

function drawConfessionOverlay(targetCtx, p, now) {
  const conf = getActiveConfession(now);
  if (!conf) return;

  const t = (now - conf.at) / conf.durationMs;
  if (t < 0 || t >= 1) return;

  const fade = t < 0.1 ? (t / 0.1) : t > 0.85 ? ((1 - t) / 0.15) : 1;
  const slideY = t < 0.1 ? (1 - Math.sin((t / 0.1) * (Math.PI / 2))) * 40 : 0;

  const cardW = 960, cardH = 135;
  const cardX = (W - cardW) / 2;
  const quiz = getActiveQuiz(now);
  const baseCardY = quiz ? 1470 : 1640;
  const cardY = baseCardY + slideY;
  const cx = 540;

  targetCtx.save();
  targetCtx.globalAlpha = clamp(fade, 0, 1);

  // 1. Velvet & Cosmic 3-Stop Gradient Card
  const confBg = targetCtx.createLinearGradient(px(cardX), py(cardY), px(cardX + cardW), py(cardY + cardH));
  confBg.addColorStop(0, "#2e1065");
  confBg.addColorStop(0.5, "#4a044e");
  confBg.addColorStop(1, "#18181b");
  targetCtx.fillStyle = confBg;
  rr(targetCtx, cardX, cardY, cardW, cardH, 22);
  targetCtx.fill();

  // 3. Multi-Stop Chromatic Neon Border
  const confBorder = targetCtx.createLinearGradient(px(cardX), 0, px(cardX + cardW), 0);
  confBorder.addColorStop(0, "#ff007f");
  confBorder.addColorStop(0.35, "#d946ef");
  confBorder.addColorStop(0.7, "#a855f7");
  confBorder.addColorStop(1, "#fbbf24");
  targetCtx.strokeStyle = confBorder;
  targetCtx.lineWidth = ps(3.2);
  rr(targetCtx, cardX, cardY, cardW, cardH, 22);
  targetCtx.stroke();

  // 4. Inner Pulse Stroke
  const innerPulse = 0.5 + 0.5 * Math.sin(now * 0.012);
  targetCtx.strokeStyle = `rgba(255, 255, 255, ${0.4 * innerPulse})`;
  targetCtx.lineWidth = ps(1.2);
  rr(targetCtx, cardX + 2, cardY + 2, cardW - 4, cardH - 4, 20);
  targetCtx.stroke();

  // 5. Header Badge Pill
  const pillW = 320, pillH = 26;
  const pillX = cardX + 24, pillY = cardY + 14;
  const pillG = targetCtx.createLinearGradient(px(pillX), 0, px(pillX + pillW), 0);
  pillG.addColorStop(0, "rgba(217, 70, 239, 0.45)");
  pillG.addColorStop(1, "rgba(245, 158, 11, 0.45)");
  targetCtx.fillStyle = pillG;
  rr(targetCtx, pillX, pillY, pillW, pillH, 13);
  targetCtx.fill();
  targetCtx.strokeStyle = "#fbbf24";
  targetCtx.lineWidth = ps(1.2);
  rr(targetCtx, pillX, pillY, pillW, pillH, 13);
  targetCtx.stroke();
  textC(targetCtx, "🤫 ANONYMOUS FAN CONFESSION", pillX + pillW / 2, pillY + 18, 13.5, "#ffffff", 950, "center");

  // Author & contestant tag (right aligned)
  const authorTag = conf.author || "Secret Fan";
  const forTag = conf.contestant ? ` • For #${conf.contestant}` : "";
  textC(targetCtx, `By ${authorTag}${forTag}`, cardX + cardW - 24, pillY + 18, 15, "#fbbf24", 850, "right");

  // 6. Confession Text (quotes) - High Contrast & Glowing
  const quoteText = `“${conf.message}”`;
  textC(targetCtx, quoteText, 540, cardY + 76, 22, "#ffffff", 900, "center");

  // 7. Subtitle call to action
  textC(targetCtx, "Drop your secret in chat: !confess <message> • Stay Anonymous!", 540, cardY + 114, 14, "rgba(240, 240, 255, 0.75)", 700, "center");

  // Sparkles
  drawMagicSparkle(targetCtx, cardX + 18, cardY + 18, 8, now, "#ff007f");
  drawMagicSparkle(targetCtx, cardX + cardW - 18, cardY + 18, 8, now + 300, "#fbbf24");
  drawMagicSparkle(targetCtx, cardX + 28, cardY + cardH - 18, 7, now + 600, "#d946ef");
  drawMagicSparkle(targetCtx, cardX + cardW - 28, cardY + cardH - 18, 7, now + 900, "#00f0ff");

  targetCtx.restore();
}

function drawQuizOverlay(targetCtx, p, now) {
  const quiz = getActiveQuiz(now);
  if (!quiz) return;

  const remSec = Math.max(0, Math.ceil((quiz.expiresAt - now) / 1000));
  const isExpired = remSec === 0;

  const cardW = 980, cardH = 210;
  const cardX = (W - cardW) / 2;
  const cardY = 1620;
  const cx = 540;

  targetCtx.save();

  // 1. Cosmic Sapphire 3-Stop Gradient Card
  const qBg = targetCtx.createLinearGradient(px(cardX), py(cardY), px(cardX + cardW), py(cardY + cardH));
  qBg.addColorStop(0, "#082f49");
  qBg.addColorStop(0.5, "#1e1b4b");
  qBg.addColorStop(1, "#0f172a");
  targetCtx.fillStyle = qBg;
  rr(targetCtx, cardX, cardY, cardW, cardH, 24);
  targetCtx.fill();

  // 3. Multi-Stop Neon Border
  const quizBorder = targetCtx.createLinearGradient(px(cardX), 0, px(cardX + cardW), 0);
  quizBorder.addColorStop(0, "#00f0ff");
  quizBorder.addColorStop(0.35, "#8b5cf6");
  quizBorder.addColorStop(0.7, "#ec4899");
  quizBorder.addColorStop(1, "#fbbf24");
  targetCtx.strokeStyle = quizBorder;
  targetCtx.lineWidth = ps(3.2);
  rr(targetCtx, cardX, cardY, cardW, cardH, 24);
  targetCtx.stroke();

  // 4. Header Badge Pill
  const pillW = 270, pillH = 26;
  const pillX = cardX + 24, pillY = cardY + 16;
  targetCtx.fillStyle = "rgba(14, 165, 233, 0.45)";
  rr(targetCtx, pillX, pillY, pillW, pillH, 13);
  targetCtx.fill();
  targetCtx.strokeStyle = "#38bdf8";
  targetCtx.lineWidth = ps(1.2);
  rr(targetCtx, pillX, pillY, pillW, pillH, 13);
  targetCtx.stroke();
  textC(targetCtx, "🧠 BIGG BOSS LIVE TRIVIA QUIZ", pillX + pillW / 2, pillY + 18, 13.5, "#ffffff", 950, "center");

  // Timer Pill on right
  const timeLabel = isExpired ? "🔔 TIME'S UP!" : `⏱️ ${remSec}s REMAINING`;
  const timeCol = isExpired ? "#f43f5e" : "#fbbf24";
  textC(targetCtx, `${timeLabel} • Answer: !ans A/B/C/D`, cardX + cardW - 24, pillY + 18, 15, timeCol, 900, "right");

  // 5. Question Text
  textC(targetCtx, quiz.question, 540, cardY + 72, 22, "#ffffff", 900, "center");

  // 6. 4 Option Pills (2x2 grid) with colorful neon styling
  const letters = ["A", "B", "C", "D"];
  const optW = (cardW - 80) / 2;
  const optH = 44;

  for (let oi = 0; oi < 4; oi++) {
    const col = oi % 2;
    const row = Math.floor(oi / 2);
    const ox = cardX + 32 + col * (optW + 16);
    const oy = cardY + 102 + row * (optH + 10);
    const optLabel = quiz.options[oi] || "";
    const isCorrect = isExpired && letters[oi] === quiz.answer;

    // Glowing Option Gradient
    const oGrad = targetCtx.createLinearGradient(px(ox), 0, px(ox + optW), 0);
    if (isCorrect) {
      oGrad.addColorStop(0, "rgba(16, 185, 129, 0.65)");
      oGrad.addColorStop(1, "rgba(5, 150, 105, 0.65)");
    } else {
      oGrad.addColorStop(0, "rgba(30, 41, 59, 0.85)");
      oGrad.addColorStop(1, "rgba(15, 23, 42, 0.85)");
    }
    targetCtx.fillStyle = oGrad;
    rr(targetCtx, ox, oy, optW, optH, 12);
    targetCtx.fill();

    targetCtx.strokeStyle = isCorrect ? "#34d399" : "rgba(255, 255, 255, 0.22)";
    targetCtx.lineWidth = ps(isCorrect ? 2.8 : 1.4);
    rr(targetCtx, ox, oy, optW, optH, 12);
    targetCtx.stroke();

    const textColor = isCorrect ? "#34d399" : "#ffffff";
    textC(targetCtx, `[${letters[oi]}]  ${optLabel}`, ox + 18, oy + 28, 16.5, textColor, 850, "left");
  }

  // Corner sparkles
  drawMagicSparkle(targetCtx, cardX + 18, cardY + 18, 8, now, "#00f0ff");
  drawMagicSparkle(targetCtx, cardX + cardW - 18, cardY + 18, 8, now + 300, "#ec4899");

  targetCtx.restore();
}

function resetCanvasState(c) {
  try { c.setTransform(1, 0, 0, 1, 0, 0); } catch {}
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  c.shadowBlur = 0;
  c.shadowOffsetX = 0;
  c.shadowOffsetY = 0;
  c._curFont = "";
  c._curFill = "";
  c._curAlign = "";
  c._curBase = "";
}

function transitionDirection(from, to) {
  const a = SCREEN_ORDER.indexOf(from);
  const b = SCREEN_ORDER.indexOf(to);
  return b >= a ? 1 : -1;
}

function drawMainFrame(now, targetCtx = ctx) {
  currentFrameDt = 1 / (config.renderFps || 30);
  lastFrameAnimTime = now;
  lastDraw = now;

  const s = interactiveState();
  if (!s.screenTransition) tickScreens(now, config.screenIntervalMs);
  updateFloatingReactions(now);

  const screen = s.screen;
  const tr = getScreenTransition(now);
  const p = palette();

  resetCanvasState(targetCtx);

  // 1. Persistent background
  drawBackground(targetCtx, p, now);

  // 2. Persistent live top bar (with viewer count below LIVE, live clock, 5-bar EQ, theme toggle)
  drawTopBar(targetCtx, p, now);

  // 3. Persistent hero (Eye, Bigg Boss 3D title, subtitle pill, call-to-action, navigation tabs)
  drawHero(targetCtx, p, now, screenLabel(screen), tr);

  // 4. Content Area (Between tabs and bottom) with 10x-faster Snapshot Diagonal Cyber Wipe
  if (tr && tr.from !== tr.to) {
    const t = clamp(tr.t, 0, 1);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const dir = transitionDirection(tr.from, tr.to);

    // One-time snapshot of outgoing screen when transition starts (saves 30ms CPU per frame!)
    const transKey = `${tr.from}->${tr.to}@${tr.startedAt || tr.start || 0}`;
    if (capturedTransitionKey !== transKey) {
      oldCtx.clearRect(0, 0, W, H);
      drawBackground(oldCtx, p, now);
      drawScreenContent(tr.from, oldCtx, p, now);
      capturedTransitionKey = transKey;
    }

    // Render incoming screen directly to targetCtx (zero redundant intermediate buffer)
    drawScreenContent(tr.to, targetCtx, p, now);

    const clipY = py(412);
    const clipH = py(1730) - clipY;
    const angleOffset = ps(180);
    const wipeProgress = dir > 0 ? (1 - eased) : eased;
    const wipeX = wipeProgress * (W + angleOffset * 2) - angleOffset;

    // Composite outgoing screen snapshot with angled diagonal cyber wipe
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.rect(0, clipY, W, clipH);
    targetCtx.clip();

    targetCtx.save();
    targetCtx.beginPath();
    if (dir > 0) {
      targetCtx.moveTo(0, clipY);
      targetCtx.lineTo(wipeX + angleOffset, clipY);
      targetCtx.lineTo(wipeX - angleOffset, clipY + clipH);
      targetCtx.lineTo(0, clipY + clipH);
    } else {
      targetCtx.moveTo(W, clipY);
      targetCtx.lineTo(wipeX + angleOffset, clipY);
      targetCtx.lineTo(wipeX - angleOffset, clipY + clipH);
      targetCtx.lineTo(W, clipY + clipH);
    }
    targetCtx.closePath();
    targetCtx.clip();

    const oldScale = 1.0 - (1 - wipeProgress) * 0.06;
    targetCtx.globalAlpha = Math.max(0, Math.min(1, wipeProgress * 1.12));
    targetCtx.translate(W / 2, clipY + clipH / 2);
    targetCtx.scale(oldScale, oldScale);
    targetCtx.translate(-W / 2, -(clipY + clipH / 2));
    targetCtx.drawImage(oldSceneCanvas, 0, 0);
    targetCtx.restore();

    // Brilliant cyber neon laser blade along the diagonal boundary
    const topX = wipeX + angleOffset;
    const botX = wipeX - angleOffset;
    const bladeAlpha = Math.sin(t * Math.PI);

    // Cyan/Gold chromatic laser aura
    targetCtx.save();
    targetCtx.strokeStyle = p.cyan;
    targetCtx.lineWidth = ps(10);
    targetCtx.globalAlpha = 0.45 * bladeAlpha;
    targetCtx.beginPath();
    targetCtx.moveTo(topX, clipY);
    targetCtx.lineTo(botX, clipY + clipH);
    targetCtx.stroke();

    // Core white laser beam
    targetCtx.strokeStyle = "#ffffff";
    targetCtx.lineWidth = ps(3);
    targetCtx.globalAlpha = 0.95 * bladeAlpha;
    targetCtx.beginPath();
    targetCtx.moveTo(topX, clipY);
    targetCtx.lineTo(botX, clipY + clipH);
    targetCtx.stroke();
    targetCtx.restore();

    // Stardust diamond glints along traveling blade
    for (let si = 0; si < 5; si++) {
      const sp = (si + 0.5) / 5;
      const bx = topX * (1 - sp) + botX * sp;
      const by = clipY + clipH * sp;
      const sparkColor = (si % 2 === 0) ? "#fbbf24" : "#ffffff";
      drawMagicSparkle(targetCtx, bx / sx, by / sy, 5.5, now + si * 220, sparkColor);
    }

    targetCtx.restore();
  } else {
    capturedTransitionKey = "";
    drawScreenContent(screen, targetCtx, p, now);
  }

  // 5. Persistent anchored footer ticker at bottom
  drawFooter(targetCtx, p, now);

  // 6. Interactive overlays and particles on top
  drawInteractive(targetCtx, p, now);

  // 7. Middle-of-Screen Alert Overlays (Vote, Command Alerts & Like Magic)
  const events = getEvents(now);
  const isLikeMagicActive = events.some(e => e.type === "like_magic" && (now - e.createdAt) < e.durationMs);
  const nowVoteAge = state.lastVote?.at ? (now - state.lastVote.at) : 999999;
  const isVoteActive = nowVoteAge >= -600 && nowVoteAge < 4200;
  const isAnnouncementActive = Boolean(s.announcement && (now - s.announcement.at < s.announcement.durationMs + 200));

  // If like magic is celebrating in center, give it full center stage!
  if (!isLikeMagicActive) {
    // If announcement was issued AFTER the vote (e.g. user typed command), or if vote is not active:
    if (isAnnouncementActive && (!isVoteActive || s.announcement.at >= state.lastVote.at)) {
      const rawAnnAge = now - s.announcement.at;
      const tAnn = Math.max(0, Math.min(1, Math.max(0, rawAnnAge) / s.announcement.durationMs));
      drawColorfulAnnouncement(targetCtx, p, now, s.announcement, tAnn);
    } else if (isVoteActive) {
      drawVoteAlertOverlay(targetCtx, p, now);
    }
  }



  // 9. Live interactive HUD overlays (Confessions, Trivia)
  drawConfessionOverlay(targetCtx, p, now);
  drawQuizOverlay(targetCtx, p, now);

  resetCanvasState(targetCtx);
}

let activeWorkers = [];
let workerUnsubs = [];

export async function initRenderer() {
  registerAllFonts();
  await loadBackground();
  if (contestantImages.size === 0) {
    for (let no = 1; no <= 17; no++) {
      try {
        const buf = await readFile(`assets/contestants/${no}.jpg`);
        const img = await loadImage(buf);
        contestantImages.set(no, img);
      } catch {}
    }
  }
  warmAvatarCache();
  if (isMainThread) {
    const fs = await getFrameServer();
    setSnapshotGenerator(() => {
      try {
        return canvas.encodeSync("jpeg", config.jpegQuality);
      } catch {
        return null;
      }
    });
    if (fs) fs.startFrameServer();
    lastDraw = Date.now();
    drawMainFrame(Date.now());
    try {
      const isRaw = config.videoFeedFormat === "raw";
      if (isRaw) {
        publishFrame(null, canvas.data());
      } else {
        publishFrame(canvas.toBuffer("image/jpeg", config.jpegQuality));
      }
    } catch {}
  }

}

export async function startRenderer() {
  await initRenderer();
  running = true;
  runtime.renderer.dropped = 0;
  runtime.renderer.frames = 0;
  const isRaw = config.videoFeedFormat === "raw";
  const numWorkers = Math.max(1, config.renderWorkers || 1);
  runtime.renderer.workers = numWorkers;

  console.log(`[renderer] engine started with ${numWorkers} worker core(s) (${config.videoFeedFormat}@${config.renderFps}fps)`);

  if (numWorkers > 1) {
    const W = config.renderWidth, H = config.renderHeight;
    const bufSize = W * H * 4;
    const SLOTS_PER_WORKER = 4;
    const workerBuffers = [];

    for (let i = 0; i < numWorkers; i++) {
      if (isRaw) {
        const slots = [];
        for (let s = 0; s < SLOTS_PER_WORKER; s++) {
          const sab = new SharedArrayBuffer(bufSize);
          slots.push({ sab, buf: Buffer.from(sab) });
        }
        workerBuffers.push(slots);
      } else {
        workerBuffers.push(null);
      }
    }

    const workerPath = fileURLToPath(new URL("./render-worker.mjs", import.meta.url));
    const readyPromises = [];

    for (let i = 0; i < numWorkers; i++) {
      const p = new Promise(resolveReady => {
        const w = new Worker(workerPath, {
          workerData: {
            workerId: i,
            sabs: workerBuffers[i]?.map(slot => slot.sab) || null,
            W,
            H,
            isRaw,
            jpegQuality: config.jpegQuality
          }
        });
        w.once("message", (msg) => {
          if (msg.type === "ready") resolveReady(w);
        });
        w.on("error", (err) => console.error(`[renderer-worker-${i}] error:`, err));
        activeWorkers.push(w);
      });
      readyPromises.push(p);
    }

    await Promise.all(readyPromises);
    console.log(`[renderer] all ${numWorkers} worker threads initialized & ready across CPU cores`);
    let cachedStateSnapshot = null;
    let cachedInteractiveSnapshot = null;
    let lastStateSnapshotAt = 0;
    let lastInteractiveSnapshotAt = 0;

    function getCachedStateSnapshot(now) {
      if (!cachedStateSnapshot || (now - lastStateSnapshotAt >= 66)) {
        cachedStateSnapshot = getStateSnapshot();
        lastStateSnapshotAt = now;
      }
      return cachedStateSnapshot;
    }

    function getCachedInteractiveSnapshot(now) {
      if (!cachedInteractiveSnapshot || (now - lastInteractiveSnapshotAt >= 66)) {
        cachedInteractiveSnapshot = getInteractiveSnapshot();
        lastInteractiveSnapshotAt = now;
      }
      return cachedInteractiveSnapshot;
    }

    const broadcastEvent = (event, payload) => {
      cachedStateSnapshot = null;
      cachedInteractiveSnapshot = null;
      lastStateSnapshotAt = 0;
      lastInteractiveSnapshotAt = 0;
      for (const w of activeWorkers) {
        try { w.postMessage({ cmd: "event", event, payload }); } catch {}
      }
    };
    workerUnsubs = [
      on("chat", payload => broadcastEvent("chat", payload)),
      on("vote", payload => broadcastEvent("vote", payload)),
      on("theme", payload => broadcastEvent("theme", payload)),
      on("voting-open", payload => broadcastEvent("voting-open", payload)),
      on("voting-closed", payload => broadcastEvent("voting-closed", payload)),
      on("interactive", payload => broadcastEvent("interactive", payload)),
      on("poll-voted", payload => broadcastEvent("poll-voted", payload)),
      on("vote-announcement", payload => broadcastEvent("vote-announcement", payload)),
    ];

    const frameInterval = 1000 / config.renderFps;
    const PIPELINE_DEPTH = Math.max(12, numWorkers * 3);
    const frameQueue = new Map();
    const streamStartTime = Date.now();
    const workerInFlight = new Array(numWorkers).fill(0);
    const MAX_IN_FLIGHT_PER_WORKER = 3;
    const workerSlots = new Array(numWorkers).fill(0);
    const workerStats = Array.from({ length: numWorkers }, () => ({ frames: 0, totalMs: 0 }));
    let nextDispatchIndex = 0;
    let deliveryIndex = 0;
    let workerDispatchCursor = 0;

    function dispatchToWorker(workerId) {
      if (!running || workerInFlight[workerId] >= MAX_IN_FLIGHT_PER_WORKER) return;
      const frameIndex = nextDispatchIndex++;
      const slot = workerSlots[workerId];
      workerSlots[workerId] = (slot + 1) % SLOTS_PER_WORKER;
      workerInFlight[workerId]++;
      frameQueue.set(frameIndex, { workerId, slot, ready: false });

      const targetFrameTime = streamStartTime + Math.round(frameIndex * frameInterval);
      updateFloatingReactions(targetFrameTime);

      activeWorkers[workerId].postMessage({
        cmd: "render",
        workerId,
        frameIndex,
        slot,
        now: targetFrameTime,
        state: getCachedStateSnapshot(targetFrameTime),
        interactive: getCachedInteractiveSnapshot(targetFrameTime),
        floatingReactions: floatingReactions.slice()
      });
    }

    function dispatchNextIdleWorker() {
      while (running && (nextDispatchIndex - deliveryIndex) < PIPELINE_DEPTH) {
        let dispatched = false;
        for (let step = 0; step < numWorkers; step++) {
          const w = (workerDispatchCursor + step) % numWorkers;
          if (workerInFlight[w] < MAX_IN_FLIGHT_PER_WORKER) {
            workerDispatchCursor = (w + 1) % numWorkers;
            dispatchToWorker(w);
            dispatched = true;
            break;
          }
        }
        if (!dispatched) break;
      }
    }

    for (let i = 0; i < numWorkers; i++) {
      activeWorkers[i].on("message", (msg) => {
        if (msg.type === "frame_done") {
          workerInFlight[msg.workerId] = Math.max(0, workerInFlight[msg.workerId] - 1);
          workerStats[msg.workerId].frames++;
          workerStats[msg.workerId].totalMs += (msg.renderMs || 0);

          const item = frameQueue.get(msg.frameIndex);
          if (item) {
            item.ready = true;
            item.renderMs = msg.renderMs;
            if (isRaw) {
              const slot = (typeof msg.slot === "number") ? msg.slot : item.slot;
              item.rawBuf = workerBuffers[msg.workerId][slot].buf;
            } else {
              item.jpegBuf = msg.jpegBuf;
            }
          }
          dispatchNextIdleWorker();
        }
      });
    }

    // Pre-fill the pipeline evenly across all worker cores
    dispatchNextIdleWorker();

    return await new Promise(async resolve => {
      // 1. Warm-up prefill: buffer 8-12 frames ahead so heavy animations never starve the delivery loop
      const prefillTarget = Math.max(8, Math.min(12, numWorkers * 3));
      const prefillTimeout = performance.now() + 5000;
      while (running && performance.now() < prefillTimeout) {
        let readyCount = 0;
        for (let f = 0; f < prefillTarget; f++) {
          if (frameQueue.get(f)?.ready) readyCount++;
        }
        if (readyCount >= prefillTarget) break;
        await new Promise(r => setTimeout(r, 10));
      }

      let fpsFrames = 0;
      let fpsLastTime = performance.now();
      let lastPublishedJpeg = null;
      let lastPublishedRaw = isRaw ? canvas.data() : null;
      let deliveryStart = performance.now();

      const deliveryLoop = async () => {
        while (running) {
          const now = performance.now();
          const targetTime = deliveryStart + (deliveryIndex * frameInterval);

          // If main-thread I/O paused the event loop by more than 1 frame,
          // realign deliveryStart so we maintain continuous 30fps pacing without cascade drops
          if (now > targetTime + frameInterval) {
            deliveryStart = now - (deliveryIndex * frameInterval);
          }

          // Wait until this frame's target wall-clock delivery time
          const waitMs = (deliveryStart + deliveryIndex * frameInterval) - performance.now();
          if (waitMs > 16) {
            await new Promise(r => setTimeout(r, Math.floor(waitMs - 8)));
          }
          while ((deliveryStart + deliveryIndex * frameInterval) > performance.now() && running) {
            await new Promise(r => setImmediate(r));
          }
          if (!running) break;

          // Check if worker finished this frame (up to 120ms grace window to absorb single-frame GC/draw spikes)
          if (!frameQueue.get(deliveryIndex)?.ready) {
            const graceEnd = performance.now() + 120;
            while (!frameQueue.get(deliveryIndex)?.ready && performance.now() < graceEnd && running) {
              await new Promise(r => setTimeout(r, 2));
            }
          }

          const item = frameQueue.get(deliveryIndex);
          if (item && item.ready) {
            fpsFrames++;
            if (isRaw) {
              lastPublishedRaw = item.rawBuf;
              publishFrame(null, lastPublishedRaw);
            } else {
              lastPublishedJpeg = item.jpegBuf;
              publishFrame(item.jpegBuf);
            }
            runtime.renderer.frames++;
            runtime.renderer.lastFrameAt = Date.now();
            runtime.renderer.lastDrawMs = Math.round(item.renderMs || 0);
            frameQueue.delete(deliveryIndex);
          } else {
            // Only if frame was not ready after 45ms grace do we emit duplicate frame
            if (runtime.encoder?.connectedHint) {
              runtime.renderer.dropped++;
            }
            fpsFrames++;
            if (isRaw && lastPublishedRaw) {
              publishFrame(null, lastPublishedRaw);
            } else if (!isRaw && lastPublishedJpeg) {
              publishFrame(lastPublishedJpeg);
            }
            frameQueue.delete(deliveryIndex);
          }
          deliveryIndex++;
          dispatchNextIdleWorker();

          // FPS accounting & periodic logging with CPU core load distribution
          const nowFpsTime = performance.now();
          if (nowFpsTime - fpsLastTime >= 1000) {
            runtime.renderer.fps = Number(((fpsFrames * 1000) / (nowFpsTime - fpsLastTime)).toFixed(2));
            fpsFrames = 0;
            fpsLastTime = nowFpsTime;
            if (!runtime.renderer._lastLogTime || (nowFpsTime - runtime.renderer._lastLogTime >= 10000)) {
              runtime.renderer._lastLogTime = nowFpsTime;
              const totalFramesDone = workerStats.reduce((sum, ws) => sum + ws.frames, 0) || 1;
              const coreLoadStr = workerStats.map((ws, idx) => `c${idx}:${((ws.frames / totalFramesDone) * 100).toFixed(0)}%`).join(" ");
              console.log(`[renderer] fps=${runtime.renderer.fps.toFixed(1)} draw=${runtime.renderer.lastDrawMs}ms frames=${runtime.renderer.frames} dropped=${runtime.renderer.dropped} | cores[${numWorkers}]: ${coreLoadStr}`);
            }
          }
        }
        resolve();
      };

      deliveryLoop();
    });
  }

  // Fallback single-thread mode (monotonic real-time scheduler)
  return await new Promise(resolve => {
    const frameInterval = 1000 / config.renderFps;
    let frameIndex = 0;
    const startTime = performance.now();
    let fpsFrames = 0;
    let fpsLastTime = performance.now();
    let lastBuf = null;

    const loop = async () => {
      while (running) {
        const now = performance.now();
        const targetIndex = Math.floor((now - startTime) / frameInterval);

        if (frameIndex <= targetIndex) {
          if (targetIndex - frameIndex > 2) {
            frameIndex = targetIndex - 1;
          }
          while (frameIndex <= targetIndex && running) {
            frameIndex++;
            fpsFrames++;
            const animNow = Date.now();
            const t0 = performance.now();
            try {
              drawMainFrame(animNow, ctx);
              const t1 = performance.now();
              if (isRaw) {
                lastBuf = canvas.data();
                publishFrame(null, lastBuf);
              } else {
                lastBuf = await canvas.encode("jpeg", config.jpegQuality);
                publishFrame(lastBuf);
              }
              const t2 = performance.now();
              runtime.renderer.lastDrawMs = Math.round(t1 - t0);
              runtime.renderer.lastPublishMs = Math.round(t2 - t1);
              runtime.renderer.frames++;
              runtime.renderer.lastFrameAt = Date.now();
            } catch (err) {
              runtime.renderer.dropped++;
              if (lastBuf) {
                if (isRaw) publishFrame(null, lastBuf);
                else publishFrame(lastBuf);
              }
            }
          }
        }

        const nowFpsTime = performance.now();
        if (nowFpsTime - fpsLastTime >= 1000) {
          runtime.renderer.fps = Number(((fpsFrames * 1000) / (nowFpsTime - fpsLastTime)).toFixed(2));
          fpsFrames = 0;
          fpsLastTime = nowFpsTime;
          if (!runtime.renderer._lastLogTime || (nowFpsTime - runtime.renderer._lastLogTime >= 10000)) {
            runtime.renderer._lastLogTime = nowFpsTime;
            console.log(`[renderer] fps=${runtime.renderer.fps.toFixed(1)} draw=${runtime.renderer.lastDrawMs}ms pub=${runtime.renderer.lastPublishMs}ms frames=${runtime.renderer.frames} dropped=${runtime.renderer.dropped}`);
          }
        }

        const nextTargetTime = startTime + frameIndex * frameInterval;
        while (running && performance.now() < nextTargetTime) {
          const remaining = nextTargetTime - performance.now();
          if (remaining > 16) {
            await new Promise(r => setTimeout(r, Math.floor(remaining - 12)));
          } else {
            await new Promise(r => setImmediate(r));
          }
        }
      }
      resolve();
    };

    loop();
  });
}

export async function stopRenderer() {
  running = false;
  for (const unsub of workerUnsubs) {
    try { unsub(); } catch {}
  }
  workerUnsubs = [];
  for (const w of activeWorkers) {
    try {
      w.postMessage({ cmd: "stop" });
      w.terminate();
    } catch {}
  }
  activeWorkers = [];
  stopFrameServer();
}

export function getAvailableThemes() { return ["dark", "light"]; }
export { drawScene, drawMainFrame, canvas, ctx, drawBackground, drawTopBar, drawHero, drawEye, drawVoteScreen, drawVoteRow, drawBottomStats, drawFooter, palette };

