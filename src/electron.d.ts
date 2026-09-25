export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
}

export interface ElectronAPI {
  getDesktopSources: () => Promise<DesktopSource[]>;
  getVersion: () => Promise<string>;
  openExternal: (url: string) => void;
  onUpdateAvailable: (cb: (version: string) => void) => void;
  onUpdateProgress: (cb: (percent: number) => void) => void;
  onUpdateDownloaded: (cb: () => void) => void;
  installUpdate: () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
