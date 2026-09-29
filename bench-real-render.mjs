import { initRenderer, drawMainFrame, canvas } from "./src/renderer.mjs";
import { performance } from "node:perf_hooks";

const frames = Number(process.env.BENCH_FRAMES || 120);
await initRenderer();

const times = [];
for (let i = 0; i < frames; i++) {
  const t0 = performance.now();
  drawMainFrame(Date.now() + i * (1000 / 30));
  // Include RGBA extraction because this is a major part of the real pipeline.
  canvas.data();
  times.push(performance.now() - t0);
}

const avg = times.reduce((a,b)=>a+b,0)/times.length;
const sorted = [...times].sort((a,b)=>a-b);
const p95 = sorted[Math.floor(sorted.length*0.95)];
const max = Math.max(...times);
console.log(`Real renderer benchmark: ${frames} frames`);
console.log(`Average: ${avg.toFixed(2)} ms/frame`);
console.log(`P95:     ${p95.toFixed(2)} ms/frame`);
console.log(`Max:     ${max.toFixed(2)} ms/frame`);
console.log(`Average theoretical FPS: ${(1000/avg).toFixed(1)}`);
console.log(`P95 theoretical FPS:     ${(1000/p95).toFixed(1)}`);
process.exit(0);
