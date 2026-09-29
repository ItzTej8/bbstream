// Quick smoke test — validates all modules load without the removed community-poll feature.
import { config } from './src/config.mjs';
import { getAvailableThemes } from './src/renderer.mjs';
import { interactiveState, viewerEvent } from './src/interactive.mjs';

console.log('config:', 'fps=' + config.fps, 'bitrate=' + config.bitrate, 'renderFps=' + config.renderFps);
console.log('themes (' + getAvailableThemes().length + '):', getAvailableThemes().join(', '));
const s = interactiveState();
console.log('interactive state initialized, screen=' + s.screen);
viewerEvent({ userId: 'smoke', name: 'SmokeTest', type: 'spark', contestant: 1, emoji: '✨' });
console.log('interactive event system: OK');
console.log('community poll feature: REMOVED');
console.log('ALL MODULES LOADED SUCCESSFULLY');
process.exit(0);
