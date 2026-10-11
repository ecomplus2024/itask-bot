// iTask Bot desktop shell.
//
// Packaged mode: spawns the embedded Next.js standalone server shipped in
// resources/server (via ELECTRON_RUN_AS_NODE) on two free ports, waits for
// it to come up, then loads it — no Node.js install required on the target
// machine. Data (SQLite + uploads) lives under the OS userData dir.
//
// Dev mode: loads an already-running server — `npm run dev` then
// `npm run electron`, or ITASK_URL=https://bot.company.com
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");

let serverProc = null;
let appUrl = process.env.ITASK_URL || "http://localhost:3000/chat";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForHttp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const req = http.get(`http://127.0.0.1:${port}/login`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("server start timeout"));
        else setTimeout(poll, 400);
      });
      req.setTimeout(2000, () => req.destroy());
    })();
  });
}

// Merge KEY=VALUE lines from a .env file into env (without overriding).
function loadEnvFile(file, env) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (env[m[1]] === undefined) env[m[1]] = val;
  }
}

// Extracts resources/server.tar.gz into userData when missing or when the
// bundled version changed (app upgrade). Windows 10+ ships bsdtar in
// System32; macOS/Linux have tar too.
function ensureServerExtracted(userData) {
  const serverDir = path.join(userData, "server");
  const versionFile = path.join(serverDir, ".version");
  const stamped = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, "utf8").trim()
    : null;
  if (stamped === app.getVersion() && fs.existsSync(path.join(serverDir, "server.js"))) {
    return serverDir;
  }
  const tarball = path.join(process.resourcesPath, "server.tar.gz");
  fs.mkdirSync(userData, { recursive: true });
  require("child_process").execFileSync(
    "tar",
    ["--force-local", "-xzf", tarball, "-C", userData],
    { windowsHide: true }
  );
  return serverDir;
}

async function startEmbeddedServer() {
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  const serverDir = ensureServerExtracted(userData);
  const serverJs = path.join(serverDir, "server.js");

  const httpPort = await freePort();
  const wsPort = await freePort();
  // Preload reads this to tell the renderer where the realtime socket lives.
  process.env.ITASK_WS_PORT = String(wsPort);

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PORT: String(httpPort),
    HOSTNAME: "0.0.0.0", // keep LAN/phone access like the dev server
    ITASK_WS_PORT: String(wsPort),
    // Standalone resolves .next relative to cwd → cwd must be the server
    // dir; the SQLite data dir moves to userData via this env instead.
    ITASK_DATA_DIR: userData,
  };
  loadEnvFile(path.join(serverDir, ".env.local"), env);

  const log = fs.createWriteStream(path.join(userData, "server.log"), {
    flags: "a",
  });
  serverProc = spawn(process.execPath, [serverJs], {
    env,
    cwd: serverDir, // .next is resolved relative to cwd
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProc.stdout.pipe(log);
  serverProc.stderr.pipe(log);
  serverProc.on("exit", (code) => {
    log.write(`\n[main] server exited, code ${code}\n`);
  });

  await waitForHttp(httpPort);
  return `http://localhost:${httpPort}/chat`;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    title: "iTask Bot",
    autoHideMenuBar: true,
    backgroundColor: "#09090b",
    // Fully frameless: no titlebar at all. The web UI draws its own
    // invisible drag strip + caption buttons via the itaskDesktop bridge.
    frame: false,
    icon: path.join(__dirname, "..", "public", "icon-512.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // External links (downloads, http links) open in the system browser,
  // file downloads stay inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(appUrl) || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

async function boot() {
  const win = createWindow();
  // Show something immediately while the embedded server boots.
  win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        '<body style="background:#09090b;color:#71717a;font-family:sans-serif;' +
          'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
          "Đang khởi động iTask Bot…</body>"
      )
  );

  if (app.isPackaged || process.env.ITASK_EMBEDDED === "1") {
    try {
      appUrl = await startEmbeddedServer();
    } catch (e) {
      win.webContents.executeJavaScript(
        `document.body.innerHTML = ${JSON.stringify(
          "Không khởi động được server nội bộ. Xem log trong %APPDATA%/iTask Bot/server.log"
        )}`
      );
      return;
    }
  }

  await win.loadURL(appUrl);

  // Frameless: reveal the invisible drag strip + shift content below the
  // overlay controls. In the browser/PWA this is handled by the
  // window-controls-overlay media query instead.
  win.webContents.on("did-finish-load", () => {
    win.webContents.insertCSS(
      ".titlebar-drag{display:block!important;height:33px;position:fixed;top:0;left:0;right:0;z-index:30}" +
        ".wco-inset{padding-top:33px!important}"
    );
  });
}

ipcMain.on("win-minimize", (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});
ipcMain.on("win-toggle-maximize", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("win-close", (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});

app.whenReady().then(() => {
  if (app.isPackaged) {
    // Launch on Windows login so scheduled bots keep working.
    app.setLoginItemSettings({ openAtLogin: true });
    // Check GitHub Releases for a newer version — downloads in the
    // background and prompts to restart when ready.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }
  boot();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});
app.on("quit", () => {
  serverProc?.kill();
});
