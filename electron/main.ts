import {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  shell,
  clipboard,
} from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "path";
import * as fs from "fs";

let nativeAudio: any = null;
function loadNativeAudio() {
  const candidates = [
    path.join(process.resourcesPath || "", "app.asar.unpacked/native-audio/build/Release/native_audio.node"),
    path.join(__dirname, "../native-audio/build/Release/native_audio.node"),
    "native-audio",
  ];
  for (const candidate of candidates) {
    try {
      if (candidate === "native-audio" || fs.existsSync(candidate)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        nativeAudio = require(candidate);
        console.log("[native-audio] Carregado de:", candidate);
        break;
      }
    } catch (e) {
      console.warn("[native-audio] Falha ao tentar carregar", candidate, e);
    }
  }
}
loadNativeAudio();

const isDev = process.env.ELECTRON_DEV === "true";

// ─── Auto-Updater ─────────────────────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function setupUpdater(win: BrowserWindow) {
  autoUpdater.on("update-available", (info) => {
    win.webContents.send("update-available", info.version);
  });
  autoUpdater.on("download-progress", (progress) => {
    win.webContents.send("update-progress", Math.round(progress.percent));
  });
  autoUpdater.on("update-downloaded", () => {
    win.webContents.send("update-downloaded");
  });
  autoUpdater.on("error", (err) => {
    console.error("[updater]", err.message);
    win.webContents.send("update-error", err.message);
  });

  if (!isDev) {
    setTimeout(() => autoUpdater.checkForUpdates(), 3000);
    setInterval(() => autoUpdater.checkForUpdates(), 60 * 60 * 1000);
  }
}

// ─── IPC: listar sources de captura ──────────────────────────────────────────
ipcMain.handle("get-desktop-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon?.toDataURL() ?? null,
  }));
});

// ─── IPC: instalar update ─────────────────────────────────────────────────────
ipcMain.on("install-update", () => {
  autoUpdater.quitAndInstall(true, true);
});

// ─── IPC: abrir link externo ──────────────────────────────────────────────────
ipcMain.on("open-external", (_, url: string) => {
  shell.openExternal(url);
});

// ─── IPC: obter versão ────────────────────────────────────────────────────────
ipcMain.handle("get-version", () => app.getVersion());

// ─── IPC: ler clipboard nativo ────────────────────────────────────────────────
ipcMain.handle("read-clipboard", () => {
  try {
    return clipboard.readText() || "";
  } catch {
    return "";
  }
});

// ─── IPC: C++ Native Audio ────────────────────────────────────────────────────
ipcMain.handle("start-native-audio", (_event, opts?: { mode?: string; windowHandle?: number }) => {
  if (!nativeAudio) return "ERROR: Módulo nativo não encontrado.";

  const callback = (err: any, buffer: Buffer, channels: number, sampleRate: number, bitsPerSample: number) => {
    if (err) {
      console.error("Erro no C++ audio:", err);
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("native-audio-chunk", buffer, channels, sampleRate, bitsPerSample);
    }
  };

  try {
    if (opts && typeof opts === "object") {
      return nativeAudio.startCapture(opts, callback);
    }
    return nativeAudio.startCapture(callback);
  } catch (e: any) {
    return "ERROR: " + (e?.message || String(e));
  }
});

ipcMain.handle("stop-native-audio", () => {
  if (!nativeAudio) return;
  try {
    return nativeAudio.stopCapture();
  } catch {}
});

// ─── ViGEm Virtual Gamepad (Controle de Xbox 360 virtual) ────────────────────
let vigemClient: any = null;
const virtualGamepads = new Map<number, any>();

function getViGEmClient() {
  if (!vigemClient) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ViGEmClient = require("vigemclient");
      vigemClient = new ViGEmClient();
      const err = vigemClient.connect();
      if (err) {
        console.warn("[ViGEm] Driver não disponível ou erro de conexão:", err);
        vigemClient = null;
      } else {
        console.log("[ViGEm] Conectado ao serviço ViGEmBus com sucesso!");
      }
    } catch (e) {
      console.warn("[ViGEm] Módulo vigemclient não pôde ser instanciado:", e);
      vigemClient = null;
    }
  }
  return vigemClient;
}

ipcMain.handle("remote-control-status", () => {
  const client = getViGEmClient();
  return {
    hasViGEm: !!client,
    hasNativeInput: !!(nativeAudio && nativeAudio.sendMouseInput),
  };
});

ipcMain.handle("send-mouse-input", (_event, inputData: any) => {
  if (nativeAudio && nativeAudio.sendMouseInput) {
    nativeAudio.sendMouseInput(inputData);
  }
});

ipcMain.handle("send-keyboard-input", (_event, inputData: any) => {
  if (nativeAudio && nativeAudio.sendKeyboardInput) {
    nativeAudio.sendKeyboardInput(inputData);
  }
});

ipcMain.handle("virtual-gamepad-connect", (_event, playerIndex: number) => {
  const client = getViGEmClient();
  if (!client) return false;
  try {
    if (virtualGamepads.has(playerIndex)) {
      virtualGamepads.get(playerIndex).disconnect();
      virtualGamepads.delete(playerIndex);
    }
    const pad = client.createX360Controller();
    const err = pad.connect();
    if (!err) {
      virtualGamepads.set(playerIndex, pad);
      console.log(`[ViGEm] Controle virtual Xbox Player ${playerIndex + 1} plugado!`);
      return true;
    }
  } catch (e) {
    console.warn("[ViGEm] Erro criando controle virtual:", e);
  }
  return false;
});

ipcMain.handle("virtual-gamepad-disconnect", (_event, playerIndex: number) => {
  if (virtualGamepads.has(playerIndex)) {
    try {
      virtualGamepads.get(playerIndex).disconnect();
      virtualGamepads.delete(playerIndex);
      console.log(`[ViGEm] Controle virtual Xbox Player ${playerIndex + 1} desconectado.`);
    } catch {}
  }
  return true;
});

ipcMain.handle("virtual-gamepad-update", (_event, playerIndex: number, state: any) => {
  const pad = virtualGamepads.get(playerIndex);
  if (!pad) return;

  try {
    // Botões digitais
    if (state.buttonA !== undefined) pad.button.A.setValue(state.buttonA);
    if (state.buttonB !== undefined) pad.button.B.setValue(state.buttonB);
    if (state.buttonX !== undefined) pad.button.X.setValue(state.buttonX);
    if (state.buttonY !== undefined) pad.button.Y.setValue(state.buttonY);
    if (state.shoulderL !== undefined) pad.button.SHOULDER_LEFT.setValue(state.shoulderL);
    if (state.shoulderR !== undefined) pad.button.SHOULDER_RIGHT.setValue(state.shoulderR);
    if (state.thumbL !== undefined) pad.button.THUMB_LEFT.setValue(state.thumbL);
    if (state.thumbR !== undefined) pad.button.THUMB_RIGHT.setValue(state.thumbR);
    if (state.start !== undefined) pad.button.START.setValue(state.start);
    if (state.back !== undefined) pad.button.BACK.setValue(state.back);
    if (state.guide !== undefined) pad.button.GUIDE.setValue(state.guide);

    // D-Pad
    if (state.dpadUp !== undefined) pad.dpad.UP.setValue(state.dpadUp);
    if (state.dpadDown !== undefined) pad.dpad.DOWN.setValue(state.dpadDown);
    if (state.dpadLeft !== undefined) pad.dpad.LEFT.setValue(state.dpadLeft);
    if (state.dpadRight !== undefined) pad.dpad.RIGHT.setValue(state.dpadRight);

    // Gatilhos Analógicos (0.0 a 1.0)
    if (state.triggerL !== undefined) pad.axis.triggerL.setValue(state.triggerL);
    if (state.triggerR !== undefined) pad.axis.triggerR.setValue(state.triggerR);

    // Analógicos X/Y (-1.0 a 1.0)
    if (state.axisLeftX !== undefined) pad.axis.leftX.setValue(state.axisLeftX);
    if (state.axisLeftY !== undefined) pad.axis.leftY.setValue(state.axisLeftY);
    if (state.axisRightX !== undefined) pad.axis.rightX.setValue(state.axisRightX);
    if (state.axisRightY !== undefined) pad.axis.rightY.setValue(state.axisRightY);
  } catch {}
});

// ─── Deep Linking e Single Instance ───────────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("compartilhartela", process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient("compartilhartela");
}

let mainWindow: BrowserWindow | null = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = commandLine.find((arg) => arg.startsWith("compartilhartela://"));
    if (url && mainWindow) {
      mainWindow.webContents.send("deep-link", url);
    }
  });
}

// macOS open-url
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (mainWindow && url.startsWith("compartilhartela://")) {
    mainWindow.webContents.send("deep-link", url);
  }
});

// ─── Criar janela ─────────────────────────────────────────────────────────────
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: "#0a0a0f",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#111118",
      symbolColor: "#9090b0",
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, "../public/icon.ico"),
    show: true,
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ["media", "display-capture", "screen", "audioCapture", "desktopCapture", "clipboard-read", "clipboard-sanitized-write"];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 } }).then((sources) => {
      const serializableSources = sources.map(s => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
      }));

      mainWindow!.webContents.send("show-desktop-source-selector", serializableSources);

      ipcMain.once("desktop-source-selected", (_event, sourceId) => {
        if (!sourceId) {
          callback(null as any);
          return;
        }
        const selected = sources.find(s => s.id === sourceId) || sources[0];
        callback({ video: selected, audio: "loopback" });
      });
    });
  });

  mainWindow.once("ready-to-show", () => {
    setupUpdater(mainWindow!);
    if (process.platform === "win32") {
      const url = process.argv.find((arg) => arg.startsWith("compartilhartela://"));
      if (url) {
        setTimeout(() => mainWindow!.webContents.send("deep-link", url), 1500);
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    await mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.disableHardwareAcceleration();
if (gotTheLock) {
  app.whenReady().then(createWindow);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
