import os from "node:os";
import { contestants as contestantCatalog } from "./contestants.mjs";
const num=(k,f)=>{const n=Number(process.env[k]);return Number.isFinite(n)?n:f};
const int=(k,f,min=1)=>Math.max(min,Math.floor(num(k,f)));
const csv=(k,f="")=>String(process.env[k]??f).split(",").map(v=>v.trim()).filter(Boolean);
const bool=(k,f=false)=>/^(1|true|yes|on)$/i.test(String(process.env[k]??f));
const res=(v,f)=>{const m=String(v||"").trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);return m?{width:Math.max(320,+m[1]),height:Math.max(320,+m[2])}:f};
const output=res(process.env.STREAM_RESOLUTION,{width:720,height:1280});
const render=res(process.env.RENDER_RESOLUTION,output);
const width=output.width,height=output.height;
const renderWidth=Math.min(width,render.width),renderHeight=Math.min(height,render.height);
let codec=String(process.env.VIDEO_CODEC||"libx264").trim();
if(process.platform!=="win32"&&codec==="h264_mf") codec="libx264";
const detectedCpus = Math.max(1, os.cpus()?.length || 4);
const defaultFps = int("FPS", 30, 10);
const defaultRenderFps = process.env.RENDER_FPS ? int("RENDER_FPS", defaultFps, 10) : defaultFps;
const envWorkers = String(process.env.RENDER_WORKERS || "").trim().toLowerCase();
const finalWorkers = (envWorkers && envWorkers !== "auto")
  ? Math.max(1, int("RENDER_WORKERS", detectedCpus, 1))
  : detectedCpus;
export const config=Object.freeze({
  rtmpUrl:String(process.env.YOUTUBE_RTMP_URL||"rtmp://a.rtmp.youtube.com/live2").replace(/\/+$/,""),
  streamKey:String(process.env.YOUTUBE_STREAM_KEY||"").trim(),videoId:String(process.env.YOUTUBE_VIDEO_ID||"").trim(),
  socialcountsVideoId:String(process.env.SOCIALCOUNTS_VIDEO_ID||process.env.YOUTUBE_VIDEO_ID||"Y6gpa3AUMK4").trim(),
  channelId:String(process.env.YOUTUBE_CHANNEL_ID||"").trim(),
  youtubeApiKey:String(process.env.YOUTUBE_API_KEY||"").trim(),
  youtubeLiveTitle:String(process.env.YOUTUBE_LIVE_TITLE||"").trim(),
  youtubeIndexWaitSeconds:int("YOUTUBE_API_INDEX_WAIT_SECONDS",15,0),
  fetchDynamicVideoId:bool("FETCH_DYNAMIC_VIDEO_ID",true),
  width,height,renderWidth,renderHeight,
  streamResolution:`${width}x${height}`,renderResolution:`${renderWidth}x${renderHeight}`,
  fps:defaultFps,renderFps:defaultRenderFps,jpegQuality:Math.min(95,int("JPEG_QUALITY",40,20)),bitrate:String(process.env.BITRATE||"2500k"),
  videoCodec:codec,preset:String(process.env.PRESET||"ultrafast"),encoderThreads:int("ENCODER_THREADS",0,0),gopSeconds:int("GOP_SECONDS",2),
  videoFeedFormat:String(process.env.VIDEO_FEED_FORMAT||"raw").toLowerCase().trim(),
  renderWorkers:finalWorkers,
  voteCommand:String(process.env.VOTE_COMMAND||"!vote").trim()||"!vote",votePolicy:"every_vote",contestants:contestantCatalog,
  adminChannelIds:csv("ADMIN_CHANNEL_IDS"),healthPort:int("HEALTH_PORT",8787),frameServerPort:int("FRAME_SERVER_PORT",8788),
  stateFile:String(process.env.STATE_FILE||"data/state.json"),dbFile:String(process.env.DB_FILE||"data/votes.sqlite"),backgroundImage:String(process.env.BACKGROUND_IMAGE||"").trim(),
  audioFile:String(process.env.AUDIO_FILE||"").trim(),audioVolume:Math.max(0,Math.min(2,num("AUDIO_VOLUME",0.15))),
  imageCacheDir:String(process.env.IMAGE_CACHE_DIR||"data/contestant-images"),imageFetchTimeoutMs:Math.max(3000,Math.floor(num("IMAGE_FETCH_TIMEOUT_MS",15000))),
  encoderRestartMinMs:Math.max(1000,Math.floor(num("ENCODER_RESTART_MIN_MS",3000))),encoderRestartMaxMs:Math.max(5000,Math.floor(num("ENCODER_RESTART_MAX_MS",30000))),
  backpressureRestartMs:Math.max(5000,Math.floor(num("BACKPRESSURE_RESTART_MS",15000))),encoderStartupGraceMs:Math.max(500,Math.floor(num("ENCODER_STARTUP_GRACE_MS",5000))),
  memoryWarnMB:Math.max(256,Math.floor(num("MEMORY_WARN_MB",800))),memoryExitMB:Math.max(1024,Math.floor(num("MEMORY_EXIT_MB",2048))),
  watchdogIntervalMs:Math.max(2000,Math.floor(num("WATCHDOG_INTERVAL_MS",5000))),encoderStaleMs:Math.max(15000,Math.floor(num("ENCODER_STALE_MS",30000))),encoderRestartCooldownMs:Math.max(10000,Math.floor(num("ENCODER_RESTART_COOLDOWN_MS",30000))),
  encoderConnectGraceMs:Math.max(10000,Math.floor(num("ENCODER_CONNECT_GRACE_MS",120000))),encoderHardConnectTimeoutMs:Math.max(30000,Math.floor(num("ENCODER_HARD_CONNECT_TIMEOUT_MS",300000))),encoderHeartbeatMs:Math.max(3000,Math.floor(num("ENCODER_HEARTBEAT_MS",5000))),
  ffmpegLogFile:String(process.env.FFMPEG_LOG_FILE||"data/ffmpeg.log"),ffmpegLogLines:int("FFMPEG_LOG_LINES",200,50),rendererLogSeconds:int("RENDERER_LOG_SECONDS",10,5),allowViewerStatus:bool("ALLOW_VIEWER_STATUS",true),
  publicThemeCommands:bool("PUBLIC_THEME_COMMANDS",true),
  publicMusicCommands:bool("PUBLIC_MUSIC_COMMANDS",true),
  publicPollCommands:bool("PUBLIC_POLL_COMMANDS",true),
  pollDurationMs:Math.max(15000,Math.floor(num("POLL_DURATION_MS",45000))),
  screenIntervalMs:Math.max(8000,Math.floor(num("SCREEN_INTERVAL_MS",20000))),
  publicScreenCommands:bool("PUBLIC_SCREEN_COMMANDS",true),
  screenTransitionMs:Math.max(250,Math.floor(num("SCREEN_TRANSITION_MS",650))),
  timeLeftText:String(process.env.TIME_LEFT_TEXT||"2D 5H 45M").trim()||"2D 5H 45M",
  nowPlayingText:String(process.env.NOW_PLAYING_TEXT||"Bigg Boss Theme Song").trim()||"Bigg Boss Theme Song",
  ttsEnabled:bool("TTS_ENABLED",true),
  ttsVoice:String(process.env.TTS_VOICE||"en-IN-NeerjaNeural").trim(),
  ttsMinIntervalMs:Math.max(1000,Math.floor(num("TTS_MIN_INTERVAL_MS",3500))),
  ttsSpecificContestants:csv("TTS_SPECIFIC_CONTESTANTS"),
  ttsVolume:Math.max(0.1,Math.min(2.0,num("TTS_VOLUME",1.0))),
  ttsCacheInRam:bool("TTS_CACHE_IN_RAM",true),
  ttsCacheTtlHours:int("TTS_CACHE_TTL_HOURS",24,1),
});
export function validateConfig(){const errors=[],warnings=[];if(!config.streamKey||/PUT_YOUR|YOUR_|CHANGE_ME/i.test(config.streamKey))errors.push("YOUTUBE_STREAM_KEY is not configured");if(!config.videoId&&!config.youtubeApiKey)errors.push("Neither YOUTUBE_VIDEO_ID nor YOUTUBE_API_KEY is configured in .env");if(!config.adminChannelIds.length)warnings.push("ADMIN_CHANNEL_IDS is empty; owner/mod can still use theme and voting controls");return{errors,warnings};}
