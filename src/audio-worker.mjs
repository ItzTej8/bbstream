import { parentPort } from "node:worker_threads";
import { generators } from "./music-tracks.mjs";

parentPort.on("message", (msg) => {
  if (msg.cmd === "generate") {
    const fn = generators[msg.id];
    if (fn) {
      const pcm = fn();
      parentPort.postMessage({ type: "track_pcm", id: msg.id, pcm: pcm.buffer }, [pcm.buffer]);
    }
  }
});

parentPort.postMessage({ type: "ready" });
