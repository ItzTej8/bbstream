import { config, validateConfig } from "./config.mjs";
import { loadImage } from "@napi-rs/canvas";
import { state, loadState, saveState } from "./state.mjs";
import { startChatLoop } from "./chat.mjs";
import { startSubscriberLoop } from "./subscribers.mjs";
import { startLikesMonitor } from "./likes-monitor.mjs";
import { initRenderer, startRenderer, stopRenderer, setContestantImages } from "./renderer.mjs";
import { loadContestantImages } from "./image-cache.mjs";
import { startHealthServer } from "./health.mjs";
import { startWatchdog } from "./watchdog.mjs";
import { startEncoderSupervisor } from "./encoder-supervisor.mjs";
import { runtime } from "./runtime.mjs";
import { acquireInstanceLock, releaseInstanceLock } from "./instance-lock.mjs";
import { startEvictionMonitor, stopEvictionMonitor } from "./eviction-monitor.mjs";
import { resolveActiveVideoId, startDynamicVideoIdPoller, getActiveVideoId, waitForLiveStreamByTitle } from "./youtube-resolver.mjs";
import { startFirebaseSync, stopFirebaseSync, syncFullStateFirebase } from "./firebase.mjs";
const controller=new AbortController();let shutdownPromise=null;
async function main(){
  await acquireInstanceLock();
  const v=validateConfig();
  if(v.errors.length){v.errors.forEach(e=>console.error(`[config] ${e}`));await releaseInstanceLock();process.exitCode=1;return;}
  v.warnings.forEach(w=>console.warn(`[config] ${w}`));
  await loadState();
  startFirebaseSync(() => state);
  syncFullStateFirebase(state).catch(e => console.warn(`[firebase] initial sync: ${e.message}`));
  const images=await loadContestantImages();
  const imageMap=new Map();
  for(const [no,file] of images){try{imageMap.set(no,await loadImage(await Bun.file(file).arrayBuffer()));}catch(e){console.warn(`[images] decode ${no}: ${e.message}`);}}
  setContestantImages(imageMap);
  startEvictionMonitor(config.contestants);
  const health=startHealthServer();

  console.log("==========================================");
  console.log(" Bigg Boss VPS Canvas Live — MULTI-SCREEN 10.1");
  console.log(` output ${config.width}x${config.height}@${config.fps}`);
  console.log(` render ${config.renderWidth}x${config.renderHeight}`);
  console.log(` resolution: STREAM_RESOLUTION=${config.streamResolution} | RENDER_RESOLUTION=${config.renderResolution}`);
  console.log(` target live title: "${config.youtubeLiveTitle || "unconfigured"}"`);
  console.log(` initial video id: ${getActiveVideoId() || "resolving dynamically once live"}`);
  console.log(" voting: UNLIMITED PER USER — every valid command counts");
  console.log("==========================================");

  await initRenderer();
  const encoderStop=startEncoderSupervisor();
  const watchdogStop=startWatchdog({signal:controller.signal,onMemoryPressure:()=>void shutdown("memory-pressure")});

  // Launch subscriber loop and live likes/views monitor immediately on startup
  startSubscriberLoop({signal:controller.signal});
  startLikesMonitor({signal:controller.signal});

  // Dynamically resolve live stream video ID (up to max 5 search attempts, with .env fallback)
  (async () => {
    try {
      const liveId = await waitForLiveStreamByTitle({ signal: controller.signal });
      if (controller.signal.aborted) return;
      console.log(`[main] 🎯 Live stream confirmed (${liveId || getActiveVideoId()}). Launching Masterchat and video ID poller...`);
    } catch (err) {
      console.warn(`[main] Live stream resolution warning: ${err.message}. Proceeding to Masterchat...`);
    }
    if (controller.signal.aborted) return;
    startChatLoop({signal:controller.signal}).catch(e=>{if(!controller.signal.aborted)console.error(`[chat] fatal ${e.message}`);});
    startDynamicVideoIdPoller({signal:controller.signal});
  })();

  try{await startRenderer();}finally{stopEvictionMonitor();watchdogStop();await encoderStop();controller.abort();await stopRenderer();await stopFirebaseSync();await saveState();health.stop();await releaseInstanceLock();}
}
async function shutdown(signal){if(shutdownPromise)return shutdownPromise;shutdownPromise=(async()=>{runtime.stopping=true;console.log(`[main] ${signal}`);controller.abort();await stopRenderer();await stopFirebaseSync();await saveState();await releaseInstanceLock();process.exit(signal==="memory-pressure"?1:0);})();return shutdownPromise;}
process.on("SIGINT",()=>void shutdown("SIGINT"));process.on("SIGTERM",()=>void shutdown("SIGTERM"));
process.on("uncaughtException",e=>{
  const code=e?.code;
  const recoverable=["EPIPE","ECONNRESET","ETIMEDOUT","ECONNABORTED","ENOTFOUND","EAI_AGAIN","UND_ERR_SOCKET"];
  if(recoverable.includes(code)){
    console.warn(`[main] recovered transient network/socket error (${code}): ${e.message}`);
    return;
  }
  console.error(`[main] uncaught ${e.stack||e.message}`);
  void shutdown("uncaughtException");
});process.on("unhandledRejection",e=>console.error(`[main] rejection ${e?.stack||e}`));main().catch(e=>{console.error(`[main] fatal ${e.stack||e.message}`);void shutdown("fatal")});
