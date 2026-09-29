import { config } from "./config.mjs";
import { state } from "./state.mjs";
let forced = null;
export function forceScene(name) { const valid = ["VOTING", "COUNTDOWN", "RESULTS"]; forced = valid.includes(String(name).toUpperCase()) ? String(name).toUpperCase() : null; return forced; }
export function sceneAt(now = Date.now()) {
  if (forced) return forced;
  const elapsed = (now - state.roundStartedAt) / 1000;
  const remaining = Math.max(0, config.voteDurationSeconds - elapsed);
  if (!state.votingOpen) return "RESULTS";
  if (remaining <= config.sceneCountdownSeconds) return "COUNTDOWN";
  return "VOTING";
}
export function clearForcedScene() { forced = null; }
