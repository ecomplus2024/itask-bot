// Exposes a minimal desktop bridge so the web UI can drive the frameless window.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("itaskDesktop", {
  minimize: () => ipcRenderer.send("win-minimize"),
  toggleMaximize: () => ipcRenderer.send("win-toggle-maximize"),
  close: () => ipcRenderer.send("win-close"),
  // Port of the embedded realtime server (3001 in dev; dynamic when packaged).
  wsPort: Number(process.env.ITASK_WS_PORT || 3001),
});
