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
  autoUpdater.quitAndInstall();
});

// ─── IPC: abrir link externo ──────────────────────────────────────────────────
ipcMain.on("open-external", (_, url: string) => {
  shell.openExternal(url);
});

// ─── IPC: obter versão ────────────────────────────────────────────────────────
ipcMain.handle("get-version", () => app.getVersion());

// ─── Criar janela ─────────────────────────────────────────────────────────────
async function createWindow() {
  const win = new BrowserWindow({
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
      win.webContents.send("show-desktop-source-selector", serializableSources);

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

  win.once("ready-to-show", () => {
    // win.show();
    setupUpdater(win);
  });

  // Impede que links externos abram no app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    await win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
