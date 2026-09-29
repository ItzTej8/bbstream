import {
  palette,
  ctx,
  drawVoteScreen,
  drawFooter
} from "./src/renderer.mjs";

const p = palette();
const now = Date.now();

function bench(name, fn, iterations = 20) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn(i);
  }
  const t1 = performance.now();
  console.log(`${name}: ${((t1 - t0) / iterations).toFixed(2)}ms`);
}

bench("drawVoteScreen", (i) => drawVoteScreen(ctx, p, now + i * 33));
bench("drawFooter", (i) => drawFooter(ctx, p, now + i * 33));

process.exit(0);
