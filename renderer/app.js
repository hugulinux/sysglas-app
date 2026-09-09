// app.js — SYSGLAS Hardware Widget Renderer
// High-performance live telemetry renderer with local Chart.js
'use strict';

const $ = (s, p = document) => p.querySelector(s);
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 40; // r=40 in SVG

// ── Chart.js Global Config ──────────────────────────────────────────────
if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = "'JetBrains Mono', monospace";
  Chart.defaults.font.size = 8;
  Chart.defaults.color = 'rgba(255, 255, 255, 0.4)';
  Chart.defaults.animation = {
    duration: 850,
    easing: 'linear',
  };
}

const accentRgb = () => getComputedStyle(document.body).getPropertyValue('--accent-rgb').trim() || '0, 229, 255';
const accent2Rgb = () => getComputedStyle(document.body).getPropertyValue('--accent-2-rgb').trim() || '255, 122, 0';

function setGauge(id, pct) {
  const el = document.getElementById(id);
  if (el) {
    const clamped = Math.max(0, Math.min(100, pct || 0));
    el.style.strokeDashoffset = GAUGE_CIRCUMFERENCE * (1 - clamped / 100);
  }
}

// ── Chart Constructors ──────────────────────────────────────────────────
function createSparkline(canvas, rgb, length = 24) {
  if (!canvas || typeof Chart === 'undefined') return null;
  return new Chart(canvas, {
    type: 'line',
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 850,
        easing: 'linear',
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false, min: 0 } },
      elements: {
        point: { radius: 0 },
        line: { tension: 0.35, borderWidth: 1.5, borderColor: `rgb(${rgb})` },
      },
    },
    data: {
      labels: Array.from({ length }, (_, i) => i),
      datasets: [{
        data: Array.from({ length }, () => 0),
        backgroundColor: (ctx) => {
          const c = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height || 35);
          c.addColorStop(0, `rgba(${rgb}, 0.35)`);
          c.addColorStop(1, `rgba(${rgb}, 0.0)`);
          return c;
        },
        fill: true,
      }],
    },
  });
}

function createAreaChart(canvas, rgb, length = 30) {
  if (!canvas || typeof Chart === 'undefined') return null;
  return new Chart(canvas, {
    type: 'line',
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 850,
        easing: 'linear',
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false, min: 0, max: 100 },
      },
      elements: {
        point: { radius: 0 },
        line: { tension: 0.3, borderWidth: 1.8, borderColor: `rgb(${rgb})` },
      },
    },
    data: {
      labels: Array.from({ length }, (_, i) => i),
      datasets: [{
        data: Array.from({ length }, () => 0),
        backgroundColor: (ctx) => {
          const c = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height || 50);
          c.addColorStop(0, `rgba(${rgb}, 0.35)`);
          c.addColorStop(1, `rgba(${rgb}, 0.0)`);
          return c;
        },
        fill: true,
      }],
    },
  });
}

let sparkCpu = null;
let chartGpuLoad = null;
let sparkNet = null;

try {
  sparkCpu = createSparkline($('#spark-cpu'), accentRgb(), 24);
  chartGpuLoad = createAreaChart($('#chart-gpu-load'), accent2Rgb(), 30);
  sparkNet = createSparkline($('#spark-net'), accentRgb(), 24);
} catch (e) {
  console.warn('Charts init warning:', e);
}

function refreshChartColors() {
  const a1 = accentRgb();
  const a2 = accent2Rgb();
  if (sparkCpu) {
    sparkCpu.options.elements.line.borderColor = `rgb(${a1})`;
    sparkCpu.update('none');
  }
  if (chartGpuLoad) {
    chartGpuLoad.options.elements.line.borderColor = `rgb(${a2})`;
    chartGpuLoad.update('none');
  }
  if (sparkNet) {
    sparkNet.options.elements.line.borderColor = `rgb(${a1})`;
    sparkNet.update('none');
  }
}

function pushPoint(chart, val) {
  if (!chart || !chart.data || !chart.data.datasets[0]) return;
  const arr = chart.data.datasets[0].data;
  arr.push(val);
  arr.shift();
  chart.update();
}

// ── Formatting Helpers ──────────────────────────────────────────────────
const fmtBytes = (b) => {
  if (!b || isNaN(b) || b < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

const fmtRate = (b) => `${fmtBytes(b)}/s`;
const fmtGB = (b) => (!b || isNaN(b)) ? '0' : (b / (1024 * 1024 * 1024)).toFixed(1);

const fmtUptime = (s) => {
  if (!s || isNaN(s)) return '0m';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (ts) => {
  const d = new Date(ts || Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// ── Smooth 60fps Interpolator (LERP) ────────────────────────────────────
// Even though sensors poll once every 1000ms, the UI glides at 60fps
const lerp = (a, b, t) => a + (b - a) * t;

const animState = {
  cpuLoad: 0,
  cpuTemp: 40,
  cpuFreq: 3.5,
  cpuPower: 25,
  gpuLoad: 0,
  gpuTemp: 50,
  gpuPower: 35,
  vramUsed: 0,
  vramTotal: 8 * 1024 * 1024 * 1024,
  memUsed: 0,
  memTotal: 16 * 1024 * 1024 * 1024,
  memPct: 0,
  diskUsed: 0,
  diskTotal: 500 * 1024 * 1024 * 1024,
  diskPct: 0,
  netRx: 0,
  netTx: 0,
};

const targetState = { ...animState };
let lastAnimTime = performance.now();
let isAnimLoopRunning = false;

function startAnimationLoop() {
  if (isAnimLoopRunning) return;
  isAnimLoopRunning = true;
  lastAnimTime = performance.now();

  function renderLoop(now) {
    const dt = Math.min((now - lastAnimTime) / 1000, 0.1);
    lastAnimTime = now;

    // Smooth exponential decay: reaches ~95% in 600ms, cleanly settling before next 1000ms tick
    const factor = 1 - Math.exp(-8 * dt);

    animState.cpuLoad = lerp(animState.cpuLoad, targetState.cpuLoad, factor);
    animState.cpuTemp = lerp(animState.cpuTemp, targetState.cpuTemp, factor);
    animState.cpuFreq = lerp(animState.cpuFreq, targetState.cpuFreq, factor);
    animState.cpuPower = lerp(animState.cpuPower, targetState.cpuPower, factor);

    animState.gpuLoad = lerp(animState.gpuLoad, targetState.gpuLoad, factor);
    animState.gpuTemp = lerp(animState.gpuTemp, targetState.gpuTemp, factor);
    animState.gpuPower = lerp(animState.gpuPower, targetState.gpuPower, factor);
    animState.vramUsed = lerp(animState.vramUsed, targetState.vramUsed, factor);

    animState.memUsed = lerp(animState.memUsed, targetState.memUsed, factor);
    animState.memPct = lerp(animState.memPct, targetState.memPct, factor);

    animState.diskUsed = lerp(animState.diskUsed, targetState.diskUsed, factor);
    animState.diskPct = lerp(animState.diskPct, targetState.diskPct, factor);

    animState.netRx = lerp(animState.netRx, targetState.netRx, factor);
    animState.netTx = lerp(animState.netTx, targetState.netTx, factor);

    // 1. CPU values
    const cpuLoadInt = Math.round(animState.cpuLoad);
    const elCpuV = $('#g-cpu-v');
    if (elCpuV) elCpuV.textContent = `${cpuLoadInt}%`;

    const elTempV = $('#g-temp-v');
    if (elTempV) elTempV.textContent = `${Math.round(animState.cpuTemp)}°C`;

    const elFreqV = $('#g-freq-v');
    if (elFreqV) elFreqV.textContent = `${animState.cpuFreq.toFixed(1)} GHz`;

    const elPowerV = $('#g-power-v');
    if (elPowerV) elPowerV.textContent = `${Math.round(animState.cpuPower)} W`;

    // 2. GPU values
    const gpuLoadInt = Math.round(animState.gpuLoad);
    const elGpuLoad = $('#gpu-load-v');
    if (elGpuLoad) elGpuLoad.textContent = `${gpuLoadInt}%`;

    const elGpuTemp = $('#gpu-temp-v');
    if (elGpuTemp) elGpuTemp.textContent = `${Math.round(animState.gpuTemp)}°C`;

    const elGpuPower = $('#gpu-power-v');
    if (elGpuPower) elGpuPower.textContent = `${Math.round(animState.gpuPower)} W`;

    const vramPct = targetState.vramTotal ? Math.round((animState.vramUsed / targetState.vramTotal) * 100) : 0;
    const elGpuVram = $('#gpu-vram-v');
    if (elGpuVram) elGpuVram.textContent = `${fmtGB(animState.vramUsed)} / ${fmtGB(targetState.vramTotal)} GB (${vramPct}%)`;

    // 3. RAM & Disk values
    const elMemV = $('#mem-v');
    if (elMemV) elMemV.textContent = `${fmtGB(animState.memUsed)} / ${fmtGB(targetState.memTotal)} GB`;

    const elMemPct = $('#mem-pct');
    if (elMemPct) elMemPct.textContent = `${Math.round(animState.memPct)}%`;

    const elDiskV = $('#disk-v');
    if (elDiskV) elDiskV.textContent = `${fmtGB(animState.diskUsed)} / ${fmtGB(targetState.diskTotal)} GB`;

    const elDiskPct = $('#disk-pct');
    if (elDiskPct) elDiskPct.textContent = `${Math.round(animState.diskPct)}%`;

    // 4. Network values
    const elRx = $('#net-rx-v');
    if (elRx) elRx.textContent = fmtRate(animState.netRx);

    const elTx = $('#net-tx-v');
    if (elTx) elTx.textContent = fmtRate(animState.netTx);

    const elRate = $('#net-rate-v');
    if (elRate) elRate.textContent = fmtRate(animState.netRx + animState.netTx);

    requestAnimationFrame(renderLoop);
  }

  requestAnimationFrame(renderLoop);
}

// ── Main Update Handler ─────────────────────────────────────────────────
let hasReceivedFirstData = false;

function update(data) {
  if (!data) return;

  // 1. CPU Telemetry
  const cpu = data.cpu || {};
  const cpuModel = cpu.brand || 'CPU';
  const cpuModelEl = $('#cpu-model');
  if (cpuModelEl) {
    cpuModelEl.textContent = cpuModel.replace(/\(R\)|\(TM\)|Processor|CPU/gi, '').trim();
    cpuModelEl.title = cpuModel;
  }

  const cpuLoad = Math.max(0, Math.min(100, cpu.load || 0));
  setGauge('g-cpu', cpuLoad);

  const cpuTemp = cpu.temp || Math.round(40 + (cpuLoad * 0.35));
  const cpuFreq = Number(cpu.speed || 3.5);
  const cpuPower = cpu.power || Math.round(25 + (cpuLoad * 0.7));
  const cpuCores = cpu.cores || 6;
  const cpuCoresEl = $('#cpu-cores-v');
  if (cpuCoresEl) cpuCoresEl.textContent = `${cpuCores} Threads`;

  targetState.cpuLoad = cpuLoad;
  targetState.cpuTemp = cpuTemp;
  targetState.cpuFreq = cpuFreq;
  targetState.cpuPower = cpuPower;

  pushPoint(sparkCpu, cpuLoad);

  // 2. GPU Telemetry
  const gpu = data.gpu || {};
  const gpuModel = gpu.model || 'GPU';
  const gpuModelEl = $('#gpu-model');
  if (gpuModelEl) {
    gpuModelEl.textContent = gpuModel.replace(/NVIDIA|GeForce|Graphics/gi, '').trim() || 'RTX 3060 Ti';
    gpuModelEl.title = gpuModel;
  }

  const gpuLoad = Math.max(0, Math.min(100, gpu.load ?? (cpuLoad * 0.7)));
  const gpuTemp = gpu.temp || 50;
  const gpuPower = gpu.power || 35;
  const vramUsed = gpu.vram || 0;
  const vramTotal = gpu.vramTotal || (8 * 1024 * 1024 * 1024);
  const vramPct = vramTotal ? Math.round((vramUsed / vramTotal) * 100) : 0;

  targetState.gpuLoad = gpuLoad;
  targetState.gpuTemp = gpuTemp;
  targetState.gpuPower = gpuPower;
  targetState.vramUsed = vramUsed;
  targetState.vramTotal = vramTotal;

  const gpuVramBar = $('#gpu-vram-bar');
  if (gpuVramBar) gpuVramBar.style.width = `${vramPct}%`;
  pushPoint(chartGpuLoad, gpuLoad);

  // 3. Memory & Disk Telemetry
  const mem = data.memory || {};
  const memTotal = mem.total || 1;
  const memUsed = mem.used || 0;
  const memPct = Math.min(100, Math.round(mem.pct || ((memUsed / memTotal) * 100)));

  targetState.memUsed = memUsed;
  targetState.memTotal = memTotal;
  targetState.memPct = memPct;
  const memBar = $('#mem-bar');
  if (memBar) memBar.style.width = `${memPct}%`;

  const disk = data.disk || {};
  const diskTotal = disk.size || 1;
  const diskUsed = disk.used || 0;
  const diskPct = Math.min(100, Math.round(disk.pct || (diskTotal ? (diskUsed / diskTotal) * 100 : 0)));

  targetState.diskUsed = diskUsed;
  targetState.diskTotal = diskTotal;
  targetState.diskPct = diskPct;
  const diskBar = $('#disk-bar');
  if (diskBar) diskBar.style.width = `${diskPct}%`;

  // 4. Network Telemetry
  const net = data.network || {};
  const rx = net.rx_sec || 0;
  const tx = net.tx_sec || 0;

  targetState.netRx = rx;
  targetState.netTx = tx;

  const netSparkVal = Math.min(100, Math.round(((rx + tx) / (10 * 1024 * 1024)) * 100));
  pushPoint(sparkNet, netSparkVal);

  // 5. System & Meta
  const os = data.os || {};
  const elUptime = $('#uptime-v');
  if (elUptime) elUptime.textContent = `Uptime: ${fmtUptime(os.uptime || 0)}`;
  if (os.hostname) {
    const elOs = $('#os-meta');
    if (elOs) elOs.textContent = `${os.platform} · ${os.release || ''}`;
  }
  const tsEl = $('#update-ts');
  if (tsEl) tsEl.textContent = fmtTime(data.ts);

  // Dismiss loading screen & snap initial values on first payload
  if (!hasReceivedFirstData) {
    hasReceivedFirstData = true;
    Object.assign(animState, targetState);
    console.log('[RENDERER] Primeiro snapshot de telemetria recebido com sucesso: CPU=' + (data.cpu ? data.cpu.load : 'N/A') + '%');
    const loading = document.getElementById('loading');
    if (loading) {
      loading.classList.add('hidden');
      setTimeout(() => loading.style.display = 'none', 300);
    }
    // Trigger chart resize once layout is computed
    setTimeout(() => {
      [sparkCpu, chartGpuLoad, sparkNet].forEach(c => { try { c && c.resize(); } catch (e) {} });
    }, 50);
    startAnimationLoop();
  }
}

// ── Transparency Controller (0% a 100%) ─────────────────────────────────
function applyTransparency(pct) {
  const val = Math.max(0, Math.min(100, Math.round(Number(pct) ?? 85)));
  const t = val / 100; // 0 = 0% transparência (opaco / sólido), 1 = 100% transparência (cristalino puro)

  // Quanto MAIS transparência (t -> 1), MENOS efeito de vidro / blur / opacidade:
  // Em 100% (t = 1): blur = 0px (zero embaçado), fundos = 0.00 (visão direta e limpa do wallpaper)
  // Em 0% (t = 0): blur = 12px, fundos = 0.95 (opaco escuro elegante)
  const factor = Math.pow(1 - t, 1.8);

  const shellAlpha = (0.95 * factor).toFixed(3);     // 0% -> 0.950, 50% -> 0.270, 85% -> 0.040, 100% -> 0.000
  const cardAlpha = (0.85 * factor).toFixed(3);      // 0% -> 0.850, 50% -> 0.240, 85% -> 0.035, 100% -> 0.000
  const headerAlpha = (0.75 * factor).toFixed(3);    // 0% -> 0.750, 50% -> 0.210, 85% -> 0.030, 100% -> 0.000
  const subAlpha = (0.28 * factor).toFixed(3);       // 0% -> 0.280, 50% -> 0.080, 85% -> 0.010, 100% -> 0.000

  // Bordas delicadas para delinear os cartões
  const rimAlpha = (0.08 + (1 - t) * 0.16).toFixed(3); // 0% -> 0.240, 100% -> 0.080

  // Blur diminui até 0px conforme a transparência aumenta (eliminando o blur embaçado)
  const blurVal = Math.max(0, (1 - t) * 12).toFixed(1);
  const glassBlur = `${blurVal}px`;                  // 0% -> 12px, 50% -> 6px, 85% -> 1.8px, 100% -> 0px
  const cardBlur = `${(blurVal * 0.5).toFixed(1)}px`; // 0% -> 6px,  50% -> 3px, 85% -> 0.9px, 100% -> 0px

  const root = document.documentElement;
  root.style.setProperty('--shell-alpha', shellAlpha);
  root.style.setProperty('--card-alpha', cardAlpha);
  root.style.setProperty('--header-alpha', headerAlpha);
  root.style.setProperty('--sub-alpha', subAlpha);
  root.style.setProperty('--rim-alpha', rimAlpha);
  root.style.setProperty('--glass-blur', glassBlur);
  root.style.setProperty('--card-blur', cardBlur);

  const slider = document.getElementById('opacity-range');
  if (slider && Number(slider.value) !== val) {
    slider.value = val;
  }
  const valText = document.getElementById('opacity-val-text');
  if (valText) {
    valText.textContent = `${val}%`;
  }

  document.querySelectorAll('.preset-chips .chip').forEach((chip) => {
    const chipVal = Number(chip.getAttribute('data-val'));
    chip.classList.toggle('active', chipVal === val);
  });
}

// ── Widget Bootstrap & Controls ─────────────────────────────────────────
async function init() {
  console.log('[RENDERER] Inicializando frontend do widget SYSGLAS...');
  const themes = ['neon', 'cyberpunk', 'orange', 'white'];
  let currentTheme = 'neon';
  let isPinned = true;
  let isGlassMode = true;
  let isGameMode = true;
  let currentTransparency = 85;

  try {
    const cfg = await window.sysglas.getConfig();
    if (cfg.theme && themes.includes(cfg.theme)) {
      currentTheme = cfg.theme;
    }
    document.body.setAttribute('data-theme', currentTheme);

    if (typeof cfg.ios26Glass === 'boolean') {
      isGlassMode = cfg.ios26Glass;
    }
    document.body.setAttribute('data-glass', isGlassMode ? 'true' : 'false');
    updateGlassButtonState(isGlassMode);

    if (typeof cfg.transparency === 'number') {
      currentTransparency = cfg.transparency;
    }
    applyTransparency(currentTransparency);

    if (typeof cfg.alwaysOnTop === 'boolean') {
      isPinned = cfg.alwaysOnTop;
      updatePinButtonState(isPinned);
    }

    if (typeof cfg.gameMode === 'boolean') {
      isGameMode = cfg.gameMode;
    } else {
      isGameMode = true;
    }
    updateGameButtonState(isGameMode);
  } catch (err) {
    console.warn('Config fetch warning:', err);
    applyTransparency(85);
  }

  // Subscribe to live telemetry
  window.sysglas.onSensorData(update);

  // Listen to external theme changes (from tray)
  window.sysglas.onTheme((theme) => {
    currentTheme = theme;
    document.body.setAttribute('data-theme', theme);
    refreshChartColors();
  });

  // Listen to glass mode changes (from tray)
  if (window.sysglas.onGlassMode) {
    window.sysglas.onGlassMode((enabled) => {
      isGlassMode = enabled;
      document.body.setAttribute('data-glass', isGlassMode ? 'true' : 'false');
      updateGlassButtonState(isGlassMode);
      refreshChartColors();
    });
  }

  // Listen to transparency updates (from tray)
  if (window.sysglas.onTransparency) {
    window.sysglas.onTransparency((val) => {
      currentTransparency = val;
      applyTransparency(val);
    });
  }

  // Listen to pin changes
  if (window.sysglas.onPinChanged) {
    window.sysglas.onPinChanged((pinned) => {
      isPinned = pinned;
      updatePinButtonState(isPinned);
    });
  }

  // Listen to game mode changes
  if (window.sysglas.onGameMode) {
    window.sysglas.onGameMode((enabled) => {
      isGameMode = enabled;
      updateGameButtonState(enabled);
      if (enabled) {
        isPinned = true;
        updatePinButtonState(true);
      }
    });
  }

  // Theme quick-switcher button
  const themeBtn = $('#theme-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const nextIdx = (themes.indexOf(currentTheme) + 1) % themes.length;
      currentTheme = themes[nextIdx];
      document.body.setAttribute('data-theme', currentTheme);
      refreshChartColors();
      if (window.sysglas.setTheme) {
        window.sysglas.setTheme(currentTheme);
      }
    });
  }

  // iOS 26 Glass Mode toggle button
  const glassBtn = $('#glass-btn');
  if (glassBtn) {
    glassBtn.addEventListener('click', async () => {
      if (window.sysglas.toggleGlassMode) {
        isGlassMode = await window.sysglas.toggleGlassMode();
        document.body.setAttribute('data-glass', isGlassMode ? 'true' : 'false');
        updateGlassButtonState(isGlassMode);
        refreshChartColors();
      }
    });
  }

  function updateGlassButtonState(enabled) {
    const btn = $('#glass-btn');
    if (!btn) return;
    if (enabled) {
      btn.classList.add('active');
      btn.title = 'Modo Vidro iOS 26 ATIVO (Transparência Extrema)';
    } else {
      btn.classList.remove('active');
      btn.title = 'Modo Vidro iOS 26 DESATIVADO (Clique para ativar)';
    }
  }

  // Opacity drawer toggle button
  const opacityBtn = $('#opacity-btn');
  const opacityDrawer = $('#opacity-drawer');
  if (opacityBtn && opacityDrawer) {
    opacityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = opacityDrawer.classList.toggle('hidden');
      opacityBtn.classList.toggle('active', !isHidden);
      if (!isHidden) {
        cancelStandbyTimer();
      } else {
        resetStandbyTimer();
      }
    });

    // Close drawer when clicking outside
    document.addEventListener('click', (e) => {
      if (!opacityDrawer.classList.contains('hidden') &&
          !opacityDrawer.contains(e.target) &&
          !opacityBtn.contains(e.target)) {
        opacityDrawer.classList.add('hidden');
        opacityBtn.classList.remove('active');
        resetStandbyTimer();
      }
    });
  }

  // Opacity Range Slider (0% a 100%)
  const opacitySlider = $('#opacity-range');
  if (opacitySlider) {
    // Instant live update while dragging slider
    opacitySlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      currentTransparency = val;
      applyTransparency(val);
      if (val > 0 && !isGlassMode && window.sysglas.setGlassMode) {
        isGlassMode = true;
        document.body.setAttribute('data-glass', 'true');
        updateGlassButtonState(true);
        window.sysglas.setGlassMode(true);
      }
    });

    // Persist to config when released
    opacitySlider.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      if (window.sysglas.setTransparency) {
        window.sysglas.setTransparency(val);
      }
    });
  }

  // Preset chips (0%, 30%, 50%, 70%, 85%, 100%)
  document.querySelectorAll('.preset-chips .chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = parseInt(chip.getAttribute('data-val'), 10);
      currentTransparency = val;
      applyTransparency(val);
      if (val > 0 && !isGlassMode && window.sysglas.setGlassMode) {
        isGlassMode = true;
        document.body.setAttribute('data-glass', 'true');
        updateGlassButtonState(true);
        window.sysglas.setGlassMode(true);
      }
      if (window.sysglas.setTransparency) {
        window.sysglas.setTransparency(val);
      }
      cancelStandbyTimer();
    });
  });

  // Pin toggle button
  const pinBtn = $('#pin-btn');
  if (pinBtn) {
    pinBtn.addEventListener('click', async () => {
      if (window.sysglas.togglePin) {
        isPinned = await window.sysglas.togglePin();
        updatePinButtonState(isPinned);
      }
    });
  }

  function updatePinButtonState(pinned) {
    const btn = $('#pin-btn');
    if (!btn) return;
    if (pinned) {
      btn.classList.add('active');
      btn.title = 'Widget fixado no topo (clique para desafixar)';
    } else {
      btn.classList.remove('active');
      btn.title = 'Widget não fixado (clique para fixar no topo)';
    }
  }

  // Modo Jogo toggle button (Sobrepor jogos & Alt+Tab)
  const gameBtn = $('#game-btn');
  if (gameBtn) {
    gameBtn.addEventListener('click', async () => {
      if (window.sysglas.toggleGameMode) {
        isGameMode = await window.sysglas.toggleGameMode();
        updateGameButtonState(isGameMode);
        if (isGameMode) {
          isPinned = true;
          updatePinButtonState(true);
        }
      }
    });
  }

  function updateGameButtonState(enabled) {
    const btn = $('#game-btn');
    if (!btn) return;
    if (enabled) {
      btn.classList.add('active');
      btn.title = 'Modo Jogo ATIVO (Fixado sobre jogos e Alt+Tab)';
    } else {
      btn.classList.remove('active');
      btn.title = 'Modo Jogo DESATIVADO (Clique para sobrepor jogos)';
    }
  }

  // Hide button
  const hideBtn = $('#hide-btn');
  if (hideBtn) {
    hideBtn.addEventListener('click', () => {
      window.sysglas.hideWidget();
    });
  }

  // ── MODO STANDBY (Oculta menus após inatividade; pausa enquanto o mouse estiver em uso) ───
  let standbyTimer = null;
  let isStandby = false;

  function calculateStandbyHeight() {
    const cardNet = document.getElementById('card-net');
    if (cardNet) {
      const rect = cardNet.getBoundingClientRect();
      const bodyRect = document.body.getBoundingClientRect();
      const h = Math.ceil(rect.bottom - bodyRect.top + 8);
      if (h > 200 && h < 900) return h;
    }
    const widgetBody = document.querySelector('.widget-body');
    if (widgetBody) {
      return Math.ceil(widgetBody.scrollHeight + 16);
    }
    return 510;
  }

  function isUserInteractingWithControls() {
    const opacityDrawer = $('#opacity-drawer');
    const isDrawerOpen = opacityDrawer && !opacityDrawer.classList.contains('hidden');
    const header = $('.widget-header');
    const isHoveringHeader = header && header.matches(':hover');
    const isHoveringDrawer = opacityDrawer && opacityDrawer.matches(':hover');
    return Boolean(isDrawerOpen || isHoveringHeader || isHoveringDrawer);
  }

  function cancelStandbyTimer() {
    if (standbyTimer) {
      clearTimeout(standbyTimer);
      standbyTimer = null;
    }
  }

  function enterStandby() {
    if (isStandby) return;

    // Se o usuário estiver mexendo nos menus ou a gaveta estiver aberta, adiar o standby
    if (isUserInteractingWithControls()) {
      return;
    }

    isStandby = true;
    document.body.classList.add('standby');
    const opacityDrawer = $('#opacity-drawer');
    const opacityBtn = $('#opacity-btn');
    if (opacityDrawer) opacityDrawer.classList.add('hidden');
    if (opacityBtn) opacityBtn.classList.remove('active');

    // Aguarda o recolhimento do cabeçalho/gaveta para calcular a altura exata dos cartões
    setTimeout(() => {
      if (!isStandby) return;
      const targetH = calculateStandbyHeight();
      if (window.sysglas.setStandby) {
        window.sysglas.setStandby(true, targetH);
      }
    }, 60);
  }

  function exitStandby() {
    if (!isStandby) return;
    isStandby = false;
    document.body.classList.remove('standby');
    if (window.sysglas.setStandby) {
      window.sysglas.setStandby(false);
    }
    resetStandbyTimer();
  }

  function resetStandbyTimer() {
    cancelStandbyTimer();
    if (isStandby) return;

    // Se estiver interagindo com controles/menus/gaveta, não inicia a contagem
    if (isUserInteractingWithControls()) {
      return;
    }

    standbyTimer = setTimeout(() => {
      enterStandby();
    }, 3000);
  }

  // Pausar o timer sempre que o mouse entrar nos menus / controles
  const widgetHeader = $('.widget-header');
  const opacityDrawerEl = $('#opacity-drawer');

  if (widgetHeader) {
    widgetHeader.addEventListener('pointerenter', () => cancelStandbyTimer());
    widgetHeader.addEventListener('pointerleave', () => resetStandbyTimer());
  }

  if (opacityDrawerEl) {
    opacityDrawerEl.addEventListener('pointerenter', () => cancelStandbyTimer());
    opacityDrawerEl.addEventListener('pointerleave', () => resetStandbyTimer());
  }

  // Enquanto o mouse estiver se movendo pelo app, adia o standby
  document.addEventListener('pointermove', () => {
    if (isStandby) return;
    if (isUserInteractingWithControls()) {
      cancelStandbyTimer();
    } else {
      resetStandbyTimer();
    }
  });

  // Clicar em qualquer ponto do app restaura o menu se estiver em standby, ou reinicia/pausa o timer
  document.addEventListener('pointerdown', () => {
    if (isStandby) {
      exitStandby();
    } else if (isUserInteractingWithControls()) {
      cancelStandbyTimer();
    } else {
      resetStandbyTimer();
    }
  });

  document.addEventListener('click', () => {
    if (isStandby) {
      exitStandby();
    } else if (isUserInteractingWithControls()) {
      cancelStandbyTimer();
    } else {
      resetStandbyTimer();
    }
  });

  // Quando o mouse sair da janela do widget
  document.addEventListener('pointerleave', () => {
    if (!isStandby) {
      resetStandbyTimer();
    }
  });

  // Manter ativo e pausar timer enquanto arrasta o slider
  if (opacitySlider) {
    opacitySlider.addEventListener('input', () => cancelStandbyTimer());
    opacitySlider.addEventListener('change', () => {
      if (!isUserInteractingWithControls()) resetStandbyTimer();
    });
  }

  // Ativado como padrão: entra em standby após 3 segundos sem interação
  resetStandbyTimer();

  // Initial colors
  setTimeout(refreshChartColors, 60);
}

init();