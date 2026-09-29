/**
 * eviction-monitor.mjs
 * Polls public news sources every 15 minutes to detect:
 *   - Contestants officially evicted from Bigg Boss 20
 *   - Contestants currently in the danger/nomination zone
 * Updates `evictionState` which the renderer reads.
 */

const FETCH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Shared eviction state — renderer reads this directly. */
export const evictionState = {
  evicted: new Set(),    // Set of contestant nos confirmed evicted
  dangerZone: new Set(), // Set of contestant nos reported in danger zone by news
  lastUpdated: null,
  lastSource: "",
};

let allContestants = [];
export function setContestantList(list) {
  allContestants = list;
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function findContestantNo(text) {
  const t = norm(text);
  for (const c of allContestants) {
    if (c.name && t.includes(norm(c.name))) return c.no;
    if (c.displayName && t.includes(norm(c.displayName))) return c.no;
  }
  return null;
}

async function fetchEvictionData() {
  const evicted = new Set();
  const danger = new Set();
  let fetchedAny = false;

  const evictionKw = ["evicted", "eliminated", "out of the house", "exits the house", "leaves the house", "sent home", "voted out"];
  const dangerKw   = ["nominated", "danger zone", "up for eviction", "at risk", "in danger", "nominated for eviction", "in the bottom", "unsafe", "nomination task"];

  // --- Source 1: DuckDuckGo instant answer ---
  try {
    const q = encodeURIComponent("bigg boss 20 evicted contestant 2025 2026");
    const res = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BB20Monitor/1.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const json = await res.json();
      const texts = [
        json.Answer || "",
        json.AbstractText || "",
        ...(json.RelatedTopics || []).map(t => t.Text || ""),
      ];
      for (const text of texts) {
        const sn = norm(text);
        const hasEvic = evictionKw.some(kw => sn.includes(kw));
        const hasDang = dangerKw.some(kw => sn.includes(kw));
        if (!hasEvic && !hasDang) continue;
        const no = findContestantNo(sn);
        if (no != null) {
          if (hasEvic) evicted.add(no);
          else if (hasDang) danger.add(no);
        }
      }
      fetchedAny = true;
    }
  } catch {}

  // --- Source 2: bigboss20.in ---
  const pages = [
    "https://bigboss20.in/evictions",
    "https://bigboss20.in/nominated-contestants",
  ];
  for (const url of pages) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
      const sentences = text.split(/[.!?\n\r]+/);
      for (const sentence of sentences) {
        const sn = norm(sentence);
        const hasEvic = evictionKw.some(kw => sn.includes(kw));
        const hasDang = dangerKw.some(kw => sn.includes(kw));
        if (!hasEvic && !hasDang) continue;
        const no = findContestantNo(sn);
        if (no != null) {
          if (hasEvic) evicted.add(no);
          else if (hasDang) danger.add(no);
        }
      }
      fetchedAny = true;
    } catch {}
  }

  return { evicted, danger, fetchedAny };
}

async function refresh() {
  try {
    console.log("[eviction-monitor] Fetching eviction/danger zone updates...");
    const { evicted, danger, fetchedAny } = await fetchEvictionData();
    evictionState.evicted   = evicted;
    evictionState.dangerZone = danger;
    evictionState.lastUpdated = Date.now();
    evictionState.lastSource  = fetchedAny ? "web" : "none";
    const ev = [...evicted].join(",") || "none";
    const dz = [...danger].join(",")  || "none";
    console.log(`[eviction-monitor] evicted=[${ev}] dangerZone=[${dz}]`);
  } catch (e) {
    console.warn(`[eviction-monitor] refresh error: ${e.message}`);
  }
}

let _timer = null;
export function startEvictionMonitor(contestants) {
  if (contestants) setContestantList(contestants);
  refresh(); // immediate first run
  _timer = setInterval(refresh, FETCH_INTERVAL_MS);
  console.log("[eviction-monitor] Started — polling every 15 minutes");
}

export function stopEvictionMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

