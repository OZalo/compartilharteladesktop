import { contextBridge, ipcRenderer } from "electron";

// Expõe uma API segura ao renderer sem expor Node.js diretamente
contextBridge.exposeInMainWorld("electronAPI", {
  // Captura de tela: lista todas as telas/janelas disponíveis
  getDesktopSources: () => ipcRenderer.invoke("get-desktop-sources"),

  // Seletor customizado de tela
  onShowDesktopSourceSelector: (cb: (sources: any[]) => void) => {
    ipcRenderer.removeAllListeners("show-desktop-source-selector");
    ipcRenderer.on("show-desktop-source-selector", (_e, sources) => cb(sources));
  },
  sendDesktopSourceSelected: (sourceId: string | null) => ipcRenderer.send("desktop-source-selected", sourceId),

  // C++ Native Audio
  startNativeAudio: (opts?: { mode?: string; windowHandle?: number }) => ipcRenderer.invoke("start-native-audio", opts),
  stopNativeAudio: () => ipcRenderer.invoke("stop-native-audio"),
  onNativeAudioChunk: (cb: (buffer: Uint8Array, channels: number, sampleRate: number, bitsPerSample: number) => void) => {
    ipcRenderer.removeAllListeners("native-audio-chunk");
    ipcRenderer.on("native-audio-chunk", (_e, buffer, channels, sampleRate, bitsPerSample) => cb(buffer, channels, sampleRate, bitsPerSample));
  },

  // Controle Remoto e Gamepad Virtual (Parsec style)
  getRemoteControlStatus: () => ipcRenderer.invoke("remote-control-status"),
  sendMouseInput: (data: any) => ipcRenderer.invoke("send-mouse-input", data),
  sendKeyboardInput: (data: any) => ipcRenderer.invoke("send-keyboard-input", data),
  virtualGamepadConnect: (playerIndex: number) => ipcRenderer.invoke("virtual-gamepad-connect", playerIndex),
  virtualGamepadDisconnect: (playerIndex: number) => ipcRenderer.invoke("virtual-gamepad-disconnect", playerIndex),
  virtualGamepadUpdate: (playerIndex: number, state: any) => ipcRenderer.invoke("virtual-gamepad-update", playerIndex, state),

  // Versão do app e utilitários
  getVersion: () => ipcRenderer.invoke("get-version"),
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),

  // Abre link no navegador padrão
  openExternal: (url: string) => ipcRenderer.send("open-external", url),

  // Auto-updater
  onUpdateAvailable: (cb: (version: string) => void) =>
    ipcRenderer.on("update-available", (_e, version) => cb(version)),
  onUpdateProgress: (cb: (percent: number) => void) =>
    ipcRenderer.on("update-progress", (_e, percent) => cb(percent)),
  onUpdateDownloaded: (cb: () => void) =>
    ipcRenderer.on("update-downloaded", () => cb()),
  onUpdateError: (cb: (error: string) => void) =>
    ipcRenderer.on("update-error", (_e, error) => cb(error)),
  installUpdate: () => ipcRenderer.send("install-update"),

  // Deep linking
  onDeepLink: (cb: (url: string) => void) => {
    ipcRenderer.removeAllListeners("deep-link");
    ipcRenderer.on("deep-link", (_e, url) => cb(url));
  },
});
