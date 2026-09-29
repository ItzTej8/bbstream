# 24x7 YouTube Stream — Immortal VPS Mode

This version uses a **direct bounded raw-video pipe** from Bun/Canvas to FFmpeg.
The YouTube encoder no longer consumes the MJPEG HTTP endpoint, so the MJPEG
HTTP connection cannot be the critical video transport.

## Install

From the project directory:

```bash
chmod +x immortal.sh
sudo ./immortal.sh
```

The installer:

- installs FFmpeg/curl/CA certificates
- uses `/usr/local/bin/bun` when available
- runs the project as the normal `admin` user
- creates `bigg-boss-immortal.service`
- enables it at boot
- restarts it after crashes
- keeps it alive after Bitvise/SSH closes
- kills the whole process group during shutdown/restart

## Close Bitvise safely

After installation, you can close Bitvise. Do **not** use `Ctrl+C` in a shell that
is running the service manually. The systemd service owns the stream.

## Commands

Status:

```bash
sudo systemctl status bigg-boss-immortal --no-pager
```

Live logs:

```bash
sudo journalctl -u bigg-boss-immortal -f
```

Restart:

```bash
sudo systemctl restart bigg-boss-immortal
```

Stop:

```bash
sudo systemctl stop bigg-boss-immortal
```

Enable after boot:

```bash
sudo systemctl enable bigg-boss-immortal
```

## Video stability profile

Default production settings:

- 720x1280
- 30 FPS
- 3200 kbps CBR video
- 128 kbps AAC
- 44.1 kHz stereo
- 2 second GOP
- libx264 `veryfast`
- 3 encoder threads
- bounded one-frame backpressure
- stale frames are dropped instead of queued
- FFmpeg restarts automatically if the ingest/output stalls
- Bun exits on sustained memory pressure so systemd can replace the process

## Important

The stream key is stored in `.env`. Keep that file private. If the stream key has
been shared publicly, rotate it in YouTube Studio.
