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

const lastSelfPushedVotes = new Map();

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
      lastSelfPushedVotes.set(Number(no), curVotes);
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

// Load full state snapshot directly from Firebase RTDB (Master Database)
export async function loadStateFromFirebase(stateObj, knownVoterIds = null) {
  const dbInstance = initFirebase();
  if (!dbInstance) {
    console.warn("[firebase] ⚠️ Cannot restore from Firebase: database uninitialized or credentials missing.");
    return false;
  }

  try {
    console.log("[firebase] ⏳ Restoring live state from Firebase Realtime Database...");

    const [contestantsSnap, streamSnap, votersSnap, votesSnap, chatsSnap] = await Promise.all([
      dbInstance.ref("contestants").once("value"),
      dbInstance.ref("stream").once("value"),
      dbInstance.ref("voters").once("value"),
      dbInstance.ref("votes").limitToLast(20).once("value"),
      dbInstance.ref("chats").limitToLast(20).once("value")
    ]);

    const contestantsVal = contestantsSnap.val();
    const streamVal = streamSnap.val() || {};
    const votersVal = votersSnap.val() || {};
    const votesVal = votesSnap.val() || {};
    const chatsVal = chatsSnap.val() || {};

    // 1. Populate contestant vote counts
    let totalVotesSum = 0;
    for (const c of config.contestants) {
      let v = 0;
      if (contestantsVal) {
        if (Array.isArray(contestantsVal)) {
          v = Number(contestantsVal[c.no]?.votes || 0);
        } else if (typeof contestantsVal === "object") {
          v = Number(contestantsVal[c.no]?.votes || contestantsVal[String(c.no)]?.votes || 0);
        }
      }
      totalVotesSum += v;
      stateObj.contestants[c.no] = {
        no: c.no,
        name: c.name,
        displayName: c.displayName,
        imageUrl: c.imageUrl,
        votes: v
      };
    }

    // 2. Restore total votes & unique voters
    stateObj.totalAcceptedVotes = Math.max(Number(streamVal.totalAcceptedVotes || 0), totalVotesSum);

    const voterKeys = Object.keys(votersVal);
    if (knownVoterIds && typeof knownVoterIds.add === "function") {
      for (const id of voterKeys) {
        knownVoterIds.add(id);
      }
      stateObj.uniqueVoters = Math.max(Number(streamVal.uniqueVoters || 0), knownVoterIds.size);
    } else {
      stateObj.uniqueVoters = Math.max(Number(streamVal.uniqueVoters || 0), voterKeys.length);
    }

    // 3. UI and stream status
    stateObj.totalChatMessages = Number(streamVal.totalChatMessages || 0);
    if (streamVal.theme === "light" || streamVal.theme === "dark") {
      stateObj.theme = streamVal.theme;
    }
    if (typeof streamVal.votingOpen === "boolean") {
      stateObj.votingOpen = streamVal.votingOpen;
    }
    if (streamVal.liveLikes) stateObj.liveLikes = Number(streamVal.liveLikes);
    if (streamVal.liveViews) stateObj.liveViews = Number(streamVal.liveViews);

    // 4. Restore recent votes
    if (votesVal && typeof votesVal === "object") {
      const voteEntries = Object.values(votesVal);
      if (voteEntries.length > 0) {
        stateObj.recentVotes = voteEntries.map(v => ({
          contestant: Number(v.contestant),
          name: String(v.name || "Viewer"),
          at: Number(v.timestamp || Date.now()),
          userId: String(v.userId || "viewer"),
          count: Number(v.count || 1),
          totalVotes: stateObj.contestants[v.contestant]?.votes || 0
        }));
        const last = stateObj.recentVotes[stateObj.recentVotes.length - 1];
        if (last) {
          stateObj.lastVote = last;
          stateObj.lastVoteAt = last.at;
        }
      }
    }

    // 5. Restore recent chats
    if (chatsVal && typeof chatsVal === "object") {
      const chatEntries = Object.values(chatsVal);
      if (chatEntries.length > 0) {
        stateObj.recentChat = chatEntries.map(c => ({
          name: String(c.name || "Viewer"),
          text: String(c.text || ""),
          at: Number(c.timestamp || Date.now())
        }));
      }
    }

    console.log(`[firebase] 🚀 State restored from Firebase cloud: votes=${stateObj.totalAcceptedVotes} uniqueVoters=${stateObj.uniqueVoters} theme=${stateObj.theme}`);
    return true;
  } catch (err) {
    console.error(`[firebase] ❌ Error loading state from Firebase: ${err.message}`);
    return false;
  }
}

// Two-way cloud synchronization listener (console edits -> live stream)
export function listenForCloudUpdates(stateObj, emitFn) {
  if (!rtdb && !initFirebase()) return;

  // Real-time theme listener
  rtdb.ref("stream/theme").on("value", (snap) => {
    if (!snap.exists()) return;
    const t = snap.val();
    if ((t === "light" || t === "dark") && stateObj.theme !== t) {
      console.log(`[firebase] 🎨 Cloud theme sync received: ${t}`);
      stateObj.theme = t;
      if (typeof emitFn === "function") emitFn("theme", { theme: t });
    }
  });

  // Real-time votingOpen listener
  rtdb.ref("stream/votingOpen").on("value", (snap) => {
    if (!snap.exists()) return;
    const open = Boolean(snap.val());
    if (stateObj.votingOpen !== open) {
      console.log(`[firebase] 🗳️ Cloud votingOpen sync received: ${open ? "OPEN" : "CLOSED"}`);
      stateObj.votingOpen = open;
      if (typeof emitFn === "function") emitFn(open ? "voting-open" : "voting-closed", {});
    }
  });

  // Real-time contestant votes listener (e.g. manual adjustments from Firebase console)
  rtdb.ref("contestants").on("child_changed", (snap) => {
    const val = snap.val();
    if (!val || val.no === undefined || val.votes === undefined) return;
    const no = Number(val.no);
    const votes = Number(val.votes);
    if (lastSelfPushedVotes.get(no) === votes) {
      lastSelfPushedVotes.delete(no);
      return;
    }
    if (stateObj.contestants[no] && stateObj.contestants[no].votes !== votes) {
      const diff = votes - stateObj.contestants[no].votes;
      stateObj.contestants[no].votes = votes;
      stateObj.totalAcceptedVotes = Math.max(0, stateObj.totalAcceptedVotes + diff);
      console.log(`[firebase] 🗳️ Cloud contestant update: #${no} (${val.name}) votes updated to ${votes} (diff: ${diff >= 0 ? "+" : ""}${diff})`);
    }
  });
}

export function setFirebaseTheme(theme) {
  if (!rtdb && !initFirebase()) return;
  rtdb.ref("stream/theme").set(theme).catch(() => {});
}

export function setFirebaseVotingOpen(open) {
  if (!rtdb && !initFirebase()) return;
  rtdb.ref("stream/votingOpen").set(Boolean(open)).catch(() => {});
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

