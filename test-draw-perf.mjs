import { drawMainFrame, canvas, ctx } from "./src/renderer.mjs";

console.log("Measuring 30 consecutive calls to drawMainFrame...");
const times = [];
for (let i = 0; i < 30; i++) {
  const t0 = performance.now();
  drawMainFrame(Date.now() + i * 33, ctx);
  const t1 = performance.now();
  times.push(t1 - t0);
}

const avg = times.reduce((a, b) => a + b, 0) / times.length;
const min = Math.min(...times);
const max = Math.max(...times);
console.log(`Min: ${min.toFixed(2)}ms, Max: ${max.toFixed(2)}ms, Avg: ${avg.toFixed(2)}ms`);
console.log(`Max achievable FPS: ${(1000 / avg).toFixed(1)} FPS`);
process.exit(0);
