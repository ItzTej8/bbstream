import { readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const lockPath = resolve("data/bigg-boss.pid");
let owned = false;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === "win32") {
      const res = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
      const out = String(res.stdout || "").toLowerCase();
      return out.includes("bun") || out.includes("node") || out.includes("powershell");
    }
    return true;
  } catch { return false; }
}

export async function acquireInstanceLock() {
  await mkdir(dirname(lockPath), { recursive: true });

  // When running manually in terminal (bun start) rather than under systemd (INVOCATION_ID):
  // Stop any active systemd service so systemd's Restart=always does not fight
  // or kill this interactive stream session.
  if (process.platform === "linux" && !process.env.INVOCATION_ID) {
    try {
      const chk = spawnSync("systemctl", ["is-active", "--quiet", "bigg-boss-live.service"], { windowsHide: true });
      if (chk.status === 0) {
        console.log("[instance-lock] Stopping background systemd service to run foreground stream...");
        spawnSync("systemctl", ["stop", "bigg-boss-live.service"], { windowsHide: true });
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch {}
  }

  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    const old = Number(raw);
    if (alive(old) && old !== process.pid) {
      console.warn(`[instance-lock] Previous instance running (PID ${old}); auto-killing before starting...`);
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/F", "/PID", String(old), "/T"], { windowsHide: true });
        } else {
          try { process.kill(old, "SIGTERM"); } catch {}
          setTimeout(() => { try { process.kill(old, "SIGKILL"); } catch {} }, 1000);
        }
      } catch (err) {
        console.warn(`[instance-lock] could not kill PID ${old}: ${err.message}`);
      }
      // Give the OS 1.5 seconds to fully free network ports and resources
      await new Promise(r => setTimeout(r, 1500));
    }
    // Also clean up any orphan ffmpeg processes to prevent stream key publishing conflicts
    if (process.platform === "win32") {
      try { spawnSync("taskkill", ["/F", "/IM", "ffmpeg.exe"], { windowsHide: true }); } catch {}
    } else {
      try { spawnSync("pkill", ["-9", "-f", "8788/raw|8788/audio|live2/"], { windowsHide: true }); } catch {}
    }
  } catch (e) {
    if (e?.code !== "ENOENT") console.warn(`[instance-lock] read lockfile: ${e.message}`);
  }
  await writeFile(lockPath, String(process.pid), { encoding: "utf8" });
  owned = true;
}

export async function releaseInstanceLock() {
  if (!owned) return;
  try {
    const current = Number((await readFile(lockPath, "utf8")).trim());
    if (current === process.pid) await unlink(lockPath);
  } catch {}
  owned = false;
}
