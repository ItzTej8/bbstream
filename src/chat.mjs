import { Masterchat, stringify } from "@stu43005/masterchat";
import { config } from "./config.mjs";
import { addChat, acceptVote, addManualVotes, saveState, setOwner, state, stats, setVoting, setTheme, registerWatchingCount } from "./state.mjs";
import { runtime } from "./runtime.mjs";
import { getActiveVideoId, resolveActiveVideoId } from "./youtube-resolver.mjs";
import {
  viewerEvent, voteEvent, setAnnouncement, setMusicEnabled, setScreen, nextScreen,
  previousScreen, setScreenAuto, setMenu, startPoll, votePoll, getPoll, addConfession,
  setContestantBuff, startQuiz, answerQuiz
} from "./interactive.mjs";
import { setBgMusicVolume, getBgMusicVolume, setMusicTrack, nextMusicTrack, prevMusicTrack, setTrackLoopMode, getTrackLoopMode, getMusicTrackInfo, MUSIC_TRACKS } from "./frame-server.mjs";
import { setTtsEnabled, isTtsEnabled, setTtsVoice, getTtsVoice, setTtsTargetContestant, getTtsFilterStatus } from "./tts.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SMILEY_REPLACEMENTS = [
  [/(^|\s):-?\)(?=\s|$)/g, "$1😊"],
  [/(^|\s):-?D(?=\s|$)/g, "$1😃"],
  [/(^|\s);-?\)(?=\s|$)/g, "$1😉"],
  [/(^|\s)<3(?=\s|$)/g, "$1❤️"],
  [/(^|\s):-?[pP](?=\s|$)/g, "$1😋"],
  [/(^|\s):-?\((?=\s|$)/g, "$1🙁"],
  [/(^|\s):'\(|:’\((?=\s|$)/g, "$1😢"],
  [/(^|\s):-?[oO](?=\s|$)/g, "$1😮"],
  [/(^|\s)\(y\)(?=\s|$)/gi, "$1👍"],
  [/(^|\s)\(n\)(?=\s|$)/gi, "$1👎"],
  [/(^|\s):fire:(?=\s|$)/gi, "$1🔥"],
  [/(^|\s):heart:(?=\s|$)/gi, "$1❤️"],
  [/(^|\s):crown:(?=\s|$)/gi, "$1👑"],
  [/(^|\s):clap:(?=\s|$)/gi, "$1👏"],
  [/(^|\s):star:(?=\s|$)/gi, "$1⭐"],
  [/(^|\s):tada:(?=\s|$)/gi, "$1🎉"]
];

function convertSmileys(str) {
  if (!str) return "";
  let s = String(str);
  for (const [re, em] of SMILEY_REPLACEMENTS) {
    s = s.replace(re, em);
  }
  return s;
}

const clean = value => {
  let s = String(value ?? "").replace(/[\u200b\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  return convertSmileys(s);
};
const idOf = a => a?.authorChannelId || a?.channelId || a?.author?.channelId || a?.author?.id || a?.authorExternalChannelId || a?.user?.channelId || a?.user?.id || null;
const ownerOf = a => Boolean(a?.isChatOwner || a?.isOwner || a?.authorIsChatOwner || a?.author?.isChatOwner || a?.author?.isOwner);
const modOf = a => Boolean(a?.isChatModerator || a?.isModerator || a?.authorIsChatModerator || a?.author?.isChatModerator || a?.author?.isModerator);

export const KNOWN_COMMANDS = new Set([
  "help", "theme", "dark", "light", "music", "track", "tracks", "vol", "volume", "louder", "quieter", "softer",
  "screen", "next", "prev", "previous", "auto", "menu", "profile",
  "drop", "boom", "bomb", "nuke", "heart", "rain", "gift", "crown", "zap", "fire", "flame", "cheer",
  "star", "support", "target", "battle", "vs", "dice", "coin", "slot", "wheel", "spin",
  "hype", "confetti", "party", "fireworks", "fw", "lightning", "zap2", "laser", "strike", "freeze", "ice", "lasers", "lightshow",
  "magic", "spell", "shield", "protect", "meteor", "boost", "rocket", "nitro", "shoutout",
  "vortex", "blackhole", "dragon", "flamethrower", "matrix", "supernova", "champion", "trophy",
  "aurora", "borealis", "phoenix", "firebird", "disco", "laserstorm", "rave", "tornado", "twister", "cyclone", "clap", "applause",
  "galaxy", "nebula", "milkyway", "tsunami", "ocean", "wave", "diamond", "gem", "prism",
  "confess", "gossip", "immunity", "danger", "supervote", "quiz", "trivia", "ans", "answer",
  "buzzer", "goldenbuzzer", "siren", "clash", "duel", "fortune", "lucky", "oracle", "spotlight", "beam", "streak", "combo",
  "random", "mvp", "event", "close", "open", "status", "predict", "winner", "addvotes", "addvote", "tts", "voice", "announce", "announcer"
]);

// Flexible vote & contestant alias map
const CONTESTANT_ALIASES = new Map();
function registerAlias(alias, no) {
  const clean = String(alias).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (clean.length >= 2) CONTESTANT_ALIASES.set(clean, no);
}

for (const c of config.contestants) {
  registerAlias(String(c.no), c.no);
  registerAlias(c.name, c.no);
  registerAlias(c.displayName, c.no);
  for (const part of `${c.name} ${c.displayName}`.split(/\s+/)) {
    const p = part.trim().toLowerCase();
    if (p.length >= 3 && p !== "the" && p !== "and" && p !== "love") {
      registerAlias(p, c.no);
    }
  }
}

// Explicit custom contestant first names & nicknames
registerAlias("mary", 1);
registerAlias("marykom", 1);
registerAlias("amrapali", 2);
registerAlias("aamrapali", 2);
registerAlias("uditi", 3);
registerAlias("arishfa", 4);
registerAlias("aman", 5);
registerAlias("qazi", 6);
registerAlias("touqeer", 6);
registerAlias("tauqeer", 6);
registerAlias("harsh", 7);
registerAlias("dsa", 7);
registerAlias("yungdsa", 7);
registerAlias("kushal", 8);
registerAlias("gullu", 8);
registerAlias("rhiya", 9);
registerAlias("lovegill", 10);
registerAlias("love gill", 10);
registerAlias("rohed", 11);
registerAlias("isha", 12);
registerAlias("mahhi", 13);
registerAlias("mahi", 13);
registerAlias("aasif", 14);
registerAlias("asif", 14);
registerAlias("rhiti", 15);
registerAlias("riti", 15);
registerAlias("kanika", 16);
registerAlias("scout", 17);
registerAlias("scoutop", 17);
registerAlias("tanmay", 17);

export function resolveContestantToken(token) {
  if (!token) return null;
  const raw = String(token).replace(/^#/, "").trim();
  const num = parseInt(raw, 10);
  if (!isNaN(num) && num >= 1 && num <= config.contestants.length) return num;
  const cleanKey = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (CONTESTANT_ALIASES.has(cleanKey)) return CONTESTANT_ALIASES.get(cleanKey);
  for (const [k, v] of CONTESTANT_ALIASES) {
    if (k.length >= 3 && (cleanKey.includes(k) || k.includes(cleanKey))) return v;
  }
  return null;
}

export function parseVote(message) {
  if (!message) return null;
  const cleanMsg = message.trim();

  // 1. !vote <arg> or vote <arg> (number, first name, or full name)
  const mVote = cleanMsg.match(/^\s*!?vote(?:\s+for)?(?:\s+contestant)?\s*#?\s*(.+)$/i);
  if (mVote) {
    const rawTarget = mVote[1].trim();
    const num = parseInt(rawTarget, 10);
    if (!isNaN(num) && num >= 1 && num <= config.contestants.length) return num;
    const key = rawTarget.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (CONTESTANT_ALIASES.has(key)) return CONTESTANT_ALIASES.get(key);
    for (const [k, v] of CONTESTANT_ALIASES) {
      if (k.length >= 3 && (key.includes(k) || k.includes(key))) return v;
    }
    return null;
  }

  // 2. !<alias> or /<alias> (e.g. !scout, !mary, !amrapali, !gullu, !kanika, !17)
  if (cleanMsg.startsWith("!") || cleanMsg.startsWith("/")) {
    const token = cleanMsg.slice(1).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (token && CONTESTANT_ALIASES.has(token) && !KNOWN_COMMANDS.has(token)) {
      return CONTESTANT_ALIASES.get(token);
    }
  }

  // 3. Exact alias as whole message (e.g. 'scout', 'mary kom', 'amrapali dubey', 'kanika mann')
  const cleanKey = cleanMsg.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleanKey && CONTESTANT_ALIASES.has(cleanKey) && !KNOWN_COMMANDS.has(cleanKey)) {
    return CONTESTANT_ALIASES.get(cleanKey);
  }

  return null;
}

export function parseVoteWithCount(message) {
  if (!message) return null;
  const cleanMsg = message.trim();

  // 1. !addvotes <contestant> <count> or !addvote <contestant> <count>
  const mAdd = cleanMsg.match(/^\s*!?addvotes?(?:\s+for)?(?:\s+contestant)?\s*#?\s*([a-zA-Z0-9_\-]+)(?:\s+\+?(\d+))?$/i);
  if (mAdd) {
    const contestant = resolveContestantToken(mAdd[1]);
    if (contestant) {
      const count = mAdd[2] ? parseInt(mAdd[2], 10) : 1;
      return { contestant, count, isManualAdd: true };
    }
  }

  // 2. !vote <contestant> <count> (e.g. !vote 2 100, !vote kanika 100, !vote 2 +50)
  const mVoteCount = cleanMsg.match(/^\s*!?vote(?:\s+for)?(?:\s+contestant)?\s*#?\s*([a-zA-Z0-9_\-]+)\s+\+?(\d+)\s*$/i);
  if (mVoteCount) {
    const contestant = resolveContestantToken(mVoteCount[1]);
    if (contestant) {
      const count = parseInt(mVoteCount[2], 10);
      return { contestant, count, isManualAdd: true };
    }
  }

  // 3. Standard single vote
  const singleVote = parseVote(message);
  if (singleVote) {
    return { contestant: singleVote, count: 1, isManualAdd: false };
  }

  return null;
}

function textFromRuns(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromRuns).join("");
  if (typeof value === "object") {
    if (typeof value.simpleText === "string") return value.simpleText;
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.runs)) {
      return value.runs.map(r => {
        if (r?.text) return r.text;
        if (r?.emoji) {
          const id = r.emoji.emojiId;
          if (id && !id.startsWith("UC") && !id.includes("/")) return id;
          const shortcut = r.emoji.shortcuts?.[0] || r.emoji.searchTerms?.[0] || "";
          return shortcut ? ` ${shortcut} ` : (id || "");
        }
        return "";
      }).join("");
    }
  }
  return "";
}

function findRenderer(value) {
  if (!value || typeof value !== "object") return null;
  if (value.liveChatTextMessageRenderer) return value.liveChatTextMessageRenderer;
  if (value.addChatItemAction?.item?.liveChatTextMessageRenderer) return value.addChatItemAction.item.liveChatTextMessageRenderer;
  if (Array.isArray(value)) {
    for (const v of value) { const found = findRenderer(v); if (found) return found; }
  } else {
    for (const v of Object.values(value)) {
      if (v && typeof v === "object") { const found = findRenderer(v); if (found) return found; }
    }
  }
  return null;
}

function stringifySafe(value) {
  const direct = textFromRuns(value);
  if (direct) return direct;
  try { return clean(stringify(value)); } catch {}
  return "";
}

function extractChat(action) {
  const renderer = findRenderer(action);
  const candidates = [renderer, action?.addChatItemAction?.item, action?.item, action].filter(Boolean);
  const message = clean(renderer ? stringifySafe(renderer.message) : candidates.map(c => stringifySafe(c.message ?? c.messageRuns ?? c.text ?? c.messageText)).find(Boolean) || "");
  const author = clean(renderer?.authorName ? textFromRuns(renderer.authorName) : candidates.map(c => textFromRuns(c.authorName) || c.author?.name || c.user?.name || c.author?.displayName).find(Boolean) || "Viewer");
  const id = renderer?.authorExternalChannelId || renderer?.authorChannelId || candidates.map(idOf).find(Boolean) || null;
  const owner = candidates.some(ownerOf);
  const mod = candidates.some(modOf);
  const messageId = renderer?.id || candidates.map(c => c.id || c.messageId || c.chatId).find(Boolean) || null;
  return { message, author, id: id ? String(id) : null, owner, mod, messageId };
}

function fallbackVoteId(action, author, message, messageId) {
  const raw = `${messageId || ""}\u0000${author}\u0000${message}\u0000${action?.timestampUsec || Date.now()}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `anon:${(h >>> 0).toString(16)}:${Date.now()}`;
}

function admin(id, owner, mod) { return Boolean(id && (owner || mod || config.adminChannelIds.includes(String(id)))); }

async function resolveLiveVideoId(channelId) {
  if (!channelId) return null;
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    const html = await res.text();
    const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/i);
    const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    const id = canonicalMatch?.[1] || videoIdMatch?.[1];
    return id || null;
  } catch {}
  return null;
}

function extractViewersAndViews(html) {
  let viewers = null;
  let views = null;

  // Concurrent live viewers matching patterns
  const mLive1 = html.match(/"concurrentViewers":"?(\d+)"?/);
  const mLive2 = html.match(/(\d[\d,.]*)\s+watching/i);
  const mLive3 = html.match(/"originalViewCount":"?(\d+)"?/);
  const mLive4 = html.match(/"text":"([0-9,]+)"\s*},\s*{"text":"\s*watching/i);

  const vStr = mLive1?.[1] || mLive3?.[1] || mLive4?.[1] || mLive2?.[1];
  if (vStr) {
    const n = parseInt(vStr.replace(/,/g, ""), 10);
    if (!isNaN(n) && n >= 0) viewers = n;
  }

  function parseCount(s) {
    if (!s) return null;
    s = s.replace(/,/g, "").trim().toLowerCase();
    let mult = 1;
    if (s.endsWith("k")) { mult = 1000; s = s.slice(0, -1); }
    else if (s.endsWith("m")) { mult = 1000000; s = s.slice(0, -1); }
    else if (s.endsWith("b")) { mult = 1000000000; s = s.slice(0, -1); }
    const val = parseFloat(s);
    return isNaN(val) ? null : Math.round(val * mult);
  }

  // Total stream views accumulated from videoDetails
  const mViewsDetails = html.match(/"videoDetails":\{[^}]*"viewCount":"?(\d+)"?/);
  if (mViewsDetails?.[1]) {
    const v = parseInt(mViewsDetails[1], 10);
    if (!isNaN(v) && v >= 0) views = v;
  }
  const mViews1 = html.match(/"viewCount":"?(\d+)"?/);
  if (views === null && mViews1?.[1]) {
    const v = parseInt(mViews1[1].replace(/,/g, ""), 10);
    if (!isNaN(v) && v >= 0) views = v;
  }
  if (!views && mViews2?.[1]) {
    const v = parseCount(mViews2[1]);
    if (v && v > 0) views = v;
  }
  if (!views && mViews3?.[1]) {
    const v = parseCount(mViews3[1]);
    if (v && v > 0) views = v;
  }
  if (!views && mViews4?.[1]) {
    const v = parseCount(mViews4[1]);
    if (v && v > 0) views = v;
  }

  return { viewers, views };
}

export async function fetchYouTubeViewersAndViews(videoId) {
  let viewers = null;
  let views = null;

  // 1. Primary: YouTube Innertube updated_metadata API (fastest, most accurate official live endpoint)
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/updated_metadata?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20240101.00.00",
            hl: "en",
            gl: "US"
          }
        },
        videoId: videoId
      })
    });
    if (res.ok) {
      const data = await res.json();
      const actions = data?.actions || [];
      for (const a of actions) {
        const vcr = a?.updateViewershipAction?.viewCount?.videoViewCountRenderer;
        if (vcr) {
          const orig = vcr.originalViewCount ?? vcr.unlabeledViewCountValue?.simpleText ?? vcr.extraShortViewCount?.simpleText;
          if (orig !== undefined && orig !== null) {
            const parsed = parseInt(String(orig).replace(/,/g, ""), 10);
            if (!isNaN(parsed) && parsed >= 0) viewers = parsed;
          }
          if (viewers === null && vcr.viewCount?.simpleText) {
            const m = vcr.viewCount.simpleText.match(/(\d[\d,.]*)/);
            if (m) {
              const parsed = parseInt(m[1].replace(/,/g, ""), 10);
              if (!isNaN(parsed) && parsed >= 0) viewers = parsed;
            }
          }
        }
      }
    }
  } catch {}

  // 2. Secondary: Watch page HTML scrape for viewCount and concurrent viewers fallback
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (res.ok) {
      const html = await res.text();
      const data = extractViewersAndViews(html);
      if (viewers === null && data.viewers !== null && data.viewers >= 0) {
        viewers = data.viewers;
      }
      if (data.views !== null && data.views >= 0) {
        views = data.views;
      }
    }
  } catch {}

  return { viewers, views };
}

async function pollViewerCount(getVideoId, signal) {
  // Poll YouTube for live viewer count and total views every 10 seconds
  while (!signal.aborted) {
    try {
      const videoId = typeof getVideoId === "function" ? getVideoId() : getVideoId;
      if (videoId) {
        const data = await fetchYouTubeViewersAndViews(videoId);
        if (data.viewers !== null && data.viewers >= 0) {
          runtime.chat.viewerCount = data.viewers;
          registerWatchingCount(data.viewers);
        }
        if (data.views !== null && data.views >= 0) {
          runtime.chat.viewCount = data.views;
          state.totalViews = data.views;
        }
      }
    } catch { /* ignore fetch errors */ }

    // Wait 10 seconds between polls
    await new Promise(r => {
      const t = setTimeout(r, 10000);
      signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
    });
  }
}

export function startChatLoop({ signal }) {
  return (async () => {
    let delay = 5000;
    let activeVideoId = getActiveVideoId() || config.videoId || null;
    let viewerPollStarted = false;

    if (!activeVideoId) {
      activeVideoId = await resolveActiveVideoId();
    }

    // Immediately start background viewer count polling if videoId is known
    if (activeVideoId && !viewerPollStarted) {
      viewerPollStarted = true;
      pollViewerCount(() => getActiveVideoId() || activeVideoId, signal).catch(() => {});
    }

    while (!signal.aborted) {
      if (!activeVideoId) {
        activeVideoId = await resolveActiveVideoId();
        if (!activeVideoId) {
          activeVideoId = await resolveLiveVideoId(config.channelId);
        }
        if (!activeVideoId) {
          runtime.chat.status = "unconfigured";
          console.log(`[chat] no videoId configured; checking channel ${config.channelId} for live stream in 15s`);
          await sleep(15000);
          continue;
        }
      }

      // Start background viewer count poller once we have a video ID
      if (!viewerPollStarted) {
        viewerPollStarted = true;
        pollViewerCount(() => getActiveVideoId() || activeVideoId, signal).catch(() => {});
      }

      let mc = null;
      runtime.chat.status = "connecting";
      try {
        mc = await Masterchat.init(activeVideoId);
        if (signal.aborted) break;

        if (!mc.isLive) {
          const discovered = await resolveActiveVideoId({ force: true, requireTitleMatch: true }) || await resolveLiveVideoId(config.channelId);
          if (discovered && discovered !== activeVideoId) {
            console.log(`[chat] video ${activeVideoId} is not live; auto-detected active live stream: ${discovered}`);
            activeVideoId = discovered;
            try { mc?.stop?.(); } catch {}
            continue;
          }
          runtime.chat.status = "waiting";
          runtime.chat.lastError = `Video ${activeVideoId} is not live yet`;
          console.log(`[chat] video ${activeVideoId} is not live yet; checking again in 30s`);
          await sleep(30000);
          continue;
        }

        const iterable = mc?.iterate?.() || mc?.iter?.();
        if (!iterable?.[Symbol.asyncIterator]) throw new Error("Masterchat chat iterator is unavailable");

        runtime.chat.status = "connected";
        runtime.chat.lastError = null;
        delay = 3000;
        console.log(`[chat] connected to live chat for ${activeVideoId} ("${mc.title || "Live"}") — vote parser armed`);

        for await (const batch of iterable) {
          if (signal.aborted) break;

          // Extract live viewer count and total views from batch metadata
          const vc = batch?.viewerCount ?? batch?.liveViewerCount;
          if (typeof vc === "number" && vc >= 0) {
            runtime.chat.viewerCount = vc;
          } else if (typeof vc === "string" && !isNaN(Number(vc)) && Number(vc) >= 0) {
            runtime.chat.viewerCount = Number(vc);
          }

          const tc = batch?.videoDetails?.viewCount ?? batch?.viewCount;
          if (typeof tc === "number" && tc > 0) {
            runtime.chat.viewCount = tc;
            state.totalViews = Math.max(state.totalViews || 0, tc);
          } else if (typeof tc === "string" && Number(tc) > 0) {
            runtime.chat.viewCount = Number(tc);
            state.totalViews = Math.max(state.totalViews || 0, Number(tc));
          }

          // Unpack action items from the batch yielded by Masterchat
          const actions = Array.isArray(batch?.actions) ? batch.actions : (batch ? [batch] : []);
          for (const action of actions) {
            if (!action) continue;
            try {
              const type = action?.type || action?.actionType;
              const isChat = type === "addChatItemAction" || type === "addSuperChatItemAction" || action.liveChatTextMessageRenderer || action.addChatItemAction;
              if (type && !isChat) continue;

              let author = action.authorName || action.author?.name;
              let message = typeof action.message === "string" ? action.message : (action.message ? stringifySafe(action.message) : "");
              let id = action.authorChannelId || action.author?.channelId || action.authorExternalChannelId;
              let owner = Boolean(action.isOwner || action.isChatOwner);
              let mod = Boolean(action.isModerator || action.isChatModerator);

              // Fallback to raw extractor if needed
              if (!message || !author) {
                const extracted = extractChat(action);
                if (!message) message = extracted.message;
                if (!author) author = extracted.author;
                if (!id) id = extracted.id;
                if (!owner) owner = extracted.owner;
                if (!mod) mod = extracted.mod;
              }

              message = clean(message);
              author = clean(author || "Viewer");
              if (!message) continue;
              id = id ? String(id) : fallbackVoteId(action, author, message, action.id);

              runtime.chat.lastEventAt = Date.now();
              if (config.adminChannelIds.includes(String(id))) setOwner(id, author);
              addChat(author, message);

              const voteParsed = parseVoteWithCount(message);
              if (voteParsed) {
                const { contestant, count, isManualAdd } = voteParsed;
                const isChannelOwner = Boolean(owner || (id && config.adminChannelIds.includes(String(id))));
                const cName = config.contestants[contestant - 1]?.displayName || config.contestants[contestant - 1]?.name || `#${contestant}`;
                runtime.chat.lastVoteCandidate = { author, contestant, at: Date.now() };

                if (count > 1 || isManualAdd) {
                  // Manual vote quantity requested: e.g. !vote 2 100 or !addvotes 2 100
                  if (isChannelOwner) {
                    const res = addManualVotes(contestant, count, author, id);
                    if (res) {
                      console.log(`[owner-vote] 👑 Channel Owner ${author} added +${count} votes to #${contestant} (${cName})! Total now: ${res.total}`);
                      setAnnouncement(`👑 OWNER BOOST: ${author} gave +${count} VOTES to ${cName}!`, "OFFICIAL VOTE BOOST", 5000);
                      voteEvent({ userId: id, name: author, contestant, candidateName: cName, count });
                      void saveState();
                    }
                  } else {
                    console.warn(`[vote] ⚠️ ${author} tried to add +${count} votes to #${contestant}, but is NOT the channel owner. Awarding 1 standard vote.`);
                    if (acceptVote(id, contestant, author)) {
                      console.log(`[vote] ${author} voted for #${contestant} (${cName}) (+1, unlimited)`);
                      voteEvent({ userId: id, name: author, contestant, candidateName: cName, count: 1 });
                      void saveState();
                    }
                  }
                } else {
                  // Standard single vote
                  if (acceptVote(id, contestant, author)) {
                    console.log(`[vote] ${author} voted for #${contestant} (${cName}) (+1, unlimited)`);
                    voteEvent({ userId: id, name: author, contestant, candidateName: cName, count: 1 });
                    void saveState();
                  } else {
                    console.warn(`[vote] rejected ${author} -> #${contestant}; votingOpen=${state.votingOpen}`);
                  }
                }
                continue;
              }

              function resolveContestant(q) {
                if (!q) return null;
                const num = parseInt(String(q).replace(/^#/, ""), 10);
                if (Number.isInteger(num) && num >= 1 && num <= config.contestants.length) return num;
                const cleanQ = String(q).toLowerCase().replace(/[^a-z0-9]/g, "");
                for (const cand of config.contestants) {
                  const d = (cand.displayName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                  const n = (cand.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                  if (d.includes(cleanQ) || n.includes(cleanQ) || (cleanQ.length >= 3 && cleanQ.includes(d))) return cand.no;
                }
                return null;
              }

              // Flexible command parsing: supports !cmd, /cmd, or bare keyword (e.g. drop, bomb, vol, wheel)
              const trimmed = message.trim();
              const parts = trimmed.split(/\s+/);
              let cmdToken = (parts[0] || "").toLowerCase();
              if (cmdToken.startsWith("!") || cmdToken.startsWith("/")) {
                cmdToken = cmdToken.slice(1);
              }
              const arg = (parts[1] || "").toLowerCase();
              const rawArg = parts.slice(1).join(" ");
              const target = resolveContestant(parts[1]);
              const themePublic = config.publicThemeCommands || admin(id, owner, mod);
              const musicPublic = config.publicMusicCommands || admin(id, owner, mod);

              const isExplicitCmd = message.startsWith("!") || message.startsWith("/");
              if (!isExplicitCmd && !KNOWN_COMMANDS.has(cmdToken)) continue;

              if (cmdToken === "help") {
                setAnnouncement(`🔥 COMMANDS: !vote 1-${config.contestants.length} • !buzzer • !clash <no1> <no2> • !fortune • !spotlight <no> • !champion <no> • !confess <msg> • !track 1-${MUSIC_TRACKS.length} • !aurora !phoenix !disco !tornado !vortex !dragon`, "BIGG BOSS COMMANDS", 6000);
                console.log(`[chat] ${author}: ${config.voteCommand} 1 ... ${config.contestants.length} | !buzzer | !clash | !fortune | !spotlight | !champion | !confess | !immunity/danger/supervote | !track <1-${MUSIC_TRACKS.length}> | !vol <1-100> | !aurora | !phoenix | !disco | !tornado | !vortex | !dragon | !matrix | !supernova`);
              }
              else if (themePublic && (cmdToken === "dark" || (cmdToken === "theme" && arg === "dark"))) {
                setTheme("dark"); void saveState(); console.log(`[theme] ${author} switched stream to DARK`);
                setAnnouncement(`${author} switched stream to DARK mode 🌙`, "THEME", 2500);
              }
              else if (themePublic && (cmdToken === "light" || (cmdToken === "theme" && arg === "light"))) {
                setTheme("light"); void saveState(); console.log(`[theme] ${author} switched stream to LIGHT`);
                setAnnouncement(`${author} switched stream to LIGHT mode ☀️`, "THEME", 2500);
              }
              else if (musicPublic && cmdToken === "music" && (arg === "off" || arg === "stop" || arg === "mute")) {
                setMusicEnabled(false); console.log(`[music] ${author} requested music OFF`);
                setAnnouncement(`🔇 Music turned OFF by ${author}`, "AUDIO", 2500);
              }
              else if (musicPublic && cmdToken === "music" && (arg === "on" || arg === "start" || arg === "play")) {
                setMusicEnabled(true); console.log(`[music] ${author} requested music ON`);
                setAnnouncement(`🔊 Music turned ON by ${author}`, "AUDIO", 2500);
              }
              // Track listing: !tracks, !track list, !music list, !playlist
              else if (musicPublic && (cmdToken === "tracks" || (cmdToken === "track" && arg === "list") || (cmdToken === "music" && (arg === "list" || arg === "tracks")))) {
                const info = getMusicTrackInfo();
                const listStr = MUSIC_TRACKS.map(t => `#${t.id} ${t.name}`).join(" • ");
                setAnnouncement(`🎶 ${MUSIC_TRACKS.length} TRACKS: ${listStr} (Type !track 1-${MUSIC_TRACKS.length}, !track loop, or !vol 1-100)`, "MUSIC PLAYLIST", 5000);
              }
              // Track loop mode: !track loop, !track auto, !music loop (play one by one in sequence)
              else if (musicPublic && ((cmdToken === "track" || cmdToken === "music") && (arg === "loop" || arg === "auto" || arg === "cycle"))) {
                setTrackLoopMode("loop");
                const info = getMusicTrackInfo();
                setAnnouncement(`🔁 ${author} enabled AUTO-LOOP! (Tracks 1-${MUSIC_TRACKS.length} play in continuous sequence)`, "MUSIC LOOP MODE", 4000);
                console.log(`[audio] ${author} enabled sequential track auto-loop`);
              }
              // Track repeat / single mode: !track hold, !track repeat, !track single
              else if (musicPublic && ((cmdToken === "track" || cmdToken === "music") && (arg === "hold" || arg === "repeat" || arg === "single" || arg === "lock"))) {
                setTrackLoopMode("single");
                const info = getMusicTrackInfo();
                setAnnouncement(`🔂 ${author} locked playback to Track #${info.id}: "${info.name}" (repeats continuously)`, "MUSIC LOOP MODE", 4000);
                console.log(`[audio] ${author} locked track loop mode to single (Track #${info.id})`);
              }
              // Track navigation & selection: !track <1-20>, !music track <1-20>, !music <1-20>, !track next, !track prev
              else if (musicPublic && (cmdToken === "track" || (cmdToken === "music" && (arg === "track" || (/^\d+$/.test(arg) && parseInt(arg, 10) <= MUSIC_TRACKS.length) || arg === "next" || arg === "prev" || arg === "back")))) {
                let trackArg = arg;
                if (cmdToken === "music" && arg === "track") trackArg = (parts[2] || "").toLowerCase();
                if (trackArg === "next" || (cmdToken === "track" && arg === "next")) {
                  const trk = nextMusicTrack();
                  state.nowPlayingText = `${trk.id}: ${trk.name}`;
                  setAnnouncement(`🎵 ${author} skipped to Track ${trk.id}: "${trk.name}" (${trk.genre})`, "MUSIC TRACK", 3800);
                } else if (trackArg === "prev" || trackArg === "back" || (cmdToken === "track" && (arg === "prev" || arg === "back"))) {
                  const trk = prevMusicTrack();
                  state.nowPlayingText = `${trk.id}: ${trk.name}`;
                  setAnnouncement(`🎵 ${author} returned to Track ${trk.id}: "${trk.name}" (${trk.genre})`, "MUSIC TRACK", 3800);
                } else {
                  const tNum = parseInt(trackArg, 10);
                  if (tNum >= 1 && tNum <= MUSIC_TRACKS.length) {
                    const trk = setMusicTrack(tNum);
                    state.nowPlayingText = `${trk.id}: ${trk.name}`;
                    setAnnouncement(`🎵 ${author} selected Track ${trk.id}: "${trk.name}" (${trk.genre})`, "MUSIC TRACK", 3800);
                  } else {
                    const info = getMusicTrackInfo();
                    const listStr = MUSIC_TRACKS.map(t => `#${t.id} ${t.name}`).join(" • ");
                    setAnnouncement(`🎵 Now: #${info.id} "${info.name}" (${info.loopMode} mode) • Tracks: ${listStr} (use !track 1-${MUSIC_TRACKS.length} or !track loop)`, "MUSIC TRACKS", 4500);
                  }
                }
              }
              // Chat volume controls: !vol 75, !volume 50, !music 80, !music vol 90
              else if (musicPublic && (cmdToken === "vol" || cmdToken === "volume" || (cmdToken === "music" && (arg === "vol" || arg === "volume" || (/^\d+$/.test(arg) && parseInt(arg, 10) > MUSIC_TRACKS.length))))) {
                let vStr = arg;
                if (cmdToken === "music" && (arg === "vol" || arg === "volume")) vStr = (parts[2] || "").toLowerCase();
                const pct = parseInt(vStr, 10);
                if (!isNaN(pct)) {
                  const targetVol = Math.max(0.1, Math.min(1.0, pct / 100));
                  setBgMusicVolume(targetVol);
                  const displayPct = Math.round(targetVol * 100);
                  setAnnouncement(`🔊 ${author} set music volume to ${displayPct}%`, "AUDIO LEVEL", 3000);
                  console.log(`[audio] ${author} set music volume to ${displayPct}%`);
                } else {
                  const cur = Math.round(getBgMusicVolume() * 100);
                  setAnnouncement(`🔊 Music volume: ${cur}% (Use !vol 1-100)`, "AUDIO LEVEL", 3000);
                }
              }
              // Query current music status if bare !music or !track typed
              else if (musicPublic && (cmdToken === "music" || cmdToken === "track") && !arg) {
                const info = getMusicTrackInfo();
                const cur = Math.round(getBgMusicVolume() * 100);
                setAnnouncement(`🎵 Track ${info.id}: "${info.name}" (${info.genre}) at ${cur}% vol [${info.loopMode.toUpperCase()}] • Type !track 1-${MUSIC_TRACKS.length} or !track loop`, "MUSIC STATUS", 3800);
              }
              else if (musicPublic && (cmdToken === "louder" || (cmdToken === "music" && arg === "louder"))) {
                const cur = getBgMusicVolume();
                const next = Math.min(1.0, cur + 0.15);
                setBgMusicVolume(next);
                const displayPct = Math.round(next * 100);
                setAnnouncement(`🔊 ${author} turned volume up to ${displayPct}%`, "AUDIO LEVEL", 3000);
              }
              else if (musicPublic && (cmdToken === "quieter" || cmdToken === "softer" || (cmdToken === "music" && (arg === "quieter" || arg === "softer")))) {
                const cur = getBgMusicVolume();
                const next = Math.max(0.05, cur - 0.15);
                setBgMusicVolume(next);
                const displayPct = Math.round(next * 100);
                setAnnouncement(`🔉 ${author} turned volume down to ${displayPct}%`, "AUDIO LEVEL", 3000);
              }
              else if (config.publicScreenCommands && cmdToken === "screen") {
                const screenArg = arg || "main";
                if (screenArg === "profile") {
                  const n = resolveContestant(parts[2]);
                  if (n) {
                    setScreen("main", { manual: true, contestant: n, userId: id });
                    viewerEvent({ userId: id, name: author, type: "support", contestant: n });
                    setAnnouncement(`${author} opened ${config.contestants[n - 1]?.displayName || `Contestant ${n}`} profile.`, "SCREEN", 3000);
                  }
                } else if (setScreen(screenArg, { manual: true, userId: id })) {
                  setAnnouncement(`${author} switched to ${screenArg.toUpperCase()} screen.`, "SCREEN", 2400);
                  console.log(`[screen] ${author} -> ${screenArg}`);
                }
              }
              else if (config.publicScreenCommands && cmdToken === "next") {
                nextScreen(id);
                setAnnouncement(`${author} moved to next screen ⏩`, "SCREEN", 2200);
              }
              else if (config.publicScreenCommands && (cmdToken === "prev" || cmdToken === "previous")) {
                previousScreen(id);
                setAnnouncement(`${author} moved to previous screen ⏪`, "SCREEN", 2200);
              }
              else if (config.publicScreenCommands && cmdToken === "auto" && (arg === "on" || arg === "off")) {
                const on = setScreenAuto(arg === "on", id);
                setAnnouncement(`Screen auto-rotation ${on ? "enabled" : "disabled"}.`, "SCREEN", 2600);
              }
              else if (config.publicScreenCommands && cmdToken === "menu") {
                setMenu(7000, id);
                setAnnouncement(`${author} opened live screen menu.`, "SCREEN MENU", 2600);
              }
              else if (config.publicScreenCommands && cmdToken === "profile") {
                const n = resolveContestant(parts[1]);
                if (n) {
                  setScreen("main", { manual: true, contestant: n, userId: id });
                  viewerEvent({ userId: id, name: author, type: "support", contestant: n });
                  setAnnouncement(`${author} opened ${config.contestants[n - 1]?.displayName || `Contestant ${n}`} profile.`, "CONTESTANT PROFILE", 3000);
                }
              }
              // !drop command: handles contestants (e.g. !drop 8), emojis (!drop 🎈), or custom text
              else if (cmdToken === "drop") {
                const contestantTarget = resolveContestant(parts[1]);
                let em = rawArg || "🎈";
                let contestantNo = contestantTarget || 0;
                let cName = "";
                if (contestantNo > 0) {
                  cName = config.contestants[contestantNo - 1]?.displayName || `#${contestantNo}`;
                  em = "🪂";
                }
                if (viewerEvent({
                  userId: id,
                  name: author,
                  type: "drop",
                  contestant: contestantNo,
                  emoji: em,
                  payload: { emoji: em, contestant: contestantNo, candidateName: cName },
                  durationMs: 4800
                })) {
                  if (contestantNo > 0) {
                    setAnnouncement(`🪂 ${author} called in a Supply Drop for ${cName}!`, "AIRDROP", 3600);
                    console.log(`[interactive] ${author} called in a contestant drop for #${contestantNo} (${cName})`);
                  } else {
                    setAnnouncement(`🎈 ${author} released a balloon airdrop!`, "AIRDROP", 3200);
                    console.log(`[interactive] ${author} dropped ${em}`);
                  }
                }
              }
              else if (cmdToken === "boom") {
                if (viewerEvent({ userId: id, name: author, type: "boom" })) console.log(`[interactive] ${author} BOOM`);
              }
              else if (cmdToken === "bomb" || cmdToken === "nuke") {
                if (target) {
                  const cItem = config.contestants.find(c => c.no === target);
                  const cName = cItem?.displayName || cItem?.name || `Contestant #${target}`;
                  if (viewerEvent({ userId: id, name: author, type: "bomb", contestant: target, durationMs: 4500 })) {
                    setAnnouncement(`💣 ${author} LAUNCHED A BOMB AT ${cName.toUpperCase()}! 💥`, "TARGETED BOMB", 3800);
                    console.log(`[interactive] ${author} bombed contestant #${target} (${cName})`);
                  }
                } else {
                  if (viewerEvent({ userId: id, name: author, type: "bomb", durationMs: 4200 })) {
                    setAnnouncement(`💣 ${author} DETONATED A SCREEN BOMB! 💥`, "BOMB EXPLOSION", 3500);
                    console.log(`[interactive] ${author} detonated screen bomb`);
                  }
                }
              }
              else if (cmdToken === "freeze" || cmdToken === "ice") {
                if (target) {
                  const cItem = config.contestants.find(c => c.no === target);
                  const cName = cItem?.displayName || cItem?.name || `Contestant #${target}`;
                  if (viewerEvent({ userId: id, name: author, type: "freeze", contestant: target, durationMs: 4500 })) {
                    setAnnouncement(`❄️ ${author} FROZE ${cName.toUpperCase()} IN SOLID ICE! 🧊`, "FREEZE BLAST", 3500);
                    console.log(`[interactive] ${author} froze contestant #${target} (${cName})`);
                  }
                }
              }
              else if (cmdToken === "laser" || cmdToken === "strike") {
                if (target) {
                  const cItem = config.contestants.find(c => c.no === target);
                  const cName = cItem?.displayName || cItem?.name || `Contestant #${target}`;
                  if (viewerEvent({ userId: id, name: author, type: "laser", contestant: target, durationMs: 4500 })) {
                    setAnnouncement(`⚡ ${author} CALLED ORBITAL LASER STRIKE ON ${cName.toUpperCase()}! 🚀`, "ORBITAL LASER", 3500);
                    console.log(`[interactive] ${author} orbital laser on #${target} (${cName})`);
                  }
                }
              }
              else if (cmdToken === "heart") {
                if (viewerEvent({ userId: id, name: author, type: "heart", emoji: "❤️" })) {
                  setAnnouncement(`❤️ ${author} sent a shower of love!`, "LOVE SHOWER", 3000);
                  console.log(`[interactive] ${author} heart storm`);
                }
              }
              else if (cmdToken === "rain") {
                const em = rawArg || "❤️";
                if (viewerEvent({ userId: id, name: author, type: "rain", emoji: em, payload: { emoji: em } })) {
                  setAnnouncement(`🌧️ ${author} started an emoji rain!`, "EMOJI RAIN", 3000);
                  console.log(`[interactive] ${author} emoji rain ${em}`);
                }
              }
              else if (cmdToken === "gift") {
                if (viewerEvent({ userId: id, name: author, type: "gift", emoji: "🎁" })) {
                  setAnnouncement(`🎁 ${author} sent a Mystery Gift!`, "MYSTERY GIFT", 3200);
                  console.log(`[interactive] ${author} mystery gift`);
                }
              }
              else if (cmdToken === "crown") {
                if (target) {
                  const cName = config.contestants[target - 1]?.displayName;
                  viewerEvent({ userId: id, name: author, type: "crown", contestant: target, emoji: "👑", durationMs: 4500 });
                  setAnnouncement(`${author} crowned ${cName}! 👑`, "FAN CROWN", 3500);
                }
              }
              else if (cmdToken === "zap") {
                if (target) {
                  const cName = config.contestants[target - 1]?.displayName;
                  viewerEvent({ userId: id, name: author, type: "zap", contestant: target, emoji: "⚡", durationMs: 4500 });
                  setAnnouncement(`${author} electric zapped ${cName}! ⚡`, "POWER ZAP", 3500);
                }
              }
              else if (cmdToken === "fire" || cmdToken === "flame" || cmdToken === "cheer") {
                if (target) {
                  const cName = config.contestants[target - 1]?.displayName;
                  viewerEvent({ userId: id, name: author, type: "fire", contestant: target, emoji: "🔥", durationMs: 4500 });
                  setAnnouncement(`🔥 ${author} cheered for ${cName}!`, "FAN CHEER", 3500);
                }
              }
              else if (cmdToken === "star") {
                if (target) {
                  const cName = config.contestants[target - 1]?.displayName;
                  viewerEvent({ userId: id, name: author, type: "star", contestant: target, emoji: "⭐", durationMs: 4500 });
                  setAnnouncement(`${author} gave a golden star to ${cName}! ⭐`, "GOLDEN STAR", 3500);
                }
              }
              else if (cmdToken === "support" || cmdToken === "target") {
                if (target) viewerEvent({ userId: id, name: author, type: "support", contestant: target });
              }
              else if (cmdToken === "battle" || cmdToken === "vs") {
                const bTarget = resolveContestant(parts[2]);
                if (target && bTarget && target !== bTarget) {
                  const aName = config.contestants[target - 1]?.displayName || `#${target}`;
                  const bName = config.contestants[bTarget - 1]?.displayName || `#${bTarget}`;
                  viewerEvent({ userId: id, name: author, type: "battle", contestant: target, payload: { a: target, b: bTarget }, durationMs: 8000 });
                  setAnnouncement(`⚔️ 1v1 BATTLE: ${aName} VS ${bName}! Vote now!`, "BATTLE ARENA", 5500);
                }
              }
              else if (cmdToken === "dice") {
                const roll = 1 + Math.floor(Math.random() * 6);
                viewerEvent({ userId: id, name: author, type: "dice", payload: { roll }, durationMs: 4500 });
                setAnnouncement(`${author} rolled a ${roll}! 🎲`, "CHAT DICE", 3500);
                console.log(`[interactive] ${author} rolled dice: ${roll}`);
              }
              else if (cmdToken === "coin") {
                const flip = Math.random() > 0.5 ? "HEADS" : "TAILS";
                viewerEvent({ userId: id, name: author, type: "coin", payload: { flip }, durationMs: 4500 });
                setAnnouncement(`${author} flipped ${flip}! 🪙`, "COIN FLIP", 3500);
                console.log(`[interactive] ${author} flipped coin: ${flip}`);
              }
              else if (cmdToken === "slot") {
                const symbols = ["🍒", "🍋", "🔔", "💎", "7️⃣"];
                const s1 = symbols[Math.floor(Math.random() * symbols.length)];
                const s2 = symbols[Math.floor(Math.random() * symbols.length)];
                const s3 = symbols[Math.floor(Math.random() * symbols.length)];
                const win = (s1 === s2 && s2 === s3);
                viewerEvent({ userId: id, name: author, type: "slot", payload: { s1, s2, s3, win }, durationMs: 4500 });
                setAnnouncement(`${author} rolled [${s1} ${s2} ${s3}] ${win ? "JACKPOT! 🏆" : ""}`, "SLOT MACHINE", 3800);
                console.log(`[interactive] ${author} played slots: ${s1} ${s2} ${s3} (win=${win})`);
              }
              else if (cmdToken === "wheel" || cmdToken === "spin") {
                const options = [
                  "🌟 2X VOTE", "💎 500 PTS", "👑 VIP FAN", "⚡ BOOST",
                  "🔥 HYPE", "🎁 MYSTERY", "🎯 CROWN", "🏆 JACKPOT"
                ];
                const winIdx = Math.floor(Math.random() * options.length);
                const winner = options[winIdx];
                const spins = 4;
                const finalAngle = spins * Math.PI * 2 + (winIdx * (Math.PI * 2 / options.length)) + (Math.PI / options.length);
                viewerEvent({ userId: id, name: author, type: "wheel", payload: { winner, winIdx, finalAngle, options }, durationMs: 5500 });
                setAnnouncement(`${author} spun the wheel: ${winner}!`, "FORTUNE WHEEL", 4500);
                console.log(`[interactive] ${author} spun wheel: ${winner}`);
              }
              else if (cmdToken === "hype") {
                viewerEvent({ userId: id, name: author, type: "hype", durationMs: 4500 });
                setAnnouncement(`🚀 ${author} TRIGGERED THE HYPE TRAIN!`, "HYPE TRAIN", 3500);
                console.log(`[interactive] ${author} triggered hype`);
              }
              else if (cmdToken === "confetti" || cmdToken === "party") {
                viewerEvent({ userId: id, name: author, type: "confetti", durationMs: 5500 });
                setAnnouncement(`🎉 ${author} LAUNCHED CONFETTI!`, "CONFETTI PARTY", 3800);
                console.log(`[interactive] ${author} launched confetti`);
              }
              else if (cmdToken === "fireworks" || cmdToken === "fw") {
                viewerEvent({ userId: id, name: author, type: "fireworks", durationMs: 5000 });
                setAnnouncement(`🎆 ${author} FIRED OFF FIREWORKS!`, "FIREWORKS", 3800);
                console.log(`[interactive] ${author} launched fireworks`);
              }
              else if (cmdToken === "lightning" || cmdToken === "zap2") {
                viewerEvent({ userId: id, name: author, type: "lightning", durationMs: 3500 });
                setAnnouncement(`⚡ ${author} CALLED DOWN LIGHTNING!`, "LIGHTNING", 3000);
                console.log(`[interactive] ${author} called lightning`);
              }
              else if (cmdToken === "laser" || cmdToken === "lasers" || cmdToken === "lightshow") {
                viewerEvent({ userId: id, name: author, type: "laser", durationMs: 5200 });
                setAnnouncement(`✨ ${author} TRIGGERED STAGE LASER SHOW!`, "LASER SHOW", 3500);
                console.log(`[interactive] ${author} triggered laser show`);
              }
              else if (cmdToken === "magic" || cmdToken === "spell") {
                viewerEvent({ userId: id, name: author, type: "magic", durationMs: 5500 });
                setAnnouncement(`✨ ${author} CAST A MAGICAL BIGG BOSS SPELL! ✨`, "MAGIC SPELL", 4000);
                console.log(`[interactive] ${author} cast magic spell`);
              }
              else if (cmdToken === "shield" || cmdToken === "protect") {
                const sTarget = target || resolveContestant(rawArg) || (1 + Math.floor(Math.random() * config.contestants.length));
                if (sTarget) {
                  const cItem = config.contestants.find(x => x.no === sTarget);
                  viewerEvent({ userId: id, name: author, type: "shield", contestant: sTarget, durationMs: 6500 });
                  setAnnouncement(`🛡️ ${author} ACTIVATED ENERGY SHIELD FOR ${cItem?.displayName || cItem?.name || "CONTESTANT"}!`, "FORCEFIELD SHIELD", 4200);
                  console.log(`[interactive] ${author} shielded #${sTarget}`);
                }
              }
              else if (cmdToken === "meteor" || cmdToken === "nuke") {
                viewerEvent({ userId: id, name: author, type: "meteor", durationMs: 5000 });
                setAnnouncement(`☄️ ${author} SUMMONED A COSMIC METEOR STRIKE! ☄️`, "METEOR STRIKE", 4000);
                console.log(`[interactive] ${author} summoned meteor strike`);
              }
              else if (cmdToken === "boost" || cmdToken === "rocket" || cmdToken === "nitro") {
                const bTarget = target || resolveContestant(rawArg) || (1 + Math.floor(Math.random() * config.contestants.length));
                if (bTarget) {
                  const cItem = config.contestants.find(x => x.no === bTarget);
                  viewerEvent({ userId: id, name: author, type: "boost", contestant: bTarget, durationMs: 5500 });
                  setAnnouncement(`🚀 ${author} GAVE NITRO ROCKET BOOST TO ${cItem?.displayName || cItem?.name || "CONTESTANT"}!`, "NITRO BOOST", 4200);
                  console.log(`[interactive] ${author} boosted #${bTarget}`);
                }
              }
              else if (cmdToken === "shoutout") {
                const shoutMsg = rawArg ? clean(rawArg).slice(0, 75) : "BIGG BOSS 24/7 FAN!";
                viewerEvent({ userId: id, name: author, type: "shoutout", payload: { message: shoutMsg }, durationMs: 5500 });
                setAnnouncement(`${author}: "${shoutMsg}"`, "VIP SHOUTOUT", 5000);
                console.log(`[interactive] ${author} shoutout: "${shoutMsg}"`);
              }
              // --- New Visual Effects: !aurora, !phoenix, !disco, !tornado, !clap, !mvp ---
              else if (cmdToken === "aurora" || cmdToken === "borealis") {
                if (viewerEvent({ userId: id, name: author, type: "aurora", durationMs: 5500 })) {
                  setAnnouncement(`🌌 ${author} SUMMONED THE CELESTIAL AURORA BOREALIS! 🌌`, "AURORA BOREALIS", 4200);
                  console.log(`[interactive] ${author} summoned aurora borealis`);
                }
              }
              else if (cmdToken === "phoenix" || cmdToken === "firebird") {
                if (viewerEvent({ userId: id, name: author, type: "phoenix", durationMs: 5500 })) {
                  setAnnouncement(`🔥 ${author} SUMMONED THE MYTHICAL GOLDEN PHOENIX! 🔥`, "PHOENIX ASCENSION", 4200);
                  console.log(`[interactive] ${author} summoned golden phoenix`);
                }
              }
              else if (cmdToken === "disco" || cmdToken === "laserstorm" || cmdToken === "rave") {
                if (viewerEvent({ userId: id, name: author, type: "disco", durationMs: 5500 })) {
                  setAnnouncement(`🪩 ${author} STARTED THE NEON DISCO LASER PARTY! 🪩`, "DISCO PARTY", 4200);
                  console.log(`[interactive] ${author} started disco laser party`);
                }
              }
              else if (cmdToken === "tornado" || cmdToken === "twister" || cmdToken === "cyclone") {
                if (viewerEvent({ userId: id, name: author, type: "tornado", durationMs: 5500 })) {
                  setAnnouncement(`🌪️ ${author} UNLEASHED A COSMIC TWISTER CYCLONE! 🌪️`, "COSMIC TWISTER", 4200);
                  console.log(`[interactive] ${author} summoned tornado`);
                }
              }
              else if (cmdToken === "clap" || cmdToken === "applause") {
                if (viewerEvent({ userId: id, name: author, type: "clap", durationMs: 3800 })) {
                  setAnnouncement(`👏 ${author} GAVE A THUNDEROUS ROUND OF APPLAUSE! 👏`, "FAN APPLAUSE", 3200);
                  console.log(`[interactive] ${author} clapped`);
                }
              }
              else if (cmdToken === "mvp" || cmdToken === "topviewers") {
                viewerEvent({ userId: id, name: author, type: "confetti", durationMs: 4500 });
                setAnnouncement(`👑 MVP SUPPORTER OF THE HOUSE: ${author}! Thank you for lighting up the chat!`, "MVP VIEWER", 4500);
                console.log(`[interactive] ${author} triggered MVP celebration`);
              }
              // --- Confession Box: !confess <text>, !gossip <text> ---
              else if (cmdToken === "confess" || cmdToken === "gossip") {
                if (rawArg) {
                  const c = addConfession({ author, message: rawArg, contestant: target || 0 });
                  setAnnouncement(`📜 CONFESSION BOX: "${clean(rawArg).slice(0, 90)}" — ${author}`, "HOUSE CONFESSION", 5500);
                  console.log(`[confess] ${author}: ${rawArg}`);
                } else {
                  setAnnouncement(`📜 CONFESSION BOX: Type !confess <your secret opinion> to post on screen!`, "CONFESSION HELP", 3500);
                }
              }
              // --- Contestant Status Buffs: !immunity <no>, !danger <no>, !supervote <no> ---
              else if (cmdToken === "immunity") {
                const bTarget = target || resolveContestant(rawArg) || (1 + Math.floor(Math.random() * config.contestants.length));
                if (bTarget) {
                  const cItem = config.contestants.find(x => x.no === bTarget);
                  setContestantBuff(bTarget, "immunity", 22000);
                  viewerEvent({ userId: id, name: author, type: "shield", contestant: bTarget, durationMs: 6500 });
                  setAnnouncement(`🛡️ ${author} GRANTED GOLDEN IMMUNITY TO ${cItem?.displayName || `#${bTarget}`}! 🛡️`, "IMMUNITY SHIELD", 4500);
                  console.log(`[buff] ${author} gave immunity to #${bTarget}`);
                }
              }
              else if (cmdToken === "danger") {
                const bTarget = target || resolveContestant(rawArg) || (1 + Math.floor(Math.random() * config.contestants.length));
                if (bTarget) {
                  const cItem = config.contestants.find(x => x.no === bTarget);
                  setContestantBuff(bTarget, "danger", 22000);
                  viewerEvent({ userId: id, name: author, type: "lightning", contestant: bTarget, durationMs: 6500 });
                  setAnnouncement(`⚠️ ${author} PUT ${cItem?.displayName || `#${bTarget}`} IN THE RED DANGER ZONE! ⚠️`, "DANGER ZONE", 4500);
                  console.log(`[buff] ${author} put #${bTarget} in danger`);
                }
              }
              else if (cmdToken === "supervote") {
                const bTarget = target || resolveContestant(rawArg) || 1;
                if (bTarget && state.votingOpen) {
                  const cItem = config.contestants.find(x => x.no === bTarget);
                  for (let v = 0; v < 5; v++) acceptVote(id, bTarget, author);
                  setContestantBuff(bTarget, "supervote", 18000);
                  voteEvent({ userId: id, name: author, contestant: bTarget, candidateName: cItem?.displayName || `#${bTarget}` });
                  viewerEvent({ userId: id, name: author, type: "supernova", contestant: bTarget, durationMs: 6500 });
                  setAnnouncement(`💥 SUPERVOTE! ${author} cast 5X MEGA VOTES for ${cItem?.displayName || `#${bTarget}`} with SUPERNOVA! 💥`, "SUPERVOTE BURST", 5000);
                  console.log(`[supervote] ${author} 5x votes for #${bTarget}`);
                }
              }
              // --- Trivia Quiz: !quiz, !trivia, !ans <letter> ---
              else if (cmdToken === "quiz" || cmdToken === "trivia") {
                const q = startQuiz();
                setAnnouncement(`🧠 TRIVIA: "${q.question}" Opts: ${q.options.map((o, idx) => `[${String.fromCharCode(65 + idx)}] ${o}`).join(" • ")} (Type !ans A, B, C, or D!)`, "BIGG BOSS TRIVIA", 6000);
                console.log(`[quiz] started: ${q.question}`);
              }
              else if (cmdToken === "ans" || cmdToken === "answer") {
                const res = answerQuiz(id, author, arg || parts[1]);
                if (res?.correct) {
                  setAnnouncement(`🎉 WINNER! ${author} answered correctly! Crowned Bigg Boss Quiz Champion! 👑`, "QUIZ WINNER", 5000);
                  console.log(`[quiz] ${author} answered correctly!`);
                } else if (res && !res.correct) {
                  setAnnouncement(`❌ ${author} answered ${(arg || "").toUpperCase()} — Incorrect! Try again!`, "QUIZ ANSWER", 2800);
                }
              }
              // --- Advanced FX Particle Commands: !vortex, !dragon, !matrix, !supernova, !champion ---
              else if (cmdToken === "vortex" || cmdToken === "blackhole") {
                viewerEvent({ userId: id, name: author, type: "vortex", durationMs: 5500 });
                setAnnouncement(`🌌 ${author} OPENED A GRAVITATIONAL SINGULARITY VORTEX! 🌌`, "COSMIC VORTEX", 4500);
                console.log(`[interactive] ${author} vortex`);
              }
              else if (cmdToken === "dragon" || cmdToken === "flamethrower") {
                viewerEvent({ userId: id, name: author, type: "dragon", durationMs: 5500 });
                setAnnouncement(`🐲 ${author} UNLEASHED BIGG BOSS DRAGON FLAME BREATH! 🐲`, "DRAGON BREATH", 4500);
                console.log(`[interactive] ${author} dragon`);
              }
              else if (cmdToken === "matrix") {
                viewerEvent({ userId: id, name: author, type: "matrix", durationMs: 6000 });
                setAnnouncement(`💻 ${author} ENTERED THE CYBER MATRIX STREAM! 💻`, "CYBER MATRIX", 4500);
                console.log(`[interactive] ${author} matrix`);
              }
              else if (cmdToken === "supernova") {
                viewerEvent({ userId: id, name: author, type: "supernova", durationMs: 6000 });
                setAnnouncement(`✨ ${author} TRIGGERED A CELESTIAL SUPERNOVA EXPLOSION! ✨`, "SUPERNOVA", 4500);
                console.log(`[interactive] ${author} supernova`);
              }
              else if (cmdToken === "champion" || cmdToken === "trophy") {
                const bTarget = target || resolveContestant(rawArg) || (1 + Math.floor(Math.random() * config.contestants.length));
                const cItem = config.contestants.find(x => x.no === bTarget);
                viewerEvent({ userId: id, name: author, type: "champion", contestant: bTarget, durationMs: 7000 });
                setAnnouncement(`🏆 ${author} CELEBRATED ${cItem?.displayName || `#${bTarget}`} AS BIGG BOSS CHAMPION! 🏆`, "CHAMPION TROPHY", 5000);
                console.log(`[interactive] ${author} champion #${bTarget}`);
              }
              // --- Iconic Reality TV Golden Buzzer ---
              else if (cmdToken === "buzzer" || cmdToken === "goldenbuzzer" || cmdToken === "siren") {
                viewerEvent({ userId: id, name: author, type: "buzzer", durationMs: 5500 });
                setAnnouncement(`🚨 GOLDEN BUZZER PRESSED BY ${author}! 🌟 STAGE ILLUMINATED!`, "GOLDEN BUZZER", 4500);
                console.log(`[interactive] ${author} pressed golden buzzer`);
              }
              // --- Head-to-Head 1v1 Battle Clash Duel ---
              else if (cmdToken === "clash" || cmdToken === "duel") {
                const c1 = target || (1 + Math.floor(Math.random() * config.contestants.length));
                let c2 = resolveContestant(parts[2]);
                if (!c2 || c2 === c1) c2 = (c1 % config.contestants.length) + 1;
                const cItem1 = config.contestants[c1 - 1];
                const cItem2 = config.contestants[c2 - 1];
                viewerEvent({
                  userId: id,
                  name: author,
                  type: "clash",
                  payload: { c1, c2, name1: cItem1?.displayName || `#${c1}`, name2: cItem2?.displayName || `#${c2}` },
                  durationMs: 8000
                });
                setAnnouncement(`⚔️ 1v1 HEAD-TO-HEAD CLASH: #${c1} ${cItem1?.displayName || `#${c1}`} VS #${c2} ${cItem2?.displayName || `#${c2}`}! VOTE NOW!`, "CONTESTANT CLASH", 6000);
                console.log(`[interactive] ${author} initiated clash: #${c1} vs #${c2}`);
              }
              // --- Mystic Bigg Boss Oracle & Fortune Card ---
              else if (cmdToken === "fortune" || cmdToken === "lucky" || cmdToken === "oracle") {
                const prophecies = [
                  "🌟 Your favorite contestant is gaining huge voting momentum right now!",
                  "⚡ A historic rank overtake is looming in the house rankings!",
                  "🔮 The Oracle predicts unforgettable Weekend Ka Vaar drama ahead!",
                  "👑 Your next vote will carry special luck for your idol!",
                  "💎 You are crowned Bigg Boss Superfan of the Hour!",
                  "🛡️ A shocking immunity twist will shake the nomination list soon!"
                ];
                const chosen = prophecies[Math.floor(Math.random() * prophecies.length)];
                viewerEvent({ userId: id, name: author, type: "fortune", payload: { prophecy: chosen }, durationMs: 6500 });
                setAnnouncement(`🔮 ORACLE PREDICTION FOR ${author}: "${chosen}"`, "BIGG BOSS ORACLE", 5200);
                console.log(`[interactive] ${author} fortune: ${chosen}`);
              }
              // --- Theatrical Stage Spotlight ---
              else if (cmdToken === "spotlight" || cmdToken === "beam") {
                const sTarget = target || resolveContestant(rawArg) || (1 + Math.floor(Math.random() * config.contestants.length));
                if (sTarget) {
                  const cItem = config.contestants[sTarget - 1];
                  viewerEvent({ userId: id, name: author, type: "spotlight", contestant: sTarget, durationMs: 7000 });
                  setAnnouncement(`🔦 THEATRICAL SPOTLIGHT ON #${sTarget} ${cItem?.displayName || "CONTESTANT"}! 🌟`, "STAGE SPOTLIGHT", 4500);
                  console.log(`[interactive] ${author} stage spotlight on #${sTarget}`);
                }
              }
              // --- New Visual Effects: !freeze, !galaxy, !tsunami, !diamond, !cheer ---
              else if (cmdToken === "freeze" || cmdToken === "ice" || cmdToken === "blizzard") {
                viewerEvent({ userId: id, name: author, type: "freeze", durationMs: 5500 });
                setAnnouncement(`❄️ ${author} CAST AN ARCTIC BLIZZARD FREEZE! ❄️`, "ARCTIC FREEZE", 4200);
                console.log(`[interactive] ${author} cast arctic freeze`);
              }
              else if (cmdToken === "galaxy" || cmdToken === "nebula" || cmdToken === "milkyway") {
                viewerEvent({ userId: id, name: author, type: "galaxy", durationMs: 5500 });
                setAnnouncement(`🌌 ${author} OPENED A SPIRAL GALAXY SINGULARITY! 🌌`, "COSMIC GALAXY", 4200);
                console.log(`[interactive] ${author} opened galaxy singularity`);
              }
              else if (cmdToken === "tsunami" || cmdToken === "ocean" || cmdToken === "wave") {
                viewerEvent({ userId: id, name: author, type: "tsunami", durationMs: 5500 });
                setAnnouncement(`🌊 ${author} UNLEASHED A ROARING OCEAN TSUNAMI! 🌊`, "OCEAN TSUNAMI", 4200);
                console.log(`[interactive] ${author} unleashed ocean tsunami`);
              }
              else if (cmdToken === "diamond" || cmdToken === "gem" || cmdToken === "prism") {
                viewerEvent({ userId: id, name: author, type: "diamond", durationMs: 5500 });
                setAnnouncement(`💎 ${author} SUMMONED PRISMATIC DIAMOND BRILLIANCE! 💎`, "DIAMOND PRISM", 4200);
                console.log(`[interactive] ${author} summoned diamond brilliance`);
              }
              else if (cmdToken === "cheer") {
                const cTarget = target || resolveContestant(rawArg) || (1 + Math.floor(Math.random() * config.contestants.length));
                const cItem = config.contestants.find(x => x.no === cTarget);
                viewerEvent({ userId: id, name: author, type: "cheer", contestant: cTarget, durationMs: 5500 });
                setAnnouncement(`📣 ${author} CHEERED FOR #${cTarget} ${cItem?.displayName || "CONTESTANT"}! 🌟`, "STADIUM CHEER", 4000);
                console.log(`[interactive] ${author} cheered for #${cTarget}`);
              }
              else if (cmdToken === "predict" || cmdToken === "winner") {
                const pTarget = target || resolveContestant(rawArg);
                if (pTarget) {
                  const cItem = config.contestants.find(x => x.no === pTarget);
                  setAnnouncement(`🔮 ${author} PREDICTS #${pTarget} ${cItem?.displayName || "CONTESTANT"} WILL WIN BIGG BOSS! 🏆`, "WINNER PREDICTION", 4500);
                  console.log(`[predict] ${author} predicted #${pTarget}`);
                } else {
                  setAnnouncement(`🔮 PREDICTION: Type !predict <contestant> to lock in your Bigg Boss Winner pick!`, "PREDICTION HELP", 3500);
                }
              }
              // --- Spoken Neural TTS Audio Announcer Controls: !announce on/off, !tts on/off ---
              else if (cmdToken === "tts" || cmdToken === "voice" || cmdToken === "announce" || cmdToken === "announcer") {
                const isOwnerOrAdmin = admin(id, owner, mod);
                const ttsArg = (parts[1] || "").toLowerCase();
                const ttsRest = parts.slice(2).join(" ").trim();

                if (ttsArg === "on" || ttsArg === "enable" || ttsArg === "start" || ttsArg === "play") {
                  if (isOwnerOrAdmin) {
                    setTtsEnabled(true);
                    setAnnouncement(`🗣️ Live Voice Announcer TURNED ON by ${author}!`, "VOICE ANNOUNCER", 3500);
                    console.log(`[tts] ${author} enabled live voice announcements`);
                  }
                } else if (ttsArg === "off" || ttsArg === "disable" || ttsArg === "mute" || ttsArg === "stop") {
                  if (isOwnerOrAdmin) {
                    setTtsEnabled(false);
                    setAnnouncement(`🔇 Live Voice Announcer TURNED OFF by ${author}!`, "VOICE ANNOUNCER", 3500);
                    console.log(`[tts] ${author} disabled live voice announcements`);
                  }
                } else if (ttsArg === "voice" || ttsArg === "speaker") {
                  if (isOwnerOrAdmin && ttsRest) {
                    let vName = ttsRest;
                    const vLower = ttsRest.toLowerCase();
                    if (vLower.includes("prabhat")) vName = "en-IN-PrabhatNeural";
                    else if (vLower.includes("neerja")) vName = "en-IN-NeerjaExpressiveNeural";
                    else if (vLower.includes("chris") || vLower.includes("christopher")) vName = "en-US-ChristopherNeural";
                    else if (vLower.includes("guy")) vName = "en-US-GuyNeural";
                    setTtsVoice(vName);
                    setAnnouncement(`🎙️ Announcer voice set to: ${vName}`, "VOICE CHANGED", 3500);
                  } else {
                    const cur = getTtsVoice();
                    setAnnouncement(`🎙️ Announcer voice: ${cur} • Available: prabhat, neerja, chris, guy`, "ANNOUNCER VOICE", 4500);
                  }
                } else if (ttsArg === "status" || (!ttsArg && (cmdToken === "announce" || cmdToken === "announcer"))) {
                  const st = isTtsEnabled() ? "ENABLED (ON)" : "DISABLED (OFF)";
                  const filt = getTtsFilterStatus();
                  const curV = getTtsVoice();
                  setAnnouncement(`🗣️ Announcer: ${st} • Voice: ${curV} • Filter: ${filt} • Use !announce on / !announce off`, "ANNOUNCER STATUS", 4000);
                } else if (ttsArg === "all" || ttsArg === "reset" || ttsArg === "clear") {
                  if (isOwnerOrAdmin) {
                    setTtsTargetContestant("all");
                    setAnnouncement(`🗣️ Voice will now announce votes for ALL CONTESTANTS!`, "TTS FILTER", 4000);
                  }
                } else {
                  const targetQ = (ttsArg === "only" || ttsArg === "contestant") ? ttsRest : parts.slice(1).join(" ");
                  const cTarget = resolveContestant(targetQ);
                  if (cTarget && isOwnerOrAdmin) {
                    const cItem = config.contestants.find(x => x.no === cTarget);
                    const cName = cItem?.displayName || cItem?.name || `#${cTarget}`;
                    setTtsTargetContestant(String(cTarget));
                    setAnnouncement(`🗣️ Voice will announce votes ONLY for #${cTarget} ${cName}!`, "TTS FILTER", 4500);
                  } else {
                    const st = isTtsEnabled() ? "ON" : "OFF";
                    const filt = getTtsFilterStatus();
                    const curV = getTtsVoice();
                    setAnnouncement(`🗣️ Announcer (${st}, ${curV}): Use !announce on/off • !announce voice <name> • !tts <contestant>`, "ANNOUNCER INFO", 4000);
                  }
                }
              }
              else if (cmdToken === "help" || cmdToken === "commands") {
                setAnnouncement(`📜 COMMANDS: !vote <#>, !magic, !drop <#>, !freeze, !galaxy, !tsunami, !diamond, !spotlight <#>, !cheer <#>, !confess <text>`, "LIVE COMMANDS", 6000);
                console.log(`[interactive] ${author} viewed commands`);
              }
              // --- Vote Streak Query ---
              else if (cmdToken === "streak" || cmdToken === "combo") {
                setAnnouncement(`🔥 VOTE STREAK: Keep voting consecutively to trigger Combo Multipliers and electric stream surges!`, "VOTE STREAK", 3800);
              }
              else if (cmdToken === "random") {
                const pick = 1 + Math.floor(Math.random() * config.contestants.length);
                viewerEvent({ userId: id, name: author, type: "random", contestant: pick });
              }
              else if (cmdToken === "mvp") {
                viewerEvent({ userId: id, name: author, type: "mvp" });
              }
              else if (cmdToken === "event") {
                const types = ["drop", "heart", "gift", "boom", "star", "wheel", "dice"];
                const type = types[Math.floor(Math.random() * types.length)];
                viewerEvent({ userId: id, name: author, type, emoji: type === "drop" ? "🎈" : type === "heart" ? "❤️" : type === "gift" ? "🎁" : type === "star" ? "⭐" : "✨" });
              }
              else if (admin(id, owner, mod) && cmdToken === "close") {
                setVoting(false); void saveState();
                setAnnouncement(`🔒 Voting has been CLOSED by Admin`, "VOTING STATUS", 3500);
              }
              else if (admin(id, owner, mod) && cmdToken === "open") {
                setVoting(true); void saveState();
                setAnnouncement(`🔓 Voting has been OPENED by Admin`, "VOTING STATUS", 3500);
              }
            } catch (error) {
              runtime.chat.lastError = `message: ${error.message}`;
              console.error(`[chat] message handler: ${error.stack || error.message}`);
            }
          }
        }
      } catch (e) {
        runtime.chat.status = "error";
        runtime.chat.lastError = e?.message || String(e);
        const isChatDisabled = /disabled|unavailable|members-only/i.test(runtime.chat.lastError);
        if (isChatDisabled) {
          console.warn(`[chat] live chat is unavailable or disabled for ${activeVideoId}; retrying in 30s`);
          delay = 30000;
        } else if (!signal.aborted) {
          console.error(`[chat] ${runtime.chat.lastError}; retrying in ${Math.round(delay/1000)}s`);
        }
      } finally {
        runtime.chat.reconnects++;
        try { mc?.stop?.(); } catch {}
        mc = null;
      }
      if (signal.aborted) break;
      runtime.chat.status = "waiting";
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
    }
    runtime.chat.status = "stopped";
  })();
}
