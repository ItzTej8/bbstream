import { config } from "./config.mjs";
import { state, registerWatchingCount } from "./state.mjs";
import { runtime } from "./runtime.mjs";
import { viewerEvent } from "./interactive.mjs";
import { getActiveVideoId } from "./youtube-resolver.mjs";

let lastKnownLikes = null;
let pollTimer = null;
let isPolling = false;

export const LIKE_MAGIC_THEMES = [
  {
    id: "magic_portal",
    name: "PORTAL",
    icon: "🌀",
    title: "CELESTIAL PORTAL UNLOCKED!",
    tag: "SPACE-TIME ANOMALY",
    subtitle: "A cosmic wormhole opened! Like energy bending Bigg Boss reality!",
    badgeBg: "linear-gradient(90deg, #8b5cf6, #3b82f6)",
    bgGrad: ["#1e1b4b", "#2e1065", "#020617"],
    borderGrad: ["#00f0ff", "#a855f7", "#fbbf24"],
    textColor: "#38bdf8",
    sparkleColor: "#a855f7"
  },
  {
    id: "disco_fever",
    name: "DISCO",
    icon: "🪩",
    title: "BIGG BOSS DISCO FEVER!",
    tag: "HOUSE DANCE PARTY",
    subtitle: "Bigg Boss breakdancing in the confession room! 100% lit vibes!",
    badgeBg: "linear-gradient(90deg, #ec4899, #f59e0b)",
    bgGrad: ["#4a044e", "#1e1b4b", "#0f172a"],
    borderGrad: ["#ff007f", "#39ff14", "#ffe600"],
    textColor: "#f472b6",
    sparkleColor: "#39ff14"
  },
  {
    id: "golden_wealth",
    name: "GOLDEN",
    icon: "👑",
    title: "ROYAL TREASURY SHOWER!",
    tag: "PURE 24K LUXURY",
    subtitle: "Raining 24K pure gold coins and diamonds across the house!",
    badgeBg: "linear-gradient(90deg, #f59e0b, #fbbf24)",
    bgGrad: ["#451a03", "#78350f", "#0c0a09"],
    borderGrad: ["#fbbf24", "#fef08a", "#f97316"],
    textColor: "#fde047",
    sparkleColor: "#fbbf24"
  },
  {
    id: "mega_love",
    name: "LOVE",
    icon: "💖",
    title: "MAXIMUM LOVE OVERLOAD!",
    tag: "ROMANCE ALERT",
    subtitle: "House romance levels exceeding safety protocols! Double-tap hearts!",
    badgeBg: "linear-gradient(90deg, #f43f5e, #ec4899)",
    bgGrad: ["#4c0519", "#831843", "#0f172a"],
    borderGrad: ["#ff007f", "#fbbf24", "#ec4899"],
    textColor: "#fb7185",
    sparkleColor: "#f43f5e"
  },
  {
    id: "alien_ufo",
    name: "ALIEN",
    icon: "🛸",
    title: "ALIEN TRACTOR BEAM!",
    tag: "EXTRATERRESTRIAL VISITATION",
    subtitle: "Extraterrestrials beaming down cosmic energy into Bigg Boss!",
    badgeBg: "linear-gradient(90deg, #10b981, #06b6d4)",
    bgGrad: ["#022c22", "#042f2e", "#020617"],
    borderGrad: ["#39ff14", "#00f0ff", "#a855f7"],
    textColor: "#34d399",
    sparkleColor: "#39ff14"
  },
  {
    id: "magic_wand",
    name: "SPELL",
    icon: "🪄",
    title: "HOGWARTS WAND SPELL!",
    tag: "MYSTIC CHARM",
    subtitle: "Expecto Patronum! +10,000 Magic immunity points granted!",
    badgeBg: "linear-gradient(90deg, #a855f7, #6366f1)",
    bgGrad: ["#3b0764", "#1e1b4b", "#09090b"],
    borderGrad: ["#c084fc", "#fbbf24", "#38bdf8"],
    textColor: "#c084fc",
    sparkleColor: "#fde047"
  },
  {
    id: "nitro_rocket",
    name: "ROCKET",
    icon: "🚀",
    title: "NITRO MOON ROCKET!",
    tag: "HYPER-DRIVE BOOST",
    subtitle: "Like counter ignited turbo rocket thrusters! Straight to orbit!",
    badgeBg: "linear-gradient(90deg, #f97316, #ef4444)",
    bgGrad: ["#431407", "#7f1d1d", "#0c0a09"],
    borderGrad: ["#f97316", "#fbbf24", "#ef4444"],
    textColor: "#fdba74",
    sparkleColor: "#f97316"
  },
  {
    id: "cyber_rave",
    name: "RAVE",
    icon: "🎧",
    title: "CYBER RAVE BASS DROP!",
    tag: "DJ BIGG BOSS",
    subtitle: "DJ Bigg Boss dropped the dirtiest bassline in television history!",
    badgeBg: "linear-gradient(90deg, #06b6d4, #8b5cf6)",
    bgGrad: ["#083344", "#1e1b4b", "#020617"],
    borderGrad: ["#00f0ff", "#ff007f", "#39ff14"],
    textColor: "#38bdf8",
    sparkleColor: "#00f0ff"
  },
  {
    id: "sigma_rizz",
    name: "SIGMA",
    icon: "🗿",
    title: "UNLIMITED SIGMA GIGACHAD!",
    tag: "100% MAXIMUM RIZZ",
    subtitle: "100% pure immaculate swagger! The entire house is completely speechless!",
    badgeBg: "linear-gradient(90deg, #64748b, #94a3b8)",
    bgGrad: ["#0f172a", "#1e293b", "#030712"],
    borderGrad: ["#38bdf8", "#fbbf24", "#e2e8f0"],
    textColor: "#cbd5e1",
    sparkleColor: "#38bdf8"
  },
  {
    id: "vegas_777",
    name: "JACKPOT",
    icon: "🎰",
    title: "777 VEGAS LUCKY HIT!",
    tag: "TRIPLE SEVEN MULTIPLIER",
    subtitle: "DING DING DING! Triple sevens jackpot rolled! Mega hype shower!",
    badgeBg: "linear-gradient(90deg, #eab308, #dc2626)",
    bgGrad: ["#450a0a", "#422006", "#09090b"],
    borderGrad: ["#fbbf24", "#ef4444", "#22c55e"],
    textColor: "#fef08a",
    sparkleColor: "#22c55e"
  }
];

export function getEffectiveVideoId() {
  return (
    getActiveVideoId() ||
    process.env.YOUTUBE_VIDEO_ID ||
    process.env.SOCIALCOUNTS_VIDEO_ID ||
    config.socialcountsVideoId ||
    config.videoId ||
    "Y6gpa3AUMK4"
  ).trim();
}

export async function fetchLiveSocialCounts(videoId) {
  const vid = videoId || getEffectiveVideoId();
  const url = `https://api.socialcounts.org/youtube-video-live-view-count/${vid}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "Referer": "https://socialcounts.org/"
      }
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const views = Number(data?.counters?.api?.viewCount ?? data?.counters?.estimation?.viewCount ?? 0);
    const likes = Number(data?.counters?.api?.likeCount ?? data?.counters?.estimation?.likeCount ?? 0);

    return { views, likes };
  } catch (err) {
    // Silently tolerate transient network drops
    return null;
  }
}

export function triggerLikeMagicCelebration(currentLikes, diff = 1) {
  state.lastLikeMagicAt = Date.now();
  state.lastLikeMagicCount = currentLikes;

  const themeIdx = Math.floor(Math.random() * LIKE_MAGIC_THEMES.length);
  const theme = LIKE_MAGIC_THEMES[themeIdx];

  viewerEvent({
    userId: "system_magic",
    name: "Live Fan",
    type: "like_magic",
    payload: {
      likes: currentLikes,
      diff: Math.max(1, diff),
      theme
    },
    durationMs: 5000
  });
}

export function startLikesMonitor({ signal, intervalMs = 5000 } = {}) {
  const videoId = getEffectiveVideoId();
  console.log(`[likes-monitor] Started live views & likes monitor for ${videoId} from .env (polling every ${Math.round(intervalMs / 1000)}s)`);

  const poll = async () => {
    if (signal?.aborted || isPolling) return;
    isPolling = true;

    try {
      const currentVideoId = getEffectiveVideoId();
      const counts = await fetchLiveSocialCounts(currentVideoId);
      if (counts) {
        const { views, likes } = counts;

        if (views > 0) {
          state.liveViews = views;
          runtime.chat.viewCount = views;
        }

        if (likes >= 0) {
          state.liveLikes = likes;
          runtime.chat.likeCount = likes;

          if (lastKnownLikes === null) {
            lastKnownLikes = likes;
            console.log(`[likes-monitor] Initial live likes baseline: ${likes} | Views: ${views.toLocaleString()}`);
          } else if (likes > lastKnownLikes) {
            const diff = likes - lastKnownLikes;
            console.log(`[likes-monitor] ✨ DOUBLE TAP LIKE RECEIVED! (${lastKnownLikes} -> ${likes}, +${diff}) — Triggering Magic Celebration! ✨`);
            triggerLikeMagicCelebration(likes, diff);
            lastKnownLikes = likes;
          } else if (likes < lastKnownLikes) {
            // Sync without false trigger if count adjusted downwards
            lastKnownLikes = likes;
          }
        }
      }
    } catch (e) {
      // Ignore transient errors
    } finally {
      isPolling = false;
      if (!signal?.aborted) {
        pollTimer = setTimeout(poll, intervalMs);
      }
    }
  };

  // Immediate first run
  poll();

  if (signal) {
    signal.addEventListener("abort", () => {
      if (pollTimer) clearTimeout(pollTimer);
    }, { once: true });
  }

  return () => {
    if (pollTimer) clearTimeout(pollTimer);
  };
}
