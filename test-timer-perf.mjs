// Test timing loop precision on Windows Bun
const targetFps = 30;
const intervalMs = 1000 / targetFps;
const intervalNs = BigInt(Math.round(intervalMs * 1_000_000));
const startNs = process.hrtime.bigint();
let frameCount = 0;
const maxFrames = 90; // 3 seconds of 30fps

console.log(`Starting 90-frame timer test targeting ${targetFps} FPS...`);
const frameTimes = [];
let lastTickNs = startNs;

function schedule() {
  if (frameCount >= maxFrames) {
    const elapsedSec = Number(process.hrtime.bigint() - startNs) / 1_000_000_000;
    const actualFps = frameCount / elapsedSec;
    console.log(`Finished ${frameCount} frames in ${elapsedSec.toFixed(3)}s -> ${actualFps.toFixed(2)} FPS`);
    process.exit(0);
    return;
  }

  const nowNs = process.hrtime.bigint();
  const nextTargetNs = startNs + BigInt(frameCount) * intervalNs;
  const delayNs = nextTargetNs > nowNs ? nextTargetNs - nowNs : 0n;
  const delayMs = Number(delayNs) / 1_000_000;

  if (delayMs < 14) {
    setImmediate(tick);
  } else {
    setTimeout(tick, Math.max(1, Math.floor(delayMs - 12)));
  }
}

function tick() {
  const nowNs = process.hrtime.bigint();
  frameCount++;
  // Simulate 12ms render work
  const workEnd = performance.now() + 12;
  while (performance.now() < workEnd) {}
  schedule();
}

tick();
