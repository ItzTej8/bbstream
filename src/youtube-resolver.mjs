import { config } from "./config.mjs";
import { runtime } from "./runtime.mjs";

let cachedVideoId = null;
let lastResolvedAt = 0;
let resolvePromise = null;
let apiQuotaExceeded = false;

/**
 * Scrape channel's live redirect without consuming any Google API quota.
 */
export async function resolveLiveVideoIdFromChannel(channelId = config.channelId) {
  const chId = (channelId || process.env.YOUTUBE_CHANNEL_ID || config.channelId || "").trim();
  if (!chId) return null;
  try {
    const res = await fetch(`https://www.youtube.com/channel/${chId}/live`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/i);
    const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    const id = canonicalMatch?.[1] || videoIdMatch?.[1];
    return id || null;
  } catch {}
  return null;
}

/**
 * Calculate title match score between candidate stream title and target title.
 * Returns a score between 0.0 and 1.0 using exact, normalized alphanumeric, and Sorensen-Dice token overlap.
 */
export function calculateTitleMatchScore(candidateTitle, targetTitle) {
  if (!candidateTitle || !targetTitle) return 0;
  const cTrim = candidateTitle.trim().toLowerCase();
  const tTrim = targetTitle.trim().toLowerCase();
  if (cTrim === tTrim) return 1.0;

  const cNorm = cTrim.replace(/[^a-z0-9]/g, "");
  const tNorm = tTrim.replace(/[^a-z0-9]/g, "");
  if (cNorm && tNorm && cNorm === tNorm) return 0.99;
  if (cNorm && tNorm && (cNorm.includes(tNorm) || tNorm.includes(cNorm))) return 0.90;

  const getTokens = s => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
  const cTokens = getTokens(candidateTitle);
  const tTokens = getTokens(targetTitle);
  if (tTokens.size === 0 || cTokens.size === 0) return 0;

  let common = 0;
  for (const tok of tTokens) {
    if (cTokens.has(tok)) common++;
  }
  return (2 * common) / (tTokens.size + cTokens.size);
}

/**
 * Query YouTube Data API v3 to find live video ID matching the configured title on the channel.
 */
export async function fetchLiveVideoIdFromYouTubeApi({
  apiKey = process.env.YOUTUBE_API_KEY || config.youtubeApiKey,
  channelId = process.env.YOUTUBE_CHANNEL_ID || config.channelId,
  liveTitle = process.env.YOUTUBE_LIVE_TITLE || config.youtubeLiveTitle,
  requireTitleMatch = false,
  minScore = 0.60
} = {}) {
  const key = (apiKey || "").trim();
  const chId = (channelId || "").trim();
  const title = (liveTitle || "").trim();

  if (!key || !chId) {
    return resolveLiveVideoIdFromChannel(chId);
  }

  if (apiQuotaExceeded) {
    return resolveLiveVideoIdFromChannel(chId);
  }

  const searchParams = new URLSearchParams({
    part: "snippet",
    channelId: chId,
    type: "video",
    eventType: "live",
    maxResults: "10",
    key: key
  });

  const url = `https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "BiggBossLiveStream/1.0"
      }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 429 || /quota/i.test(errText)) {
        apiQuotaExceeded = true;
        console.warn(`[youtube-resolver] ⚠️ YouTube Data API search quota exceeded (429). Switching to zero-quota channel live scraper...`);
        const scraped = await resolveLiveVideoIdFromChannel(chId);
        if (scraped) {
          console.log(`[youtube-resolver] 🎯 Zero-quota resolver found active live stream: ${scraped}`);
          return scraped;
        }
      } else {
        console.warn(`[youtube-resolver] YouTube API search error (${response.status}): ${errText.slice(0, 200)}`);
      }
      return null;
    }

    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];

    if (items.length === 0) {
      console.log(`[youtube-resolver] No live videos currently found on channel ${chId}`);
      return null;
    }

    let liveVideo = null;

    if (title) {
      const scoredItems = items.map(item => {
        const itemTitle = item.snippet?.title || "";
        const score = calculateTitleMatchScore(itemTitle, title);
        return { item, itemTitle, score, videoId: item.id?.videoId };
      });

      scoredItems.sort((a, b) => b.score - a.score);
      const best = scoredItems[0];

      if (best && (best.score >= minScore || (items.length === 1 && best.score >= 0.35))) {
        liveVideo = best.item;
        console.log(`[youtube-resolver] 🎯 Matched live stream: "${best.itemTitle}" (score: ${(best.score * 100).toFixed(0)}%, videoId: ${best.videoId})`);
      } else {
        console.log(`[youtube-resolver] Evaluated ${items.length} stream(s). Best title match was "${best?.itemTitle}" with score ${(best?.score * 100 || 0).toFixed(0)}% (threshold: ${(minScore * 100)}%)`);
      }
    }

    if (!liveVideo && !requireTitleMatch && items.length > 0) {
      liveVideo = items[0];
      console.log(`[youtube-resolver] Using first active channel stream: "${liveVideo.snippet?.title}" (${liveVideo.id?.videoId})`);
    }

    const matchedVideoId = liveVideo?.id?.videoId || null;
    return matchedVideoId;
  } catch (err) {
    console.warn(`[youtube-resolver] Failed to query YouTube API: ${err.message}`);
    return null;
  }
}

/**
 * Wait until RTMP stream goes live, wait a few seconds for YouTube Data API to index it,
 * dynamically grab the video ID whose title matches YOUTUBE_LIVE_TITLE in .env,
 * and then return the resolved video ID.
 */
export async function waitForLiveStreamByTitle({
  timeoutSeconds = 90,
  initialDelaySeconds = config.youtubeIndexWaitSeconds || 10,
  retryIntervalSeconds = 8,
  minScore = 0.45,
  maxAttempts = 5,
  signal
} = {}) {
  const isDynamicEnabled = Boolean(
    process.env.FETCH_DYNAMIC_VIDEO_ID === "true" ||
    config.fetchDynamicVideoId ||
    (Boolean(process.env.YOUTUBE_API_KEY || config.youtubeApiKey) && process.env.FETCH_DYNAMIC_VIDEO_ID !== "false")
  );

  const targetTitle = (process.env.YOUTUBE_LIVE_TITLE || config.youtubeLiveTitle || "").trim();
  const fallbackId = (process.env.YOUTUBE_VIDEO_ID || config.videoId || "").trim();

  if (!isDynamicEnabled || !targetTitle) {
    if (fallbackId) {
      cachedVideoId = fallbackId;
      process.env.YOUTUBE_VIDEO_ID = fallbackId;
      if (runtime?.chat) runtime.chat.videoId = fallbackId;
    }
    return fallbackId;
  }

  // 1. First, check channel directly via zero-quota live scraper (saves 100 API quota points!)
  try {
    const scraped = await resolveLiveVideoIdFromChannel();
    if (scraped) {
      console.log(`[youtube-resolver] 🎯 Zero-quota channel scraper found active live stream: ${scraped}`);
      cachedVideoId = scraped;
      process.env.YOUTUBE_VIDEO_ID = scraped;
      if (runtime?.chat) runtime.chat.videoId = scraped;
      return scraped;
    }
  } catch {}

  console.log(`[youtube-resolver] ⏳ Waiting for stream to go live on YouTube RTMP before querying YouTube API...`);

  // Step 1: Wait for RTMP encoder connection (connectedHint or outputStartedAt > 0)
  const encoderWaitStart = Date.now();
  while (!signal?.aborted) {
    if (runtime?.encoder?.connectedHint || (runtime?.encoder?.outputStartedAt && runtime.encoder.outputStartedAt > 0)) {
      break;
    }
    // If 30s passed and encoder status is running or has output, proceed
    if (Date.now() - encoderWaitStart > 30000 && runtime?.encoder?.status === "running") {
      console.log(`[youtube-resolver] Encoder running. Proceeding to YouTube API check...`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (signal?.aborted) return fallbackId;

  console.log(`[youtube-resolver] 🚀 RTMP stream is live! Waiting ${initialDelaySeconds}s for YouTube Data API to index the live broadcast...`);

  // Step 2: Wait initialDelaySeconds for YouTube API to register and index the stream
  for (let s = 0; s < initialDelaySeconds; s++) {
    if (signal?.aborted) return fallbackId;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (signal?.aborted) return fallbackId;

  console.log(`[youtube-resolver] 🔍 Querying YouTube Data API for live stream matching title: "${targetTitle}" (max ${maxAttempts} attempts)`);

  // Step 3: Poll YouTube Data API with maximum 5 attempts to conserve quota
  const startTime = Date.now();
  let attempt = 0;

  while (!signal?.aborted && attempt < maxAttempts) {
    attempt++;
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);

    const matchedId = await fetchLiveVideoIdFromYouTubeApi({
      liveTitle: targetTitle,
      requireTitleMatch: true,
      minScore
    });

    if (matchedId) {
      cachedVideoId = matchedId;
      lastResolvedAt = Date.now();
      process.env.YOUTUBE_VIDEO_ID = matchedId;
      if (runtime?.chat) runtime.chat.videoId = matchedId;
      console.log(`[youtube-resolver] 🎯 Successfully grabbed video ID: ${matchedId} matching title "${targetTitle}"!`);
      return matchedId;
    }

    if (apiQuotaExceeded) {
      console.log(`[youtube-resolver] ⚠️ YouTube API quota exceeded; falling back immediately to video ID from .env: ${fallbackId}`);
      break;
    }

    if (attempt >= maxAttempts) {
      console.log(`[youtube-resolver] ⚠️ Maximum search attempts (${maxAttempts}) reached. Falling back to video ID from .env: ${fallbackId}`);
      break;
    }

    if (elapsedSec >= timeoutSeconds) {
      console.warn(`[youtube-resolver] ⚠️ Timeout (${timeoutSeconds}s) reached waiting for live stream matching "${targetTitle}".`);
      break;
    }

    console.log(`[youtube-resolver] Live stream matching "${targetTitle}" not indexed yet (attempt ${attempt}/${maxAttempts}, ${elapsedSec}s elapsed). Retrying in ${retryIntervalSeconds}s...`);

    for (let s = 0; s < retryIntervalSeconds; s++) {
      if (signal?.aborted) return fallbackId;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Fallback to .env video ID
  const finalVideoId = fallbackId;
  if (finalVideoId) {
    cachedVideoId = finalVideoId;
    process.env.YOUTUBE_VIDEO_ID = finalVideoId;
    if (runtime?.chat) runtime.chat.videoId = finalVideoId;
    console.log(`[youtube-resolver] Proceeding with fallback video ID from .env: ${finalVideoId}`);
  }
  return finalVideoId;
}

/**
 * Get the active video ID, resolving dynamically from YouTube API if enabled,
 * or falling back to process.env.YOUTUBE_VIDEO_ID.
 */
export async function resolveActiveVideoId({ force = false, requireTitleMatch = false } = {}) {
  const fallback = (process.env.YOUTUBE_VIDEO_ID || config.videoId || "").trim();
  const isDynamicEnabled = Boolean(
    process.env.FETCH_DYNAMIC_VIDEO_ID === "true" ||
    config.fetchDynamicVideoId ||
    (Boolean(process.env.YOUTUBE_API_KEY || config.youtubeApiKey) && process.env.FETCH_DYNAMIC_VIDEO_ID !== "false")
  );

  if (!isDynamicEnabled) {
    cachedVideoId = fallback;
    return fallback;
  }

  // Return cached result if fresh (< 5 minutes) unless forced
  const now = Date.now();
  if (!force && cachedVideoId && (now - lastResolvedAt < 5 * 60 * 1000)) {
    return cachedVideoId;
  }

  if (resolvePromise) {
    return resolvePromise;
  }

  resolvePromise = (async () => {
    try {
      const resolved = await fetchLiveVideoIdFromYouTubeApi({ requireTitleMatch });
      if (resolved) {
        cachedVideoId = resolved;
        lastResolvedAt = Date.now();
        process.env.YOUTUBE_VIDEO_ID = resolved;
        if (runtime?.chat) runtime.chat.videoId = resolved;
        return resolved;
      }
    } catch (e) {
      // Ignored
    } finally {
      resolvePromise = null;
    }

    if (cachedVideoId) {
      return cachedVideoId;
    }

    if (fallback) {
      cachedVideoId = fallback;
      lastResolvedAt = Date.now();
      return fallback;
    }

    return "";
  })();

  return resolvePromise;
}

/**
 * Synchronous getter for current video ID (returns cached or .env fallback).
 */
export function getActiveVideoId() {
  return (
    cachedVideoId ||
    process.env.YOUTUBE_VIDEO_ID ||
    config.videoId ||
    ""
  ).trim();
}

/**
 * Periodic background poller to keep live video ID fresh if dynamic resolution is active.
 */
export function startDynamicVideoIdPoller({ intervalMs = 10 * 60 * 1000, signal } = {}) {
  const isDynamicEnabled = Boolean(
    process.env.FETCH_DYNAMIC_VIDEO_ID === "true" ||
    config.fetchDynamicVideoId ||
    (Boolean(process.env.YOUTUBE_API_KEY || config.youtubeApiKey) && process.env.FETCH_DYNAMIC_VIDEO_ID !== "false")
  );

  if (!isDynamicEnabled) return () => {};

  let timer = null;
  const poll = async () => {
    if (signal?.aborted) return;
    try {
      const prev = getActiveVideoId();
      // Use zero-quota scraper to check if live stream video ID changed on channel without draining search quota
      const updated = await resolveLiveVideoIdFromChannel();
      if (updated && updated !== prev) {
        cachedVideoId = updated;
        process.env.YOUTUBE_VIDEO_ID = updated;
        if (runtime?.chat) runtime.chat.videoId = updated;
        console.log(`[youtube-resolver] 🔄 Stream video ID changed: ${prev} -> ${updated}`);
      }
    } catch {}
    if (!signal?.aborted) {
      timer = setTimeout(poll, intervalMs);
    }
  };

  timer = setTimeout(poll, intervalMs);

  if (signal) {
    signal.addEventListener("abort", () => {
      if (timer) clearTimeout(timer);
    }, { once: true });
  }

  return () => {
    if (timer) clearTimeout(timer);
  };
}
