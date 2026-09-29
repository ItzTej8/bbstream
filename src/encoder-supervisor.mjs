import { config } from "./config.mjs";
import { runtime } from "./runtime.mjs";
import { createEncoder, stopEncoder } from "./ffmpeg.mjs";
import { on } from "./events.mjs";

let child = null;
let running = false;
let timer = null;
let wakeTimer = null;
let restartAt = 0;
let retryMs = config.encoderRestartMinMs;
let restarting = false;
let reasonPending = null;

function schedule(reason = "supervisor") {
  if (!running || restarting) return;
  runtime.encoder.restartReason = reason;
  reasonPending = reason;
  const now = Date.now();
  restartAt = Math.max(restartAt || now, now + retryMs);
  retryMs = Math.min(Math.max(config.encoderRestartMinMs, retryMs * 2), config.encoderRestartMaxMs);
}

async function restart(reason) {
  if (!running || restarting) return;
  restarting = true;
  runtime.encoder.restartReason = reason;
  runtime.encoder.restarts++;
  try { if (child) await stopEncoder(child); } catch {}
  child = null;
  const now = Date.now();
  restartAt = now + config.encoderRestartMinMs;
  retryMs = config.encoderRestartMinMs;
  reasonPending = null;
  restarting = false;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(tick, config.encoderRestartMinMs);
}

function handleClosed({ code, signal, stopping }) {
  if (!running || runtime.stopping || stopping) return;
  const now = Date.now();
  if (runtime.encoder.outputStartedAt && (now - runtime.encoder.outputStartedAt > 60000)) {
    retryMs = config.encoderRestartMinMs;
  }
  console.log(`[supervisor] encoder exited (code=${code ?? "null"}, signal=${signal ?? "none"}); triggering quick recovery`);
  schedule(`encoder-exit:code=${code}:signal=${signal}`);
  const delay = Math.max(500, restartAt - now);
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(tick, delay);
}

function tick() {
  if (!running || runtime.stopping || restarting) return;
  const now = Date.now();

  if (!child || child._bb?.closed) {
    if (now >= restartAt) {
      try {
        child = createEncoder();
        restartAt = 0;
      } catch (e) {
        runtime.encoder.lastError = e.message;
        schedule(`spawn-error:${e.message}`);
        const delay = Math.max(1000, restartAt - now);
        if (wakeTimer) clearTimeout(wakeTimer);
        wakeTimer = setTimeout(tick, delay);
      }
    } else {
      const delay = Math.max(500, restartAt - now);
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = setTimeout(tick, delay);
    }
    return;
  }

  const age = now - runtime.encoder.lastProgressAt;
  const videoAge = runtime.encoder.lastVideoProgressAt ? now - runtime.encoder.lastVideoProgressAt : 0;
  const sinceStart = now - runtime.encoder.startedAt;

  // Reset retry backoff on sustained healthy stream
  if (runtime.encoder.outputStartedAt && age < 15000 && videoAge < 15000 && retryMs > config.encoderRestartMinMs) {
    retryMs = config.encoderRestartMinMs;
  }

  // Do NOT kill FFmpeg merely because YouTube has not produced the first muxed timestamp yet.
  if (!runtime.encoder.outputStartedAt && sinceStart > config.encoderConnectGraceMs) {
    if (runtime.encoder.inputClients > 0) {
      runtime.encoder.lastError = `encoder waiting for output for ${Math.round(sinceStart / 1000)}s`;
      console.warn(`[supervisor] encoder still waiting for YouTube output after ${Math.round(sinceStart / 1000)}s; keeping process alive`);
    }
    if (sinceStart > config.encoderHardConnectTimeoutMs) {
      void restart(`encoder-connect-timeout:${Math.round(sinceStart / 1000)}s`);
    }
    return;
  }

  // If FFmpeg has been running for > 15s and has 0 input clients, video input was lost
  if (sinceStart > 15000 && runtime.encoder.inputClients === 0) {
    void restart("encoder-lost-mjpeg-input");
    return;
  }

  if (runtime.encoder.outputStartedAt) {
    if (age > config.encoderStaleMs) {
      void restart(`encoder-output-stalled:${Math.round(age / 1000)}s`);
      return;
    }
    if (videoAge > config.encoderStaleMs) {
      void restart(`encoder-video-stalled:${Math.round(videoAge / 1000)}s`);
      return;
    }
  }
}

export function startEncoderSupervisor() {
  running = true;
  restartAt = 0;
  timer = setInterval(tick, config.encoderHeartbeatMs);
  const offRestart = on("encoder-restart", ({ reason }) => void restart(reason || "watchdog"));
  const offClosed = on("encoder-closed", handleClosed);
  tick();
  return async () => {
    running = false;
    offRestart?.();
    offClosed?.();
    if (timer) clearInterval(timer);
    timer = null;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
    if (child) { try { await stopEncoder(child); } catch {} child = null; }
  };
}
