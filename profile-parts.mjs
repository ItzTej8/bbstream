import {
  drawBackground,
  drawTopBar,
  drawHero,
  palette,
  canvas,
  ctx
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

bench("drawBackground", (i) => drawBackground(ctx, p, now + i * 33));
bench("drawTopBar", (i) => drawTopBar(ctx, p, now + i * 33));
bench("drawHero", (i) => drawHero(ctx, p, now + i * 33, "VOTING", null));
bench("canvas.data()", () => canvas.data());

process.exit(0);
