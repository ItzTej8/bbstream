import { initRenderer, drawMainFrame, canvas } from "./src/renderer.mjs";

console.log("Initializing renderer...");
await initRenderer();
console.log("Measuring 30 frames rendering time...");
const t0 = performance.now();
for (let i = 0; i < 30; i++) {
  drawMainFrame(Date.now() + i * 33);
}
const t1 = performance.now();
const total = t1 - t0;
console.log(`Total time for 30 frames: ${total.toFixed(1)}ms`);
console.log(`Average time per frame: ${(total / 30).toFixed(2)}ms`);
console.log(`Theoretical max FPS: ${(1000 / (total / 30)).toFixed(1)} FPS`);
process.exit(0);
