// Music AI for Mac — tray/app menu
import prompt from 'custom-electron-prompt';

import promptOptions from '@/providers/prompt-options';

import { backend, defaultDeviceName, piCall } from './backend';

import type { MusicAiConfig } from './index';
import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

export const onMenu = async ({
  window,
  getConfig,
  setConfig,
}: MenuContext<MusicAiConfig>): Promise<MenuTemplate> => {
  const config = await getConfig();
  const statusLabel = {
    off: '○ Pi: not set up',
    online: '● Pi connected',
    offline: '○ Pi offline',
  }[backend.status];

  return [
    { label: statusLabel, enabled: false },
    {
      label: 'Pi address…',
      async click() {
        const value = await prompt(
          {
            title: 'Music AI',
            label: 'Address of your Pi taste server',
            value: config.serverUrl || 'http://umbrel.local:8765',
            inputAttrs: { type: 'url' },
            type: 'input',
            ...promptOptions(),
          },
          window,
        );
        if (value) await setConfig({ serverUrl: value.trim() });
      },
    },
    {
      label: 'Smart continue (AI picks songs when the queue ends)',
      type: 'checkbox',
      checked: config.smartContinue,
      click(item) {
        void setConfig({ smartContinue: item.checked });
      },
    },
    { type: 'separator' },
    config.token
      ? { label: `✓ Paired as "${config.deviceName}"`, enabled: false }
      : {
          label: 'Pair this Mac…',
          click() {
            void backend.pairThisMac();
          },
        },
    {
      label: 'Add a device (enter its code)…',
      enabled: Boolean(config.token),
      async click() {
        const code = await prompt(
          {
            title: 'Add a device',
            label: 'Type the 6-digit code shown on the other device',
            value: '',
            inputAttrs: { type: 'text' },
            type: 'input',
            ...promptOptions(),
          },
          window,
        );
        if (!code) return;
        const res = await piCall(config, '/pair/approve', {
          method: 'POST',
          auth: true,
          body: { code: code.replace(/\s/g, '') },
        });
        window.webContents.send(
          'music-ai:toast',
          res?.status === 200 ? 'Device added!' : 'Wrong or expired code',
        );
      },
    },
    {
      label: 'Rename this Mac…',
      async click() {
        const value = await prompt(
          {
            title: 'Music AI',
            label: 'Name shown on your other devices',
            value: config.deviceName || defaultDeviceName(),
            inputAttrs: { type: 'text' },
            type: 'input',
            ...promptOptions(),
          },
          window,
        );
        if (value) await setConfig({ deviceName: value.trim() });
      },
    },
    {
      label: 'Unpair this Mac',
      enabled: Boolean(config.token),
      async click() {
        await piCall(config, '/sync/unpair', {
          method: 'POST',
          auth: true,
          body: {},
        });
        await setConfig({ token: '' });
      },
    },
  ];
};
