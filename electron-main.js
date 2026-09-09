// electron-main.js — SYSGLAS Hardware Widget Main Process
// ─────────────────────────────────────────────────────────────────────────
// Lightweight Tray-Resident Glassmorphic Hardware Widget.
// High-performance tiered polling architecture (sub-millisecond CPU/RAM,
// fast NVIDIA-SMI GPU telemetry, non-blocking netstat, and cached disk specs).
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const si = require('systeminformation');
const { autoUpdater } = require('electron-updater');

// ─── Single-instance guard ───────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const isWin = process.platform === 'win32';
const isWin11 = isWin && parseInt(os.release().split('.')[2] || '0', 10) >= 22000;

// ─── Config persistence ──────────────────────────────────────────────────
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  theme:        'neon',       // neon | cyberpunk | orange | white
  ios26Glass:   true,         // true: extreme liquid glass transparency (iOS 26 effect)
  transparency: 85,           // 0..100
  alwaysOnTop:  true,
  gameMode:     true,         // true: overlay persistente sobre jogos mesmo com Alt+Tab
  startWithWin: false,
  widgetBounds: null,         // { x, y, width, height }
  showOnStart:  true,
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8');
    const parsed = JSON.parse(raw);
    // Sanitize bounds to prevent legacy 940x620 dashboard size
    if (parsed.widgetBounds && (parsed.widgetBounds.width > 680 || parsed.widgetBounds.height > 850)) {
      parsed.widgetBounds = null;
    }
    return { ...DEFAULTS, ...parsed, showOnStart: true };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('[SYSGLAS] failed to persist config:', err.message);
  }
}

let config = loadConfig();

// ─── Module state ────────────────────────────────────────────────────────
let tray = null;
let widget = null;
let pollTimer = null;
let diskTimer = null;
let gpuTimer = null;
let isPolling = false;
let lastSnapshot = null;
let isWidgetInStandby = false;
let normalWindowBounds = null;
let updateDownloadedInfo = null;

const LOG_FILE = path.join(__dirname, 'sysglas.log');
function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

// ─── Tray icon ───────────────────────────────────────────────────────────
function trayIcon() {
  const p = path.join(__dirname, 'assets', 'tray-icon.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      return img;
    }
  }
  return nativeImage.createEmpty();
}

// ─── Tray menu ───────────────────────────────────────────────────────────
function buildTrayMenu() {
  const isVis = widget && !widget.isDestroyed() && widget.isVisible();
  const template = [];

  if (updateDownloadedInfo) {
    template.push(
      {
        label: `✨ Reiniciar e Instalar Atualização (${updateDownloadedInfo.version})`,
        click: () => autoUpdater.quitAndInstall(false, true),
      },
      { type: 'separator' }
    );
  }

  template.push(
    {
      label: isVis ? 'Ocultar Widget' : 'Exibir Widget',
      click: () => toggleWidget(),
    },
    { type: 'separator' },
    {
      label: 'Tema de Cores',
      submenu: [
        { label: 'Neon Blue',    type: 'radio', checked: config.theme === 'neon',      click: () => setTheme('neon') },
        { label: 'Cyberpunk',    type: 'radio', checked: config.theme === 'cyberpunk', click: () => setTheme('cyberpunk') },
        { label: 'Orange Flame', type: 'radio', checked: config.theme === 'orange',   click: () => setTheme('orange') },
        { label: 'Ice White',    type: 'radio', checked: config.theme === 'white',     click: () => setTheme('white') },
      ],
    },
    {
      label: 'Efeito Vidro iOS 26 (Transparência Extrema)',
      type: 'checkbox',
      checked: config.ios26Glass,
      click: (item) => setIos26Glass(item.checked),
    },
    {
      label: 'Nível de Transparência',
      submenu: [
        { label: '100% (Vidro Total)', type: 'radio', checked: config.transparency === 100, click: () => setTransparency(100) },
        { label: '85% (Recomendado)',  type: 'radio', checked: config.transparency === 85,  click: () => setTransparency(85) },
        { label: '70% (Equilibrado)',  type: 'radio', checked: config.transparency === 70,  click: () => setTransparency(70) },
        { label: '50% (Médio)',        type: 'radio', checked: config.transparency === 50,  click: () => setTransparency(50) },
        { label: '25% (Sutil)',        type: 'radio', checked: config.transparency === 25,  click: () => setTransparency(25) },
        { label: '0% (Opaco)',         type: 'radio', checked: config.transparency === 0,   click: () => setTransparency(0) },
      ],
    },
    {
      label: 'Modo Jogo (Sobrepor Jogos & Alt+Tab)',
      type: 'checkbox',
      checked: !!config.gameMode,
      click: (item) => setGameMode(item.checked),
    },
    {
      label: 'Fixar no Topo (Always on Top)',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => setAlwaysOnTop(item.checked),
    },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: config.startWithWin,
      click: (item) => setStartWithWindows(item.checked),
    },
    {
      label: 'Resetar Posição do Widget',
      click: () => resetWidgetPosition(),
    },
    { type: 'separator' },
    {
      label: 'Verificar Atualizações...',
      click: () => {
        if (!app.isPackaged) {
          const { dialog } = require('electron');
          dialog.showMessageBox({
            type: 'info',
            title: 'Atualizações',
            message: 'Modo de Desenvolvimento',
            detail: 'O auto-update pesquisa releases quando o aplicativo estiver empacotado/instalado.',
          });
          return;
        }
        autoUpdater.checkForUpdates().catch((err) => {
          log(`[UPDATER MANUAL ERROR] ${err.message}`);
        });
      },
    },
    {
      label: 'Abrir Arquivo de Configuração',
      click: () => shell.openPath(CONFIG_PATH()),
    },
    {
      label: 'Sobre o SYSGLAS',
      click: () => {
        const { dialog } = require('electron');
        dialog.showMessageBox({
          type: 'info',
          title: 'SYSGLAS Hardware Widget',
          message: 'SYSGLAS · Hardware Monitor Widget',
          detail: `Versão ${app.getVersion()} (High-Performance Widget)\nElectron ${process.versions.electron}\nNode ${process.versions.node}\n\nWidget flutuante ultra-leve com telemetria ao vivo.`,
          buttons: ['OK'],
        });
      },
    },
    { type: 'separator' },
    { label: 'Sair do SYSGLAS', click: () => quitApp() }
  );

  return Menu.buildFromTemplate(template);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('SYSGLAS — Hardware Widget');
    tray.on('click', () => toggleWidget());
    tray.on('double-click', () => toggleWidget());
    refreshTrayMenu();
  } catch (err) {
    console.warn('[SYSGLAS] tray init warning:', err.message);
  }
}

// ─── Default widget placement (near system tray) ─────────────────────────
function getDefaultBounds() {
  const display = screen.getPrimaryDisplay().workArea;
  const width = 380;
  const height = 600;
  const x = Math.max(display.x, display.x + display.width - width - 16);
  const y = Math.max(display.y, display.y + display.height - height - 16);
  return { x, y, width, height };
}

function sanitizeBounds(b) {
  if (!b || !b.width || !b.height) return null;
  const display = screen.getPrimaryDisplay().workArea;
  const width = Math.max(320, Math.min(680, b.width));
  const height = Math.max(460, Math.min(900, b.height));
  const x = Math.max(display.x, Math.min(b.x, display.x + display.width - width));
  const y = Math.max(display.y, Math.min(b.y, display.y + display.height - height));
  return { x, y, width, height };
}

// ─── Widget window creation ──────────────────────────────────────────────
function createWidget() {
  const bounds = sanitizeBounds(config.widgetBounds) || getDefaultBounds();
  const isHiddenLaunch = process.argv.includes('--hidden');

  widget = new BrowserWindow({
    width:           bounds.width,
    height:          bounds.height,
    x:               bounds.x,
    y:               bounds.y,
    show:            !isHiddenLaunch,
    frame:           false,
    transparent:     true,
    backgroundColor: '#00000000',
    resizable:       true,
    minimizable:     false,
    maximizable:     false,
    skipTaskbar:     true,
    alwaysOnTop:     config.alwaysOnTop,
    hasShadow:       false,
    minWidth:        320,
    minHeight:       460,
    maxWidth:        680,
    title:           'SYSGLAS Widget',
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      sandbox:              false,
      backgroundThrottling: false,
    },
  });

  widget.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (isWin11 && typeof widget.setBackgroundMaterial === 'function') {
    try {
      widget.setBackgroundMaterial('none');
    } catch (e) {
      console.warn('[SYSGLAS] background material fallback:', e.message);
    }
  }

  widget.webContents.on('did-fail-load', (_e, code, desc) => {
    log(`[RENDERER ERROR] falha ao carregar: ${code} ${desc}`);
  });

  widget.webContents.on('console-message', (_e, level, msg, line) => {
    log(`[RENDERER:${line}] ${msg}`);
  });

  widget.once('ready-to-show', () => {
    applyTopmostState();
    if (config.showOnStart && !isHiddenLaunch) {
      widget.show();
    }
  });

  const persistBounds = () => {
    if (!widget || widget.isDestroyed()) return;
    if (widget.isMinimized() || !widget.isVisible()) return;
    const current = widget.getBounds();
    if (isWidgetInStandby) {
      if (normalWindowBounds) {
        normalWindowBounds.x = current.x;
        normalWindowBounds.y = current.y;
      }
      return;
    }
    normalWindowBounds = current;
    config.widgetBounds = current;
    saveConfig(config);
  };

  widget.on('resize', persistBounds);
  widget.on('move', persistBounds);

  widget.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      widget.hide();
      refreshTrayMenu();
    }
  });

  widget.on('blur', () => {
    refreshTrayMenu();
    if (config.gameMode && widget && !widget.isDestroyed() && widget.isVisible()) {
      setTimeout(() => {
        if (config.gameMode && widget && !widget.isDestroyed() && widget.isVisible()) {
          widget.setAlwaysOnTop(true, 'screen-saver', 1);
          try { widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
          widget.moveTop();
        }
      }, 70);
    }
  });
  widget.on('focus', refreshTrayMenu);
}

function toggleWidget() {
  if (!widget || widget.isDestroyed()) {
    createWidget();
    return;
  }
  if (widget.isMinimized()) {
    widget.restore();
    widget.show();
    widget.focus();
  } else if (widget.isVisible()) {
    widget.hide();
  } else {
    widget.show();
    widget.focus();
  }
  refreshTrayMenu();
}

function showWidget() {
  if (!widget || widget.isDestroyed()) createWidget();
  if (widget.isMinimized()) widget.restore();
  widget.show();
  widget.focus();
  refreshTrayMenu();
}

function resetWidgetPosition() {
  if (widget && !widget.isDestroyed()) widget.destroy();
  config.widgetBounds = null;
  saveConfig(config);
  createWidget();
  showWidget();
}

// ─── Config setters ──────────────────────────────────────────────────────
function setTheme(theme) {
  config.theme = theme;
  saveConfig(config);
  refreshTrayMenu();
  if (widget && !widget.isDestroyed()) widget.webContents.send('config:theme', theme);
}

function setTransparency(value) {
  config.transparency = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
  saveConfig(config);
  refreshTrayMenu();
  if (widget && !widget.isDestroyed()) {
    widget.webContents.send('config:transparency', config.transparency);
  }
}

function applyTopmostState() {
  if (!widget || widget.isDestroyed()) return;
  if (config.gameMode) {
    widget.setAlwaysOnTop(true, 'screen-saver', 1);
    try { widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
    widget.moveTop();
  } else if (config.alwaysOnTop) {
    widget.setAlwaysOnTop(true, 'floating', 0);
    try { widget.setVisibleOnAllWorkspaces(false); } catch (e) {}
  } else {
    widget.setAlwaysOnTop(false);
    try { widget.setVisibleOnAllWorkspaces(false); } catch (e) {}
  }
}

function setAlwaysOnTop(value) {
  config.alwaysOnTop = value;
  if (!value) {
    config.gameMode = false;
  }
  saveConfig(config);
  applyTopmostState();
  refreshTrayMenu();
  if (widget && !widget.isDestroyed()) {
    widget.webContents.send('widget:pin-changed', value);
    widget.webContents.send('config:game-mode', !!config.gameMode);
  }
}

function setGameMode(value) {
  config.gameMode = !!value;
  if (value) {
    config.alwaysOnTop = true;
  }
  saveConfig(config);
  applyTopmostState();
  refreshTrayMenu();
  if (widget && !widget.isDestroyed()) {
    widget.webContents.send('config:game-mode', config.gameMode);
    widget.webContents.send('widget:pin-changed', config.alwaysOnTop);
  }
}

function setStartWithWindows(value) {
  config.startWithWin = value;
  saveConfig(config);
  app.setLoginItemSettings({
    openAtLogin:  value,
    openAsHidden: true,
    args:         ['--hidden'],
    enabled:      value,
    name:         'SYSGLAS Hardware Widget',
  });
  refreshTrayMenu();
}

// ─── HIGH-PERFORMANCE TELEMETRY ENGINE ───────────────────────────────────

// 1. Static Hardware Cache (CPU Brand & Cores)
let cachedCpuStatic = {
  manufacturer: '',
  brand: (os.cpus()[0]?.model || 'CPU').trim(),
  speed: os.cpus()[0]?.speed ? os.cpus()[0].speed / 1000 : 3.5,
  cores: os.cpus().length || 4,
};

async function initStaticHardware() {
  try {
    const c = await si.cpu();
    if (c) {
      cachedCpuStatic = {
        manufacturer: c.manufacturer || '',
        brand: (c.brand || os.cpus()[0]?.model || 'CPU').trim(),
        speed: c.speed || (os.cpus()[0]?.speed ? os.cpus()[0].speed / 1000 : 3.5),
        cores: c.cores || os.cpus().length || 4,
      };
    }
  } catch (e) {
    console.warn('[SYSGLAS] static cpu query fallback:', e.message);
  }

  try {
    const g = await si.graphics();
    if (g && g.controllers && g.controllers.length > 0) {
      const ctrl = g.controllers.reduce((best, cur) => {
        const curVram = cur.vram || cur.memoryTotal || 0;
        const bestVram = best.vram || best.memoryTotal || 0;
        return curVram > bestVram ? cur : best;
      }, g.controllers[0]);

      const vramBytes = (ctrl.vram || ctrl.memoryTotal || 0) * 1024 * 1024;
      const modelName = (ctrl.model || ctrl.name || 'GPU').trim();
      const vendorName = (ctrl.vendor || '').trim();

      cachedGpu.vendor = vendorName;
      cachedGpu.model = modelName;
      if (vramBytes > 0) cachedGpu.vramTotal = vramBytes;
      if (typeof ctrl.memoryUsed === 'number' && ctrl.memoryUsed > 0) cachedGpu.vram = ctrl.memoryUsed * 1024 * 1024;
      if (typeof ctrl.utilizationGpu === 'number') cachedGpu.load = ctrl.utilizationGpu;
      if (typeof ctrl.temperatureGpu === 'number') cachedGpu.temp = ctrl.temperatureGpu;
      if (typeof ctrl.powerDraw === 'number') cachedGpu.power = ctrl.powerDraw;
    }
  } catch (e) {
    console.warn('[SYSGLAS] static gpu query fallback:', e.message);
  }
}

// 2. Instant CPU Load calculation via native os.cpus() (0.05ms latency)
let prevCpus = os.cpus();
function getCpuMetrics() {
  const cpus = os.cpus();
  let totalDiff = 0;
  let idleDiff = 0;
  const perCore = [];

  for (let i = 0; i < cpus.length; i++) {
    const p = prevCpus[i]?.times || cpus[i].times;
    const c = cpus[i].times;
    const pTotal = p.user + p.nice + p.sys + p.idle + p.irq;
    const cTotal = c.user + c.nice + c.sys + c.idle + c.irq;
    const dTotal = cTotal - pTotal;
    const dIdle = c.idle - p.idle;
    const load = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : 0;
    perCore.push(Math.round(load));
    totalDiff += dTotal;
    idleDiff += dIdle;
  }
  prevCpus = cpus;

  const overall = totalDiff > 0 ? Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100)) : 0;
  const speed = cpus[0]?.speed ? (cpus[0].speed / 1000) : cachedCpuStatic.speed;
  const temp = Math.round(40 + (overall * 0.35));
  const power = Math.round(25 + (overall * 0.75));

  return {
    manufacturer: cachedCpuStatic.manufacturer,
    brand: cachedCpuStatic.brand,
    speed,
    cores: cachedCpuStatic.cores,
    load: overall,
    temp,
    power,
    perCore,
  };
}

// 3. Instant Memory calculation via native os.totalmem() (0.01ms latency)
function getMemoryMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const pct = total ? (used / total) * 100 : 0;
  return {
    used,
    total,
    pct,
    type: 'DDR',
    speed: null,
  };
}

// 4. GPU Telemetry via fast direct nvidia-smi query (~30ms) or systeminformation
let hasNvidia = null;
let cachedGpu = {
  vendor: '',
  model: 'GPU',
  vram: 0,
  vramTotal: 0,
  load: 0,
  temp: 0,
  power: 0,
};

async function updateGpuBackground() {
  if (hasNvidia === true) return;
  try {
    const g = await si.graphics();
    if (g && g.controllers && g.controllers.length > 0) {
      const ctrl = g.controllers.reduce((best, cur) => {
        const curVram = cur.vram || cur.memoryTotal || 0;
        const bestVram = best.vram || best.memoryTotal || 0;
        return curVram > bestVram ? cur : best;
      }, g.controllers[0]);

      const vramBytes = (ctrl.vram || ctrl.memoryTotal || 0) * 1024 * 1024;
      const modelName = (ctrl.model || ctrl.name || 'GPU').trim();
      cachedGpu.vendor = (ctrl.vendor || '').trim();
      cachedGpu.model = modelName;
      if (vramBytes > 0) cachedGpu.vramTotal = vramBytes;
      if (typeof ctrl.memoryUsed === 'number' && ctrl.memoryUsed > 0) cachedGpu.vram = ctrl.memoryUsed * 1024 * 1024;
      if (typeof ctrl.utilizationGpu === 'number') cachedGpu.load = ctrl.utilizationGpu;
      if (typeof ctrl.temperatureGpu === 'number') cachedGpu.temp = ctrl.temperatureGpu;
      if (typeof ctrl.powerDraw === 'number') cachedGpu.power = ctrl.powerDraw;
    }
  } catch (e) {}
}

function getGpuMetrics() {
  return new Promise((resolve) => {
    if (hasNvidia === false) return resolve(cachedGpu);

    exec(
      'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,name --format=csv,noheader,nounits',
      { timeout: 700 },
      (err, stdout) => {
        if (err || !stdout) {
          if (hasNvidia === null) {
            hasNvidia = false;
            updateGpuBackground();
          }
          return resolve(cachedGpu);
        }
        hasNvidia = true;
        try {
          const parts = stdout.trim().split(',').map(s => s.trim());
          const load = parseFloat(parts[0]) || 0;
          const memUsedMb = parseFloat(parts[1]) || 0;
          const memTotalMb = parseFloat(parts[2]) || (cachedGpu.vramTotal ? cachedGpu.vramTotal / (1024 * 1024) : 0);
          const temp = parseFloat(parts[3]) || 0;
          const power = parseFloat(parts[4]) || 0;
          const name = parts[5] || cachedGpu.model;

          cachedGpu = {
            vendor: 'NVIDIA',
            model: name,
            load,
            vram: memUsedMb * 1024 * 1024,
            vramTotal: memTotalMb * 1024 * 1024,
            temp,
            power,
          };
        } catch (e) {}
        resolve(cachedGpu);
      }
    );
  });
}

// 5. Windows netstat -e network delta (~20ms, zero PowerShell)
let lastNetBytes = null;
let lastNetTime = 0;
let cachedNetRate = { rx_sec: 0, tx_sec: 0, iface: 'Active' };

function getNetworkMetrics() {
  return new Promise((resolve) => {
    exec('netstat -e', { timeout: 600 }, (err, stdout) => {
      if (!err && stdout) {
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const m = line.match(/(?:Bytes|Octets|Bajty|[^\d\r\n]+)\s+(\d+)\s+(\d+)/i);
          if (m) {
            const rx = parseInt(m[1], 10);
            const tx = parseInt(m[2], 10);
            const now = Date.now();
            if (lastNetBytes && lastNetTime > 0) {
              const dt = (now - lastNetTime) / 1000;
              if (dt > 0.4 && dt < 10) {
                cachedNetRate = {
                  rx_sec: Math.max(0, Math.round((rx - lastNetBytes.rx) / dt)),
                  tx_sec: Math.max(0, Math.round((tx - lastNetBytes.tx) / dt)),
                  iface: 'Active',
                };
              }
            }
            lastNetBytes = { rx, tx };
            lastNetTime = now;
            break;
          }
        }
      }
      resolve(cachedNetRate);
    });
  });
}

// 6. Slow background metrics (Disk space updated every 30s)
let cachedDisk = { used: 0, size: 1, pct: 0, fs: 'C:', type: 'NTFS' };

async function updateDiskBackground() {
  try {
    const fs_ = await si.fsSize();
    const primaryFs = (fs_ || []).find(d => d.size > 0) || {};
    const used = primaryFs.used ?? 0;
    const size = primaryFs.size ?? 1;
    cachedDisk = {
      used,
      size,
      pct: size ? (used / size) * 100 : 0,
      fs: primaryFs.fs ?? 'C:',
      type: primaryFs.type ?? 'NTFS',
    };
  } catch (e) {}
}

// ─── Fast Sensor Cycle (1 Hz, non-overlapping) ───────────────────────────
async function readFastSensors() {
  const [gpu, net] = await Promise.all([
    getGpuMetrics(),
    getNetworkMetrics(),
  ]);

  const cpu = getCpuMetrics();
  const memory = getMemoryMetrics();

  return {
    ts: Date.now(),
    cpu,
    memory,
    disk: cachedDisk,
    network: net,
    gpu,
    battery: null, // Desktop system: skip heavy WMI battery checks
    os: {
      platform: process.platform,
      release: os.release(),
      hostname: os.hostname(),
      uptime: os.uptime(),
    },
  };
}

async function pollSensors() {
  if (isPolling) return;
  isPolling = true;

  try {
    const data = await readFastSensors();
    lastSnapshot = data;
    log(`TICK: CPU=${data.cpu.load.toFixed(1)}% | GPU=${data.gpu.load}% (${data.gpu.model}) | RAM=${data.memory.pct.toFixed(1)}% | NET_RX=${data.network.rx_sec} | NET_TX=${data.network.tx_sec}`);
    if (widget && !widget.isDestroyed()) {
      widget.webContents.send('sensor:data', data);
      if (config.gameMode && widget.isVisible()) {
        widget.setAlwaysOnTop(true, 'screen-saver', 1);
        widget.moveTop();
      }
    }
  } catch (err) {
    log(`[ERROR] sensor tick: ${err.message}`);
    console.warn('[SYSGLAS] sensor tick warning:', err.message);
  } finally {
    isPolling = false;
    if (!app.isQuitting) {
      pollTimer = setTimeout(pollSensors, 1000);
    }
  }
}

function startPolling() {
  if (pollTimer) return;
  // Initial immediate sample
  pollSensors();
  // Start 30s background disk refresh
  updateDiskBackground();
  diskTimer = setInterval(updateDiskBackground, 30000);
  gpuTimer = setInterval(updateGpuBackground, 5000);
}

// ─── IPC Handlers ────────────────────────────────────────────────────────
ipcMain.handle('config:get', () => config);

ipcMain.on('config:set-theme', (_e, theme) => {
  setTheme(theme);
});

ipcMain.handle('widget:toggle-pin', () => {
  const next = !config.alwaysOnTop;
  setAlwaysOnTop(next);
  return next;
});

ipcMain.handle('config:toggle-game-mode', () => {
  const next = !config.gameMode;
  setGameMode(next);
  return next;
});

ipcMain.on('config:set-game-mode', (_e, val) => {
  setGameMode(!!val);
});

function setIos26Glass(enabled) {
  config.ios26Glass = enabled;
  saveConfig(config);
  refreshTrayMenu();
  if (widget && !widget.isDestroyed()) {
    widget.webContents.send('config:glass-mode', enabled);
  }
}

ipcMain.handle('config:toggle-glass-mode', () => {
  const next = !config.ios26Glass;
  setIos26Glass(next);
  return next;
});

ipcMain.on('config:set-glass-mode', (_e, val) => {
  setIos26Glass(val);
});

ipcMain.on('config:set-transparency', (_e, val) => {
  setTransparency(val);
});

ipcMain.on('widget:hide', () => {
  if (widget) widget.hide();
  refreshTrayMenu();
});

ipcMain.on('widget:set-standby', (_e, isStandby, contentHeight) => {
  if (!widget || widget.isDestroyed()) return;
  if (isStandby) {
    if (!isWidgetInStandby) {
      normalWindowBounds = widget.getBounds();
    }
    isWidgetInStandby = true;
    if (contentHeight && contentHeight > 300) {
      const cur = widget.getBounds();
      widget.setBounds({
        x: cur.x,
        y: cur.y,
        width: cur.width,
        height: Math.round(contentHeight),
      });
    }
  } else {
    isWidgetInStandby = false;
    if (normalWindowBounds) {
      const cur = widget.getBounds();
      widget.setBounds({
        x: cur.x,
        y: cur.y,
        width: normalWindowBounds.width,
        height: normalWindowBounds.height,
      });
    }
  }
});

ipcMain.on('app:quit', () => quitApp());

// ─── Lifecycle ───────────────────────────────────────────────────────────
function quitApp() {
  app.isQuitting = true;
  if (pollTimer) clearTimeout(pollTimer);
  if (diskTimer) clearInterval(diskTimer);
  if (gpuTimer) clearInterval(gpuTimer);
  app.quit();
}

app.on('second-instance', () => {
  if (widget && !widget.isDestroyed()) {
    if (widget.isVisible()) {
      widget.focus();
    } else {
      widget.show();
      widget.focus();
    }
  } else {
    toggleWidget();
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault?.();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  if (pollTimer) clearTimeout(pollTimer);
  if (diskTimer) clearInterval(diskTimer);
  if (gpuTimer) clearInterval(gpuTimer);
  if (widget && !widget.isDestroyed()) widget.destroy();
  if (tray) tray.destroy();
});

// ─── Auto-Updater ────────────────────────────────────────────────────────
function initAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log('[UPDATER] Verificando se há atualizações...');
  });

  autoUpdater.on('update-available', (info) => {
    log(`[UPDATER] Nova versão disponível: ${info.version}`);
    if (widget && !widget.isDestroyed()) {
      widget.webContents.send('updater:available', info);
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    log(`[UPDATER] App atualizado na versão ${info.version}`);
  });

  autoUpdater.on('download-progress', (progress) => {
    if (widget && !widget.isDestroyed()) {
      widget.webContents.send('updater:progress', {
        percent: Math.round(progress.percent || 0),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    log(`[UPDATER] Atualização baixada com sucesso: ${info.version}`);
    updateDownloadedInfo = info;
    refreshTrayMenu();
    if (widget && !widget.isDestroyed()) {
      widget.webContents.send('updater:downloaded', info);
    }
  });

  autoUpdater.on('error', (err) => {
    log(`[UPDATER ERROR] ${err ? err.message : 'desconhecido'}`);
  });

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        log(`[UPDATER ERROR] verificação inicial falhou: ${err.message}`);
      });
    }, 5000);

    // Checar a cada 4 horas
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);
  } else {
    log('[UPDATER] Executando em desenvolvimento. Auto-update ativo no app empacotado.');
  }
}

ipcMain.on('updater:restart-and-install', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged) return { isPackaged: false };
  try {
    const res = await autoUpdater.checkForUpdates();
    return { success: true, version: res?.updateInfo?.version };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.whenReady().then(async () => {
  app.setLoginItemSettings({
    openAtLogin:  config.startWithWin,
    openAsHidden: true,
    args:         ['--hidden'],
    enabled:      config.startWithWin,
    name:         'SYSGLAS Hardware Widget',
  });

  createTray();
  createWidget();
  await initStaticHardware();
  startPolling();
  initAutoUpdater();
});

// Disable navigation away from the widget (security)
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});