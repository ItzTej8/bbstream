import { runtime } from "./runtime.mjs";
import { state } from "./state.mjs";
import { config } from "./config.mjs";
import { emit } from "./events.mjs";
import { subscriberMilestone } from "./interactive.mjs";
import { getActiveVideoId } from "./youtube-resolver.mjs";

let pollerActive = false;
let pollerTimer = null;
let lastKnownSubCount = 0;

function parseSubscriberString(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  const m = s.match(/([\d,.]+)\s*(thousand|million|billion|lakh|crore|[kmb])?/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(num)) return null;
  const unit = (m[2] || '').toLowerCase();
  let mult = 1;
  if (unit === 'thousand' || unit === 'k') mult = 1000;
  else if (unit === 'million' || unit === 'm') mult = 1000000;
  else if (unit === 'billion' || unit === 'b') mult = 1000000000;
  else if (unit === 'lakh') mult = 100000;
  else if (unit === 'crore') mult = 10000000;
  return Math.round(num * mult);
}

let cachedPublicSubCount = 0;
let lastPublicSubFetchAt = 0;

async function fetchPublicSubscriberCount(channelId) {
  const now = Date.now();
  if (cachedPublicSubCount > 0 && (now - lastPublicSubFetchAt) < 60000) {
    return cachedPublicSubCount;
  }
  const cid = channelId || config.channelId || "UCUNbognrXqUWzJOtrK8YP2A";

  // 1. Official YouTube Data API v3 (Ultra-fast ~100ms, only 200 bytes JSON, costs only 1 unit)
  if (config.youtubeApiKey) {
    try {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${cid}&key=${config.youtubeApiKey}`, {
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const data = await res.json();
        const subStr = data?.items?.[0]?.statistics?.subscriberCount;
        const total = parseInt(subStr, 10);
        if (Number.isFinite(total) && total > 0) {
          cachedPublicSubCount = total;
          lastPublicSubFetchAt = now;
          return total;
        }
      }
    } catch {}
  }

  // 2. Return last known subscriber count if already set (avoid heavy multi-megabyte HTML parsing on main thread)
  if (lastKnownSubCount > 0) {
    return lastKnownSubCount;
  }

  return null;
}

const STUDIO_HEADERS = {
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.9,mr;q=0.8",
  "authorization": process.env.YOUTUBE_STUDIO_AUTH || "SAPISIDHASH 1790576375_626b4a2442e6b74f6e5bc2f376029a5f01d84020_u SAPISID1PHASH 1790576375_626b4a2442e6b74f6e5bc2f376029a5f01d84020_u SAPISID3PHASH 1790576375_626b4a2442e6b74f6e5bc2f376029a5f01d84020_u",
  "content-type": "application/json",
  "priority": "u=1, i",
  "sec-ch-ua": "\"Not=A?Brand\";v=\"99\", \"Google Chrome\";v=\"151\", \"Chromium\";v=\"151\"",
  "sec-ch-ua-arch": "\"x86\"",
  "sec-ch-ua-bitness": "\"64\"",
  "sec-ch-ua-form-factors": "\"Desktop\"",
  "sec-ch-ua-full-version": "\"151.0.7922.175\"",
  "sec-ch-ua-full-version-list": "\"Not=A?Brand\";v=\"99.0.0.0\", \"Google Chrome\";v=\"151.0.7922.175\", \"Chromium\";v=\"151.0.7922.175\"",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-model": "\"\"",
  "sec-ch-ua-platform": "\"Windows\"",
  "sec-ch-ua-platform-version": "\"19.0.0\"",
  "sec-ch-ua-wow64": "?0",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "x-browser-channel": "stable",
  "x-browser-copyright": "Copyright 2026 Google LLC. All Rights Reserved.",
  "x-browser-validation": "n3vfL909mLjmn69wqLR0nP++fWE=",
  "x-browser-year": "2026",
  "x-client-data": "CKmdygEIlKHLAQiFoM0BCO3flDAYrN+UMBiz4JQw",
  "x-goog-authuser": "1",
  "x-goog-visitor-id": "CgtEVElHLVo0NmZoSSjejejVBjIKCgJJThIEGgAgGmLfAgrcAjIyLllUPWEtYzdSc0JGTExyRTFhajFTbWJCLW1hdzhtLXpCS2hMSGNVTGdHTFB4VHo5T1Y3X3l4OHo3LVR3QW9Pb0F2dnRpeU80aGdKamk3dDRYcTlNdFdtdzJDYUZGeFdZVkcwY0hkSHh5SFo4VUlITllEWjhYby1HenVPWGVuekFzalMwVHpaczNic1Y1VFU2QXFKWHV5aEZGWVRZTTVaRlVOV29JWkFIMkdRSzU5bVlLcHdfNEtBaGJtQnNERUxGR0ZWOVNaZFl1aC1KWVZGUDhMeE1WUjNaek1seGpKcW9CZldKRFBGYjd3WUEtTHFxVWxHRkdDZFcyaGpNOHBYRGJnVGlPN1FfWE10RWF0OHY3SjZjM2U2TDhkYVJmVEdQZHhUWlZqTHpkNTJFeENMTE9oSmU2Q0hMWF9CV2FTaW9FSVI5TnAzck1RMV9KakVURm1uLWREQTdwZw%3D%3D",
  "x-origin": "https://studio.youtube.com",
  "x-youtube-ad-signals": "dt=1790576358260&flash=0&frm&u_tz=330&u_his=27&u_h=1080&u_w=1920&u_ah=1032&u_aw=1920&u_cd=24&bc=31&bih=542&biw=1920&brdim=0%2C0%2C0%2C0%2C1920%2C0%2C1920%2C1032%2C1920%2C542&vis=1&wgl=true&ca_type=image",
  "x-youtube-client-name": "62",
  "x-youtube-client-version": "1.20260924.00.01",
  "x-youtube-delegation-context": "EhhVQ1VOYm9nbnJYcVVXekpPdHJLOFlQMkEqAggI",
  "x-youtube-page-cl": "986666773",
  "x-youtube-page-label": "youtube.studio.web_20260924_00_RC01",
  "x-youtube-time-zone": "Asia/Calcutta",
  "x-youtube-utc-offset": "330",
  "cookie": process.env.YOUTUBE_STUDIO_COOKIE || "VISITOR_INFO1_LIVE=DTIG-Z46fhI; VISITOR_PRIVACY_METADATA=CgJJThIEGgAgGg%3D%3D; _gcl_au=1.1.1572519284.1783620587; YSC=Zwb2wJ3IkJI; LOGIN_INFO=AFmmF2swRQIhAKTu9f7BPmiDj7ii2BPXcTJoHXUJz_1EqlJkXLSwxCScAiABhVSxw_MlNltP6seTb4NSuhoGFiocwJdtJyUPaiLCZg:QUQ3MjNmeE9YbU55aVN4T29LSFlMcUFwaU5sem04U3RoVEY2RDhYVDh1SXV5RS04TVlXdWo1LUZaM2I0MkpPTC1KNmM3bnF0bTFxdDZBTG9kUUI0VWVkWXFRWUpyeWRQRWNVaGIzR2JId29kT2lkR2ljUDRQT19CMGZubW5tNzZFbnBLbThHNlZRSVl5WVNYVUYyOEpFN056bVRtMjgtclZ3; HSID=AtsxZhv4DV6ifjGaS; SSID=AkKPr5OOv9I8k5Nph; APISID=TWI5cGWIoKzg3qGj/ABWzS7tBaFsU80Kao; SAPISID=ZCAvfM-PmMN4aOM2/Auinfbqb1pMnOVJ1f; __Secure-1PAPISID=ZCAvfM-PmMN4aOM2/Auinfbqb1pMnOVJ1f; __Secure-3PAPISID=ZCAvfM-PmMN4aOM2/Auinfbqb1pMnOVJ1f; SID=g.a000DAnngZoU271O8qd6zI37RMiYqtUV27D1U4lPMWpz_WeL33xYz58PC5wij0UefSc6Wc5akwACgYKAc4SARUSFQHGX2MiQKThy3VzxcAiwsN40uue5hoVAUF8yKonRJaWNtHG4882SGRMlsMJ0076; __Secure-1PSID=g.a000DAnngZoU271O8qd6zI37RMiYqtUV27D1U4lPMWpz_WeL33xYnVhQ015ZXmLcXVtfHJIE3gACgYKAdMSARUSFQHGX2MiayHeX2SRtCBbXKT20oAcWxoVAUF8yKp6cSKyLj8ZcIc5azYMcUrc0076; __Secure-3PSID=g.a000DAnngZoU271O8qd6zI37RMiYqtUV27D1U4lPMWpz_WeL33xYvuQ9Qw5Fj9_x31qJvt9ZxgACgYKAXISARUSFQHGX2MiDbupJahxU4INHCBPv6JYSxoVAUF8yKoCrAYpbLs88p_Qx3d-mQKM0076; __Secure-YNID=22.YT=a-c7RsBFLLrE1aj1SmbB-maw8m-zBKhLHcULgGLPxTz9OV7_yx8z7-TwAoOoAvvtiyO4hgJji7t4Xq9MtWmw2CaFFxWYVG0cHdHxyHZ8UIHNYDZ8Xo-GzuOXenzAsjS0TzZs3bsV5TU6AqJXuyhFFYTYM5ZFUNWoIZAH2GQK59mYKpw_4KAhbmBsDELFGFV9SZdYuh-JYVFP8LxMVR3ZzMlxjJqoBfWJDPFb7wYA-LqqUlGFGCdW2hjM8pXDbgTiO7Q_XMtEat8v7J6c3e6L8daRfTGPdxTZVjLzd52ExCLLOhJe6CHLX_BWaSioEIR9Np3rMQ1_JjETFmn-dDA7pg; __Secure-ROLLOUT_TOKEN=CJaQyK2z6s6EChCfyvLdl_-UAxjege_LmI6XAw%3D%3D; PREF=tz=Asia.Calcutta&f7=100&repeat=NONE&autoplay=true&f4=10000&f5=30000; __Secure-1PSIDTS=sidts-CjUBkldj_7H38nZPWPL3nPEOh02E08gxj7BC2yMVdXS_7H_T3br0DhXLRnw03FLY74oCsu3oWRAA; __Secure-3PSIDTS=sidts-CjUBkldj_7H38nZPWPL3nPEOh02E08gxj7BC2yMVdXS_7H_T3br0DhXLRnw03FLY74oCsu3oWRAA; SIDCC=AKEyXzWMjzLfKC9x3tMBeyR0v4ilmBnHrOW_TALxHXjY7CSxMAKe1t0BsM6wTpm1ASF_FyJrXA; __Secure-1PSIDCC=AKEyXzXqAH5W2S9EkaGVUn06mQ1MI18Mh4FV4k2TPCgscndD8RtOpltw07fCTYtS9vj0YagwHio; __Secure-3PSIDCC=AKEyXzX-mWD53eZPwOKsbV74JJy2APVBGeXOjBIooRQmkREgd9tv5WF2xZdFfjXZpKAL3JYH8g",
  "Referer": `https://studio.youtube.com/channel/${config.channelId || "UCUNbognrXqUWzJOtrK8YP2A"}/analytics/tab-overview/period-default/explore?entity_type=CHANNEL&entity_id=${config.channelId || "UCUNbognrXqUWzJOtrK8YP2A"}&time_period=4_weeks&explore_type=SUBSCRIBERS`
};

function buildRequestBody(channelId) {
  const cid = channelId || config.channelId || "UCUNbognrXqUWzJOtrK8YP2A";
  return {
    nodes: [
      {
        key: "0__CUMULATIVE_SUBSCRIBERS_KEY",
        value: {
          getCards: {
            screenConfig: {
              entity: { channelId: cid },
              timePeriod: { timePeriodType: "ANALYTICS_TIME_PERIOD_TYPE_FOUR_WEEKS" },
              currency: "USD",
              timeZoneOffsetSecs: 19800
            },
            cardConfigs: [
              {
                autoUpdateInterval: "ANALYTICS_AUTO_UPDATE_INTERVAL_NEVER",
                cumulativeSubscribersCardConfig: {
                  returnTableData: false,
                  returnLifetimeTotal: true
                }
              }
            ],
            enabledExperiments: [],
            experimentFlags: [],
            fetchingType: "FETCHING_TYPE_FOREGROUND"
          }
        }
      }
    ],
    connectors: [],
    allowFailureResultNodes: true,
    context: {
      client: {
        clientName: 62,
        clientVersion: "1.20260924.00.01",
        hl: "en-IN",
        gl: "IN",
        experimentsToken: "",
        utcOffsetMinutes: 330,
        userInterfaceTheme: "USER_INTERFACE_THEME_LIGHT",
        screenWidthPoints: 1920,
        screenHeightPoints: 542,
        screenPixelDensity: 1,
        screenDensityFloat: 1
      },
      request: {
        returnLogEntry: false,
        internalExperimentFlags: [],
        eats: "AXoBSW-MAFOpeebxSazURAypp092O5XYW_dpU2ahHJV_PMhY5rAdLfmv3xIemUAEa44fVgTg3T5fAVI9AYTNSpWmXFAQ5S3yMRCL1UuPSWZPP8rPnIjlC86IyI6c3Ss=",
        sessionInfo: {
          token: "AUQqFwmU7F-EOmJSlDbkTMksvQD6M13W0nHkGROUY0qe-fohXBH9X5ej5U0JKuJd3pV5J1yg3DFg0oqZKYcU9TgGdxa8kSgRm4othJKlZTBAOBBHXmWXmLD3Z2iO_vUHokITEYU5GRw8SIN0_cyQTQeXG8h3eBaeUCw="
        },
        consistencyTokenJars: []
      },
      user: {
        delegationContext: {
          externalChannelId: cid,
          roleType: { channelRoleType: "CREATOR_CHANNEL_ROLE_TYPE_OWNER" }
        },
        serializedDelegationContext: "EhhVQ1VOYm9nbnJYcVVXekpPdHJLOFlQMkEqAggI"
      },
      clickTracking: { visualElement: { veType: 38408 } },
      clientScreenNonce: "oBDeliZ4qZQhziKr"
    },
    trackingLabel: "web_yta_unbatched"
  };
}

let studio401Warned = false;
let nextStudioAttemptAt = 0;

export async function fetchLiveSubscribers() {
  const now = Date.now();
  if (now < nextStudioAttemptAt) {
    return lastKnownSubCount;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const res = await fetch("https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json", {
      method: "POST",
      headers: STUDIO_HEADERS,
      body: JSON.stringify(buildRequestBody(config.channelId)),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.status === 401 || !res.ok) {
      if (!studio401Warned) {
        studio401Warned = true;
        console.log(`[subscribers] studio status: ${res.status} (expired session), backed off 1h — using official YouTube Data API channel stats`);
      }
      nextStudioAttemptAt = Date.now() + 60 * 60 * 1000; // Backoff 1 hour to prevent event-loop stalls
      const pubTotal = await fetchPublicSubscriberCount(config.channelId);
      if (typeof pubTotal === "number" && pubTotal > 0) {
        lastKnownSubCount = pubTotal;
        if (!runtime.chat) runtime.chat = {};
        runtime.chat.subscriberCount = pubTotal;
        state.subscriberCount = pubTotal;
        return pubTotal;
      }
      return lastKnownSubCount;
    }

    const data = await res.json();
    const total = data.results?.[0]?.value?.getCards?.cards?.[0]?.cumulativeSubscribersCardData?.lifetimeTotal;

    if (typeof total === "number" && total > 0) {
      studio401Warned = false;
      const prev = lastKnownSubCount;
      lastKnownSubCount = total;

      if (!runtime.chat) runtime.chat = {};
      runtime.chat.subscriberCount = total;
      state.subscriberCount = total;

      // Celebrate new subscriber in live stream if count increased
      if (total > prev && prev > 0) {
        console.log(`[subscribers] 🎉 NEW SUBSCRIBER! ${prev} -> ${total}`);
        subscriberMilestone(total);
        emit("subscriber-increase", { previous: prev, current: total });
      }

      return total;
    }
  } catch (err) {
    try {
      const pubTotal = await fetchPublicSubscriberCount(config.channelId);
      if (typeof pubTotal === "number" && pubTotal > 0) {
        lastKnownSubCount = pubTotal;
        if (!runtime.chat) runtime.chat = {};
        runtime.chat.subscriberCount = pubTotal;
        state.subscriberCount = pubTotal;
        return pubTotal;
      }
    } catch {}
  }
  return lastKnownSubCount;
}


export function getSubscriberCount() {
  return runtime.chat?.subscriberCount || state?.subscriberCount || lastKnownSubCount;
}

export function startSubscriberLoop({ signal, intervalMs = 60000 } = {}) {
  if (pollerActive) return;
  pollerActive = true;

  // Initialize runtime & state with default
  if (!runtime.chat) runtime.chat = {};
  runtime.chat.subscriberCount = lastKnownSubCount;
  state.subscriberCount = lastKnownSubCount;

  // Initial immediate fetch
  fetchLiveSubscribers()
    .then(cnt => console.log(`[subscribers] Live subscriber count loaded: ${Number(cnt).toLocaleString()}`))
    .catch(() => {});

  const loop = async () => {
    if (!pollerActive || signal?.aborted) return;
    try {
      await fetchLiveSubscribers();
    } catch {}
    if (!pollerActive || signal?.aborted) return;
    pollerTimer = setTimeout(loop, intervalMs);
  };

  pollerTimer = setTimeout(loop, intervalMs);

  if (signal) {
    signal.addEventListener("abort", () => stopSubscriberLoop(), { once: true });
  }
}

export function stopSubscriberLoop() {
  pollerActive = false;
  if (pollerTimer) {
    clearTimeout(pollerTimer);
    pollerTimer = null;
  }
}
