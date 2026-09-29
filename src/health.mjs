import { config } from "./config.mjs";
import { state, snapshot, acceptVote, saveState, setTheme } from "./state.mjs";
import { analytics } from "./analytics.mjs";
import { runtime } from "./runtime.mjs";
import { interactiveState, screenLabel, setScreen, setScreenAuto, viewerEvent } from "./interactive.mjs";
import { setMusicTrack, nextMusicTrack, prevMusicTrack, setTrackLoopMode, getTrackLoopMode, getMusicTrackInfo, setBgMusicVolume, getBgMusicVolume, MUSIC_TRACKS } from "./frame-server.mjs";

export function startHealthServer(){
  const server=Bun.serve({
    hostname:"127.0.0.1",
    port:config.healthPort,
    fetch(req){
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/vote") {
        const c = parseInt(url.searchParams.get("contestant") || url.searchParams.get("no") || "", 10);
        const name = url.searchParams.get("name") || "Test Voter";
        if (Number.isInteger(c) && c >= 1 && c <= config.contestants.length) {
          const ok = acceptVote("http:" + Math.random().toString(36).slice(2), c, name);
          if (ok) void saveState();
          return Response.json({ ok, contestant: c, name, totalVotes: state.totalAcceptedVotes });
        }
        return Response.json({ ok: false, error: "Invalid contestant number (1-" + config.contestants.length + ")" }, { status: 400 });
      }
      if (path === "/viewers") {
        const count = url.searchParams.get("count") || url.searchParams.get("c");
        const views = url.searchParams.get("views") || url.searchParams.get("v");
        if (count !== null) {
          const parsed = parseInt(count, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            runtime.chat.viewerCount = parsed;
          }
        }
        if (views !== null) {
          const parsed = parseInt(views, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            runtime.chat.viewCount = parsed;
            state.totalViews = Math.max(state.totalViews || 0, parsed);
          }
        }
        return Response.json({
          ok: true,
          viewerCount: runtime.chat.viewerCount,
          viewCount: runtime.chat.viewCount || state.totalViews || 0
        });
      }
      if (path === "/subscribers" || path === "/subs") {
        const count = url.searchParams.get("count") || url.searchParams.get("c");
        if (count !== null) {
          const parsed = parseInt(count, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            runtime.chat.subscriberCount = parsed;
            state.subscriberCount = parsed;
          }
        }
        return Response.json({
          ok: true,
          subscriberCount: runtime.chat.subscriberCount || state.subscriberCount || 0
        });
      }
      if (path === "/screen") {
        const s = url.searchParams.get("name") || url.searchParams.get("s") || "main";
        const auto = url.searchParams.get("auto");
        if (auto !== null) setScreenAuto(auto === "1" || auto === "true");
        const ok = setScreen(s, { manual: true });
        return Response.json({ ok, screen: interactiveState().screen, label: screenLabel(interactiveState().screen) });
      }
      if (path === "/theme") {
        const t = url.searchParams.get("name") || url.searchParams.get("t") || "dark";
        setTheme(t);
        void saveState();
        return Response.json({ ok: true, theme: state.theme });
      }
      if (path === "/track") {
        const t = url.searchParams.get("t") || url.searchParams.get("id");
        const loop = url.searchParams.get("loop");
        const action = url.searchParams.get("action");
        if (loop !== null) setTrackLoopMode(loop === "1" || loop === "true" || loop === "loop" ? "loop" : "single");
        if (action === "next") nextMusicTrack();
        else if (action === "prev") prevMusicTrack();
        else if (t !== null) setMusicTrack(parseInt(t, 10));
        return Response.json({ ok: true, track: getMusicTrackInfo(), tracks: MUSIC_TRACKS.map(m => ({ id: m.id, name: m.name, genre: m.genre })) });
      }
      if (path === "/volume" || path === "/vol") {
        const v = url.searchParams.get("v") || url.searchParams.get("level");
        if (v !== null) setBgMusicVolume(parseFloat(v) > 1 ? parseFloat(v) / 100 : parseFloat(v));
        return Response.json({ ok: true, volume: Math.round(getBgMusicVolume() * 100) });
      }
      if (path === "/event") {
        const type = url.searchParams.get("type") || "drop";
        const name = url.searchParams.get("name") || "Viewer";
        const emoji = url.searchParams.get("emoji") || "🎈";
        const contestant = parseInt(url.searchParams.get("contestant") || "0", 10);
        let payload = {};
        if (type === "wheel") {
          const options = ["🌟 2X VOTE", "💎 500 PTS", "👑 VIP FAN", "⚡ BOOST", "🔥 HYPE", "🎁 MYSTERY", "🎯 CROWN", "🏆 JACKPOT"];
          const winIdx = Math.floor(Math.random() * options.length);
          payload = { winner: options[winIdx], winIdx, finalAngle: 4 * Math.PI * 2 + (winIdx * (Math.PI * 2 / options.length)) + (Math.PI / options.length), options };
        }
        const ok = viewerEvent({ userId: "api-" + Math.random().toString(36).slice(2), name, type, contestant, emoji, payload, durationMs: type === "wheel" ? 5500 : 4200 });
        return Response.json({ ok, type, name, emoji, payload });
      }
      if(!["/","/health","/status","/stats"].includes(path)) return new Response("Not Found",{status:404});
      const rss=Math.round(process.memoryUsage().rss/1024/1024);
      return Response.json({
        ok:!runtime.stopping&&rss<config.memoryExitMB,
        uptimeSeconds:Math.floor(process.uptime()),
        memoryMB:rss,
        pid:process.pid,
        config:{
          width:config.width,
          height:config.height,
          streamResolution:config.streamResolution,
          renderWidth:config.renderWidth,
          renderHeight:config.renderHeight,
          renderResolution:config.renderResolution,
          fps:config.fps,
          votePolicy:config.votePolicy
        },
        screen:{current:interactiveState().screen,label:screenLabel(interactiveState().screen),auto:interactiveState().screenAuto,transition:interactiveState().screenTransition},
        music: getMusicTrackInfo(),
        volume: Math.round(getBgMusicVolume() * 100),
        state:path==="/stats"?analytics():snapshot(),
        runtime
      });
    }
  });
  console.log(`[health] http://127.0.0.1:${config.healthPort}`);
  return server;
}
