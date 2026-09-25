import { contextBridge, ipcRenderer } from "electron";

// Expõe uma API segura ao renderer sem expor Node.js diretamente
contextBridge.exposeInMainWorld("electronAPI", {
  // Captura de tela: lista todas as telas/janelas disponíveis
  getDesktopSources: () => ipcRenderer.invoke("get-desktop-sources"),

  // Versão do app
  getVersion: () => ipcRenderer.invoke("get-version"),

  // Abre link no navegador padrão
  openExternal: (url: string) => ipcRenderer.send("open-external", url),

  // Auto-updater
  onUpdateAvailable: (cb: (version: string) => void) =>
    ipcRenderer.on("update-available", (_e, version) => cb(version)),
  onUpdateProgress: (cb: (percent: number) => void) =>
    ipcRenderer.on("update-progress", (_e, percent) => cb(percent)),
  onUpdateDownloaded: (cb: () => void) =>
    ipcRenderer.on("update-downloaded", () => cb()),
  installUpdate: () => ipcRenderer.send("install-update"),
});
