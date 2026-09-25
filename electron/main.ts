import {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  shell,
} from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "path";

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
    // Check after 3 seconds, then every hour
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

// ─── Deep Linking e Single Instance ─────────────────────────────────────────────
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
  app.on("second-instance", (event, commandLine, workingDirectory) => {
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

  // Permissão para captura de mídia (essencial para getDisplayMedia)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ["media", "display-capture", "screen", "audioCapture", "desktopCapture"];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 } }).then((sources) => {
      const serializableSources = sources.map(s => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
      }));

      // Pede para o renderer exibir o seletor
      mainWindow!.webContents.send("show-desktop-source-selector", serializableSources);

      ipcMain.once("desktop-source-selected", (_event, sourceId) => {
        if (!sourceId) {
          // Cancelado pelo usuário
          callback(null as any);
          return;
        }
        const selected = sources.find(s => s.id === sourceId) || sources[0];
        callback({ video: selected, audio: "loopback" });
      });
    });
  });

  mainWindow.once("ready-to-show", () => {
    // mainWindow.show();
    setupUpdater(mainWindow!);
    // Checar se abriu com um link direto no Windows
    if (process.platform === "win32") {
      const url = process.argv.find((arg) => arg.startsWith("compartilhartela://"));
      if (url) {
        // Envia com um pequeno delay para garantir que o React carregou
        setTimeout(() => mainWindow!.webContents.send("deep-link", url), 1500);
      }
    }
  });

  // Impede que links externos abram no app
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
