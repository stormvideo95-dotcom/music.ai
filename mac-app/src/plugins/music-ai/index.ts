// Music AI for Mac — Storm's taste AI, "Play on" device picker and resume sync.
import { createPlugin } from '@/utils';

import { backend } from './backend';
import { onMenu } from './menu';
import { renderer } from './renderer';
import style from './style.css?inline';

export interface MusicAiConfig {
  enabled: boolean;
  serverUrl: string;
  token: string;
  deviceName: string;
  smartContinue: boolean;
}

export default createPlugin({
  name: () => 'Music AI',
  description: () =>
    "Storm's taste AI on the Pi, a Spotify-style 'Play on' device picker and resume between phone and Mac",
  restartNeeded: true,
  config: {
    enabled: true,
    serverUrl: 'http://umbrel.local:8765',
    token: '',
    deviceName: '',
    smartContinue: true,
  } as MusicAiConfig,
  stylesheets: [style],
  menu: onMenu,
  backend,
  renderer,
});
