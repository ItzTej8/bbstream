import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import os from "node:os";
import { config } from "./config.mjs";
import { runtime } from "./runtime.mjs";
import { emit } from "./events.mjs";

const kbps = v => {
  const m = String(v).match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!m) return 2500;
  const n = Number(m[1]);
  return Math.round(m[2].toLowerCase() === "m" ? n * 1000 : n);
};

let logReady = null;
async function ensureLog() {
  if (!logReady) logReady = mkdir(dirname(config.ffmpegLogFile), { recursive: true }).catch(() => {});
  await logReady;
}
function pushTail(line) {
  runtime.encoder.stderrTail.push(line.slice(-1500));
  if (runtime.encoder.stderrTail.length > config.ffmpegLogLines) runtime.encoder.stderrTail.splice(0, runtime.encoder.stderrTail.length - config.ffmpegLogLines);
}
async function persistStderr(line) {
  try { await ensureLog(); await appendFile(config.ffmpegLogFile, `${new Date().toISOString()} ${line}\n`); } catch {}
}

export function createEncoder() {
  const out = `${config.rtmpUrl}/${config.streamKey}`;
  const br = kbps(config.bitrate);
  const scale = config.renderWidth === config.width && config.renderHeight === config.height
    ? null : `scale=${config.width}:${config.height}:flags=fast_bilinear`;
  const vfilters = [`setpts=N/(${config.renderFps}*TB)`];
  if (scale) vfilters.push(scale);
  if (config.renderFps !== config.fps) vfilters.push(`fps=fps=${config.fps}:round=near`);

  const isRaw = config.videoFeedFormat === "raw";
  const videoInputArgs = isRaw ? [
    "-thread_queue_size", "2048",
    "-probesize", "32",
    "-analyzeduration", "0",
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", `${config.renderWidth}x${config.renderHeight}`,
    "-framerate", String(config.renderFps),
    "-i", `http://127.0.0.1:${config.frameServerPort}/raw`,
  ] : [
    "-thread_queue_size", "1024",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-framerate", String(config.renderFps),
    "-i", `http://127.0.0.1:${config.frameServerPort}/mjpeg`,
  ];

  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "info", "-progress", "pipe:2",
    "-fflags", "+nobuffer+genpts",
    ...videoInputArgs,
  ];
  if (config.audioFile) {
    args.push(
      "-thread_queue_size", "512", "-stream_loop", "-1", "-re", "-i", config.audioFile,
      "-thread_queue_size", "1024", "-probesize", "32", "-analyzeduration", "0", "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", `http://127.0.0.1:${config.frameServerPort}/audio`,
      "-filter_complex", `[1:a]volume=${config.audioVolume}[bg];[bg][2:a]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      "-map", "0:v:0", "-map", "[aout]",
    );
  } else {
    args.push(
      "-thread_queue_size", "2048", "-probesize", "32", "-analyzeduration", "0", "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", `http://127.0.0.1:${config.frameServerPort}/audio`,
      "-map", "0:v:0", "-map", "1:a:0",
    );
  }

  args.push(
    "-sws_flags", "fast_bilinear",
    "-vf", vfilters.join(","),
    "-r", String(config.fps),
    "-fps_mode", "cfr",
  );

  if (config.videoCodec === "h264_mf" && process.platform === "win32") {
    args.push(
      "-c:v", "h264_mf",
      "-scenario", "live_streaming",
      "-rate_control", "cbr",
      "-b:v", `${br}k`,
      "-minrate", `${br}k`,
      "-maxrate", `${br}k`,
      "-bufsize", `${br * 2}k`,
      "-g", String(config.fps * config.gopSeconds),
      "-pix_fmt", "yuv420p",
    );
    const detectedCpus = os.cpus()?.length || 2;
    // On low-end Linux VPS, allow x264 to utilize multi-threaded slice encoding with fast lookahead
    const x264Threads = config.encoderThreads > 0
      ? config.encoderThreads
      : Math.max(2, Math.min(8, detectedCpus));
    const slices = Math.max(1, Math.min(4, Math.floor(x264Threads / 2) || 1));
    args.push(
      "-c:v", "libx264",
      "-preset", config.preset || "ultrafast",
      "-threads", String(x264Threads),
      "-slices", String(slices),
      "-pix_fmt", "yuv420p",
      "-b:v", `${br}k`,
      "-minrate", `${br}k`,
      "-maxrate", `${br}k`,
      "-bufsize", `${br * 2}k`,
      "-x264-params", "nal-hrd=cbr:force-cfr=1:sync-lookahead=2:rc-lookahead=10",
      "-profile:v", "main",
      "-g", String(config.fps * config.gopSeconds),
      "-keyint_min", String(config.fps * config.gopSeconds),
      "-sc_threshold", "0",
    );
  }

  args.push(
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-af", "aresample=async=1000:first_pts=0",
    "-flags", "+global_header",
    "-max_muxing_queue_size", "8192",
    "-flvflags", "no_duration_filesize",
    "-rtmp_live", "live",
    "-rtmp_buffer", "4000",
    "-f", "flv", out,
  );

  console.log(`[ffmpeg] codec=${config.videoCodec} command=${["ffmpeg", ...args].map(v => /live2\//.test(v) ? "<RTMP_URL>/<STREAM_KEY>" : v).join(" ")}`);
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  child._bb = { closed: false, stopping: false, spawned: false, stderrBuffer: "" };
  runtime.encoder.status = "starting";
  runtime.encoder.pid = child.pid ?? null;
  runtime.encoder.starts++;
  runtime.encoder.startedAt = Date.now();
  runtime.encoder.lastProgressAt = Date.now();
  runtime.encoder.lastVideoProgressAt = Date.now();
  runtime.encoder.lastFrameNumber = 0;
  runtime.encoder.lastProgressSeconds = 0;
  runtime.encoder.lastOutputTimeSeconds = 0;
  runtime.encoder.outputStartedAt = 0;
  runtime.encoder.connectedHint = false;
  runtime.encoder.lastSpeed = null;
  runtime.encoder.lastError = null;
  runtime.encoder.stderrTail = [];
  runtime.encoder.exitReason = null;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    child._bb.stderrBuffer += String(chunk);
    const lines = child._bb.stderrBuffer.split(/\r?\n/);
    child._bb.stderrBuffer = lines.pop() ?? "";
    for (const raw of lines.map(x => x.trim()).filter(Boolean)) {
      const eq = raw.indexOf("=");
      if (eq > 0) {
        const key = raw.slice(0, eq).toLowerCase();
        const value = raw.slice(eq + 1).trim();
        if (key === "frame") {
          const fn = parseInt(value, 10);
          if (Number.isFinite(fn)) {
            if (fn > (runtime.encoder.lastFrameNumber || 0)) {
              runtime.encoder.lastFrameNumber = fn;
              runtime.encoder.lastVideoProgressAt = Date.now();
            }
          }
          continue;
        }
        if (key === "out_time_ms" || key === "out_time_us") {
          const seconds = Number(value) / 1_000_000;
          if (Number.isFinite(seconds) && seconds > 0) {
            runtime.encoder.lastProgressSeconds = seconds;
            runtime.encoder.lastOutputTimeSeconds = seconds;
            runtime.encoder.lastProgressAt = Date.now();
            runtime.encoder.connectedHint = true;
            if (!runtime.encoder.outputStartedAt) {
              runtime.encoder.outputStartedAt = Date.now();
              runtime.renderer.dropped = 0;
              runtime.renderer.frames = 0;
              console.log(`[ffmpeg] YouTube live ingest connected! Stream time: ${seconds.toFixed(1)}s`);
            }

            // Calculate true real-time instantaneous encoding speed over rolling 5s window
            const now = Date.now();
            if (!child._bb.lastSpeedCalcAt) {
              child._bb.lastSpeedCalcAt = now;
              child._bb.lastSpeedOutTime = seconds;
            } else if (now - child._bb.lastSpeedCalcAt >= 5000) {
              const dt = (now - child._bb.lastSpeedCalcAt) / 1000;
              const dOut = seconds - child._bb.lastSpeedOutTime;
              const instantSpeed = dt > 0 ? (dOut / dt) : 1.0;
              runtime.encoder.instantSpeed = instantSpeed;
              child._bb.lastSpeedCalcAt = now;
              child._bb.lastSpeedOutTime = seconds;

              // Only warn if the encoder is genuinely falling behind in real-time (instant speed < 0.80x)
              // for at least 2 consecutive 5-second sampling periods (sustained bottleneck, not a momentary animation surge)
              // after the stream has been live for at least 30s, throttled to at most once per 60s
              if (instantSpeed < 0.80) {
                child._bb.lowSpeedStreak = (child._bb.lowSpeedStreak || 0) + 1;
              } else if (instantSpeed >= 0.90) {
                child._bb.lowSpeedStreak = 0;
              }

              if (now - runtime.encoder.outputStartedAt > 30000 && (child._bb.lowSpeedStreak || 0) >= 2) {
                if (!child._bb.lastSpeedWarnAt || (now - child._bb.lastSpeedWarnAt > 60000)) {
                  child._bb.lastSpeedWarnAt = now;
                  console.warn(`[ffmpeg] WARNING: Real-time encoder speed is ${instantSpeed.toFixed(2)}x (below 1.0x). If YouTube alerts buffering, consider setting RENDER_FPS=20 or PRESET=ultrafast in .env`);
                }
              }
            }
          }
          continue;
        }
        if (key === "speed") {
          runtime.encoder.lastSpeed = value;
          continue;
        }
        if (key === "fps") {
          runtime.encoder.lastFps = value;
          continue;
        }
        if (["dup_frames", "drop_frames", "total_size", "progress", "bitrate", "stream_0_0_q"].includes(key)) {
          continue;
        }
      }

      pushTail(raw);
      void persistStderr(raw);
      const isError = /error|failed|invalid|abort|fatal|broken|denied/i.test(raw);
      if (isError) {
        runtime.encoder.lastError = raw.slice(-1500);
        console.error(`[ffmpeg] ${raw}`);
      } else if (raw.startsWith("Output #0") || raw.startsWith("Stream mapping") || raw.includes("Conversion failed")) {
        console.log(`[ffmpeg] ${raw}`);
      }
    }
  });
  child.once("spawn", () => { child._bb.spawned = true; runtime.encoder.status = "running"; });
  child.once("error", error => {
    runtime.encoder.status = "error";
    runtime.encoder.lastError = error.message;
    runtime.encoder.exitReason = `process-error:${error.code || error.message}`;
    console.error(`[ffmpeg] process error: ${error.code || "ERROR"}: ${error.message}`);
  });
  child.once("close", (code, signal) => {
    child._bb.closed = true;
    runtime.encoder.status = "stopped";
    runtime.encoder.lastExitCode = code;
    runtime.encoder.lastSignal = signal;
    runtime.encoder.exitReason = `code=${code ?? "null"} signal=${signal ?? "none"}`;
    runtime.encoder.pid = null;
    if (!child._bb.stopping || code !== 0 || signal) {
      runtime.encoder.lastError ||= `closed code=${code ?? "null"} signal=${signal ?? "none"}`;
      console.error(`[ffmpeg] exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    } else console.log(`[ffmpeg] stopped cleanly code=${code ?? 0}`);
    emit("encoder-closed", { code, signal, stopping: child._bb.stopping });
  });
  console.log(`[ffmpeg] started pid=${child.pid ?? "?"} input=${config.videoFeedFormat}@${config.renderFps} output=${config.fps}fps bitrate=${config.bitrate}`);
  return child;
}

export async function stopEncoder(child) {
  if (!child || child._bb?.stopping) return;
  child._bb.stopping = true;
  await new Promise(resolve => {
    if (child._bb.closed) return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(termTimer); clearTimeout(killTimer); child.removeListener("close", finish); resolve(); };
    child.once("close", finish);
    const termTimer = setTimeout(() => { try { if (!child._bb.closed) child.kill("SIGTERM"); } catch {} }, 1000);
    const killTimer = setTimeout(() => { try { if (!child._bb.closed) child.kill("SIGKILL"); } catch {} finish(); }, 5000);
  });
}
