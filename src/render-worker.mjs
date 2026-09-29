import { parentPort, workerData } from "node:worker_threads";
import { initRenderer, drawMainFrame, canvas, setFloatingReactions } from "./renderer.mjs";
import { applyStateSnapshot } from "./state.mjs";
import { applyInteractiveSnapshot } from "./interactive.mjs";
import { emit } from "./events.mjs";

const { workerId, sab, sabs, W, H, isRaw, jpegQuality } = workerData;
const sharedSlots = sabs
  ? sabs.map(s => new Uint8Array(s))
  : (sab ? [new Uint8Array(sab)] : null);

// Initialize Skia canvas, load contestant assets & pre-warm avatar cache on this worker's core
await initRenderer();

// Warm Skia canvas, fonts, shaders & layout on this worker's core
try {
  drawMainFrame(Date.now());
  if (!isRaw) await canvas.encode("jpeg", jpegQuality || 75);
} catch (e) {
  console.error(`[worker-${workerId}] warm-up error:`, e);
}

parentPort.postMessage({ type: "ready", workerId });

parentPort.on("message", async (msg) => {
  if (!msg || !msg.cmd) return;

  if (msg.cmd === "render") {
    try {
      const t0 = performance.now();
      if (msg.state) applyStateSnapshot(msg.state);
      if (msg.interactive) applyInteractiveSnapshot(msg.interactive);
      if (msg.floatingReactions) setFloatingReactions(msg.floatingReactions);

      drawMainFrame(msg.now);
      const tDraw = performance.now();

      let jpegBuf = null;
      const slot = (typeof msg.slot === "number" && sharedSlots) ? (msg.slot % sharedSlots.length) : 0;
      if (isRaw) {
        const data = canvas.data();
        if (sharedSlots && sharedSlots[slot]) sharedSlots[slot].set(data);
      } else {
        jpegBuf = await canvas.encode("jpeg", jpegQuality || 75);
      }
      const tEncode = performance.now();

      parentPort.postMessage({
        type: "frame_done",
        workerId,
        frameIndex: msg.frameIndex,
        slot,
        renderMs: tEncode - t0,
        drawMs: tDraw - t0,
        encodeMs: tEncode - tDraw,
        jpegBuf
      });
    } catch (err) {
      console.error(`[worker-${workerId}] render error:`, err);
      parentPort.postMessage({
        type: "frame_done",
        workerId,
        frameIndex: msg.frameIndex,
        error: err.message,
        renderMs: 0
      });
    }
    return;
  }

  if (msg.cmd === "event") {
    try {
      emit(msg.event, msg.payload);
    } catch {}
    return;
  }

  if (msg.cmd === "sync_state") {
    if (msg.state) applyStateSnapshot(msg.state);
    return;
  }

  if (msg.cmd === "sync_interactive") {
    if (msg.interactive) applyInteractiveSnapshot(msg.interactive);
    return;
  }

  if (msg.cmd === "stop") {
    process.exit(0);
  }
});
