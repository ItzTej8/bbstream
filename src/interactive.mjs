import { emit } from './events.mjs';
import { runtime } from './runtime.mjs';
import { config } from './config.mjs';

const MAX_EVENTS = 120;
const MAX_PARTICLES = 450;
const USER_WINDOW_MS = 10000;
const USER_MAX_EVENTS = 30;
const GLOBAL_WINDOW_MS = 1000;
const GLOBAL_MAX_EVENTS = 120;
const SCREEN_NAMES = ['main', 'race', 'stats', 'supporters', 'menu', 'events'];
const SCREEN_LABELS = { main: 'LIVE VOTING', race: 'RANK RACE', stats: 'LIVE STATS', supporters: 'TOP SUPPORTERS', menu: 'STREAM MENU', events: 'LIVE EVENTS' };
const userBuckets = new Map();
const globalTimes = [];

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

const clean = v => convertSmileys(String(v ?? '').replace(/[\u200b\uFEFF]/g, '').trim()).slice(0, 80);
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));

function ensure(){
  if(!runtime.interactive) runtime.interactive={events:[],particles:[],announcement:null,combo:new Map(),musicEnabled:true,topViewers:new Map(),lastEventAt:0,screen:'main',screenAuto:false,screenIndex:0,screenTransition:null,screenOverrideUntil:0,screenOverride:'events',selectedContestant:0,menuUntil:0,poll:null,confessions:[],contestantBuffs:new Map(),quiz:null};
  const s=runtime.interactive;
  s.screen ??= 'main'; s.screenAuto ??= false; s.screenIndex ??= SCREEN_NAMES.indexOf(s.screen)||0;
  s.screenTransition ??= null; s.screenOverrideUntil ??= 0; s.screenOverride ??= 'events'; s.selectedContestant ??= 0; s.menuUntil ??= 0;
  s.poll ??= null; s.confessions ??= []; s.contestantBuffs ??= new Map(); s.quiz ??= null;
  return s;
}

export function interactiveState(){ return ensure(); }

function allow(userId, type='event') {
  const now=Date.now();
  const bucketKey=`${userId||'anon'}:${type}`;
  const u=userBuckets.get(bucketKey)||[];
  while(u.length && now-u[0]>USER_WINDOW_MS) u.shift();
  if(u.length>=USER_MAX_EVENTS) {
    console.warn(`[interactive] rate-limit reached for ${bucketKey} (${u.length}/${USER_MAX_EVENTS})`);
    return false;
  }
  u.push(now); userBuckets.set(bucketKey,u);
  while(globalTimes.length && now-globalTimes[0]>GLOBAL_WINDOW_MS) globalTimes.shift();
  if(globalTimes.length>=GLOBAL_MAX_EVENTS) {
    console.warn(`[interactive] global rate-limit reached (${globalTimes.length}/${GLOBAL_MAX_EVENTS})`);
    return false;
  }
  globalTimes.push(now);
  return true;
}

function addEvent(event){
  const s=ensure();
  const dur = Math.max(600, event.durationMs || 3200);
  const e={
    ...event,
    id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    createdAt:Date.now(),
    durationMs: dur
  };
  s.events.push(e); if(s.events.length>MAX_EVENTS) s.events.splice(0,s.events.length-MAX_EVENTS);
  s.lastEventAt=e.createdAt;
  if(['milestone','battle','overtake'].includes(e.type)) { s.screenOverride='events'; s.screenOverrideUntil=e.createdAt+Math.min(9000,e.durationMs+1500); }
  emit('interactive',e);
  return e;
}

export function viewerEvent({userId,name,type,contestant=0,emoji='',payload={},durationMs=0}){
  if(!allow(userId,type)) return false;
  const n=clean(name)||'Viewer';
  const s=ensure();
  const key=String(userId||n);
  s.topViewers.set(key,{id:key,name:n,interactions:(s.topViewers.get(key)?.interactions||0)+1,lastAt:Date.now()});
  if(Number(contestant)>0) s.selectedContestant=Number(contestant);
  addEvent({type,userId:key,name:n,contestant:Number(contestant)||0,emoji:emoji||'',payload,durationMs});
  return true;
}

export function voteEvent({userId,name,contestant,candidateName,count=1}){
  const n=clean(name)||'Viewer';
  const s=ensure();
  const key=String(userId||n);
  const old=s.combo.get(Number(contestant));
  const now=Date.now();
  const combo=old && now-old.at<6000 ? old.count+1 : 1;
  s.combo.set(Number(contestant),{count:combo,at:now,name:candidateName});
  s.topViewers.set(key,{id:key,name:n,interactions:(s.topViewers.get(key)?.interactions||0)+count,lastAt:now});
  s.selectedContestant=Number(contestant);
  addEvent({type:'vote',userId:key,name:n,contestant:Number(contestant),candidateName,count,durationMs:5500,combo});
  if(combo>=3) addEvent({type:'combo',contestant:Number(contestant),candidateName,count:combo,durationMs:3500});
  emit('vote-announcement',{name:n,candidateName,contestant:Number(contestant),count});
}

export function prune(now=Date.now()){
  const s=ensure();
  s.events=s.events.filter(e=>now-e.createdAt<e.durationMs);
  for(const [k,v] of s.combo) if(now-v.at>9000) s.combo.delete(k);
  if(s.announcement && now-s.announcement.at>s.announcement.durationMs) s.announcement=null;
  if(s.particles.length) s.particles=s.particles.filter(q=>(now-(q.born||now))<=q.max);
  if(s.particles.length>MAX_PARTICLES) s.particles.splice(0,s.particles.length-MAX_PARTICLES);
  for(const [k,v] of s.topViewers) if(now-v.lastAt>1000*60*60*24*7) s.topViewers.delete(k);
  if(userBuckets.size>5000){ for(const [k,v] of userBuckets) if(!v.length || now-v[v.length-1]>USER_WINDOW_MS*4) userBuckets.delete(k); }
}

export function getEvents(now=Date.now()){prune(now);return ensure().events;}
export function getTopViewers(){return [...ensure().topViewers.values()].sort((a,b)=>(b.interactions-a.interactions)||(b.lastAt-a.lastAt)).slice(0,5);}
export function setAnnouncement(text,name='Bigg Boss',durationMs=3800){ensure().announcement={text:convertSmileys(String(text)).slice(0,180),name:convertSmileys(String(name)).slice(0,60),at:Date.now(),durationMs};}
export function setMusicEnabled(v){ensure().musicEnabled=Boolean(v); emit('music',{enabled:Boolean(v)});}
export function isMusicEnabled(){return ensure().musicEnabled!==false;}

export function milestone(total){
  const milestones=[1000,5000,10000,25000,50000,100000,250000,500000,1000000];
  const m=milestones.find(x=>total===x);
  if(m) addEvent({type:'milestone',value:m,durationMs:5200});
}

export function subscriberMilestone(count){
  addEvent({
    type: 'subscriber',
    value: count,
    title: 'NEW SUBSCRIBER',
    text: `🎉 LIVE SUBSCRIBERS: ${Number(count).toLocaleString()}`,
    durationMs: 6000
  });
}

export function normalizeScreen(v){
  const x=String(v||'').toLowerCase().trim();
  if(['vote','voting','home','main','1'].includes(x)) return 'main';
  if(['race','rank','ranking','leaderboard','2'].includes(x)) return 'race';
  if(['stat','stats','statistics','analytics','3'].includes(x)) return 'stats';
  if(['support','supporters','top','mvp','4'].includes(x)) return 'supporters';
  if(['menu','guide','screens','help','5'].includes(x)) return 'menu';
  if(['event','events','interactive','6'].includes(x)) return 'events';
  return SCREEN_NAMES.includes(x)?x:null;
}

export function screenLabel(screen){return SCREEN_LABELS[normalizeScreen(screen)||'main'];}

export function setScreen(screen,{manual=true,overrideMs=0,contestant=0,userId=null}={}){
  const s=ensure();
  const next=normalizeScreen(screen);
  if(!next) return false;
  if(manual && userId && !allow(userId,'screen')) return false;
  const current=s.screen;
  if(current===next){
    if(contestant) s.selectedContestant=Number(contestant);
    if(manual) s.screenAuto=false;
    return true;
  }
  s.screenTransition={from:current,to:next,startedAt:Date.now(),durationMs:config.screenTransitionMs};
  s.screen=next;
  s.screenIndex=SCREEN_NAMES.indexOf(next);
  if(contestant) s.selectedContestant=Number(contestant);
  if(manual) s.screenAuto=false;
  if(overrideMs>0) s.screenOverrideUntil=Date.now()+overrideMs;
  emit('screen',{screen:next,manual});
  return true;
}

export function nextScreen(userId=null){
  const s=ensure();
  return setScreen(SCREEN_NAMES[(s.screenIndex+1)%SCREEN_NAMES.length],{manual:true,userId});
}
export function previousScreen(userId=null){
  const s=ensure();
  return setScreen(SCREEN_NAMES[(s.screenIndex-1+SCREEN_NAMES.length)%SCREEN_NAMES.length],{manual:true,userId});
}
export function setScreenAuto(enabled,userId=null){
  if(userId&&!allow(userId,'screen-auto')) return ensure().screenAuto!==false;
  const s=ensure(); s.screenAuto=Boolean(enabled); if(enabled) s.screenIndex=SCREEN_NAMES.indexOf(s.screen)||0;
  emit('screen-auto',{enabled:s.screenAuto}); return s.screenAuto;
}
export function isScreenAuto(){return ensure().screenAuto!==false;}
export function getScreenNames(){return [...SCREEN_NAMES];}

export function tickScreens(now=Date.now(),intervalMs=20000){
  const s=ensure();
  if(s.screenOverrideUntil && now>=s.screenOverrideUntil) s.screenOverrideUntil=0;
  if(!s.screenAuto || s.screenOverrideUntil>now) return s.screen;
  if(!s._nextAutoAt) s._nextAutoAt=now+Math.max(5000,intervalMs);
  if(now>=s._nextAutoAt){
    const next=SCREEN_NAMES[(s.screenIndex+1)%SCREEN_NAMES.length];
    setScreen(next,{manual:false});
    s._nextAutoAt=now+Math.max(5000,intervalMs);
  }
  return s.screen;
}

export function getScreenTransition(now=Date.now()){
  const s=ensure();
  const tr=s.screenTransition;
  if(!tr) return null;
  const startedAt = tr.startedAt ?? tr.start ?? now;
  const durationMs = tr.durationMs || 1000;
  const t = (typeof tr.t === "number" && !isNaN(tr.t)) ? clamp(tr.t, 0, 1) : clamp((now - startedAt) / durationMs, 0, 1);
  if(t>=1){s.screenTransition=null;return null;}
  return {...tr,t};
}

export function isMenuVisible(now=Date.now()){return ensure().menuUntil>now;}
export function setMenu(durationMs = 7000, userId = null) {
  if (userId && !allow(userId, 'menu')) return false;
  const s = ensure();
  s.menuUntil = Date.now() + durationMs;
  emit('menu', { open: true, durationMs });
  return true;
}
export function triggerSpotlight(contestantNo, author = "Bigg Boss", reason = "", durationMs = 10000) {
  const s = ensure();
  s.selectedContestant = Number(contestantNo);
  addEvent({ type: "spotlight", contestant: Number(contestantNo), author, reason, durationMs });
  return true;
}
export function getSelectedContestant(){ return ensure().selectedContestant || 0; }

// --- Interactive Live Poll ---
const DEFAULT_POLLS = [
  { question: "Who is the strongest housemate?", optA: "SALMAN", optB: "POOJA" },
  { question: "Will next eviction be a shocker?", optA: "YES! ⚡", optB: "NO ❌" },
  { question: "Who is playing the best mind game?", optA: "ABHISHEK", optB: "BEBIKA" },
  { question: "Will the secret alliance survive?", optA: "YES 🤝", optB: "BETRAYAL 🐍" },
  { question: "Is Bigg Boss 24/7 more fiery than ever?", optA: "100% 🔥", optB: "SUPER LIT ✨" }
];
let defaultPollIdx = 0;

export function startPoll(question, optA, optB, durationMs = config.pollDurationMs || 45000) {
  const s = ensure();
  const poll = {
    id: `poll-${Date.now()}`,
    question: clean(question) || "Live Bigg Boss Poll",
    optA: clean(optA).toUpperCase() || "OPTION A",
    optB: clean(optB).toUpperCase() || "OPTION B",
    votesA: 0,
    votesB: 0,
    voters: new Map(),
    startedAt: Date.now(),
    expiresAt: Date.now() + Math.max(15000, durationMs)
  };
  s.poll = poll;
  emit("interactive", { type: "poll", question: poll.question, optA: poll.optA, optB: poll.optB });
  return poll;
}

export function votePoll(userId, option) {
  const s = ensure();
  if (!s.poll || s.poll.expiresAt <= Date.now()) {
    getPoll();
  }
  const p = s.poll;
  if (!p) return null;
  const key = String(userId || "anon");
  const opt = String(option).toUpperCase().trim();
  const choice = (opt === "A" || opt === "1" || opt.includes(p.optA)) ? "A" : (opt === "B" || opt === "2" || opt.includes(p.optB)) ? "B" : null;
  if (!choice) return null;

  const prev = p.voters.get(key);
  if (prev === choice) return p;
  if (prev === "A") p.votesA = Math.max(0, p.votesA - 1);
  if (prev === "B") p.votesB = Math.max(0, p.votesB - 1);

  if (choice === "A") p.votesA++;
  else if (choice === "B") p.votesB++;
  p.voters.set(key, choice);

  emit("poll-voted", { userId: key, choice, votesA: p.votesA, votesB: p.votesB });
  return p;
}

export function getPoll(now = Date.now()) {
  const s = ensure();
  if (s.poll && s.poll.expiresAt > now) {
    const total = s.poll.votesA + s.poll.votesB;
    const pctA = total > 0 ? Math.round((s.poll.votesA / total) * 100) : 50;
    const pctB = total > 0 ? 100 - pctA : 50;
    return { ...s.poll, total, pctA, pctB, timeLeftMs: Math.max(0, s.poll.expiresAt - now) };
  }
  const def = DEFAULT_POLLS[defaultPollIdx % DEFAULT_POLLS.length];
  defaultPollIdx++;
  s.poll = {
    id: `def-poll-${Date.now()}`,
    question: def.question,
    optA: def.optA,
    optB: def.optB,
    votesA: Math.floor(Math.random() * 8) + 4,
    votesB: Math.floor(Math.random() * 8) + 3,
    voters: new Map(),
    startedAt: now,
    expiresAt: now + (config.pollDurationMs || 45000)
  };
  const total = s.poll.votesA + s.poll.votesB;
  const pctA = Math.round((s.poll.votesA / total) * 100);
  const pctB = 100 - pctA;
  return { ...s.poll, total, pctA, pctB, timeLeftMs: Math.max(0, s.poll.expiresAt - now) };
}

// --- Confession Box ---
export function addConfession({ author, message, contestant = 0 }) {
  const s = ensure();
  const c = {
    id: `confess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    author: clean(author) || "Anonymous Housemate",
    message: clean(message),
    contestant: Number(contestant) || 0,
    createdAt: Date.now(),
    durationMs: 7000
  };
  s.confessions.push(c);
  if (s.confessions.length > 20) s.confessions.shift();
  addEvent({ type: "confess", author: c.author, message: c.message, contestant: c.contestant, durationMs: 7000 });
  return c;
}

export function getActiveConfession(now = Date.now()) {
  const s = ensure();
  const c = s.confessions.find(x => now - x.createdAt < x.durationMs);
  return c || null;
}

// --- Contestant Status Buffs ---
export function setContestantBuff(contestantNo, buffType, durationMs = 15000) {
  const s = ensure();
  const no = Number(contestantNo);
  if (no < 1 || no > config.contestants.length) return false;
  s.contestantBuffs.set(no, {
    buff: buffType,
    until: Date.now() + durationMs,
    startedAt: Date.now()
  });
  addEvent({ type: buffType, contestant: no, durationMs });
  return true;
}

export function getContestantBuff(contestantNo, now = Date.now()) {
  const s = ensure();
  const b = s.contestantBuffs.get(Number(contestantNo));
  if (b && b.until > now) return b;
  if (b) s.contestantBuffs.delete(Number(contestantNo));
  return null;
}

// --- Trivia Quiz ---
const BB_TRIVIA_QUESTIONS = [
  { q: "Who was the winner of Bigg Boss Season 1?", opts: ["Rahul Roy", "Ravi Kishan", "Carol Gracias", "Rakhi Sawant"], ans: 0 },
  { q: "What is the Bigg Boss eye symbol inspired by?", opts: ["All-Seeing Eye", "Horus Eye", "Camera Lens", "Third Eye"], ans: 0 },
  { q: "Which host is legendary for Weekend Ka Vaar?", opts: ["Salman Khan", "Amitabh Bachchan", "Sanjay Dutt", "Arshad Warsi"], ans: 0 },
  { q: "What gives a contestant safety from nomination?", opts: ["Captaincy / Immunity", "Secret Task", "Jail Time", "Wildcard Entry"], ans: 0 },
  { q: "What is the punishment room inside the house?", opts: ["Kaal Kothri (Jail)", "Store Room", "Activity Area", "Medical Room"], ans: 0 }
];
let triviaIdx = 0;

export function startQuiz(question = null, opts = null, ans = 0, durationMs = 30000) {
  const s = ensure();
  const tItem = question ? { q: question, opts: opts || ["A", "B", "C", "D"], ans } : BB_TRIVIA_QUESTIONS[triviaIdx % BB_TRIVIA_QUESTIONS.length];
  triviaIdx++;

  let ansIdx = 0;
  if (typeof tItem.ans === "string") {
    const map = { A: 0, B: 1, C: 2, D: 3, "1": 0, "2": 1, "3": 2, "4": 3 };
    ansIdx = map[tItem.ans.toUpperCase().trim()] ?? 0;
  } else if (typeof tItem.ans === "number") {
    ansIdx = clamp(Math.floor(tItem.ans), 0, 3);
  }

  s.quiz = {
    id: `quiz-${Date.now()}`,
    question: tItem.q,
    options: tItem.opts,
    correctIndex: ansIdx,
    startedAt: Date.now(),
    expiresAt: Date.now() + durationMs,
    winner: null
  };
  addEvent({ type: "quiz", question: s.quiz.question, options: s.quiz.options, durationMs });
  return s.quiz;
}

export function answerQuiz(userId, author, letter) {
  const s = ensure();
  if (!s.quiz || s.quiz.expiresAt < Date.now() || s.quiz.winner) return null;
  const l = String(letter).toUpperCase().trim();
  const map = { A: 0, B: 1, C: 2, D: 3, "1": 0, "2": 1, "3": 2, "4": 3 };
  const idx = map[l];
  if (idx === undefined) return null;
  if (idx === s.quiz.correctIndex) {
    s.quiz.winner = { userId, author: clean(author) };
    addEvent({ type: "confetti", durationMs: 4000 });
    return { correct: true, winner: s.quiz.winner };
  }
  return { correct: false };
}

export function getActiveQuiz(now = Date.now()) {
  const s = ensure();
  if (s.quiz && s.quiz.expiresAt > now) return s.quiz;
  return null;
}

export function getInteractiveSnapshot() {
  const s = ensure();
  return {
    screen: s.screen,
    screenAuto: s.screenAuto,
    screenIndex: s.screenIndex,
    screenTransition: s.screenTransition,
    screenOverrideUntil: s.screenOverrideUntil,
    screenOverride: s.screenOverride,
    selectedContestant: s.selectedContestant,
    menuUntil: s.menuUntil,
    poll: s.poll,
    announcement: s.announcement,
    confessions: s.confessions,
    quiz: s.quiz,
    lastEventAt: s.lastEventAt,
    musicEnabled: s.musicEnabled,
    particles: s.particles ? s.particles.slice() : [],
    events: s.events ? s.events.slice() : []
  };
}

export function applyInteractiveSnapshot(snap) {
  if (!snap) return;
  const s = ensure();
  Object.assign(s, snap);
  if (snap.events) s.events = snap.events.slice();
  if (snap.particles) s.particles = snap.particles.slice();
}
