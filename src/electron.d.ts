export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
}

export interface ElectronAPI {
  getDesktopSources: () => Promise<DesktopSource[]>;
  onShowDesktopSourceSelector: (cb: (sources: DesktopSource[]) => void) => void;
  sendDesktopSourceSelected: (sourceId: string | null) => void;
  getVersion: () => Promise<string>;
  openExternal: (url: string) => void;
  onUpdateAvailable: (cb: (version: string) => void) => void;
  onUpdateProgress: (cb: (percent: number) => void) => void;
  onUpdateDownloaded: (cb: () => void) => void;
  installUpdate: () => void;
  onDeepLink?: (cb: (url: string) => void) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
