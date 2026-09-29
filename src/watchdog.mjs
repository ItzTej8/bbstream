import { config } from "./config.mjs";
import { runtime } from "./runtime.mjs";
import { emit } from "./events.mjs";

export function startWatchdog({ onMemoryPressure, signal }) {
  let lastActionAt = 0;
  const timer = setInterval(() => {
    if (signal.aborted || runtime.stopping) return;
    const now = Date.now();
    const rss = process.memoryUsage().rss / 1024 / 1024;
    const rendererAge = runtime.renderer.lastFrameAt ? now - runtime.renderer.lastFrameAt : 0;
    const encoderAge = runtime.encoder.lastProgressAt ? now - runtime.encoder.lastProgressAt : Infinity;
    const warnings = [];
    if (rss >= config.memoryWarnMB) {
      warnings.push(`memory=${Math.round(rss)}MB`);
      if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
        try { Bun.gc(true); } catch {}
      } else if (typeof global !== "undefined" && typeof global.gc === "function") {
        try { global.gc(); } catch {}
      }
    }
    if (rendererAge > config.encoderStaleMs) warnings.push("renderer-stale");
    const alive = Boolean(runtime.encoder.pid) && ["starting", "running"].includes(runtime.encoder.status);
    if (alive && !runtime.encoder.outputStartedAt && now - runtime.encoder.startedAt > config.encoderConnectGraceMs) warnings.push("encoder-never-connected");
    if (alive && runtime.encoder.outputStartedAt && encoderAge > config.encoderStaleMs) warnings.push(`encoder-output-stalled:${Math.round(encoderAge/1000)}s`);
    if (runtime.encoder.status === "error") warnings.push("encoder-error");
    if (!alive && runtime.encoder.status === "stopped" && !runtime.stopping) {
      const stoppedAge = runtime.encoder.lastExitCode !== undefined && runtime.encoder.lastProgressAt ? now - runtime.encoder.lastProgressAt : 0;
      if (stoppedAge > 5000) warnings.push("encoder-stopped");
    }
    runtime.health = { lastCheckAt: now, warnings };
    if (rss >= config.memoryExitMB) {
      if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
        try { Bun.gc(true); } catch {}
      }
      const postGCRss = process.memoryUsage().rss / 1024 / 1024;
      if (postGCRss >= config.memoryExitMB) {
        runtime.watchdog.lastAction = `memory-pressure:${Math.round(postGCRss)}MB`;
        onMemoryPressure?.();
        return;
      }
    }
    const actionable = warnings.filter(x=>!x.startsWith("memory=")&&x!=="renderer-stale");
    if (actionable.length && now-lastActionAt>=config.encoderRestartCooldownMs) {
      lastActionAt=now; runtime.watchdog.lastAction=actionable.join(",");
      console.error(`[watchdog] ${runtime.watchdog.lastAction}; requesting encoder supervisor recovery`);
      emit("encoder-restart", { reason: runtime.watchdog.lastAction });
    }
  }, config.watchdogIntervalMs);
  return ()=>clearInterval(timer);
}
