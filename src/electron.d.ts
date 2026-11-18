export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
}

export interface NativeAudioOptions {
  mode?: "exclude-discord" | "window-only" | "all";
  windowHandle?: number;
}

export interface RemoteControlStatus {
  hasViGEm: boolean;
  hasNativeInput: boolean;
}

export interface VirtualGamepadState {
  buttonA?: boolean;
  buttonB?: boolean;
  buttonX?: boolean;
  buttonY?: boolean;
  shoulderL?: boolean;
  shoulderR?: boolean;
  thumbL?: boolean;
  thumbR?: boolean;
  start?: boolean;
  back?: boolean;
  guide?: boolean;
  dpadUp?: boolean;
  dpadDown?: boolean;
  dpadLeft?: boolean;
  dpadRight?: boolean;
  triggerL?: number;
  triggerR?: number;
  axisLeftX?: number;
  axisLeftY?: number;
  axisRightX?: number;
  axisRightY?: number;
}

export interface ElectronAPI {
  getDesktopSources: () => Promise<DesktopSource[]>;
  onShowDesktopSourceSelector: (cb: (sources: DesktopSource[]) => void) => void;
  sendDesktopSourceSelected: (sourceId: string | null) => void;
  getVersion: () => Promise<string>;
  readClipboard?: () => Promise<string>;
  openExternal: (url: string) => void;
  startNativeAudio: (opts?: NativeAudioOptions) => Promise<string>;
  stopNativeAudio: () => Promise<any>;
  onNativeAudioChunk: (cb: (buffer: Uint8Array, channels: number, sampleRate: number, bitsPerSample: number) => void) => void;
  
  // Parsec Remote Play & Virtual Gamepad
  getRemoteControlStatus: () => Promise<RemoteControlStatus>;
  sendMouseInput: (data: any) => Promise<void>;
  sendKeyboardInput: (data: any) => Promise<void>;
  virtualGamepadConnect: (playerIndex: number) => Promise<boolean>;
  virtualGamepadDisconnect: (playerIndex: number) => Promise<boolean>;
  virtualGamepadUpdate: (playerIndex: number, state: VirtualGamepadState) => Promise<void>;

  onUpdateAvailable: (cb: (version: string) => void) => void;
  onUpdateProgress: (cb: (percent: number) => void) => void;
  onUpdateDownloaded: (cb: () => void) => void;
  onUpdateError?: (cb: (err: string) => void) => void;
  installUpdate: () => void;
  onDeepLink?: (cb: (url: string) => void) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

