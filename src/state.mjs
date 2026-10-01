import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.mjs";
import { emit } from "./events.mjs";
import { milestone } from "./interactive.mjs";
import { syncFullStateFirebase, loadStateFromFirebase, listenForCloudUpdates, setFirebaseTheme, setFirebaseVotingOpen } from "./firebase.mjs";

const now = () => Date.now();
const names = () => Object.fromEntries(config.contestants.map(c => [c.no, { no: c.no, name: c.name, displayName: c.displayName, imageUrl: c.imageUrl, votes: 0 }]));

export const state = {
  version: 7,
  contestants: names(),
  votingOpen: true,
  totalAcceptedVotes: 0,
  totalChatMessages: 0,
  uniqueVoters: 0,
  recentChat: [],
  recentVotes: [],
  lastVote: null,
  lastVoteAt: 0,
  chatVoteFlashAt: 0,
  chatVoteFlashContestant: 0,
  liveLikes: 0,
  liveViews: 0,
  lastWatchingCount: 0,
  highlightDoubleTapUntil: 0,
  lastLikeMagicAt: 0,
  lastLikeMagicCount: 0,
  updatedAt: now(),
  theme: "dark",
  timeLeftText: config.timeLeftText,
  nowPlayingText: config.nowPlayingText
};

export const knownVoterIds = new Set();
let saveTimeout = null, saveChain = Promise.resolve();

export async function loadState() {
  // 1. Primary: Restore state from Firebase Realtime Database
  const restoredFromCloud = await loadStateFromFirebase(state, knownVoterIds);

  // 2. Two-way cloud sync: listen to remote theme, voting toggle, and contestant updates
  listenForCloudUpdates(state, emit);

  // 3. Fallback: If cloud unavailable, load from local state.json backup
  if (!restoredFromCloud) {
    const p = resolve(config.stateFile);
    if (existsSync(p)) {
      try {
        const raw = await readFile(p, "utf8");
        const snap = JSON.parse(raw);
        if (snap?.contestants) {
          for (const c of config.contestants) {
            state.contestants[c.no] = {
              no: c.no,
              name: c.name,
              displayName: c.displayName,
              imageUrl: c.imageUrl,
              votes: Number(snap.contestants[c.no]?.votes || snap.contestants[String(c.no)]?.votes || 0)
            };
          }
        }
        if (snap.totalAcceptedVotes) state.totalAcceptedVotes = Number(snap.totalAcceptedVotes);
        if (snap.uniqueVoters) state.uniqueVoters = Number(snap.uniqueVoters);
        if (snap.theme === "light" || snap.theme === "dark") state.theme = snap.theme;
        console.log(`[state] 💾 Restored from local state.json backup: votes=${state.totalAcceptedVotes}`);
      } catch (err) {
        console.warn(`[state] Local fallback parse warning: ${err.message}`);
      }
    }
  }

  console.log(`[state] Database initialized (Firebase Master): votes=${state.totalAcceptedVotes} uniqueVoters=${state.uniqueVoters} theme=${state.theme}`);
}

export function saveState() {
  if (saveTimeout) return saveChain;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveChain = saveChain.then(async () => {
      state.updatedAt = now();
      const p = resolve(config.stateFile);
      await mkdir(dirname(p), { recursive: true });
      const t = `${p}.tmp-${process.pid}`;
      await writeFile(t, JSON.stringify(state, null, 2));
      await rename(t, p);
      syncFullStateFirebase(state).catch(() => {});
    }).catch(e => console.error(`[state] snapshot save: ${e.message}`));
  }, 2000);
  return saveChain;
}

export function setOwner() {}

export function addChat(name, text) {
  state.totalChatMessages++;
  state.recentChat.push({
    name: String(name || "Viewer").slice(0, 80),
    text: String(text || "").slice(0, 300),
    at: now()
  });
  if (state.recentChat.length > 30) state.recentChat.splice(0, state.recentChat.length - 30);
  emit("chat", { name, text });
}

export function acceptVote(userId, contestant, name) {
  const k = String(contestant);
  if (!state.votingOpen || !state.contestants[k] || !userId) return false;

  const id = String(userId);
  const n = String(name || "Viewer").slice(0, 80);
  const at = now();

  // 0ms instant Skia state update
  state.contestants[k].votes++;
  state.totalAcceptedVotes++;
  milestone(state.totalAcceptedVotes);

  knownVoterIds.add(id);
  state.uniqueVoters = knownVoterIds.size;

  state.lastVote = {
    contestant: Number(contestant),
    name: n,
    at,
    userId: id,
    count: 1,
    totalVotes: state.contestants[k].votes
  };
  state.lastVoteAt = at;
  state.chatVoteFlashAt = at;
  state.chatVoteFlashContestant = Number(contestant);
  state.recentVotes.push(state.lastVote);
  if (state.recentVotes.length > 20) state.recentVotes.shift();

  // Emit event which queues async background sync to Firebase RTDB
  emit("vote", state.lastVote);
  return true;
}

export function addManualVotes(contestant, count, name = "Channel Owner", userId = "owner") {
  const k = String(contestant);
  if (!state.contestants[k]) return null;
  const numVotes = Math.max(1, parseInt(count, 10) || 1);
  const id = String(userId || "owner");
  const n = String(name || "Channel Owner").slice(0, 80);
  const at = now();

  state.contestants[k].votes += numVotes;
  state.totalAcceptedVotes += numVotes;
  milestone(state.totalAcceptedVotes);

  knownVoterIds.add(id);
  state.uniqueVoters = knownVoterIds.size;

  state.lastVote = {
    contestant: Number(contestant),
    name: n,
    at,
    userId: id,
    count: numVotes,
    totalVotes: state.contestants[k].votes
  };
  state.lastVoteAt = at;
  state.chatVoteFlashAt = at;
  state.chatVoteFlashContestant = Number(contestant);
  state.recentVotes.push(state.lastVote);
  if (state.recentVotes.length > 20) state.recentVotes.shift();

  emit("vote", state.lastVote);
  return { ok: true, contestant: Number(contestant), added: numVotes, total: state.contestants[k].votes };
}

export function setVoting(open, fromCloud = false) {
  state.votingOpen = Boolean(open);
  if (!fromCloud) {
    setFirebaseVotingOpen(state.votingOpen);
  }
  emit(open ? "voting-open" : "voting-closed", {});
}

export function setTheme(theme, fromCloud = false) {
  const t = String(theme || "").toLowerCase();
  if (t !== "dark" && t !== "light") return false;
  state.theme = t;
  if (!fromCloud) {
    setFirebaseTheme(t);
  }
  emit("theme", { theme: t });
  return true;
}

export function stats() {
  return Object.values(state.contestants).sort((a, b) => (b.votes - a.votes) || a.no - b.no);
}
export const activeRankTransitions = new Map();
export const previousRanks = new Map();

export function getCardLayoutForRank(r) {
  const colW = 490, cardH = 96, rowGap = 8, colGap = 20;
  if (r === 0) {
    return { x: 40, y: 368, w: 1000, h: 94 };
  }
  const isLeft = (r <= 8);
  const rowIndex = isLeft ? (r - 1) : (r - 9);
  return {
    x: isLeft ? 40 : (40 + colW + colGap),
    y: 472 + rowIndex * (cardH + rowGap),
    w: colW,
    h: cardH
  };
}

export function updateRankTransitions(n = now()) {
  const ranking = stats();
  if (previousRanks.size === 0) {
    ranking.forEach((c, r) => previousRanks.set(c.no, r));
    return;
  }
  ranking.forEach((c, r) => {
    const oldR = previousRanks.get(c.no);
    if (oldR !== undefined && oldR !== r) {
      const oldLayout = getCardLayoutForRank(oldR);
      const newLayout = getCardLayoutForRank(r);
      let fromX = oldLayout.x, fromY = oldLayout.y, fromW = oldLayout.w, fromH = oldLayout.h;
      const prevTrans = activeRankTransitions.get(c.no);
      if (prevTrans) {
        const p = Math.min(1, Math.max(0, (n - prevTrans.startMs) / prevTrans.durationMs));
        const ease = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        fromX = prevTrans.fromX + (prevTrans.toX - prevTrans.fromX) * ease;
        fromY = prevTrans.fromY + (prevTrans.toY - prevTrans.fromY) * ease;
        fromW = prevTrans.fromW + (prevTrans.toW - prevTrans.fromW) * ease;
        fromH = prevTrans.fromH + (prevTrans.toH - prevTrans.fromH) * ease;
      }
      // When an overtake happens, if vote alert is actively showing in mid, delay the start until alert completes!
      const isVoteAlertActive = state.lastVote && (n - state.lastVote.at < 4200);
      const startMs = isVoteAlertActive ? (state.lastVote.at + 4200) : n;

      activeRankTransitions.set(c.no, {
        no: c.no,
        oldRank: oldR,
        newRank: r,
        isOvertake: r < oldR,
        fromX,
        fromY,
        fromW,
        fromH,
        toX: newLayout.x,
        toY: newLayout.y,
        toW: newLayout.w,
        toH: newLayout.h,
        startMs,
        durationMs: 850
      });
      previousRanks.set(c.no, r);
    }
  });

  for (const [no, tr] of activeRankTransitions.entries()) {
    if (n - tr.startMs > tr.durationMs + 400) {
      activeRankTransitions.delete(no);
    }
  }
}

export function currentVotes(){return state.totalAcceptedVotes;}
export function snapshot(){return{votingOpen:state.votingOpen,totalVotes:state.totalAcceptedVotes,uniqueVoters:state.uniqueVoters,totalChatMessages:state.totalChatMessages,ranking:stats(),recentChat:state.recentChat.slice(-10),recentVotes:state.recentVotes.slice(-10),lastVote:state.lastVote,liveLikes:state.liveLikes,liveViews:state.liveViews};}
export function registerWatchingCount(count) {
  const c = Number(count) || 0;
  if (c <= 0) return;
  if (state.lastWatchingCount > 0 && c > state.lastWatchingCount) {
    const diff = c - state.lastWatchingCount;
    console.log(`[state] 👥 Viewers increased (${state.lastWatchingCount} -> ${c}, +${diff})! Highlighting Double Tap!`);
    state.highlightDoubleTapUntil = Date.now() + 8500;
  }
  state.lastWatchingCount = c;
}

export function getStateSnapshot(){
  updateRankTransitions(now());
  return {
    contestants:state.contestants,
    votingOpen:state.votingOpen,
    totalAcceptedVotes:state.totalAcceptedVotes,
    totalChatMessages:state.totalChatMessages,
    uniqueVoters:state.uniqueVoters,
    recentChat:state.recentChat,
    recentVotes:state.recentVotes,
    lastVote:state.lastVote,
    lastVoteAt:state.lastVoteAt,
    chatVoteFlashAt:state.chatVoteFlashAt,
    chatVoteFlashContestant:state.chatVoteFlashContestant,
    liveLikes:state.liveLikes,
    liveViews:state.liveViews,
    lastWatchingCount:state.lastWatchingCount,
    highlightDoubleTapUntil:state.highlightDoubleTapUntil,
    lastLikeMagicAt:state.lastLikeMagicAt,
    lastLikeMagicCount:state.lastLikeMagicCount,
    theme:state.theme,
    timeLeftText:state.timeLeftText,
    nowPlayingText:state.nowPlayingText,
    rankTransitions: Object.fromEntries(activeRankTransitions)
  };
}
export function applyStateSnapshot(snap){
  if(!snap)return;
  Object.assign(state,snap);
  if (snap.rankTransitions) state.rankTransitions = snap.rankTransitions;
}
