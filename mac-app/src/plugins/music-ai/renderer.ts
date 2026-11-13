// Music AI for Mac — renderer: "Play on" button + popup, resume sync, listen events, smart continue.
import { createRenderer } from '@/utils';

import { getMusicQueueRenderer } from '../music-together/queue/song';
import { mapQueueItem } from '../music-together/queue/utils';

import type { MusicAiConfig } from './index';
import type { MusicPlayer } from '@/types/music-player';
import type { AppElement, QueueElement } from '@/types/queue';
import type { RendererContext } from '@/types/contexts';

type SyncTrack = {
  id: string;
  title: string;
  artists: string[];
  album?: string | null;
  duration: number;
  thumbnail?: string | null;
};

type SyncState = {
  track?: SyncTrack | null;
  positionMs: number;
  playing: boolean;
  queue: SyncTrack[];
  updatedAt: number;
};

type SyncDevice = {
  id: string;
  name: string;
  type: string;
  me: boolean;
  online: boolean;
  state: Partial<SyncState>;
};

type SyncCommand = {
  action: string;
  track?: SyncTrack;
  positionMs?: number;
  queue?: SyncTrack[];
  from?: string;
};

type PiStatus = 'off' | 'online' | 'offline';

const DEVICE_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M4,6h18L22,4L4,4c-1.1,0 -2,0.9 -2,2v11L0,17v3h14v-3L4,17L4,6zM23,8h-6c-0.55,0 -1,0.45 -1,1v10c0,0.55 0.45,1 1,1h6c0.55,0 1,-0.45 1,-1L24,9c0,-0.55 -0.45,-1 -1,-1zM22,17h-4v-7h4v7z"/></svg>`;
const PHONE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M17,1.01L7,1c-1.1,0 -2,0.9 -2,2v18c0,1.1 0.9,2 2,2h10c1.1,0 2,-0.9 2,-2V3c0,-1.1 -0.9,-1.99 -2,-1.99zM17,19H7V5h10v14z"/></svg>`;
const LAPTOP_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M20,18c1.1,0 1.99,-0.9 1.99,-2L22,6c0,-1.1 -0.9,-2 -2,-2H4c-1.1,0 -2,0.9 -2,2v10c0,1.1 0.9,2 2,2H0v2h24v-2h-4zM4,6h16v10H4V6z"/></svg>`;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

const app = () => document.querySelector<AppElement>('ytmusic-app');
const queueEl = () => document.querySelector<QueueElement>('#queue');

const toast = (message: string) => app()?.toastService?.show(message);

function queueTracks(): { tracks: SyncTrack[]; selected: number } {
  const items = queueEl()?.queue.store.store.getState().queue.items ?? [];
  const flat = mapQueueItem((it) => it, items);
  const selected = flat.findIndex((it) => it?.selected);
  const tracks = flat.map((it) => ({
    id: it?.videoId ?? '',
    title: it?.title?.runs?.map((r) => r.text).join('') ?? '',
    artists: [it?.shortBylineText?.runs?.[0]?.text ?? ''].filter(Boolean),
    duration: 0,
    thumbnail: `https://i.ytimg.com/vi/${it?.videoId}/hqdefault.jpg`,
  }));
  return { tracks: tracks.filter((t) => t.id), selected };
}

async function playTracks(
  api: MusicPlayer | undefined,
  tracks: SyncTrack[],
  positionMs: number,
) {
  if (!tracks.length) return;
  const ids = tracks.map((t) => t.id).slice(0, 50);
  const seekWhenLoaded = () => {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (api?.getVideoData()?.video_id === ids[0]) {
        clearInterval(timer);
        if (positionMs > 3000) api.seekTo(positionMs / 1000);
        api.playVideo();
      } else if (tries > 40) {
        clearInterval(timer);
      }
    }, 250);
  };

  try {
    const res = await getMusicQueueRenderer(ids);
    const queue = queueEl();
    const items = res?.queueDatas.map((it) => it?.content).filter(Boolean);
    if (queue && items?.length) {
      const state = queue.queue.store.store.getState();
      queue.dispatch({ type: 'CLEAR' });
      queue.dispatch({
        type: 'ADD_ITEMS',
        payload: {
          nextQueueItemId: state.queue.nextQueueItemId,
          index: 0,
          items,
          shuffleEnabled: false,
          shouldAssignIds: true,
        },
      });
      queue.dispatch({ type: 'SET_INDEX', payload: 0 });
      setTimeout(() => {
        if (api?.getVideoData()?.video_id !== ids[0]) {
          api?.loadVideoById(ids[0], positionMs / 1000, 'auto');
        }
      }, 2500);
      seekWhenLoaded();
      return;
    }
  } catch (err) {
    console.warn('[Music AI] queue play failed, falling back', err);
  }
  api?.loadVideoById(ids[0], positionMs / 1000, 'auto');
  seekWhenLoaded();
}

type RadioItem = { videoId: string; title: string; artist: string };

async function fetchRadio(videoId: string): Promise<RadioItem[]> {
  const a = app() as unknown as {
    networkManager?: { fetch: (url: string, data: unknown) => Promise<unknown> };
  };
  if (!a?.networkManager) return [];
  const res = (await a.networkManager.fetch('/next', {
    videoId,
    playlistId: `RDAMVM${videoId}`,
    isAudioOnly: true,
  })) as Record<string, unknown>;
  // Walk the response and collect every playlistPanelVideoRenderer.
  const out: RadioItem[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const obj = node as Record<string, unknown>;
    const panel = obj.playlistPanelVideoRenderer as
      | {
          videoId?: string;
          title?: { runs?: { text: string }[] };
          shortBylineText?: { runs?: { text: string }[] };
        }
      | undefined;
    if (panel?.videoId) {
      out.push({
        videoId: panel.videoId,
        title: panel.title?.runs?.map((r) => r.text).join('') ?? '',
        artist: panel.shortBylineText?.runs?.[0]?.text ?? '',
      });
      return;
    }
    Object.values(obj).forEach(walk);
  };
  walk(res);
  return out;
}

export const renderer = createRenderer<
  {
    ctx?: RendererContext<MusicAiConfig>;
    api?: MusicPlayer;
    config?: MusicAiConfig;
    status: PiStatus;
    button?: HTMLElement;
    popup?: HTMLElement;
    timers: number[];
    current?: { track: SyncTrack; startedAt: number };
    recent: string[];
    extending: boolean;
    likeObserver?: MutationObserver;
    onVideoChange: (e: Event) => void;
    currentState(): SyncState;
    sendState(): Promise<void>;
    renderPopup(): Promise<void>;
    togglePopup(): void;
    handleCommand(command: SyncCommand): void;
    trackChanged(): void;
    maybeExtendQueue(): Promise<void>;
    updateStatusDot(): void;
  },
  MusicAiConfig
>({
  status: 'off',
  timers: [],
  recent: [],
  extending: false,

  currentState(): SyncState {
    const data = this.api?.getVideoData();
    const { tracks, selected } = queueTracks();
    const playing = this.api?.getPlayerState() === 1;
    const current = data?.video_id
      ? {
          id: data.video_id,
          title: data.title,
          artists: [data.author].filter(Boolean),
          duration: Math.round(this.api?.getDuration() ?? 0),
          thumbnail: `https://i.ytimg.com/vi/${data.video_id}/hqdefault.jpg`,
        }
      : null;
    return {
      track: current,
      positionMs: Math.round((this.api?.getCurrentTime() ?? 0) * 1000),
      playing,
      queue: selected >= 0 ? tracks.slice(selected + 1, selected + 26) : [],
      updatedAt: Date.now(),
    };
  },

  async sendState() {
    if (!this.ctx || !this.api) return;
    await this.ctx.ipc.invoke('music-ai:state', this.currentState());
  },

  updateStatusDot() {
    const dot = this.button?.querySelector<HTMLElement>('.music-ai-dot');
    if (!dot) return;
    dot.dataset.status = this.status;
    this.button!.title =
      this.status === 'online'
        ? 'Play on… (Pi connected)'
        : this.status === 'offline'
          ? 'Play on… (Pi offline)'
          : 'Play on…';
  },

  async renderPopup() {
    const popup = this.popup;
    if (!popup || !this.ctx) return;
    const info = (await this.ctx.ipc.invoke('music-ai:get-info')) as {
      paired: boolean;
      hasServer: boolean;
    };
    const data = info.paired
      ? ((await this.ctx.ipc.invoke('music-ai:devices')) as {
          devices: SyncDevice[];
        } | null)
      : null;
    const others = (data?.devices ?? []).filter((d) => !d.me);
    const statusText =
      this.status === 'online'
        ? '<span class="music-ai-dot" data-status="online"></span> Pi connected'
        : this.status === 'offline'
          ? '<span class="music-ai-dot" data-status="offline"></span> Pi offline'
          : '<span class="music-ai-dot" data-status="off"></span> Pi not set up';

    let rows = `
      <div class="music-ai-row selected">
        ${LAPTOP_ICON}
        <div class="music-ai-text"><div class="music-ai-name">This Mac</div><div class="music-ai-sub">Playing here</div></div>
      </div>`;
    if (!info.paired) {
      rows += `<div class="music-ai-hint">Pair this Mac: menu Plugins → Music AI → Pair this Mac…</div>`;
    } else if (!others.length) {
      rows += `<div class="music-ai-hint">No other devices paired yet</div>`;
    }
    for (const d of others) {
      const track = d.state?.track;
      const sub = !d.online
        ? 'Offline'
        : track
          ? `${d.state.playing ? 'Playing' : 'Paused'}: ${escapeHtml(track.title)}`
          : 'Online';
      rows += `
        <div class="music-ai-row ${d.online ? '' : 'disabled'}" data-device="${escapeHtml(d.id)}">
          ${d.type === 'mac' || d.type === 'desktop' ? LAPTOP_ICON : PHONE_ICON}
          <div class="music-ai-text"><div class="music-ai-name">${escapeHtml(d.name)}</div><div class="music-ai-sub">${sub}</div></div>
          ${track ? `<button class="music-ai-continue" data-continue="${escapeHtml(d.id)}">Continue here</button>` : ''}
        </div>`;
    }
    popup.innerHTML = `
      <div class="music-ai-title">Play on</div>
      ${rows}
      <div class="music-ai-footer">${statusText}</div>`;

    popup.querySelectorAll<HTMLElement>('[data-device]').forEach((row) => {
      row.addEventListener('click', async (e) => {
        if ((e.target as HTMLElement).closest('[data-continue]')) return;
        const device = others.find((d) => d.id === row.dataset.device);
        if (!device?.online) return;
        const state = this.currentState();
        if (!state.track) return toast('Nothing is playing');
        const ok = await this.ctx!.ipc.invoke('music-ai:command', device.id, {
          action: 'play',
          track: state.track,
          positionMs: state.positionMs,
          queue: state.queue,
        });
        if (ok) {
          this.api?.pauseVideo();
          toast(`Playing on ${device.name}`);
          popup.classList.remove('open');
        } else {
          toast('Could not reach that device');
        }
      });
    });
    popup.querySelectorAll<HTMLElement>('[data-continue]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const device = others.find((d) => d.id === btn.dataset.continue);
        const s = device?.state;
        if (!device || !s?.track) return;
        const elapsed = s.playing && s.updatedAt ? Date.now() - s.updatedAt : 0;
        await playTracks(
          this.api,
          [s.track, ...(s.queue ?? [])],
          (s.positionMs ?? 0) + elapsed,
        );
        if (s.playing) {
          void this.ctx!.ipc.invoke('music-ai:command', device.id, {
            action: 'pause',
          });
        }
        toast(`Continuing from ${device.name}`);
        popup.classList.remove('open');
      });
    });
  },

  togglePopup() {
    if (!this.popup) return;
    const open = this.popup.classList.toggle('open');
    if (open) {
      this.popup.innerHTML = '<div class="music-ai-title">Play on</div><div class="music-ai-hint">Loading…</div>';
      void this.renderPopup();
    }
  },

  handleCommand(command: SyncCommand) {
    if (command.action === 'play' && command.track) {
      void playTracks(
        this.api,
        [command.track, ...(command.queue ?? [])],
        command.positionMs ?? 0,
      );
      if (command.from) toast(`Moved here from ${command.from}`);
    } else if (command.action === 'pause') {
      this.api?.pauseVideo();
    }
  },

  trackChanged() {
    const data = this.api?.getVideoData();
    if (!data?.video_id) return;
    const prev = this.current;
    if (prev && prev.track.id !== data.video_id && this.ctx) {
      const listened = Date.now() - prev.startedAt;
      const durationMs = prev.track.duration * 1000;
      // Finished (or almost) = complete; left early = skip
      const type =
        durationMs > 0 && listened >= durationMs * 0.8 ? 'complete' : 'skip';
      if (listened > 1500) {
        void this.ctx.ipc.invoke('music-ai:event', {
          type,
          track: prev.track,
          ts: Date.now(),
          listenedMs: listened,
        });
      }
    }
    this.current = {
      track: {
        id: data.video_id,
        title: data.title,
        artists: [data.author].filter(Boolean),
        duration: Math.round(this.api?.getDuration() ?? 0),
      },
      startedAt: Date.now(),
    };
    this.recent = [...this.recent.filter((id) => id !== data.video_id), data.video_id].slice(-50);
    void this.sendState();
    void this.maybeExtendQueue();
  },

  async maybeExtendQueue() {
    if (!this.config?.smartContinue || this.extending || !this.ctx) return;
    const { tracks, selected } = queueTracks();
    if (selected < 0 || tracks.length - selected > 2) return;
    const seed = tracks[selected];
    if (!seed) return;
    this.extending = true;
    try {
      const inQueue = new Set(tracks.map((t) => t.id));
      const radio = (await fetchRadio(seed.id)).filter(
        (r) => !inQueue.has(r.videoId) && !this.recent.includes(r.videoId),
      );
      if (!radio.length) return;
      const candidates = radio.map((r) => ({
        id: r.videoId,
        title: r.title,
        artists: [r.artist].filter(Boolean),
      }));
      const ranked = (await this.ctx.ipc.invoke(
        'music-ai:rank',
        candidates,
        this.recent.slice(-20),
        10,
      )) as string[] | null;
      const ids = ranked?.length ? ranked : candidates.slice(0, 10).map((c) => c.id);
      const res = await getMusicQueueRenderer(ids);
      const queue = queueEl();
      const items = res?.queueDatas.map((it) => it?.content).filter(Boolean);
      if (!queue || !items?.length) return;
      const state = queue.queue.store.store.getState();
      queue.dispatch({
        type: 'ADD_ITEMS',
        payload: {
          nextQueueItemId: state.queue.nextQueueItemId,
          index: state.queue.items.length,
          items,
          shuffleEnabled: false,
          shouldAssignIds: true,
        },
      });
    } catch (err) {
      console.warn('[Music AI] smart continue failed', err);
    } finally {
      this.extending = false;
    }
  },

  onVideoChange() {},

  async start(ctx) {
    this.ctx = ctx;
    this.config = await ctx.getConfig();

    ctx.ipc.on('music-ai:status', (status: PiStatus) => {
      this.status = status;
      this.updateStatusDot();
    });
    ctx.ipc.on('music-ai:command', (command: SyncCommand) =>
      this.handleCommand(command),
    );
    ctx.ipc.on('music-ai:toast', (message: string) => toast(message));
    this.status = (await ctx.ipc.invoke('music-ai:get-status')) as PiStatus;

    // "Play on" button in the player bar, next to volume.
    const button = document.createElement('div');
    button.className = 'music-ai-button';
    button.innerHTML = `${DEVICE_ICON}<span class="music-ai-dot"></span>`;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopup();
    });
    const popup = document.createElement('div');
    popup.className = 'music-ai-popup';
    popup.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => popup.classList.remove('open'));
    document.body.appendChild(popup);
    this.button = button;
    this.popup = popup;

    const inject = () => {
      const bar = document.querySelector('.right-controls-buttons');
      if (bar && !bar.contains(button)) bar.prepend(button);
    };
    inject();
    this.timers.push(window.setInterval(inject, 3000));
    this.updateStatusDot();
  },

  onPlayerApiReady(api) {
    this.api = api;
    this.onVideoChange = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string }>).detail;
      if (detail?.name === 'dataloaded') this.trackChanged();
    };
    document.addEventListener('videodatachange', this.onVideoChange);

    // Heartbeat: tell the Pi what's playing here.
    let tick = 0;
    this.timers.push(
      window.setInterval(() => {
        tick++;
        const playing = this.api?.getPlayerState() === 1;
        if (playing || tick % 3 === 0) void this.sendState();
      }, 10_000),
    );

    // Likes / unlikes teach the taste AI too.
    const likeButton = document.querySelector<HTMLElement>('#like-button-renderer');
    if (likeButton) {
      let last = likeButton.getAttribute('like-status');
      let lastId = api.getVideoData()?.video_id;
      this.likeObserver = new MutationObserver(() => {
        const now = likeButton.getAttribute('like-status');
        const id = api.getVideoData()?.video_id;
        if (id === lastId && now !== last && this.current && this.ctx) {
          const type = now === 'LIKE' ? 'like' : last === 'LIKE' ? 'unlike' : null;
          if (type) {
            void this.ctx.ipc.invoke('music-ai:event', {
              type,
              track: this.current.track,
              ts: Date.now(),
            });
          }
        }
        last = now;
        lastId = id;
      });
      this.likeObserver.observe(likeButton, { attributes: true });
    }
  },

  onConfigChange(newConfig) {
    this.config = newConfig;
  },

  stop() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    this.likeObserver?.disconnect();
    document.removeEventListener('videodatachange', this.onVideoChange);
    this.button?.remove();
    this.popup?.remove();
  },
});
