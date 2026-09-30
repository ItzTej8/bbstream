import { Database } from "bun:sqlite";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "./config.mjs";
import { emit } from "./events.mjs";
import { milestone } from "./interactive.mjs";
import { syncFullStateFirebase } from "./firebase.mjs";
const now=()=>Date.now();
const names=()=>Object.fromEntries(config.contestants.map(c=>[c.no,{no:c.no,name:c.name,displayName:c.displayName,imageUrl:c.imageUrl,votes:0}]));
export const state={version:7,contestants:names(),votingOpen:true,totalAcceptedVotes:0,totalChatMessages:0,uniqueVoters:0,recentChat:[],recentVotes:[],lastVote:null,lastVoteAt:0,chatVoteFlashAt:0,chatVoteFlashContestant:0,liveLikes:0,liveViews:0,lastWatchingCount:0,highlightDoubleTapUntil:0,lastLikeMagicAt:0,lastLikeMagicCount:0,updatedAt:now(),theme:"dark",timeLeftText:config.timeLeftText,nowPlayingText:config.nowPlayingText};
let db=null, saveChain=Promise.resolve();
function safeDb(){if(db)return db;const p=resolve(config.dbFile);db=new Database(p);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS contestants(no INTEGER PRIMARY KEY,name TEXT NOT NULL,votes INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS voters(user_id TEXT PRIMARY KEY,name TEXT,contestant_no INTEGER NOT NULL,first_vote_at INTEGER NOT NULL,last_vote_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS votes(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,name TEXT,contestant_no INTEGER NOT NULL,created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_votes_created_at ON votes(created_at);`);const ins=db.prepare("INSERT OR IGNORE INTO contestants(no,name,votes) VALUES(?,?,0)");for(const c of config.contestants)ins.run(c.no,c.name);return db;}
export async function loadState(){
  await mkdir(dirname(resolve(config.dbFile)),{recursive:true});
  const d=safeDb();
  const oldRows=d.query("SELECT no,name,votes FROM contestants ORDER BY no").all();
  const normalize=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const alias=new Map(config.contestants.flatMap(c=>{const a=[c.name,c.displayName];if(c.no===1)a.push("ScoutOP (Tanmay Singh)","Tanmay Singh (Scoutop)");if(c.no===2)a.push("Mary Kom","MC Mary Kom");if(c.no===11)a.push("Kushal Tanwar (Gullu)");if(c.no===12)a.push("Love Gill","Lovepreet Kaur Gill");if(c.no===16)a.push("Qazi Touqeer");return a.map(x=>[normalize(x),c.no]);}));
  const oldToNew=new Map();
  for(const row of oldRows){const mapped=alias.get(normalize(row.name));if(mapped)oldToNew.set(Number(row.no),mapped);}
  const unmappedOld=[...oldRows.map(r=>Number(r.no)).filter(no=>!oldToNew.has(no))];
  if(unmappedOld.length)d.exec(`DELETE FROM votes WHERE contestant_no IN (${unmappedOld.join(",")})`);
  if(oldToNew.size){const cases=[...oldToNew.entries()].map(([oldNo,newNo])=>`WHEN ${oldNo} THEN ${newNo}`).join(" ");d.exec(`UPDATE votes SET contestant_no=CASE contestant_no ${cases} ELSE contestant_no END WHERE contestant_no IN (${[...oldToNew.keys()].join(",")})`);}
  const reset=d.prepare("UPDATE contestants SET name=?,votes=0 WHERE no=?");for(const c of config.contestants)reset.run(c.name,c.no);
  const add=d.prepare("INSERT OR IGNORE INTO contestants(no,name,votes) VALUES(?,?,0)");for(const c of config.contestants)add.run(c.no,c.name);
  const totals=d.query("SELECT contestant_no no, COUNT(*) votes FROM votes GROUP BY contestant_no").all();const totalMap=new Map(totals.map(r=>[Number(r.no),Number(r.votes)||0]));const setVotes=d.prepare("UPDATE contestants SET votes=? WHERE no=?");for(const c of config.contestants)setVotes.run(totalMap.get(c.no)||0,c.no);
  for(const c of config.contestants){state.contestants[c.no]={no:c.no,name:c.name,displayName:c.displayName,imageUrl:c.imageUrl,votes:totalMap.get(c.no)||0};}
  state.totalAcceptedVotes=Number(d.query("SELECT COUNT(*) n FROM votes").get().n)||0;
  state.uniqueVoters=Number(d.query("SELECT COUNT(*) n FROM voters").get().n)||0;
  state.totalChatMessages=Number(d.query("SELECT value FROM meta WHERE key='chatMessages'").get()?.value||0);
  const last=d.query("SELECT user_id userId,name,contestant_no contestant,created_at at FROM votes ORDER BY id DESC LIMIT 1").get();state.lastVote=last||null;state.lastVoteAt=last?.at||0;
  const savedTheme=d.query("SELECT value FROM meta WHERE key='theme'").get()?.value; if(savedTheme==="light"||savedTheme==="dark") state.theme=savedTheme; console.log(`[state] database restored votes=${state.totalAcceptedVotes} uniqueVoters=${state.uniqueVoters} theme=${state.theme}`);
}
let saveTimeout=null;
export function saveState(){if(saveTimeout)return saveChain;saveTimeout=setTimeout(()=>{saveTimeout=null;saveChain=saveChain.then(async()=>{state.updatedAt=now();const p=resolve(config.stateFile);await mkdir(dirname(p),{recursive:true});const t=`${p}.tmp-${process.pid}`;await writeFile(t,JSON.stringify(state,null,2));await rename(t,p);syncFullStateFirebase(state).catch(()=>{});}).catch(e=>console.error(`[state] snapshot save: ${e.message}`));},2000);return saveChain;}
export function setOwner(){}
export function addChat(name,text){state.totalChatMessages++;state.recentChat.push({name:String(name||"Viewer").slice(0,80),text:String(text||"").slice(0,300),at:now()});if(state.recentChat.length>30)state.recentChat.splice(0,state.recentChat.length-30);safeDb().query("INSERT INTO meta(key,value) VALUES('chatMessages',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(state.totalChatMessages));emit("chat",{name,text});}
let lastCountAt = 0;
export function acceptVote(userId,contestant,name){const k=String(contestant),d=safeDb();if(!state.votingOpen||!state.contestants[k]||!userId)return false;const id=String(userId),n=String(name||"Viewer").slice(0,80),at=now();const tx=d.transaction(()=>{d.query("INSERT INTO voters(user_id,name,contestant_no,first_vote_at,last_vote_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET last_vote_at=excluded.last_vote_at,contestant_no=excluded.contestant_no,name=excluded.name").run(id,n,Number(contestant),at,at);d.query("INSERT INTO votes(user_id,name,contestant_no,created_at) VALUES(?,?,?,?)").run(id,n,Number(contestant),at);d.query("UPDATE contestants SET votes=votes+1 WHERE no=?").run(Number(contestant));});tx();state.contestants[k].votes++;state.totalAcceptedVotes++;milestone(state.totalAcceptedVotes);if(at-lastCountAt>5000||!state.uniqueVoters){lastCountAt=at;state.uniqueVoters=Number(d.query("SELECT COUNT(*) n FROM voters").get().n)||0;}state.lastVote={contestant:Number(contestant),name:n,at,userId:id,count:1};state.lastVoteAt=at;state.chatVoteFlashAt=at;state.chatVoteFlashContestant=Number(contestant);state.recentVotes.push(state.lastVote);if(state.recentVotes.length>20)state.recentVotes.shift();emit("vote",state.lastVote);return true;}
export function addManualVotes(contestant,count,name="Channel Owner",userId="owner"){const k=String(contestant),d=safeDb();if(!state.contestants[k])return null;const numVotes=Math.max(1,parseInt(count,10)||1);const id=String(userId||"owner"),n=String(name||"Channel Owner").slice(0,80),at=now();const tx=d.transaction(()=>{d.query("INSERT INTO voters(user_id,name,contestant_no,first_vote_at,last_vote_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET last_vote_at=excluded.last_vote_at,contestant_no=excluded.contestant_no,name=excluded.name").run(id,n,Number(contestant),at,at);d.query("UPDATE contestants SET votes=votes+? WHERE no=?").run(numVotes,Number(contestant));d.query("INSERT INTO votes(user_id,name,contestant_no,created_at) VALUES(?,?,?,?)").run(id,`${n} (+${numVotes})`,Number(contestant),at);});tx();state.contestants[k].votes+=numVotes;state.totalAcceptedVotes+=numVotes;milestone(state.totalAcceptedVotes);if(at-lastCountAt>5000||!state.uniqueVoters){lastCountAt=at;state.uniqueVoters=Number(d.query("SELECT COUNT(*) n FROM voters").get().n)||0;}state.lastVote={contestant:Number(contestant),name:n,at,userId:id,count:numVotes};state.lastVoteAt=at;state.chatVoteFlashAt=at;state.chatVoteFlashContestant=Number(contestant);state.recentVotes.push(state.lastVote);if(state.recentVotes.length>20)state.recentVotes.shift();emit("vote",state.lastVote);return{ok:true,contestant:Number(contestant),added:numVotes,total:state.contestants[k].votes};}
export function setVoting(open){state.votingOpen=Boolean(open);emit(open?"voting-open":"voting-closed",{});}
export function setTheme(theme){const t=String(theme||"").toLowerCase();if(t!=="dark"&&t!=="light")return false;state.theme=t;safeDb().query("INSERT INTO meta(key,value) VALUES('theme',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(t);emit("theme",{theme:t});return true;}
export function stats(){return Object.values(state.contestants).sort((a,b)=>(b.votes-a.votes)||a.no-b.no);}
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
