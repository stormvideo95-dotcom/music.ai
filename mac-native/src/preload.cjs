// Music AI for Mac — safe bridge between the UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || 'failed');
  return res.data;
};

const ALLOWED_EVENTS = ['config', 'pi:status', 'pi:command', 'pi:paired', 'library:changed', 'hp:state', 'hp:event'];

contextBridge.exposeInMainWorld('musicai', {
  invoke,
  on(channel, callback) {
    if (!ALLOWED_EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => callback(...args));
  },
});
