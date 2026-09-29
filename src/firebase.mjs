import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.mjs";
import { on } from "./events.mjs";

let rtdb = null;
let initialized = false;
let syncInterval = null;
let unsubs = [];
const serviceAccountPath = resolve("bb-stream-yt-firebase-adminsdk-fbsvc-04c229f91a.json");

export function initFirebase() {
  if (initialized && rtdb) return rtdb;
  if (!existsSync(serviceAccountPath)) {
    console.warn(`[firebase] credentials file not found at ${serviceAccountPath}; skipping cloud sync`);
    return null;
  }

  try {
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
    const databaseURL = `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`;

    const app = getApps().length > 0 ? getApps()[0] : initializeApp({
      credential: cert(serviceAccount),
      databaseURL
    });

    rtdb = getDatabase(app);
    initialized = true;
    console.log(`[firebase] 🚀 Connected to Firebase Realtime Database: ${databaseURL}`);

    // Initial heart-beat to set stream status
    rtdb.ref("stream/status").set("live").catch(() => {});
    rtdb.ref("stream/startedAt").set(Date.now()).catch(() => {});
    return rtdb;
  } catch (err) {
    console.error("[firebase] initialization error:", err.message);
    return null;
  }
}

import { state } from "./state.mjs";

const dirtyVoters = new Map();
const dirtyContestants = new Set();
let pendingStreamUpdate = null;
let flushTimer = null;

function queueFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushBatchUpdates, 1000);
}

async function flushBatchUpdates() {
  flushTimer = null;
  if (!rtdb) return;

  const updates = {};
  if (pendingStreamUpdate) {
    for (const [k, v] of Object.entries(pendingStreamUpdate)) {
      updates[`stream/${k}`] = v;
    }
    pendingStreamUpdate = null;
  }

  // Sync dirty contestants directly from current validated state
  if (dirtyContestants.size > 0) {
    for (const no of dirtyContestants) {
      const c = config.contestants.find(x => x.no === no);
      const curVotes = state.contestants?.[String(no)]?.votes ?? c?.votes ?? 0;
      updates[`contestants/${no}/no`] = Number(no);
      updates[`contestants/${no}/name`] = c?.displayName || c?.name || `Contestant ${no}`;
      updates[`contestants/${no}/votes`] = curVotes;
      updates[`contestants/${no}/updatedAt`] = Date.now();
    }
    dirtyContestants.clear();
  }

  // Sync dirty voters in batch
  if (dirtyVoters.size > 0) {
    for (const [id, data] of dirtyVoters.entries()) {
      updates[`voters/${id}/userId`] = data.userId;
      updates[`voters/${id}/name`] = data.name;
      updates[`voters/${id}/lastContestant`] = data.lastContestant;
      updates[`voters/${id}/voteCount`] = data.voteCount;
      updates[`voters/${id}/lastVoteAt`] = data.lastVoteAt;
    }
    dirtyVoters.clear();
  }

  if (Object.keys(updates).length > 0) {
    rtdb.ref().update(updates).catch(() => {});
  }
}

// Record an individual vote into Firebase
export async function recordVoteFirebase(vote) {
  if (!rtdb && !initFirebase()) return;
  try {
    const { userId, name, contestant, at } = vote;
    const contestantInfo = config.contestants.find(c => c.no === contestant);
    const contestantName = contestantInfo?.displayName || contestantInfo?.name || `Contestant ${contestant}`;

    // 1. Fast append-only write to /votes
    const votesRef = rtdb.ref("votes");
    votesRef.push().set({
      userId: String(userId || "unknown"),
      name: String(name || "Viewer"),
      contestant: Number(contestant),
      contestantName,
      timestamp: at || Date.now()
    }).catch(() => {});

    // 2. Queue voter profile update
    if (userId) {
      const sanitizedId = String(userId).replace(/[.#$[\]/]/g, "_");
      const existing = dirtyVoters.get(sanitizedId);
      dirtyVoters.set(sanitizedId, {
        userId: String(userId),
        name: String(name || existing?.name || "Viewer"),
        lastContestant: Number(contestant),
        voteCount: (existing?.voteCount || 0) + 1,
        lastVoteAt: at || Date.now()
      });
    }

    // 3. Mark contestant dirty for batched multi-path update
    dirtyContestants.add(Number(contestant));

    // 4. Queue stream live totals
    pendingStreamUpdate = {
      lastVote: {
        contestant: Number(contestant),
        contestantName,
        name: String(name || "Viewer"),
        at: at || Date.now()
      },
      totalAcceptedVotes: Number(state.totalAcceptedVotes || 0),
      uniqueVoters: Number(state.uniqueVoters || 0),
      updatedAt: Date.now()
    };

    queueFlush();
  } catch (e) {
    console.warn("[firebase] recordVote error:", e.message);
  }
}

// Record a chat message into Firebase
export async function recordChatFirebase(chat) {
  if (!rtdb && !initFirebase()) return;
  try {
    const { name, text, at } = chat;
    const chatsRef = rtdb.ref("chats");
    chatsRef.push().set({
      name: String(name || "Viewer"),
      text: String(text || ""),
      timestamp: at || Date.now()
    }).catch(() => {});
  } catch (e) {
    console.warn("[firebase] recordChat error:", e.message);
  }
}

// Record an interactive event (spell, drop, bomb, etc.) into Firebase
export async function recordEventFirebase(event) {
  if (!rtdb && !initFirebase()) return;
  try {
    const eventsRef = rtdb.ref("events");
    eventsRef.push().set({
      type: String(event.type || "unknown"),
      user: String(event.name || event.userId || "Viewer"),
      contestant: event.contestant ? Number(event.contestant) : null,
      timestamp: event.createdAt || Date.now()
    }).catch(() => {});
  } catch (e) {
    console.warn("[firebase] recordEvent error:", e.message);
  }
}

// Sync full snapshot of stream state and contestant rankings to Firebase
export async function syncFullStateFirebase(stateObj) {
  if (!rtdb && !initFirebase()) return;
  try {
    const contestantsMap = {};
    if (stateObj?.contestants) {
      for (const [k, c] of Object.entries(stateObj.contestants)) {
        contestantsMap[k] = {
          no: Number(c.no),
          name: String(c.displayName || c.name || ""),
          votes: Number(c.votes || 0)
        };
      }
    }

    await rtdb.ref("stream").update({
      totalAcceptedVotes: Number(stateObj?.totalAcceptedVotes || 0),
      uniqueVoters: Number(stateObj?.uniqueVoters || 0),
      totalChatMessages: Number(stateObj?.totalChatMessages || 0),
      liveLikes: Number(stateObj?.liveLikes || 0),
      liveViews: Number(stateObj?.liveViews || 0),
      liveWatching: Number(stateObj?.lastWatchingCount || 0),
      theme: String(stateObj?.theme || "dark"),
      votingOpen: Boolean(stateObj?.votingOpen),
      status: "live",
      updatedAt: Date.now()
    });

    if (Object.keys(contestantsMap).length > 0) {
      await rtdb.ref("contestants").update(contestantsMap);
    }
  } catch (e) {
    console.warn("[firebase] syncFullState error:", e.message);
  }
}

// Attach event listeners and start periodic background syncing
export function startFirebaseSync(getStateFn = null) {
  const dbInstance = initFirebase();
  if (!dbInstance) return;

  // Unsubscribe any previous listeners
  stopFirebaseSync();

  const u1 = on("vote", (vote) => {
    recordVoteFirebase(vote);
  });

  const u2 = on("chat", (chat) => {
    recordChatFirebase(chat);
  });

  const u3 = on("interactive", (ev) => {
    recordEventFirebase(ev);
  });

  const u4 = on("subscriber-increase", (data) => {
    if (!rtdb) return;
    rtdb.ref("stream").update({
      subscribers: Number(data.current || 0),
      updatedAt: Date.now()
    }).catch(() => {});
  });

  unsubs = [u1, u2, u3, u4];

  // Periodic heartbeat sync every 20s if getStateFn is provided
  if (typeof getStateFn === "function") {
    syncInterval = setInterval(() => {
      try {
        const s = getStateFn();
        if (s) syncFullStateFirebase(s);
      } catch (err) {
        console.warn("[firebase] periodic sync error:", err.message);
      }
    }, 20000);
  }

  console.log("[firebase] 📡 Real-time listeners active (votes, chats, interactive events, subscribers)");
}

export async function stopFirebaseSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  for (const unsub of unsubs) {
    try { unsub(); } catch {}
  }
  unsubs = [];
  if (rtdb) {
    try {
      await rtdb.ref("stream/status").set("offline");
      await rtdb.ref("stream/endedAt").set(Date.now());
    } catch {}
  }
}

