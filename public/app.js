'use strict';

(() => {
  const WINDOW = 60;
  const COLORS = {
    cpu: '#4cc2ff',
    mem: '#b48ee6',
    disk: '#3ddc97',
    read: '#5b9dff',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    info: null,
    samples: [],
    networkSeries: [],
    view: 'overview',
    cpuMode: 'total',
    cpuCoreCharts: [],
    diskName: null,
    diskSig: '',
    diskRows: [],
    live: false,
    page: 'overview',
    health: null,
    healthPolling: 0,
    transfers: new Map(),
    transferHistory: new Map(),
    cards: new Map(),
    cardSig: '',
    searchQuery: '',
    processes: null,
    processSort: { key: 'cpu', dir: 'desc' },
    processQuery: '',
    processTree: null,
    treeExpanded: new Set(),
    treeInitialized: false,
    remote: null,
    users: null,
    services: null,
    network: null,
    servicesQuery: '',
    networkQuery: '',
  };

  const charts = {};
  const diskCharts = new Map();

  /* ------------------------------------------------------------------ */
  /* 格式化                                                              */
  /* ------------------------------------------------------------------ */

  const GB = 1024 ** 3;

  function pad60(arr) {
    const rest = arr.slice(-WINDOW);
    return rest.length === WINDOW
      ? rest
      : new Array(WINDOW - rest.length).fill(null).concat(rest);
  }

  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    const digits = i === 0 || value >= 100 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[i]}`;
  }

  function fmtRate(bytes) {
    return `${fmtBytes(bytes)}/s`;
  }

  function fmtGB(bytes, digits = 1) {
    return (bytes / GB).toFixed(digits);
  }

  function pct(value, digits = 0) {
    if (!Number.isFinite(value)) return '—';
    return `${value.toFixed(digits)}%`;
  }

  function fmtUptime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d}:${pad(h)}:${pad(m)}:${pad(ss)}`;
  }

  function prettyMount(mount) {
    if (!mount) return '';
    return mount.replace(/^\/home\/[^/]+/, '~');
  }

  function mountText(mounts) {
    if (!mounts || !mounts.length) return '未挂载';
    if (mounts.includes('/')) return '/';
    const first = prettyMount(mounts[0]);
    return mounts.length > 1 ? `${first} 等 ${mounts.length} 个` : first;
  }

  function setText(sel, value) {
    const el = $(sel);
    if (!el) return;
    const text = String(value);
    if (el.textContent !== text) el.textContent = text;
  }

  function withAlpha(hex, alpha) {
    const raw = hex.replace('#', '');
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    const n = parseInt(full, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function niceMax(value) {
    if (!(value > 0)) return 1;
    const exp = Math.floor(Math.log10(value));
    const base = 10 ** exp;
    const f = value / base;
    const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const nf = steps.find((s) => f <= s) || 10;
    return nf * base;
  }

  /* ------------------------------------------------------------------ */
  /* 轻量 Canvas 折线 / 面积图                                            */
  /* ------------------------------------------------------------------ */

  class Chart {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign(
        {
          window: WINDOW,
          max: null,
          min: 0,
          minScale: 0,
          grid: true,
          labels: false,
          yLabels: false,
          yFormat: null,
          hover: false,
          tooltip: null,
          series: [{ color: COLORS.cpu, fill: true }],
        },
        options
      );
      this.data = this.opts.series.map(() => []);
      this.scaleMax = this.opts.max || 1;
      this.hoverIndex = -1;
      this.size = { w: 0, h: 0 };

      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);

      if (this.opts.hover) this.bindHover();
      this.resize();
    }

    destroy() {
      this.ro.disconnect();
    }

    pad() {
      const showY = this.opts.labels || this.opts.yLabels;
      return {
        t: 7,
        r: 8,
        b: this.opts.labels ? 19 : showY ? 9 : 4,
        l: showY ? 54 : 4,
      };
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (!w || !h) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pxW = Math.round(w * dpr);
      const pxH = Math.round(h * dpr);
      if (this.canvas.width !== pxW) this.canvas.width = pxW;
      if (this.canvas.height !== pxH) this.canvas.height = pxH;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.size = { w, h };
      this.draw();
    }

    setData(arrays) {
      this.data = arrays.map((arr) => {
        const rest = (arr || []).slice(-this.opts.window);
        return rest.length === this.opts.window
          ? rest
          : new Array(this.opts.window - rest.length).fill(null).concat(rest);
      });
      this.scaleMax = this.computeScale();
      this.draw();
    }

    setSeries(series) {
      this.opts.series = series;
      this.data = series.map(() => []);
      this.draw();
    }

    computeScale() {
      if (this.opts.max != null) return this.opts.max;
      let max = 0;
      for (const arr of this.data) {
        for (const v of arr) if (v != null && v > max) max = v;
      }
      const floor = this.opts.minScale || 1;
      return niceMax(Math.max(max * 1.08, floor));
    }

    bindHover() {
      const canvas = this.canvas;
      canvas.style.touchAction = 'none';

      canvas.addEventListener('pointermove', (e) => {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width) return;
        const pad = this.pad();
        const plotW = rect.width - pad.l - pad.r;
        const rel = (e.clientX - rect.left - pad.l) / plotW;
        const index = Math.round(rel * (this.opts.window - 1));
        if (index < 0 || index > this.opts.window - 1) return;

        this.hoverIndex = index;
        this.draw();
        if (this.opts.tooltip) {
          this.opts.tooltip({
            index,
            values: this.data.map((arr) => arr[index]),
            x: e.clientX,
            y: e.clientY,
          });
        }
      });

      canvas.addEventListener('pointerleave', () => {
        this.hoverIndex = -1;
        this.draw();
        if (this.opts.tooltip) this.opts.tooltip(null);
      });
    }

    draw() {
      const { ctx, size } = this;
      if (!size.w || !size.h) return;

      const { w, h } = size;
      const pad = this.pad();
      const x0 = pad.l;
      const y0 = pad.t;
      const plotW = w - pad.l - pad.r;
      const plotH = h - pad.t - pad.b;
      if (plotW <= 2 || plotH <= 2) return;

      ctx.clearRect(0, 0, w, h);

      if (this.opts.grid) {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= 4; i += 1) {
          const y = Math.round(y0 + (plotH * i) / 4) + 0.5;
          ctx.moveTo(x0, y);
          ctx.lineTo(x0 + plotW, y);
        }
        for (let i = 0; i <= 4; i += 1) {
          const x = Math.round(x0 + (plotW * i) / 4) + 0.5;
          ctx.moveTo(x, y0);
          ctx.lineTo(x, y0 + plotH);
        }
        ctx.stroke();
      }

      const min = this.opts.min;
      const max = Math.max(this.scaleMax, min + 1e-9);
      const stepX = this.opts.window > 1 ? plotW / (this.opts.window - 1) : plotW;
      const xOf = (i) => x0 + i * stepX;
      const yOf = (v) => {
        const clamped = Math.min(max, Math.max(min, v));
        return y0 + plotH - ((clamped - min) / (max - min)) * plotH;
      };

      this.opts.series.forEach((series, si) => {
        const arr = this.data[si] || [];

        if (series.fill) {
          const points = [];
          for (let i = 0; i < arr.length; i += 1) {
            const v = arr[i];
            if (v == null) continue;
            points.push([xOf(i), yOf(v)]);
          }
          if (points.length) {
            let topY = points[0][1];
            for (const point of points) if (point[1] < topY) topY = point[1];
            ctx.beginPath();
            ctx.moveTo(points[0][0], y0 + plotH);
            for (const point of points) ctx.lineTo(point[0], point[1]);
            ctx.lineTo(points[points.length - 1][0], y0 + plotH);
            ctx.closePath();
            const grad = ctx.createLinearGradient(0, topY, 0, y0 + plotH);
            grad.addColorStop(0, withAlpha(series.color, 0.34));
            grad.addColorStop(1, withAlpha(series.color, 0.03));
            ctx.fillStyle = grad;
            ctx.fill();
          }
        }

        let started = false;
        ctx.beginPath();
        for (let i = 0; i < arr.length; i += 1) {
          const v = arr[i];
          if (v == null) {
            started = false;
            continue;
          }
          const x = xOf(i);
          const y = yOf(v);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.lineWidth = series.width || 1.6;
        ctx.strokeStyle = series.color;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      });

      if (this.hoverIndex >= 0) {
        const i = this.hoverIndex;
        const x = xOf(i);
        ctx.strokeStyle = 'rgba(255,255,255,0.26)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, y0);
        ctx.lineTo(Math.round(x) + 0.5, y0 + plotH);
        ctx.stroke();

        this.opts.series.forEach((series, si) => {
          const v = (this.data[si] || [])[i];
          if (v == null) return;
          ctx.beginPath();
          ctx.arc(x, yOf(v), 2.8, 0, Math.PI * 2);
          ctx.fillStyle = series.color;
          ctx.fill();
          ctx.strokeStyle = '#1b1b1b';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        });
      }

      const labelFont = '10px "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei UI", sans-serif';
      if (this.opts.labels || this.opts.yLabels) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = labelFont;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const yFormat = this.opts.yFormat || ((v) => String(Math.round(v)));
        for (let i = 0; i <= 4; i += 1) {
          const value = max - ((max - min) * i) / 4;
          const y = y0 + (plotH * i) / 4;
          ctx.fillText(yFormat(value), x0 - 7, y);
        }
      }

      if (this.opts.labels) {
        ctx.fillStyle = 'rgba(255,255,255,0.38)';
        ctx.font = labelFont;
        ctx.textBaseline = 'alphabetic';
        const xLabels = ['60 秒前', '45 秒前', '30 秒前', '15 秒前', '现在'];
        for (let i = 0; i < xLabels.length; i += 1) {
          const x = x0 + (plotW * i) / (xLabels.length - 1);
          ctx.textAlign = i === 0 ? 'left' : i === xLabels.length - 1 ? 'right' : 'center';
          ctx.fillText(xLabels[i], x, h - 4);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 提示气泡                                                            */
  /* ------------------------------------------------------------------ */

  function timeLabel(index) {
    const secs = WINDOW - 1 - index;
    return secs <= 0 ? '现在' : `${secs} 秒前`;
  }

  function showTooltip(title, rows, x, y) {
    const el = $('#tooltip');
    el.innerHTML =
      `<div class="tt-title">${title}</div>` +
      rows
        .map(
          (row) =>
            `<div class="tt-row"><i style="background:${row.color}"></i>` +
            `<span>${row.label}</span><b>${row.value}</b></div>`
        )
        .join('');
    el.hidden = false;

    const rect = el.getBoundingClientRect();
    let left = x + 16;
    let top = y + 16;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 16;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - 16;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }

  function hideTooltip() {
    $('#tooltip').hidden = true;
  }

  function cpuTooltip(payload) {
    if (!payload) return hideTooltip();
    const value = payload.values[0];
    showTooltip(
      timeLabel(payload.index),
      [{ color: COLORS.cpu, label: '利用率', value: value == null ? '—' : pct(value) }],
      payload.x,
      payload.y
    );
  }

  const CPU_CORE_COLORS = ['#4cc2ff', '#3ddc97', '#f0b24a', '#b48ee6', '#ff6b6b', '#6fd3e8', '#c7d36f', '#e89ad0'];

  function cpuCoreColor(index) {
    return CPU_CORE_COLORS[index % CPU_CORE_COLORS.length];
  }

  function cpuGridShape(count) {
    const cols = count <= 4 ? Math.min(2, Math.max(1, count)) : 4;
    return { cols, rows: Math.ceil(count / cols) };
  }

  function cpuCoreTooltip(index, color) {
    return (payload) => {
      if (!payload) return hideTooltip();
      const value = payload.values[0];
      showTooltip(
        timeLabel(payload.index),
        [{ color, label: `CPU ${index}`, value: value == null ? '—' : pct(value) }],
        payload.x,
        payload.y
      );
    };
  }

  function ensureCpuCoreGrid(count) {
    const grid = $('#cpuCoresGrid');
    if (!grid) return;
    const { cols, rows } = cpuGridShape(count);
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    if (state.cpuCoreCharts.length === count && grid.children.length === count) return;

    grid.innerHTML = '';
    state.cpuCoreCharts = [];
    for (let index = 0; index < count; index += 1) {
      const color = cpuCoreColor(index);
      const card = document.createElement('div');
      card.className = 'cpu-core-card';
      card.innerHTML =
        `<div class="cpu-core-card-head">` +
        `<span class="cpu-core-card-name"><i style="background:${color}"></i>CPU ${index}</span>` +
        `<span class="cpu-core-card-val">--</span>` +
        `</div>` +
        `<div class="cpu-core-chart"><canvas></canvas></div>`;
      grid.appendChild(card);
      const chart = new Chart(card.querySelector('canvas'), {
        max: 100,
        grid: true,
        labels: false,
        minScale: 0,
        hover: true,
        tooltip: cpuCoreTooltip(index, color),
        series: [{ color, fill: true, width: 1.3 }],
      });
      state.cpuCoreCharts.push({ chart, valueEl: card.querySelector('.cpu-core-card-val') });
    }
    requestAnimationFrame(() => {
      state.cpuCoreCharts.forEach((entry) => entry.chart.resize());
    });
  }

  function updateCpuPerformance(last, cpuSeries) {
    const cores = (last.cpu && last.cpu.perCore) || [];
    const coresMode = state.cpuMode === 'cores' && cores.length > 0;
    const totalPanel = $('#cpuTotalPanel');
    const coresGrid = $('#cpuCoresGrid');
    if (totalPanel) totalPanel.hidden = coresMode;
    if (coresGrid) coresGrid.hidden = !coresMode;

    if (coresMode) {
      ensureCpuCoreGrid(cores.length);
      const arrays = cores.map((_, index) =>
        pad60(state.samples.map((sample) => sample.cpu.perCore?.[index] ?? null))
      );
      state.cpuCoreCharts.forEach((entry, index) => {
        entry.chart.setData([arrays[index]]);
        entry.valueEl.textContent = pct(cores[index]);
      });
      requestAnimationFrame(() => {
        state.cpuCoreCharts.forEach((entry) => entry.chart.resize());
      });
    } else if (charts.cpu) {
      charts.cpu.setSeries([{ color: COLORS.cpu, fill: true, width: 1.6 }]);
      charts.cpu.opts.tooltip = cpuTooltip;
      charts.cpu.setData([cpuSeries]);
    }
  }

  function setCpuMode(mode) {
    state.cpuMode = mode === 'cores' ? 'cores' : 'total';
    $$('#cpuModeToggle [data-cpu-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.cpuMode === state.cpuMode);
    });
    savePageState();
    render();
  }

  function memTooltip(payload) {
    if (!payload) return hideTooltip();
    const value = payload.values[0];
    showTooltip(
      timeLabel(payload.index),
      [{ color: COLORS.mem, label: '使用率', value: value == null ? '—' : pct(value) }],
      payload.x,
      payload.y
    );
  }

  function diskTooltip(payload) {
    if (!payload) return hideTooltip();
    const write = payload.values[0];
    const read = payload.values[1];
    showTooltip(
      timeLabel(payload.index),
      [
        { color: COLORS.disk, label: '写入', value: write == null ? '—' : fmtRate(write) },
        { color: COLORS.read, label: '读取', value: read == null ? '—' : fmtRate(read) },
      ],
      payload.x,
      payload.y
    );
  }

  function netTooltip(payload) {
    if (!payload) return hideTooltip();
    const down = payload.values[0];
    const up = payload.values[1];
    showTooltip(
      timeLabel(payload.index),
      [
        { color: COLORS.read, label: '下载', value: down == null ? '—' : fmtRate(down) },
        { color: COLORS.disk, label: '上传', value: up == null ? '—' : fmtRate(up) },
      ],
      payload.x,
      payload.y
    );
  }

  /* ------------------------------------------------------------------ */
  /* 图表初始化                                                          */
  /* ------------------------------------------------------------------ */

  function initCharts() {
    charts.sideCpu = new Chart($('#sideCpuChart'), {
      max: 100,
      grid: false,
      series: [{ color: COLORS.cpu, fill: true }],
    });
    charts.sideMem = new Chart($('#sideMemChart'), {
      max: 100,
      grid: false,
      series: [{ color: COLORS.mem, fill: true }],
    });
    charts.sideNet = new Chart($('#sideNetChart'), {
      minScale: 1024,
      grid: false,
      series: [
        { color: COLORS.read, fill: true, width: 1.4 },
        { color: COLORS.disk, fill: false, width: 1.2 },
      ],
    });

    charts.ovCpu = new Chart($('#ovCpuChart'), {
      max: 100,
      yLabels: true,
      yFormat: (v) => `${Math.round(v)}%`,
      series: [{ color: COLORS.cpu, fill: true }],
    });
    charts.ovMem = new Chart($('#ovMemChart'), {
      max: 100,
      yLabels: true,
      yFormat: (v) => `${Math.round(v)}%`,
      series: [{ color: COLORS.mem, fill: true }],
    });
    charts.ovDisk = new Chart($('#ovDiskChart'), {
      minScale: 1024 * 1024,
      yLabels: true,
      yFormat: (v) => fmtRate(v),
      series: [
        { color: COLORS.disk, fill: true, width: 1.8 },
        { color: COLORS.read, fill: false, width: 1.3 },
      ],
    });
    charts.ovNet = new Chart($('#ovNetChart'), {
      minScale: 1024,
      yLabels: true,
      yFormat: (v) => fmtRate(v),
      series: [
        { color: COLORS.read, fill: true, width: 1.8 },
        { color: COLORS.disk, fill: false, width: 1.3 },
      ],
    });

    charts.cpu = new Chart($('#cpuChart'), {
      max: 100,
      labels: true,
      yFormat: (v) => `${Math.round(v)}%`,
      hover: true,
      tooltip: cpuTooltip,
      series: [{ color: COLORS.cpu, fill: true }],
    });
    charts.mem = new Chart($('#memChart'), {
      max: 100,
      labels: true,
      yFormat: (v) => `${Math.round(v)}%`,
      hover: true,
      tooltip: memTooltip,
      series: [{ color: COLORS.mem, fill: true }],
    });
    charts.disk = new Chart($('#diskChart'), {
      minScale: 1024 * 1024,
      labels: true,
      yFormat: (v) => fmtRate(v),
      hover: true,
      tooltip: diskTooltip,
      series: [
        { color: COLORS.disk, fill: true, width: 1.8 },
        { color: COLORS.read, fill: false, width: 1.3 },
      ],
    });
    charts.net = new Chart($('#netChart'), {
      minScale: 1024,
      labels: true,
      yFormat: (v) => fmtRate(v),
      hover: true,
      tooltip: netTooltip,
      series: [
        { color: COLORS.read, fill: true, width: 1.8 },
        { color: COLORS.disk, fill: false, width: 1.3 },
      ],
    });
    state.networkRow = {
      el: $('#resNetwork'),
      valEl: $('#resNetVal'),
      subEl: $('#resNetSub'),
    };
    const netCard = $('#ovNetCard');
    if (netCard) netCard.addEventListener('click', () => showView('network'));
  }

  /* ------------------------------------------------------------------ */
  /* 侧边栏磁盘条目                                                      */
  /* ------------------------------------------------------------------ */

  function makeDiskRow(name, title, subtitle, key) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'res-item';
    el.dataset.key = key;
    el.innerHTML =
      '<div class="res-top"><span class="res-name"></span><span class="res-val">--</span></div>' +
      '<div class="res-sub"></div>' +
      '<div class="mini-chart"><canvas></canvas></div>';

    el.querySelector('.res-name').textContent = title;
    const subEl = el.querySelector('.res-sub');
    subEl.textContent = subtitle;

    const chart = new Chart(el.querySelector('canvas'), {
      grid: false,
      minScale: 1024 * 1024,
      series: [{ color: COLORS.disk, fill: true }],
    });

    if (name === null) charts.sideDiskTotal = chart;
    else diskCharts.set(name, chart);

    state.diskRows.push({
      name,
      valEl: el.querySelector('.res-val'),
      subEl,
      dynamicSub: name !== null,
    });

    return el;
  }

  function buildDiskList(devices) {
    const sig = devices.map((d) => d.name).join(',');
    if (sig === state.diskSig) return;
    state.diskSig = sig;

    for (const chart of diskCharts.values()) chart.destroy();
    diskCharts.clear();
    if (charts.sideDiskTotal) {
      charts.sideDiskTotal.destroy();
      charts.sideDiskTotal = null;
    }
    state.diskRows = [];

    const wrap = $('#diskItems');
    wrap.innerHTML = '';

    wrap.appendChild(makeDiskRow(null, '磁盘', '全部物理磁盘', 'disk:total'));

    for (const dev of devices) {
      const mount = dev.mount && dev.mount.length ? prettyMount(dev.mount[0]) : '未挂载';
      wrap.appendChild(
        makeDiskRow(dev.name, `磁盘 ${dev.index} (${dev.name})`, mount, `disk:${dev.name}`)
      );
    }

    if (state.view === 'disk' && state.diskName) {
      const exists = devices.some((d) => d.name === state.diskName);
      if (!exists) state.diskName = null;
    }

    syncActive();
  }

  /* ------------------------------------------------------------------ */
  /* 视图切换                                                            */
  /* ------------------------------------------------------------------ */

  function syncActive() {
    const key = state.view === 'disk' ? `disk:${state.diskName || 'total'}` : state.view;
    $$('.res-item').forEach((el) => el.classList.toggle('active', el.dataset.key === key));
  }

  function viewCharts(view) {
    if (view === 'overview') return [charts.ovCpu, charts.ovMem, charts.ovDisk];
    if (view === 'cpu') return [charts.cpu];
    if (view === 'mem') return [charts.mem];
    if (view === 'network') return [charts.net];
    return [charts.disk];
  }

  function showView(view, diskName = null) {
    if (state.page !== 'performance') setPage('performance');
    hideTooltip();
    state.view = view;
    state.diskName = view === 'disk' ? diskName : null;
    savePageState();

    $$('.view').forEach((el) => {
      el.hidden = el.dataset.view !== view;
    });

    syncActive();
    if (view === 'disk') updateDiskStatic();

    requestAnimationFrame(() => {
      viewCharts(view).forEach((chart) => chart.resize());
      render();
    });
  }

  function updateDiskStatic() {
    const info = state.info;
    if (!info) return;

    const devices = info.devices || [];
    const dev = state.diskName ? devices.find((d) => d.name === state.diskName) : null;
    const totalSize = devices.reduce((sum, d) => sum + (d.sizeBytes || 0), 0);

    if (dev) {
      setText('#diskTitle', `磁盘 ${dev.index} (${dev.name})`);
      setText('#tblDiskDev', dev.name);
      setText('#tblDiskModel', dev.model);
      setText('#tblDiskType', dev.type);
      setText('#stDiskCap', fmtBytes(dev.sizeBytes));
      setText('#stDiskMount', mountText(dev.mount));
    } else {
      setText('#diskTitle', '磁盘（全部）');
      setText('#tblDiskDev', `${devices.length} 块`);
      setText('#tblDiskModel', '全部物理磁盘');
      setText('#tblDiskType', '—');
      setText('#stDiskCap', fmtBytes(totalSize));
      setText('#stDiskMount', '—');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 静态信息                                                            */
  /* ------------------------------------------------------------------ */

  function applyInfo(info) {
    if (!info) return;
    state.info = info;

    const cpu = info.cpu || {};
    setText('#cpuModel', cpu.model || '—');
    setText('#tblCpuModel', cpu.model || '—');
    setText('#ovCpuModel', cpu.model || '—');
    setText('#stCpuLogical', cpu.logical || '—');
    setText('#stCpuCores', cpu.physical || '—');
    setText('#ovCpuCores', cpu.logical || '—');
    setText(
      '#tblCpuBase',
      cpu.baseMHz ? `${(cpu.baseMHz / 1000).toFixed(2)} GHz` : '—'
    );

    const caches = cpu.caches || {};
    setText('#tblCpuL2', caches.L2 || '—');
    setText('#tblCpuL3', caches.L3 || '—');

    setText('#hostText', info.host || '—');
    setText('#sampleText', `${((info.sampleMs || 1000) / 1000).toFixed(1)} 秒`);

    buildDiskList(info.devices || []);
    buildDiskCards(info.devices || []);
    if (state.view === 'disk') updateDiskStatic();
    syncActive();
    render();
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function render() {
    const samples = state.samples;
    if (!samples.length || !state.info) return;

    const last = samples[samples.length - 1];
    const cpuCores = state.info.cpu ? state.info.cpu.logical : '—';
    const devices = state.info.devices || [];

    const cpuSeries = pad60(samples.map((s) => s.cpu.usage));
    const memSeries = pad60(
      samples.map((s) => (s.mem.total ? (s.mem.used / s.mem.total) * 100 : null))
    );
    const writeSeries = pad60(samples.map((s) => s.disk.total.writeBps));
    const readSeries = pad60(samples.map((s) => s.disk.total.readBps));

    charts.sideCpu.setData([cpuSeries]);
    charts.sideMem.setData([memSeries]);
    if (charts.sideDiskTotal) charts.sideDiskTotal.setData([writeSeries]);

    for (const [name, chart] of diskCharts) {
      chart.setData([
        pad60(
          samples.map((s) => {
            const d = s.disk.devices.find((item) => item.name === name);
            return d ? d.writeBps : 0;
          })
        ),
      ]);
    }

    charts.ovCpu.setData([cpuSeries]);
    charts.ovMem.setData([memSeries]);
    charts.ovDisk.setData([writeSeries, readSeries]);

    updateCpuPerformance(last, cpuSeries);
    charts.mem.setData([memSeries]);

    /* 侧边栏 */
    const speedText = last.cpu.speedMHz
      ? `${(last.cpu.speedMHz / 1000).toFixed(2)} GHz`
      : '—';
    setText('#resCpuVal', pct(last.cpu.usage));
    setText('#resCpuSub', speedText);

    const usedPct = last.mem.total ? (last.mem.used / last.mem.total) * 100 : 0;
    setText('#resMemVal', pct(usedPct));
    setText('#resMemSub', `${fmtGB(last.mem.used)} / ${fmtGB(last.mem.total)} GB`);

    setText(
      '#resOverviewVal',
      `写 ${fmtRate(last.disk.total.writeBps)} · 读 ${fmtRate(last.disk.total.readBps)}`
    );
    setText('#resOverviewSub', `CPU ${pct(last.cpu.usage)} · 内存 ${pct(usedPct)}`);

    for (const row of state.diskRows) {
      if (row.name === null) {
        row.valEl.textContent =
          `写 ${fmtRate(last.disk.total.writeBps)} · 读 ${fmtRate(last.disk.total.readBps)}`;
        row.subEl.textContent = `活动时间占比 ${pct(last.disk.total.busy)}`;
      } else {
        const dev = last.disk.devices.find((item) => item.name === row.name);
        row.valEl.textContent = dev
          ? `写 ${fmtRate(dev.writeBps)} · 读 ${fmtRate(dev.readBps)}`
          : '—';
        row.subEl.textContent = dev ? `活动时间占比 ${pct(dev.busy)}` : '—';
      }
    }

    updateDiskCardIo(last.disk.devices || []);

    /* 概览卡片 */
    setText('#ovCpuPct', pct(last.cpu.usage));
    setText('#ovCpuMeta', `${speedText} · ${cpuCores} 线程`);
    setText('#ovCpuProcs', last.cpu.procs);
    setText('#ovCpuThreads', last.cpu.threads);

    setText('#ovMemPct', pct(usedPct));
    setText('#ovMemMeta', `${fmtGB(last.mem.used)} / ${fmtGB(last.mem.total)} GB`);
    setText('#ovMemUsed', `${fmtGB(last.mem.used)} GB`);
    setText('#ovMemAvail', `${fmtGB(last.mem.available)} GB`);
    setText('#ovMemCached', `${fmtGB(last.mem.cached)} GB`);
    setText(
      '#ovMemSwap',
      last.mem.swapTotal ? `${fmtGB(last.mem.swapUsed)} GB` : '未启用'
    );

    setText('#ovDiskWrite', fmtRate(last.disk.total.writeBps));
    setText('#ovDiskRead', fmtRate(last.disk.total.readBps));
    setText('#ovDiskMeta', `活动时间占比 ${pct(last.disk.total.busy)}`);
    setText('#ovDiskCount', devices.length);
    setText(
      '#ovDiskCap',
      fmtBytes(devices.reduce((sum, d) => sum + (d.sizeBytes || 0), 0))
    );
    setText('#ovDiskIops', last.disk.total.iops.toFixed(1));
    setText('#ovDiskBusy', pct(last.disk.total.busy));

    /* CPU 详情 */
    setText('#cpuPct', pct(last.cpu.usage));
    setText('#cpuSpeedInline', speedText);
    setText('#stCpuUsage', pct(last.cpu.usage));
    setText('#stCpuSpeed', speedText);
    setText('#stCpuProcs', last.cpu.procs);
    setText('#stCpuThreads', last.cpu.threads);
    setText('#stCpuUptime', fmtUptime(last.up));

    /* 内存详情 */
    setText('#memPct', pct(usedPct));
    setText('#memSub', `${fmtGB(last.mem.used)} / ${fmtGB(last.mem.total)} GB`);
    setText('#stMemUsed', `${fmtGB(last.mem.used)} GB`);
    setText('#stMemAvail', `${fmtGB(last.mem.available)} GB`);
    setText('#stMemCached', `${fmtGB(last.mem.cached)} GB`);
    setText('#stMemBuffers', `${fmtGB(last.mem.buffers)} GB`);
    setText(
      '#stMemSwap',
      last.mem.swapTotal
        ? `${fmtGB(last.mem.swapUsed)} / ${fmtGB(last.mem.swapTotal)} GB`
        : '未启用'
    );
    setText('#stMemTotal', `${fmtGB(last.mem.total)} GB`);

    setText('#tblMemUsed', `${fmtGB(last.mem.used)} GB（${pct(usedPct)}）`);
    setText('#tblMemAvail', `${fmtGB(last.mem.available)} GB`);
    setText('#tblMemCached', `${fmtGB(last.mem.cached)} GB`);
    setText(
      '#tblMemSwap',
      last.mem.swapTotal
        ? `${fmtGB(last.mem.swapUsed)} / ${fmtGB(last.mem.swapTotal)} GB`
        : '未启用'
    );

    const cachedPct = last.mem.total ? (last.mem.cached / last.mem.total) * 100 : 0;
    const freePct = Math.max(0, 100 - usedPct - cachedPct);
    $('#memBarUsed').style.width = `${usedPct.toFixed(2)}%`;
    $('#memBarCached').style.width = `${Math.min(cachedPct, 100 - usedPct).toFixed(2)}%`;
    $('#memBarFree').style.width = `${freePct.toFixed(2)}%`;

    /* 磁盘详情 */
    const diskName = state.diskName;
    const diskData = diskName
      ? last.disk.devices.find((d) => d.name === diskName) || {
          readBps: 0,
          writeBps: 0,
          busy: 0,
          iops: 0,
          latencyMs: 0,
        }
      : last.disk.total;
    const diskWriteSeries = pad60(
      samples.map((s) => {
        if (!diskName) return s.disk.total.writeBps;
        const d = s.disk.devices.find((item) => item.name === diskName);
        return d ? d.writeBps : 0;
      })
    );
    const diskReadSeries = pad60(
      samples.map((s) => {
        if (!diskName) return s.disk.total.readBps;
        const d = s.disk.devices.find((item) => item.name === diskName);
        return d ? d.readBps : 0;
      })
    );
    charts.disk.setData([diskWriteSeries, diskReadSeries]);

    setText('#diskRead', fmtRate(diskData.readBps));
    setText('#diskWrite', fmtRate(diskData.writeBps));
    setText(
      '#diskSub',
      `活动时间占比 ${pct(diskData.busy)} · IOPS ${diskData.iops.toFixed(1)}`
    );
    setText('#stDiskWrite', fmtRate(diskData.writeBps));
    setText('#stDiskRead', fmtRate(diskData.readBps));
    setText('#stDiskBusy', pct(diskData.busy));
    setText('#stDiskLatency', `${diskData.latencyMs.toFixed(2)} ms`);
    setText('#stDiskIops', diskData.iops.toFixed(1));
    setText('#tblDiskState', diskData.busy > 1 ? '活动' : '空闲');

    /* 网络 */
    const netSummary = state.network && state.network.summary;
    const netRecv = netSummary ? netSummary.recvBps || 0 : 0;
    const netSend = netSummary ? netSummary.sendBps || 0 : 0;
    const lastNet = state.networkSeries[state.networkSeries.length - 1];
    if (!lastNet || lastNet.t !== last.t) {
      state.networkSeries.push({ recv: netRecv, send: netSend, t: last.t });
      if (state.networkSeries.length > WINDOW) state.networkSeries.shift();
    }
    const netRecvSeries = pad60(state.networkSeries.map((item) => item.recv));
    const netSendSeries = pad60(state.networkSeries.map((item) => item.send));
    if (charts.sideNet) charts.sideNet.setData([netRecvSeries, netSendSeries]);
    if (charts.ovNet) charts.ovNet.setData([netRecvSeries, netSendSeries]);
    if (charts.net) charts.net.setData([netRecvSeries, netSendSeries]);

    setText('#ovNetDown', fmtRate(netRecv));
    setText('#ovNetUp', fmtRate(netSend));
    setText('#ovNetMeta', netSummary ? `${netSummary.total} 个连接` : '—');
    setText('#ovNetConns', netSummary ? netSummary.total : '—');
    setText('#ovNetTcp', netSummary ? netSummary.tcp : '—');
    setText('#ovNetUdp', netSummary ? netSummary.udp : '—');
    setText('#ovNetContainers', netSummary ? netSummary.containers : '—');

    setText('#netDown', fmtRate(netRecv));
    setText('#netUp', fmtRate(netSend));
    setText(
      '#netSub',
      netSummary
        ? `${netSummary.total} 个连接 · TCP ${netSummary.tcp} · UDP ${netSummary.udp} · 近 10 秒平均`
        : '—'
    );
    setText('#stNetDown', fmtRate(netRecv));
    setText('#stNetUp', fmtRate(netSend));
    setText('#stNetTotal', netSummary ? netSummary.total : '—');
    setText('#stNetInbound', netSummary ? netSummary.inbound : '—');
    setText('#stNetOutbound', netSummary ? netSummary.outbound : '—');
    setText('#stNetListening', netSummary ? netSummary.listening : '—');
    setText('#stNetTcp', netSummary ? netSummary.tcp : '—');
    setText('#stNetUdp', netSummary ? netSummary.udp : '—');
    setText('#stNetContainers', netSummary ? netSummary.containers : '—');

    if (state.networkRow) {
      state.networkRow.valEl.textContent = `↓ ${fmtRate(netRecv)} · ↑ ${fmtRate(netSend)}`;
      state.networkRow.subEl.textContent = netSummary ? `${netSummary.total} 个连接` : '—';
    }

    /* 状态栏 */
    updateFooterBrief();

    if (state.page === 'processes') updateProcessSummary();
  }

/* ------------------------------------------------------------------ */
/* 总览：资源管理器风格                                                 */
/* ------------------------------------------------------------------ */

const TRANSFER_COLORS = ['#4cc2ff', '#3ddc97', '#b48ee6', '#f0b24a'];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function fmtClock(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('zh-CN');
}

function hashString(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function transferColor(id) {
  return TRANSFER_COLORS[hashString(id) % TRANSFER_COLORS.length];
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function driveSvg(dev) {
  const cls = dev.removable ? 'removable' : dev.type === 'HDD' ? 'hdd' : 'ssd';
  return `<svg class="disk-icon ${cls}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect x="7" y="15" width="50" height="34" rx="4" stroke="currentColor" stroke-width="2"/>
    <rect x="13" y="21" width="38" height="10" rx="2" fill="currentColor" opacity=".13" stroke="currentColor" stroke-opacity=".45" stroke-width="1.2"/>
    <circle cx="19" cy="41" r="3" fill="currentColor" opacity=".85"/>
    <rect x="27" y="39.5" width="24" height="3" rx="1.5" fill="currentColor" opacity=".25"/>
    <path d="M13 30.5h38" stroke="currentColor" stroke-opacity=".22" stroke-width="1"/>
  </svg>`;
}

function healthTitle(dev, health) {
  const lines = [`${dev.label} · ${dev.model}`];
  if (!health) {
    lines.push('健康状态：正在检查…');
    return lines.join('\n');
  }

  lines.push(
    `健康状态：${health.label}（${
      health.source === 'smart'
        ? 'SMART'
        : health.source === 'smartctl'
          ? 'SMART（smartctl）'
          : '基础检查'
    }）`
  );
  if (health.issues && health.issues.length) {
    lines.push(`问题：${health.issues.join('；')}`);
  }
  if (health.smart && health.smart.supported) {
    const s = health.smart;
    lines.push(`温度：${s.temperatureC ?? '—'}°C · 通电：${formatNumber(s.powerOnHours)} 小时`);
    lines.push(
      `坏扇区：${s.badSectors ?? 0} · 失败属性：${s.attributesFailing ?? 0} · 自检：${s.selftest || '—'}`
    );
    if (s.loadCycleCount != null) lines.push(`负载/卸载周期：${formatNumber(s.loadCycleCount)}（归一化 ${s.loadCycleValue ?? '—'}/100）`);
    if (s.reportedUncorrect) lines.push(`不可纠正错误：${formatNumber(s.reportedUncorrect)}`);
    if (s.commandTimeout) lines.push(`命令超时：${formatNumber(s.commandTimeout)}`);
    if (s.warnings && s.warnings.length) lines.push(`SMART 警告：${s.warnings.join('；')}`);
  } else {
    lines.push('SMART：此设备未提供 ATA/SMART 接口');
  }
  if (health.basic) {
    const b = health.basic;
    lines.push(
      `挂载：${b.mount || '未挂载'}${b.fsType ? `（${b.fsType}）` : ''}${b.readOnly ? ' · 只读' : ''}`
    );
    if (b.usage) {
      lines.push(
        `剩余空间：${fmtBytes(b.usage.freeBytes)} / ${fmtBytes(b.usage.totalBytes)}（${(
          100 - b.usage.usedPct
        ).toFixed(1)}%）`
      );
    }
    if (b.fsErrorCount) lines.push(`文件系统错误记录：${b.fsErrorCount} 次（建议 e2fsck）`);
    if (b.kernelErrors) lines.push(`内核 I/O/文件系统错误：${b.kernelErrors} 条`);
  }
  if (health.checkedAt) lines.push(`检查时间：${fmtClock(health.checkedAt)}`);
  return lines.join('\n');
}

function buildMetrics(health) {
  if (!health) return '<span>等待检查…</span>';
  const parts = [];
  if (health.smart && health.smart.supported) {
    parts.push(`温度 <b>${health.smart.temperatureC ?? '—'}°C</b>`);
    parts.push(`通电 <b>${formatNumber(health.smart.powerOnHours)} 小时</b>`);
    parts.push(`坏扇区 <b>${health.smart.badSectors ?? 0}</b>`);
    if (health.smart.loadCycleCount != null) {
      parts.push(`负载周期 <b>${formatNumber(health.smart.loadCycleCount)}</b>`);
    }
    if (health.smart.reportedUncorrect) {
      parts.push(`不可纠正 <b>${formatNumber(health.smart.reportedUncorrect)}</b>`);
    }
    if (health.smart.warnings && health.smart.warnings.length) {
      parts.push(`SMART 警告 <b>${health.smart.warnings.length}</b>`);
    }
  } else {
    const free = health.basic && health.basic.freePct;
    parts.push('SMART <b>不可用</b>');
    parts.push(`剩余 <b>${free != null ? `${free.toFixed(1)}%` : '—'}</b>`);
    parts.push(`I/O 错误 <b>${health.basic ? (health.basic.kernelErrors || 0) + (health.basic.fsErrorCount || 0) : 0}</b>`);
  }
  return parts.map((part) => `<span>${part}</span>`).join('');
}

function buildDiskCards(devices) {
  const signature = devices.map((dev) => dev.name).join(',');
  if (signature === state.cardSig) return;
  state.cardSig = signature;

  const grid = $('#diskGrid');
  grid.innerHTML = '';
  state.cards.clear();

  for (const dev of devices) {
    const card = document.createElement('article');
    card.className = 'disk-card';
    card.dataset.disk = dev.name;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${dev.label}，点击查看性能`);
    card.innerHTML = `
      <div class="disk-icon-wrap">
        ${driveSvg(dev)}
        <span class="health-badge unknown" aria-hidden="true">?</span>
      </div>
      <div class="disk-info">
        <div class="disk-line1">
          <span class="disk-name">${escapeHtml(dev.label)}</span>
          <span class="disk-kind">${escapeHtml(dev.removable ? '可移动' : dev.type || '磁盘')}</span>
          <span class="disk-service-tags"></span>
        </div>
        <div class="disk-model">${escapeHtml(dev.model)} · ${escapeHtml(mountText(dev.mount))}</div>
        <div class="capacity-bar"><i></i></div>
        <div class="capacity-text"><span class="cap-used">--</span><span class="cap-free"></span></div>
        <div class="disk-io"><span class="io-read">读 <b>--</b></span><span class="io-write">写 <b>--</b></span></div>
        <div class="disk-metrics"></div>
        <div class="health-line">
          <span class="health-dot unknown"></span>
          <span class="health-text">正在检查健康状态…</span>
          <span class="health-tag" hidden></span>
        </div>
      </div>
      <span class="disk-open" aria-hidden="true">›</span>`;

    const open = () => showView('disk', dev.name);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    grid.appendChild(card);
    state.cards.set(dev.name, card);
    updateCardUsage(dev, state.health && state.health.disks ? state.health.disks[dev.name] : null);
    card.title = healthTitle(dev, state.health && state.health.disks ? state.health.disks[dev.name] : null);
  }

  setText('#diskCount', `${devices.length} 块磁盘`);
  filterDiskCards(state.searchQuery || '');
  applyHealthToCards();
  updateDiskServiceTags();
}

function updateDiskServiceTags() {
  const external = state.remote && state.remote.external;
  const service = external && external.active && external.fileService ? external.fileServiceName : '';
  const disk = external && external.active && external.fileService ? external.disk : '';
  const media = [];
  for (const device of (state.remote && state.remote.devices) || []) {
    if (!device.active || !device.readDisk) continue;
    for (const serviceName of device.services || []) {
      if (serviceName !== 'OpenList' && serviceName !== 'Jellyfin' && serviceName !== 'PhotoPrism') continue;
      media.push({ name: serviceName, disk: device.readDisk, file: device.readFile || '' });
    }
  }
  for (const [name, card] of state.cards) {
    const box = card.querySelector('.disk-service-tags');
    if (!box) continue;
    const labels = [];
    if (service && disk === name) {
      labels.push({ name: service, file: external.fileServiceFile || '' });
    }
    for (const item of media) {
      if (item.disk !== name) continue;
      if (labels.some((entry) => entry.name === item.name)) continue;
      labels.push(item);
    }
    box.innerHTML = labels
      .map((item) => {
        const title = `${item.name} 正在使用此磁盘${item.file ? `（${item.file}）` : ''}`;
        return `<span class="disk-service-tag" title="${escapeHtml(title)}">${escapeHtml(item.name)}</span>`;
      })
      .join('');
  }
}

function updateCardUsage(dev, health) {
  if (!dev) return;
  const card = state.cards.get(dev.name);
  if (!card) return;

  const usage = (health && health.basic && health.basic.usage) || dev.usage;
  const bar = card.querySelector('.capacity-bar');
  const fill = card.querySelector('.capacity-bar i');
  const usedEl = card.querySelector('.cap-used');
  const freeEl = card.querySelector('.cap-free');
  if (!bar || !fill || !usedEl || !freeEl) return;

  if (usage && usage.totalBytes) {
    const usedPct = clamp((usage.usedBytes / usage.totalBytes) * 100, 0, 100);
    fill.style.width = `${usedPct.toFixed(1)}%`;
    bar.classList.toggle('warn', usedPct >= 90 && usedPct < 97);
    bar.classList.toggle('bad', usedPct >= 97);
    usedEl.textContent = `已用 ${fmtBytes(usage.usedBytes)} / ${fmtBytes(usage.totalBytes)}`;
    freeEl.textContent = `可用 ${fmtBytes(usage.freeBytes)}`;
    const reserved = usage.reservedBytes > 0
      ? ` · 系统保留 ${fmtBytes(usage.reservedBytes)}（不计入已用）`
      : '';
    bar.title = `已用 ${fmtBytes(usage.usedBytes)} · 可用 ${fmtBytes(usage.freeBytes)}${reserved}`;
  } else {
    fill.style.width = '0%';
    bar.classList.remove('warn', 'bad');
    usedEl.textContent = '未挂载';
    freeEl.textContent = '';
  }
}

function updateDiskCardIo(disks) {
  for (const [name, card] of state.cards) {
    const dev = (disks || []).find((item) => item.name === name);
    const readEl = card.querySelector('.io-read b');
    const writeEl = card.querySelector('.io-write b');
    if (!readEl || !writeEl) continue;
    if (!dev) {
      readEl.textContent = '—';
      writeEl.textContent = '—';
      continue;
    }
    readEl.textContent = fmtRate(dev.readBps || 0);
    writeEl.textContent = fmtRate(dev.writeBps || 0);
  }
}

function applyHealthToCards() {
  const disks = state.health && state.health.disks ? state.health.disks : {};

  for (const [name, card] of state.cards) {
    const dev = (state.info && state.info.devices || []).find((item) => item.name === name);
    const health = disks[name];

    if (dev) updateCardUsage(dev, health);

    const badge = card.querySelector('.health-badge');
    const dot = card.querySelector('.health-dot');
    const text = card.querySelector('.health-text');
    const tag = card.querySelector('.health-tag');
    const metrics = card.querySelector('.disk-metrics');
    const status = health ? health.status : 'unknown';

    card.classList.toggle('health-warning', status === 'warning');
    card.classList.toggle('health-critical', status === 'critical');

    if (badge) {
      badge.className = `health-badge ${status}`;
      badge.textContent =
        status === 'good' ? '✓' : status === 'warning' ? '!' : status === 'critical' ? '×' : '?';
    }
    if (dot) dot.className = `health-dot ${status}`;
    if (text) text.textContent = health ? health.summary : '正在检查健康状态…';
    if (tag) {
      tag.hidden = !health;
      tag.textContent = health && health.source === 'smart' ? 'SMART' : '基础';
    }
    if (metrics) metrics.innerHTML = buildMetrics(health);
    if (dev) card.title = healthTitle(dev, health);
  }

  updateHealthSummary();
  updateHealthButton();
  renderHealthTable();
}

function renderHealthTable() {
  const table = $('#healthTable');
  if (!table) return;

  const devices = (state.info && state.info.devices) || [];
  const disks = (state.health && state.health.disks) || {};
  if (!devices.length) {
    table.innerHTML = '';
    return;
  }

  const rows = devices.map((dev) => {
    const health = disks[dev.name];
    const status = health ? health.status : 'unknown';
    const label = health ? health.label : '检查中';
    const smart = health && health.smart && health.smart.supported ? health.smart : null;
    const basic = health ? health.basic : null;

    const temp = smart && smart.temperatureC != null ? `${smart.temperatureC}°C` : '—';
    const hours =
      smart && smart.powerOnHours != null ? `${formatNumber(smart.powerOnHours)} 小时` : '—';
    const bad = smart && smart.badSectors != null ? `${smart.badSectors}` : '—';
    const free =
      basic && basic.freePct != null ? `${basic.freePct.toFixed(1)}%` : '—';
    const source = health
      ? health.source === 'smart'
        ? 'SMART'
        : health.source === 'smartctl'
          ? 'SMART (smartctl)'
          : '基础检查'
      : '—';
    const sourceCell =
      source === '—' ? '<span class="muted">—</span>' : `<span class="health-source-tag">${source}</span>`;
    const mutedClass = (value) => (value === '—' ? ' muted' : '');

    return `<div class="health-row" data-disk="${escapeHtml(dev.name)}" title="${escapeHtml(
      health ? health.summary : '正在检查…'
    )}">
      <span class="hdisk"><i class="status-dot ${status}"></i>${escapeHtml(dev.label)}</span>
      <span class="hstatus ${status}">${escapeHtml(label)}</span>
      <span class="num${mutedClass(temp)}">${temp}</span>
      <span class="num${mutedClass(hours)}">${hours}</span>
      <span class="num${mutedClass(bad)}">${bad}</span>
      <span class="num${mutedClass(free)}">${free}</span>
      <span>${sourceCell}</span>
    </div>`;
  });

  table.innerHTML = `
    <div class="health-row head">
      <span>磁盘</span><span>状态</span><span>温度</span><span>通电时间</span><span>坏扇区</span><span>剩余空间</span><span>数据来源</span>
    </div>
    ${rows.join('')}`;

  table.querySelectorAll('.health-row[data-disk]').forEach((row) => {
    row.addEventListener('click', () => showView('disk', row.dataset.disk));
  });
}

function updateHealthSummary() {
  const summary = $('#healthSummary');
  const updated = $('#healthUpdated');
  if (!summary || !updated) return;

  const health = state.health;
  const disks = health && health.disks ? Object.values(health.disks) : [];

  if (!disks.length) {
    summary.className = 'health-summary';
    if (health && health.refreshing) {
      summary.innerHTML = '<span class="spinner"></span>正在检查磁盘健康…';
    } else {
      summary.textContent = '等待健康检查…';
    }
    updated.textContent = '';
    return;
  }

  const counts = { good: 0, warning: 0, critical: 0, unknown: 0 };
  for (const disk of disks) counts[disk.status] = (counts[disk.status] || 0) + 1;

  let cls = 'good';
  let text = '全部磁盘状态正常';
  if (counts.critical) {
    cls = 'critical';
    text = `${counts.critical} 块磁盘严重异常`;
  } else if (counts.warning) {
    cls = 'warning';
    text = `${counts.warning} 块磁盘需要注意`;
  } else if (counts.unknown) {
    cls = '';
    text = `${counts.unknown} 块磁盘状态未知`;
  }

  summary.className = `health-summary ${cls}`.trim();
  if (health.refreshing) {
    summary.innerHTML = '<span class="spinner"></span>正在重新检查磁盘健康…';
  } else {
    summary.textContent = text;
  }

  const smart = disks.filter((disk) => disk.source === 'smart').length;
  updated.textContent = `上次检查 ${fmtClock(health.at)} · SMART ${smart} 块 / 基础 ${
    disks.length - smart
  } 块`;
}

function updateHealthButton() {
  const button = $('#healthRefreshBtn');
  const label = $('#healthRefreshLabel');
  const icon = $('#healthRefreshIcon');
  if (!button || !label || !icon) return;

  const refreshing = Boolean(state.health && state.health.refreshing);
  button.disabled = refreshing;
  label.textContent = refreshing ? '检查中…' : '检查健康';
  icon.classList.toggle('spin', refreshing);
}

function startHealthPolling() {
  if (state.healthPolling) return;
  const startedAt = Date.now();

  state.healthPolling = window.setInterval(async () => {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = await response.json();
      state.health = health;
      applyHealthToCards();
      if (!health.refreshing || Date.now() - startedAt > 30000) {
        clearInterval(state.healthPolling);
        state.healthPolling = 0;
      }
    } catch {
      clearInterval(state.healthPolling);
      state.healthPolling = 0;
    }
  }, 800);
}

function applyHealth(health) {
  if (!health) return;
  state.health = health;
  applyHealthToCards();
  if (health.refreshing) startHealthPolling();
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) return;
    applyHealth(await response.json());
  } catch {
    /* 由 SSE 推送兜底 */
  }
}

async function requestHealthRefresh() {
  if (state.health && state.health.refreshing) return;
  try {
    await fetch('/api/health/refresh', { cache: 'no-store' });
  } catch {
    /* 即使请求失败也继续轮询一次 */
  }
  state.health = { ...(state.health || {}), refreshing: true };
  applyHealthToCards();
  startHealthPolling();
}

function filterDiskCards(query) {
  state.searchQuery = query || '';
  const needle = state.searchQuery.trim().toLowerCase();
  const devices = (state.info && state.info.devices) || [];

  for (const [name, card] of state.cards) {
    const dev = devices.find((item) => item.name === name);
    if (!dev) continue;
    const haystack = [
      dev.label,
      dev.name,
      dev.model,
      dev.type,
      dev.fsType,
      ...(dev.mount || []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    card.hidden = Boolean(needle) && !haystack.includes(needle);
  }
}

function updateFooterBrief() {
  const last = state.samples[state.samples.length - 1];
  const summary = state.network && state.network.summary;
  const parts = [];
  if (summary) {
    parts.push(`网速 ↓ ${fmtRate(summary.recvBps || 0)} ↑ ${fmtRate(summary.sendBps || 0)}`);
  } else {
    parts.push('网速 --');
  }
  if (last) {
    parts.push(`CPU ${pct(last.cpu.usage)}`);
    parts.push(`已启动 ${fmtUptime(last.up)}`);
  }
  setText('#footerBrief', parts.join(' · '));
}

const PAGE_STATE_KEYS = {
  page: 'task-manager-web.page',
  view: 'task-manager-web.view',
  disk: 'task-manager-web.disk',
  mode: 'task-manager-web.cpuMode',
};

function savePageState() {
  try {
    localStorage.setItem(PAGE_STATE_KEYS.page, state.page);
    localStorage.setItem(PAGE_STATE_KEYS.view, state.view);
    localStorage.setItem(PAGE_STATE_KEYS.disk, state.diskName || '');
    localStorage.setItem(PAGE_STATE_KEYS.mode, state.cpuMode);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

function restorePageState() {
  let page = 'overview';
  let view = 'overview';
  let disk = '';
  let mode = 'total';
  try {
    page = localStorage.getItem(PAGE_STATE_KEYS.page) || page;
    view = localStorage.getItem(PAGE_STATE_KEYS.view) || view;
    disk = localStorage.getItem(PAGE_STATE_KEYS.disk) || '';
    mode = localStorage.getItem(PAGE_STATE_KEYS.mode) || mode;
  } catch {
    /* ignore */
  }
  state.cpuMode = mode === 'cores' ? 'cores' : 'total';
  $$('#cpuModeToggle [data-cpu-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.cpuMode === state.cpuMode);
  });
  const pages = ['overview', 'performance', 'processes', 'users', 'details', 'services', 'network'];
  const views = ['overview', 'cpu', 'mem', 'disk', 'network'];
  if (!pages.includes(page)) page = 'overview';
  if (!views.includes(view)) view = 'overview';
  setPage(page);
  if (page === 'performance') {
    showView(view, view === 'disk' && disk ? disk : null);
  }
}

function setPage(page) {
  const next = ['performance', 'processes', 'users', 'services', 'network', 'details'].includes(page)
    ? page
    : 'overview';
  state.page = next;
  const performance = next === 'performance';
  const processes = next === 'processes';
  const users = next === 'users';
  const services = next === 'services';
  const network = next === 'network';
  const details = next === 'details';

  $('#resourceList').hidden = !performance;
  $('#performancePages').hidden = !performance;
  $('#explorerPage').hidden = next !== 'overview';
  $('#processesPage').hidden = !processes;
  $('#detailsPage').hidden = !details;
  $('#usersPage').hidden = !users;
  $('#servicesPage').hidden = !services;
  $('#networkPage').hidden = !network;
  setText('#tbTitle', next === 'overview' ? '文件资源管理器' : '任务管理器');
  const gaugeIcon = $('#iconGauge');
  const folderIcon = $('#iconFolder');
  if (gaugeIcon) gaugeIcon.hidden = next === 'overview';
  if (folderIcon) folderIcon.hidden = next !== 'overview';

  $$('.tab[data-page]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.page === next);
  });

  hideTooltip();

  if (performance) {
    requestAnimationFrame(() => {
      viewCharts(state.view).forEach((chart) => chart.resize());
      if (charts.sideCpu) charts.sideCpu.resize();
      if (charts.sideMem) charts.sideMem.resize();
      if (charts.sideNet) charts.sideNet.resize();
      if (charts.sideDiskTotal) charts.sideDiskTotal.resize();
      for (const chart of diskCharts.values()) chart.resize();
      render();
    });
  } else if (processes) {
    renderProcesses();
  } else if (details) {
    renderProcessTree();
    loadProcessTree();
  } else if (users) {
    renderUsers();
    loadUsers();
  } else if (services) {
    renderServices();
    loadServices();
  } else if (network) {
    renderNetwork();
    loadNetwork();
  } else {
    renderRemote();
    requestAnimationFrame(() => {
      resizeTransferCanvas();
      updateTransferBar();
    });
  }

  savePageState();
}

/* ---------------------------- 跨盘传输 ---------------------------- */

function ingestTransfers(list) {
  const now = Date.now();
  const seen = new Set();

  for (const transfer of list || []) {
    if (!transfer || !transfer.from || !transfer.to) continue;

    const previous = state.transfers.get(transfer.id);
    state.transfers.set(transfer.id, {
      ...transfer,
      since: previous ? previous.since : transfer.since || now,
      lastSeen: now,
      bps: previous
        ? Math.round(previous.bps * 0.4 + transfer.bps * 0.6)
        : transfer.bps,
    });

    const file = transfer.file || (previous && previous.file) || '';
    const key = file ? `${file}|${transfer.from}|${transfer.to}` : `${transfer.id}|${transfer.from}|${transfer.to}`;
    const history = state.transferHistory.get(key);
    seen.add(key);
    state.transferHistory.set(key, {
      ...history,
      ...transfer,
      key,
      file: file || '文件传输',
      active: transfer.active !== false,
      firstSeen: history ? history.firstSeen : now,
      lastSeen: now,
      bps: transfer.bps,
      proc: transfer.proc || (history && history.proc) || '',
    });
  }

  for (const [key, entry] of state.transferHistory) {
    if (seen.has(key)) continue;
    if (entry.active && now - entry.lastSeen > 4000) {
      entry.active = false;
      entry.endedAt = now;
    }
  }

  // 只保留最近 30 个文件，优先清理已经结束的
  if (state.transferHistory.size > 30) {
    const ordered = [...state.transferHistory.entries()].sort((a, b) => {
      if (a[1].active !== b[1].active) return a[1].active ? 1 : -1;
      return a[1].lastSeen - b[1].lastSeen;
    });
    for (const [key] of ordered) {
      if (state.transferHistory.size <= 30) break;
      if (!state.transferHistory.get(key).active) state.transferHistory.delete(key);
    }
    for (const [key] of ordered) {
      if (state.transferHistory.size <= 30) break;
      state.transferHistory.delete(key);
    }
  }

  pruneTransfers(now);
  updateTransferBar();
}

function pruneTransfers(now) {
  for (const [id, transfer] of state.transfers) {
    if (now - transfer.lastSeen > 4000) state.transfers.delete(id);
  }
}

function updateTransferBar() {
  const listEl = $('#transferList');
  const emptyEl = $('#transferIdle');
  const countEl = $('#transferCount');
  if (!listEl || !emptyEl || !countEl) return;

  const list = [...state.transferHistory.values()];
  const remote = state.remote;
  for (const device of (remote && remote.devices) || []) {
    if (!device.active) continue;
    if (Array.isArray(device.streams) && device.streams.length) {
      for (const stream of device.streams) {
        if (!stream.file) continue;
        list.push({
          id: `media-${device.id}-${stream.service}`,
          key: `media-${device.id}-${stream.service}`,
          file: stream.file,
          from: stream.disk || device.readDisk || '磁盘',
          to: device.name || device.ip || '客户端',
          bps: stream.bps || 0,
          active: true,
          lastSeen: Date.now(),
          proc: `${device.name || device.ip} · ${stream.service}`,
          color: '#3ddc97',
          external: false,
        });
      }
      continue;
    }
    const file = device.readFile || device.writeFile;
    if (!file) continue;
    list.push({
      id: `smb-${device.id}`,
      key: `smb-${device.id}`,
      file,
      from: device.readDisk || '远程设备',
      to: device.writeDisk || device.name || device.ip || '远程设备',
      bps: Math.max(device.downloadBps || 0, device.uploadBps || 0),
      active: true,
      lastSeen: Date.now(),
      proc: `${device.name || device.ip} · ${(device.services || []).includes('Jellyfin') ? 'Jellyfin' : 'SMB'}`,
      color: '#3ddc97',
      external: false,
    });
  }
  const external = state.remote && state.remote.external;
  if (external && external.active && Array.isArray(external.cliDownloads)) {
    for (const dl of external.cliDownloads) {
      list.push({
        id: `cli-${dl.pid}-${dl.file}`,
        key: `cli-${dl.pid}-${dl.file}`,
        file: dl.file || '外网下载',
        from: '外网',
        to: dl.disk || '磁盘',
        bps: dl.bps || 0,
        active: true,
        lastSeen: Date.now(),
        proc: `${dl.name || 'curl'} · ${dl.host || '外网'}`,
        color: '#5b9dff',
        external: true,
      });
    }
  }
  if (external && external.active && external.fileService) {
    list.push({
      id: 'external-file-service',
      key: 'external-file-service',
      file: external.fileServiceFile || `${external.fileServiceName || '文件服务'} 上传`,
      from: external.disk || '本机',
      to: '外网',
      bps: Math.max(external.uploadBps || 0, external.downloadBps || 0),
      active: true,
      lastSeen: Date.now(),
      proc: external.fileServiceName || 'OpenList',
      color: '#5b9dff',
      external: true,
    });
  }
  list.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  });

  if (!list.length) {
    listEl.hidden = true;
    emptyEl.hidden = false;
    countEl.textContent = '';
    return;
  }

  listEl.hidden = false;
  emptyEl.hidden = true;
  const activeCount = list.filter((transfer) => transfer.active).length;
  countEl.textContent = activeCount
    ? `${list.length} 个文件 · ${activeCount} 传输中`
    : `${list.length} 个文件`;

  const shown = list.slice(0, 8);
  listEl.innerHTML = shown
    .map((transfer) => {
      const color = transfer.color || transferColor(transfer.id || transfer.key);
      return `<span class="transfer-chip${transfer.active ? '' : ' ended'}" title="${escapeHtml(
        transfer.proc || ''
      )} · ${escapeHtml(transfer.file || '文件传输')}">
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style="color:${color}">
          <path d="M14 2 2 7l4.2 1.6L8 14z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
        <b class="file" title="${escapeHtml(transfer.file || '文件传输')}">${escapeHtml(
          transfer.file || '文件传输'
        )}</b>
        <span class="route">${escapeHtml(transfer.from)} → ${escapeHtml(transfer.to)}</span>
        <span class="rate">${fmtRate(transfer.bps)}</span>
        <span class="state">${transfer.active ? '传输中' : '已结束'}</span>
      </span>`;
    })
    .join('');
}

/* ---------------------------- 传输动画 ---------------------------- */

let canvasCtx = null;
let canvasSize = { w: 0, h: 0 };
let canvasDirty = false;
let animationStarted = false;

function resizeTransferCanvas() {
  const canvas = $('#transferCanvas');
  const page = $('#explorerPage');
  if (!canvas || !page) return;

  const rect = page.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvasCtx = canvas.getContext('2d');
  canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvasSize = { w: width, h: height };
  canvasDirty = true;
}

function startTransferAnimation() {
  if (animationStarted) return;
  animationStarted = true;

  const frame = () => {
    window.requestAnimationFrame(frame);
    drawTransfers();
  };
  window.requestAnimationFrame(frame);
}

function drawTransfers() {
  const ctx = canvasCtx;
  const { w, h } = canvasSize;
  if (!ctx || !w || !h) return;

  if (state.page !== 'overview') {
    if (canvasDirty) {
      ctx.clearRect(0, 0, w, h);
      canvasDirty = false;
    }
    return;
  }

  ctx.clearRect(0, 0, w, h);
  canvasDirty = true;
  pruneTransfers(Date.now());

  const page = $('#explorerPage');
  if (!page) return;
  const origin = page.getBoundingClientRect();

  const anchorEl = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (
      !rect.width ||
      rect.bottom < origin.top ||
      rect.top > origin.bottom ||
      rect.right < origin.left ||
      rect.left > origin.right
    ) {
      return null;
    }
    return {
      x: rect.left + rect.width / 2 - origin.left,
      y: rect.top + rect.height / 2 - origin.top,
    };
  };

  const diskAnchor = (name) => {
    const card = state.cards.get(name);
    if (!card || card.hidden) return null;
    return anchorEl(card.querySelector('.disk-icon-wrap'));
  };

  const now = Date.now();
  const transfers = [...state.transfers.values()]
    .sort((a, b) => b.bps - a.bps)
    .slice(0, 4);

  for (const transfer of transfers) {
    const from = diskAnchor(transfer.from);
    const to = diskAnchor(transfer.to);
    if (!from || !to) continue;
    drawTransferCurve(ctx, transfer, from, to, w, h, now);
  }

  drawRemoteTransfers(ctx, origin, w, h, now);
}

function drawRemoteTransfers(ctx, origin, width, height, now) {
  const remote = state.remote;
  if (!remote) return;

  const anchorEl = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (
      !rect.width ||
      rect.bottom < origin.top ||
      rect.top > origin.bottom ||
      rect.right < origin.left ||
      rect.left > origin.right
    ) {
      return null;
    }
    return {
      x: rect.left + rect.width / 2 - origin.left,
      y: rect.top + rect.height / 2 - origin.top,
    };
  };

  const diskAnchor = (name) => {
    const card = state.cards.get(name);
    if (!card || card.hidden) return null;
    return anchorEl(card.querySelector('.disk-icon-wrap'));
  };

  const deviceAnchor = (id) => {
    const cards = document.querySelectorAll('.remote-device');
    for (const card of cards) {
      if (card.dataset.remoteId === id) {
        return anchorEl(card.querySelector('.remote-device-icon'));
      }
    }
    return null;
  };

  const globeAnchor = () => anchorEl($('#remoteGlobeIcon'));

  let drawn = 0;
  for (const device of remote.devices || []) {
    if (!device.active || drawn >= 4) continue;
    const dev = deviceAnchor(device.id);
    if (!dev) continue;

    const down = device.downloadBps || 0;
    const up = device.uploadBps || 0;
    let linked = false;

    if (down >= 64 * 1024 && device.readDisk) {
      const disk = diskAnchor(device.readDisk);
      if (disk) {
        drawTransferCurve(
          ctx,
          {
            id: `remote-${device.id}-down`,
            bps: down,
            active: true,
            lastSeen: Date.now(),
            color: '#3ddc97',
          },
          disk,
          dev,
          width,
          height,
          now
        );
        drawn += 1;
        linked = true;
      }
    }

    if (up >= 64 * 1024 && device.writeDisk && drawn < 4) {
      const disk = diskAnchor(device.writeDisk);
      if (disk) {
        drawTransferCurve(
          ctx,
          {
            id: `remote-${device.id}-up`,
            bps: up,
            active: true,
            lastSeen: Date.now(),
            color: '#b48ee6',
          },
          dev,
          disk,
          width,
          height,
          now
        );
        drawn += 1;
        linked = true;
      }
    }

    if (!linked && device.disk) {
      const disk = diskAnchor(device.disk);
      if (disk) {
        drawTransferCurve(
          ctx,
          {
            id: `remote-${device.id}`,
            bps: Math.max(down, up),
            active: true,
            lastSeen: Date.now(),
            color: '#3ddc97',
          },
          disk,
          dev,
          width,
          height,
          now
        );
        drawn += 1;
      }
    }
  }

  const external = remote.external;
  if (external && external.active && external.disk && drawn < 4) {
    const disk = diskAnchor(external.disk);
    const globe = globeAnchor();
    if (disk && globe) {
      const aria2 = Boolean(external.aria2);
      const fileService = Boolean(external.fileService);
      const cliDownload = Boolean(external.cliDownload);
      const download = external.downloadBps >= external.uploadBps;
      // 文件服务（OpenList）是「本机磁盘 → 外网」上传；aria2 / curl / wget 是「外网 → 本机磁盘」下载
      const intoDisk = fileService ? false : aria2 || cliDownload ? download : !download;
      drawTransferCurve(
        ctx,
        {
          id: 'remote-external',
          bps: Math.max(external.downloadBps, external.uploadBps),
          active: true,
          lastSeen: Date.now(),
          color: '#5b9dff',
        },
        intoDisk ? globe : disk,
        intoDisk ? disk : globe,
        width,
        height,
        now
      );
    }
  }
}

function drawTransferCurve(ctx, transfer, from, to, width, height, now) {
  const live = transfer.active !== false && now - transfer.lastSeen < 1800;
  const color = transfer.color || transferColor(transfer.id);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  let nx = -dy / distance;
  let ny = dx / distance;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const variance = 0.95 + (hashString(transfer.id) % 12) / 100;
  const bulge = Math.min(110, Math.max(40, distance * 0.18)) * variance;
  let cx = (from.x + to.x) / 2 + nx * bulge;
  let cy = (from.y + to.y) / 2 + ny * bulge;
  cx = clamp(cx, 24, width - 24);
  cy = clamp(cy, 24, height - 24);

  ctx.save();
  ctx.globalAlpha = live ? 1 : 0.3;

  // 柔和光晕
  ctx.strokeStyle = color;
  ctx.lineWidth = 7;
  ctx.globalAlpha *= 0.1;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(cx, cy, to.x, to.y);
  ctx.stroke();
  ctx.globalAlpha = live ? 0.9 : 0.35;

  // 虚线主体
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 7]);
  ctx.lineDashOffset = -((now / 35) % 12);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(cx, cy, to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // 两端圆点
  ctx.beginPath();
  ctx.arc(from.x, from.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(from.x, from.y, 8, 0, Math.PI * 2);
  ctx.strokeStyle = withAlpha(color, 0.35);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const pulse = 8 + Math.sin(now / 280) * 2.4;
  ctx.beginPath();
  ctx.arc(to.x, to.y, pulse, 0, Math.PI * 2);
  ctx.strokeStyle = withAlpha(color, 0.45);
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(to.x, to.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // 目标端箭头，明确数据流向
  const tangentX = to.x - cx;
  const tangentY = to.y - cy;
  const tangentLen = Math.hypot(tangentX, tangentY) || 1;
  const ux = tangentX / tangentLen;
  const uy = tangentY / tangentLen;
  const baseX = to.x - ux * 11;
  const baseY = to.y - uy * 11;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(baseX - uy * 4.5, baseY + ux * 4.5);
  ctx.lineTo(baseX + uy * 4.5, baseY - ux * 4.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  if (live) {
    const phase = (performance.now() / 2600 + (hashString(transfer.id) % 100) / 100) % 1;

    // 尾迹
    for (let i = 1; i <= 3; i += 1) {
      const t = (phase - i * 0.028 + 1) % 1;
      const point = bezierPoint(from, { x: cx, y: cy }, to, t);
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.2 - i * 0.05;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    const point = bezierPoint(from, { x: cx, y: cy }, to, phase);
    const ahead = bezierPoint(from, { x: cx, y: cy }, to, Math.min(1, phase + 0.01));
    const angle = Math.atan2(ahead.y - point.y, ahead.x - point.x);
    drawPlane(ctx, point.x, point.y, angle, color);
  }

  ctx.restore();
}

function bezierPoint(from, control, to, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * from.x + 2 * mt * t * control.x + t * t * to.x,
    y: mt * mt * from.y + 2 * mt * t * control.y + t * t * to.y,
  };
}

function drawPlane(ctx, x, y, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // 光晕 + 深色底盘，保证在文字/卡片上也能看清
  ctx.beginPath();
  ctx.arc(0, 0, 16, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(color, 0.12);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(14, 18, 24, 0.88)';
  ctx.fill();
  ctx.strokeStyle = withAlpha(color, 0.85);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.scale(1.12, 1.12);
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#fbfcff';
  ctx.beginPath();
  ctx.moveTo(11, 0);
  ctx.lineTo(-9, -7);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-9, 7);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(10, 12, 16, 0.55)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-4, 0);
  ctx.lineTo(11, 0);
  ctx.stroke();
  ctx.restore();
}

function initExplorer() {
  const refreshButton = $('#healthRefreshBtn');
  if (refreshButton) refreshButton.addEventListener('click', requestHealthRefresh);

  const search = $('#explorerSearch');
  if (search) {
    search.addEventListener('input', (event) => filterDiskCards(event.target.value));
  }

  const page = $('#explorerPage');
  if (page) {
    new ResizeObserver(() => resizeTransferCanvas()).observe(page);
  }
  resizeTransferCanvas();
  updateTransferBar();
  updateHealthSummary();
  updateHealthButton();
  startTransferAnimation();
}

/* ------------------------------------------------------------------ */
/* 远程传输 UI                                                         */
/* ------------------------------------------------------------------ */

function remoteTypeIcon(type) {
  if (type === 'phone') {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.4" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5h3" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="18.6" r=".9" fill="currentColor"/></svg>`;
  }
  if (type === 'tablet') {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4.5" y="3" width="15" height="18" rx="2.2" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="18.5" r=".9" fill="currentColor"/></svg>`;
  }
  if (type === 'computer') {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.6" stroke="currentColor" stroke-width="1.5"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  }
  if (type === 'container') {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5" stroke="currentColor" stroke-width="1.5"/><circle cx="6.5" cy="7" r=".9" fill="currentColor"/><circle cx="6.5" cy="17" r=".9" fill="currentColor"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2.2" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

function diskLabel(name) {
  const devices = (state.info && state.info.devices) || [];
  const device = devices.find((item) => item.name === name);
  return device ? device.label : name;
}

function renderRemote() {
  const countEl = $('#remoteCount');
  const listEl = $('#remoteDevices');
  const globe = $('#remoteGlobe');
  const globeState = $('#globeState');
  if (!countEl || !listEl || !globe || !globeState) return;

  const data = state.remote;
  const scrollLeft = listEl.scrollLeft;
  if (!data) {
    countEl.textContent = '检测中…';
    listEl.innerHTML = '<span class="remote-empty">正在检测远程连接…</span>';
    globe.classList.remove('active');
    globeState.textContent = '空闲';
    return;
  }

  const devices = Array.isArray(data.devices) ? data.devices : [];
  const activeCount = devices.filter((device) => device.active).length;
  const external = data.external || {};

  countEl.textContent = devices.length
    ? `${devices.length} 台设备${activeCount ? ` · ${activeCount} 个传输中` : ''}${
        external.aria2 ? ' · aria2 下载中' : ''
      }`
    : external.aria2
      ? 'aria2 下载中'
      : '未检测到远程设备';

  if (!devices.length) {
    listEl.innerHTML = external.aria2
      ? '<span class="remote-empty">aria2 正在通过外部网络下载 · 见左侧地球与磁盘连线</span>'
      : '<span class="remote-empty">暂无远程文件传输连接 · 手机 / 电脑通过 SMB、SFTP、OpenList 访问本机文件时会显示</span>';
  } else {
    listEl.innerHTML = devices
      .map((device) => {
        const down = device.downloadBps || 0;
        const up = device.uploadBps || 0;
        const downActive = down >= 64 * 1024;
        const upActive = up >= 64 * 1024;
        let status;
        if (device.active) {
          const parts = [];
          if (downActive) parts.push(`↓ ${fmtRate(down)}`);
          if (upActive) parts.push(`↑ ${fmtRate(up)}`);
          if (!parts.length) parts.push(`↕ ${fmtRate(Math.max(down, up))}`);
          const disks = [];
          if (downActive && device.readDisk) disks.push(device.readDisk);
          if (upActive && device.writeDisk) disks.push(device.writeDisk);
          const uniqueDisks = [...new Set(disks)];
          status = parts.join(' · ') + (uniqueDisks.length ? ` · ${uniqueDisks.join(' ↔ ')}` : '');
        } else {
          status = '已连接 · 等待传输';
        }
        const meta = [device.vendor, device.typeLabel, device.ipLabel]
          .filter(Boolean)
          .join(' · ');
        const serviceTags = (device.services || [])
          .map((service) => `<span class="remote-service-tag">${escapeHtml(service)}</span>`)
          .join('');
        const title = [
          device.hostname || device.ip,
          device.mac ? `MAC ${device.mac}` : '',
          (device.services || []).join(' / '),
          status,
          device.readFile ? `读取：${device.readFile}` : '',
          device.writeFile ? `写入：${device.writeFile}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        return `<div class="remote-device${device.active ? ' active' : ''}" data-remote-id="${escapeHtml(
          device.id
        )}" title="${escapeHtml(title)}">
          <span class="remote-device-icon ${escapeHtml(device.type || 'device')}">${remoteTypeIcon(
            device.type
          )}</span>
          <span class="remote-device-info">
            <span class="remote-device-name">${escapeHtml(device.name || device.ipLabel)}</span>
            <span class="remote-service-tags">${serviceTags}</span>
            <span class="remote-device-meta">${escapeHtml(meta)}</span>
            <span class="remote-device-status">${escapeHtml(status)}</span>
            ${
              device.readFile || device.writeFile
                ? `<span class="remote-device-file" title="${escapeHtml(
                    device.readFile || device.writeFile
                  )}">${escapeHtml(device.readFile || device.writeFile)}</span>`
                : ''
            }
          </span>
        </div>`;
      })
      .join('');
  }

  if (listEl.scrollLeft !== scrollLeft) listEl.scrollLeft = scrollLeft;

  const globeSource = $('#globeSource');
  if (globeSource) {
    globeSource.textContent = external.aria2
      ? external.aria2Name || 'aria2'
      : external.cliDownload
        ? external.cliName || 'curl'
        : '';
  }

  const globeActive = Boolean(external.active);
  globe.classList.toggle('active', globeActive);
  if (globeActive) {
    const rate = Math.max(external.downloadBps || 0, external.uploadBps || 0);
    const direction = external.fileService
      ? '外网上传'
      : (external.downloadBps || 0) >= (external.uploadBps || 0)
        ? '↓ 下载'
        : '↑ 上传';
    const diskText = external.disk
      ? external.aria2 || external.fileService || external.cliDownload
        ? external.disk
        : diskLabel(external.disk)
      : '';
    globeState.textContent = `${direction} ${fmtRate(rate)}${diskText ? ` · ${diskText}` : ''}`;
  } else if (external.connections) {
    globeState.textContent = `${external.connections} 个外网连接 · 空闲`;
  } else {
    globeState.textContent = '空闲';
  }

  const titleParts = [];
  titleParts.push(
    external.peers && external.peers.length
      ? `外部网络：${external.peers.join(', ')}`
      : '外部网络'
  );
  if (external.aria2) {
    titleParts.push(`aria2：${external.aria2Name || '下载中'}`);
    if (external.aria2Title) titleParts.push(external.aria2Title);
  }
  if (external.fileService) {
    titleParts.push(`文件服务：${external.fileServiceName || 'OpenList'}`);
  }
  if (external.fileServiceFile) {
    titleParts.push(`文件：${external.fileServiceFile}`);
  }
  if (external.cliDownload) {
    titleParts.push(`外网下载：${external.cliName || 'curl'}`);
    if (external.cliFile) titleParts.push(`文件：${external.cliFile}`);
    if (external.cliHost) titleParts.push(`来源：${external.cliHost}`);
    if ((external.cliDownloads || []).length > 1) {
      titleParts.push(`共 ${external.cliDownloads.length} 个下载`);
    }
  }
  globe.title = titleParts.join('\n');
  updateDiskServiceTags();
  updateTransferBar();
}

async function loadRemote() {
  try {
    const response = await fetch('/api/remote', { cache: 'no-store' });
    if (!response.ok) return;
    state.remote = await response.json();
    if (state.page === 'overview') renderRemote();
  } catch {
    /* SSE 推送兜底 */
  }
}

/* ------------------------------------------------------------------ */
/* 用户 / 服务 / 网络连接 UI                                           */
/* ------------------------------------------------------------------ */

function serviceState(service) {
  if (service.active === 'failed' || service.sub === 'failed') {
    return { key: 'failed', label: '失败' };
  }
  if (service.active === 'active' && service.sub === 'running') {
    return { key: 'running', label: '运行中' };
  }
  if (service.active === 'active' && (service.sub === 'waiting' || service.sub === 'start')) {
    return { key: 'running', label: '启动中' };
  }
  if (service.active === 'active' && service.sub === 'exited') {
    return { key: 'exited', label: '已退出' };
  }
  if (service.active === 'inactive') {
    return { key: 'inactive', label: '未激活' };
  }
  return { key: 'inactive', label: service.active || '—' };
}

function renderUsers() {
  const countEl = $('#usersCount');
  const summaryEl = $('#usersSummary');
  const rowsEl = $('#usersRows');
  if (!countEl || !summaryEl || !rowsEl) return;

  const data = state.users;
  if (!data) {
    countEl.textContent = '--';
    summaryEl.innerHTML = '';
    rowsEl.innerHTML = '<div class="list-empty">正在读取登录用户…</div>';
    return;
  }

  const summary = data.summary || {};
  countEl.textContent = `${summary.users || 0} 个用户 · ${(data.groups || []).length} 条用户/IP`;
  summaryEl.innerHTML = `
    <span>在线用户 <b>${summary.users || 0}</b></span>
    <span>登录会话 <b>${summary.sessions || 0}</b></span>
    <span>网络连接 <b>${summary.connections || 0}</b></span>
    <span>来源 IP <b>${summary.hosts || 0}</b></span>
  `;

  if (!data.groups || !data.groups.length) {
    rowsEl.innerHTML = '<div class="list-empty">暂无已建立连接的登录用户</div>';
    return;
  }

  rowsEl.innerHTML = data.groups
    .map((group) => {
      const services = (group.services || []).join(' / ');
      const title = [services, group.command].filter(Boolean).join('\n');
      return `<div class="list-row">
        <span class="u-user" title="${escapeHtml(title)}">${escapeHtml(group.user)}</span>
        <span class="u-host" title="${escapeHtml(group.host)}">${escapeHtml(group.hostLabel || group.host)}</span>
        <span class="u-sessions">${group.sessions}</span>
        <span class="u-conns"><b>${group.connections}</b></span>
        <span class="u-tty">${escapeHtml((group.ttys || []).join(', '))}</span>
        <span class="u-login">${escapeHtml(group.loginAt || '—')}</span>
        <span class="u-idle">${escapeHtml(group.idle || '—')}</span>
        <span class="u-command" title="${escapeHtml(group.command || '')}">${escapeHtml(group.command || '—')}</span>
      </div>`;
    })
    .join('');
}

function renderServices() {
  const countEl = $('#servicesCount');
  const summaryEl = $('#servicesSummary');
  const rowsEl = $('#servicesRows');
  if (!countEl || !summaryEl || !rowsEl) return;

  const data = state.services;
  if (!data) {
    countEl.textContent = '--';
    summaryEl.innerHTML = '';
    rowsEl.innerHTML = '<div class="list-empty">正在读取 systemctl 服务…</div>';
    return;
  }

  const summary = data.summary || {};
  summaryEl.innerHTML = `
    <span class="ok">运行中 <b>${summary.running || 0}</b></span>
    <span class="bad">失败 <b>${summary.failed || 0}</b></span>
    <span>未激活 <b>${summary.inactive || 0}</b></span>
    <span>已退出 <b>${summary.exited || 0}</b></span>
    <span>总数 <b>${summary.total || 0}</b></span>
  `;

  const query = (state.servicesQuery || '').trim().toLowerCase();
  const list = (data.services || []).filter((service) => {
    if (!query) return true;
    return `${service.name} ${service.description} ${service.sub} ${service.active}`.toLowerCase().includes(query);
  });
  countEl.textContent = query ? `${list.length} / ${(data.services || []).length} 个服务` : `${(data.services || []).length} 个服务`;

  if (!list.length) {
    rowsEl.innerHTML = '<div class="list-empty">没有匹配的服务</div>';
    return;
  }

  rowsEl.innerHTML = list
    .map((service) => {
      const stateInfo = serviceState(service);
      return `<div class="list-row">
        <span class="s-name" title="${escapeHtml(service.name)}">${escapeHtml(service.name)}</span>
        <span class="s-state"><i class="svc-badge ${stateInfo.key}"><i class="svc-dot"></i>${stateInfo.label}</i></span>
        <span class="s-sub">${escapeHtml(service.sub || '—')}</span>
        <span class="s-desc" title="${escapeHtml(service.description || '')}">${escapeHtml(service.description || '—')}</span>
      </div>`;
    })
    .join('');
}

function renderNetwork() {
  const countEl = $('#networkCount');
  const summaryEl = $('#networkSummary');
  const rowsEl = $('#networkRows');
  if (!countEl || !summaryEl || !rowsEl) return;

  const wrap = rowsEl.closest('.list-table-wrap');
  const scrollTop = wrap ? wrap.scrollTop : 0;

  const data = state.network;
  if (!data) {
    countEl.textContent = '--';
    summaryEl.innerHTML = '';
    rowsEl.innerHTML = '<div class="list-empty">正在读取网络连接…</div>';
    return;
  }

  const summary = data.summary || {};
  summaryEl.innerHTML = `
    <span>入站 <b>${summary.inbound || 0}</b></span>
    <span>出站 <b>${summary.outbound || 0}</b></span>
    <span>监听 <b>${summary.listening || 0}</b></span>
    <span>TCP <b>${summary.tcp || 0}</b></span>
    <span>UDP <b>${summary.udp || 0}</b></span>
    <span>容器 <b>${summary.containers || 0}</b></span>
    <span class="ok">接收 <b>${fmtRate(summary.recvBps || 0)}</b></span>
    <span class="ok">发送 <b>${fmtRate(summary.sendBps || 0)}</b></span>
    <span class="network-rate-note">速率：近 10 秒平均</span>
  `;

  const query = (state.networkQuery || '').trim().toLowerCase();
  const list = (data.connections || []).filter((conn) => {
    if (!query) return true;
    return `${conn.app} ${conn.proto} ${conn.direction} ${conn.state} ${conn.local} ${conn.remote}`
      .toLowerCase()
      .includes(query);
  });
  countEl.textContent = query ? `${list.length} / ${(data.connections || []).length} 条连接` : `${(data.connections || []).length} 条连接`;

  if (!list.length) {
    rowsEl.innerHTML = '<div class="list-empty">没有匹配的网络连接</div>';
    if (wrap) wrap.scrollTop = scrollTop;
    return;
  }

  rowsEl.innerHTML = list
    .map((conn) => {
      const protoClass = conn.proto === 'TCP' ? 'tcp' : conn.proto === 'UDP' ? 'udp' : 'container';
      const dirClass = conn.direction === '入站'
        ? 'in'
        : conn.direction === '出站'
          ? 'out'
          : conn.direction === '监听'
            ? 'listen'
            : 'container';
      const stateLabel = conn.state === 'ESTAB' ? '已建立' : conn.state === 'LISTEN' ? '监听' : conn.state;
      const appTitle = conn.container
        ? `${conn.app} · 容器 ${conn.container} · Docker 网络聚合`
        : conn.pid
          ? `${conn.app} · PID ${conn.pid}`
          : conn.app;
      return `<div class="list-row">
        <span class="n-app" title="${escapeHtml(appTitle)}">${escapeHtml(conn.app)}</span>
        <span><i class="proto-badge ${protoClass}">${conn.proto}</i></span>
        <span><i class="dir-badge ${dirClass}">${escapeHtml(conn.direction)}</i></span>
        <span class="n-state">${escapeHtml(stateLabel)}</span>
        <span class="n-local" title="${escapeHtml(conn.local)}">${escapeHtml(conn.local)}</span>
        <span class="n-remote" title="${escapeHtml(conn.remote)}">${escapeHtml(conn.remote)}</span>
        <span class="n-recv">${fmtRate(conn.recvBps || 0)}</span>
        <span class="n-send">${fmtRate(conn.sendBps || 0)}</span>
        <span class="n-total">↓ ${fmtBytes(conn.recvBytes || 0)} · ↑ ${fmtBytes(conn.sendBytes || 0)}</span>
      </div>`;
    })
    .join('');

  if (wrap) wrap.scrollTop = scrollTop;
}

async function loadUsers() {
  try {
    const response = await fetch('/api/users', { cache: 'no-store' });
    if (!response.ok) return;
    state.users = await response.json();
    if (state.page === 'users') renderUsers();
  } catch {
    /* SSE 兜底 */
  }
}

async function loadServices() {
  try {
    const response = await fetch('/api/services', { cache: 'no-store' });
    if (!response.ok) return;
    state.services = await response.json();
    if (state.page === 'services') renderServices();
  } catch {
    /* SSE 兜底 */
  }
}

async function loadNetwork() {
  try {
    const response = await fetch('/api/network', { cache: 'no-store' });
    if (!response.ok) return;
    state.network = await response.json();
    if (state.page === 'network') renderNetwork();
  } catch {
    /* SSE 兜底 */
  }
}

/* ------------------------------------------------------------------ */
/* 进程                                                                */
/* ------------------------------------------------------------------ */

const PROC_STATES = {
  R: { label: '运行', cls: 'running' },
  S: { label: '睡眠', cls: 'sleeping' },
  D: { label: '等待 I/O', cls: 'io' },
  Z: { label: '僵尸', cls: 'zombie' },
  T: { label: '停止', cls: 'stopped' },
  t: { label: '跟踪停止', cls: 'stopped' },
  I: { label: '空闲', cls: 'sleeping' },
  X: { label: '已结束', cls: 'zombie' },
  x: { label: '已结束', cls: 'zombie' },
};

const PROC_COLORS = ['#4cc2ff', '#3ddc97', '#b48ee6', '#f0b24a', '#ff7a7a', '#7aa2ff', '#5bd4c4'];

function processIcon(name) {
  const color = PROC_COLORS[hashString(name) % PROC_COLORS.length];
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="proc-icon" style="color:${color};background:${withAlpha(color, 0.16)}">${escapeHtml(letter)}</span>`;
}

function processState(state) {
  const info = PROC_STATES[state] || { label: state || '—', cls: '' };
  return `<span class="state-pill ${info.cls}">${escapeHtml(info.label)}</span>`;
}

function sortedProcesses() {
  const data = state.processes;
  if (!data || !Array.isArray(data.list)) return [];

  const needle = (state.processQuery || '').trim().toLowerCase();
  const list = data.list.filter((proc) => {
    if (!needle) return true;
    return (
      String(proc.pid).includes(needle) ||
      (proc.displayName || proc.name || '').toLowerCase().includes(needle) ||
      (proc.name || '').toLowerCase().includes(needle) ||
      (proc.cmd || '').toLowerCase().includes(needle) ||
      (proc.user || '').toLowerCase().includes(needle)
    );
  });

  const { key, dir } = state.processSort;
  const sign = dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    let diff = 0;
    if (key === 'name') {
      diff = (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '', 'zh-CN');
    } else if (key === 'mem') {
      diff = (a.rssBytes || 0) - (b.rssBytes || 0);
    } else {
      diff = (a.cpuPct || 0) - (b.cpuPct || 0);
    }
    if (diff === 0) {
      diff = (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '', 'zh-CN');
    }
    return diff * sign;
  });
  return list;
}

function updateProcessSortUI() {
  const { key, dir } = state.processSort;
  $$('.process-head .sortable').forEach((header) => {
    const active = header.dataset.sort === key;
    header.classList.toggle('active', active);
    const arrow = header.querySelector('.head-arrow');
    if (arrow) arrow.textContent = active ? (dir === 'asc' ? '▲' : '▼') : '';
  });
}

function processDiskText(proc) {
  const parts = [];
  if (proc.writeBps > 0) parts.push(`<span class="w">W ${fmtRate(proc.writeBps)}</span>`);
  if (proc.readBps > 0) parts.push(`<span class="r">R ${fmtRate(proc.readBps)}</span>`);
  return parts.length ? parts.join(' · ') : '—';
}

function renderProcesses() {
  const rows = $('#processRows');
  if (!rows) return;

  const wrap = $('#processTableWrap');
  const scrollTop = wrap ? wrap.scrollTop : 0;
  const data = state.processes;
  const list = sortedProcesses();

  if (!data || !Array.isArray(data.list) || !data.list.length) {
    rows.innerHTML = '<div class="process-empty">正在读取进程数据…</div>';
  } else if (!list.length) {
    rows.innerHTML = '<div class="process-empty">没有匹配的进程</div>';
  } else {
    const maxCpu = Math.max(0.1, ...data.list.map((proc) => proc.cpuPct || 0));
    const maxMem = Math.max(1, ...data.list.map((proc) => proc.rssBytes || 0));

    rows.innerHTML = list
      .map((proc) => {
        const displayName = proc.displayName || proc.name || '—';
        const cpuWidth = Math.min(100, ((proc.cpuPct || 0) / maxCpu) * 100);
        const memWidth = Math.min(100, ((proc.rssBytes || 0) / maxMem) * 100);
        const title = escapeHtml(proc.cmd || proc.name || String(proc.pid));
        const cpuTitle = escapeHtml(
          `CPU ${(proc.cpuPct || 0).toFixed(1)}%（占全部逻辑处理器）`
        );
        const memTitle = escapeHtml(
          `内存 ${fmtBytes(proc.rssBytes)} · ${(proc.memPct || 0).toFixed(1)}%`
        );
        return `<div class="process-row" title="${title}">
          <span class="process-name-cell">${processIcon(displayName)}<span class="proc-name">${escapeHtml(
            displayName
          )}</span></span>
          <span class="proc-pid">${proc.pid}</span>
          <span>${processState(proc.state)}</span>
          <span class="metric cpu" title="${cpuTitle}"><i style="width:${cpuWidth.toFixed(
            1
          )}%"></i><b>${(proc.cpuPct || 0).toFixed(1)}%</b></span>
          <span class="metric mem" title="${memTitle}"><i style="width:${memWidth.toFixed(
            1
          )}%"></i><b>${fmtBytes(proc.rssBytes)} · ${(proc.memPct || 0).toFixed(1)}%</b></span>
          <span class="disk-cell">${processDiskText(proc)}</span>
          <span class="threads-cell">${proc.threads}</span>
          <span class="user-cell">${escapeHtml(proc.user || '—')}</span>
        </div>`;
      })
      .join('');
  }

  if (wrap) wrap.scrollTop = scrollTop;

  setText('#processCount', data ? `共 ${data.total} 个` : '--');
  setText(
    '#processHint',
    data
      ? `显示 ${list.length} / ${data.total} 个 · 按${
          state.processSort.key === 'cpu'
            ? 'CPU'
            : state.processSort.key === 'mem'
            ? '内存'
            : '名称'
        }${state.processSort.dir === 'asc' ? '升序' : '降序'}`
      : '显示 CPU / 内存占用最高的进程'
  );
  updateProcessSortUI();
  updateProcessSummary();
}

function renderProcessTree() {
  const rowsEl = $('#treeRows');
  if (!rowsEl) return;
  const wrap = $('#treeWrap');
  const scrollTop = wrap ? wrap.scrollTop : 0;
  const data = state.processTree;

  if (!data || !Array.isArray(data.list)) {
    rowsEl.innerHTML = '<div class="tree-empty">正在读取进程数据…</div>';
    setText('#treeCount', '--');
    return;
  }

  const list = data.list;
  if (!state.treeInitialized && list.length) {
    state.treeExpanded = new Set(list.map((proc) => proc.pid));
    state.treeInitialized = true;
  }

  const byPid = new Map(list.map((proc) => [proc.pid, proc]));
  const children = new Map();
  for (const proc of list) {
    if (proc.ppid === proc.pid) continue;
    const parent = byPid.get(proc.ppid);
    if (!parent) continue;
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }
  for (const kids of children.values()) kids.sort((a, b) => a.pid - b.pid);

  const roots = list
    .filter((proc) => !byPid.has(proc.ppid) || proc.ppid === 0)
    .sort((a, b) => a.pid - b.pid);

  const rows = [];
  const seen = new Set();

  const rowFor = (proc, branch, hasChildren) => {
    const display = escapeHtml(proc.displayName || proc.name || String(proc.pid));
    const command = proc.cmd || (proc.name ? `[${proc.name}]` : '');
    const expanded = state.treeExpanded.has(proc.pid);
    const toggle = hasChildren
      ? `<button type="button" class="tree-toggle" aria-expanded="${expanded}" title="${
          expanded ? '折叠子进程' : '展开子进程'
        }">${expanded ? '▾' : '▸'}</button>`
      : '<span class="tree-toggle-space"></span>';
    return `<div class="tree-row" data-tree-pid="${proc.pid}" title="${escapeHtml(
      command || display
    )}">
      <span class="tree-user">${escapeHtml(proc.user || '—')}</span>
      <span class="tree-pid">${proc.pid}</span>
      <span class="tree-ppid">${proc.ppid || 0}</span>
      <span class="tree-cpu">${(proc.cpuPct || 0).toFixed(1)}%</span>
      <span class="tree-mem">${(proc.memPct || 0).toFixed(1)}%</span>
      <span class="tree-state" title="${escapeHtml(proc.state || '')}">${escapeHtml(
        proc.state || '?'
      )}</span>
      <span class="tree-cmd">${toggle}<span class="tree-branch">${escapeHtml(
        branch
      )}</span><span class="tree-name">${display}</span><span class="tree-args">${escapeHtml(
        command
      )}</span></span>
    </div>`;
  };

  const walk = (proc, prefix, isLast, isRoot) => {
    if (seen.has(proc.pid)) return;
    seen.add(proc.pid);
    const kids = children.get(proc.pid) || [];
    const branch = isRoot ? '' : `${prefix}${isLast ? '└─' : '├─'}`;
    const childPrefix = isRoot ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
    rows.push(rowFor(proc, branch, kids.length > 0));
    if (state.treeExpanded.has(proc.pid)) {
      kids.forEach((kid, index) => walk(kid, childPrefix, index === kids.length - 1, false));
    }
  };

  for (const root of roots) walk(root, '', true, true);
  for (const proc of list) {
    if (!seen.has(proc.pid)) walk(proc, '', true, true);
  }

  rowsEl.innerHTML = rows.join('') || '<div class="tree-empty">没有可显示的进程</div>';
  if (wrap) wrap.scrollTop = scrollTop;
  setText('#treeCount', `共 ${data.total} 个`);
}

let treeLoading = false;

async function loadProcessTree() {
  if (treeLoading) return;
  treeLoading = true;
  try {
    const response = await fetch('/api/process-tree', { cache: 'no-store' });
    if (!response.ok) return;
    state.processTree = await response.json();
    if (state.page === 'details') renderProcessTree();
  } catch {
    /* 保持上一份数据 */
  } finally {
    treeLoading = false;
  }
}

function updateProcessSummary() {
  const last = state.samples[state.samples.length - 1];
  if (!last) return;

  setText('#procCpuTotal', pct(last.cpu.usage, 1));
  setText(
    '#procMemTotal',
    `${fmtGB(last.mem.used)} / ${fmtGB(last.mem.total)} GB · ${pct(
      last.mem.total ? (last.mem.used / last.mem.total) * 100 : 0,
      0
    )}`
  );
  setText('#procWriteTotal', fmtRate(last.disk.total.writeBps));
  setText('#procReadTotal', fmtRate(last.disk.total.readBps));
}

function setProcessSort(key) {
  if (!key) return;
  if (state.processSort.key === key) {
    state.processSort.dir = state.processSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.processSort.key = key;
    state.processSort.dir = key === 'name' ? 'asc' : 'desc';
  }
  renderProcesses();
}

function initProcessUI() {
  const page = $('#processesPage');
  if (page) {
    page.addEventListener('click', (event) => {
      const sort = event.target.closest('[data-sort]');
      if (sort) setProcessSort(sort.dataset.sort);
    });
  }

  const search = $('#processSearch');
  if (search) {
    search.addEventListener('input', (event) => {
      state.processQuery = event.target.value;
      renderProcesses();
    });
  }
}

async function loadProcesses() {
  try {
    const response = await fetch('/api/processes', { cache: 'no-store' });
    if (!response.ok) return;
    state.processes = await response.json();
    if (state.page === 'processes') renderProcesses();
  } catch {
    /* SSE 推送兜底 */
  }
}

  /* ------------------------------------------------------------------ */
  /* 连接                                                                */
  /* ------------------------------------------------------------------ */

  function setLive(live) {
    state.live = live;
    $('#liveDot').classList.toggle('off', !live);
    setText('#liveText', live ? '实时更新' : '连接中断，正在重连…');
  }

  async function loadInfo() {
    try {
      const res = await fetch('/api/info', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyInfo(await res.json());
    } catch {
      /* SSE 会继续重试 */
    }
  }

  function connect() {
    const source = new EventSource('/api/stream');

    source.addEventListener('open', () => setLive(true));
    source.addEventListener('error', () => setLive(false));

    source.addEventListener('history', (event) => {
      const payload = JSON.parse(event.data);
      state.samples = (payload.samples || []).slice(-WINDOW);
      if (payload.info) applyInfo(payload.info);
      if (payload.health) applyHealth(payload.health);
      if (payload.transfers) ingestTransfers(payload.transfers);
      if (payload.processes) {
        state.processes = payload.processes;
        if (state.page === 'processes') renderProcesses();
      }
      if (payload.remote) {
        state.remote = payload.remote;
        if (state.page === 'overview') renderRemote();
      }
      setLive(true);
      render();
    });

    source.addEventListener('sample', (event) => {
      const sample = JSON.parse(event.data);
      state.samples.push(sample);
      if (state.samples.length > WINDOW) state.samples.shift();
      if (sample.transfers) ingestTransfers(sample.transfers);
      render();
    });

    source.addEventListener('info', (event) => {
      applyInfo(JSON.parse(event.data));
    });

    source.addEventListener('health', (event) => {
      applyHealth(JSON.parse(event.data));
    });

    source.addEventListener('transfers', (event) => {
      const payload = JSON.parse(event.data);
      ingestTransfers(Array.isArray(payload) ? payload : payload.transfers);
    });

    source.addEventListener('processes', (event) => {
      state.processes = JSON.parse(event.data);
      if (state.page === 'processes') renderProcesses();
    });

    source.addEventListener('remote', (event) => {
      state.remote = JSON.parse(event.data);
      if (state.page === 'overview') renderRemote();
    });

    source.addEventListener('users', (event) => {
      state.users = JSON.parse(event.data);
      if (state.page === 'users') renderUsers();
    });

    source.addEventListener('services', (event) => {
      state.services = JSON.parse(event.data);
      if (state.page === 'services') renderServices();
    });

    source.addEventListener('network', (event) => {
      state.network = JSON.parse(event.data);
      updateFooterBrief();
      if (state.page === 'network') renderNetwork();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 交互                                                                */
  /* ------------------------------------------------------------------ */

  function bindUI() {
    $('.resource-list').addEventListener('click', (event) => {
      const item = event.target.closest('.res-item');
      if (!item) return;
      const key = item.dataset.key;
      if (key === 'overview' || key === 'cpu' || key === 'mem' || key === 'network') {
        showView(key);
        return;
      }
      if (key.startsWith('disk:')) {
        const name = key.slice('disk:'.length);
        showView('disk', name === 'total' ? null : name);
      }
    });

    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (tab.dataset.page) {
          setPage(tab.dataset.page);
          return;
        }
        if (!tab.classList.contains('active')) {
          toast('这个页面暂未实现');
        }
      });
    });

    $$('#cpuModeToggle [data-cpu-mode]').forEach((btn) => {
      btn.addEventListener('click', () => setCpuMode(btn.dataset.cpuMode));
    });

    const treeRows = $('#treeRows');
    if (treeRows) {
      treeRows.addEventListener('click', (event) => {
        const row = event.target.closest('.tree-row[data-tree-pid]');
        if (!row) return;
        const pid = Number(row.dataset.treePid);
        if (!Number.isFinite(pid)) return;
        if (state.treeExpanded.has(pid)) state.treeExpanded.delete(pid);
        else state.treeExpanded.add(pid);
        renderProcessTree();
      });
    }

    const expandAll = $('#treeExpandAll');
    if (expandAll) {
      expandAll.addEventListener('click', () => {
        const list = (state.processTree && state.processTree.list) || [];
        state.treeExpanded = new Set(list.map((proc) => proc.pid));
        renderProcessTree();
      });
    }

    const collapseAll = $('#treeCollapseAll');
    if (collapseAll) {
      collapseAll.addEventListener('click', () => {
        state.treeExpanded.clear();
        renderProcessTree();
      });
    }

    window.setInterval(() => {
      if (state.page === 'details') loadProcessTree();
    }, 3000);

    const servicesSearch = $('#servicesSearch');
    if (servicesSearch) {
      servicesSearch.addEventListener('input', (event) => {
        state.servicesQuery = event.target.value;
        renderServices();
      });
    }

    const networkSearch = $('#networkSearch');
    if (networkSearch) {
      networkSearch.addEventListener('input', (event) => {
        state.networkQuery = event.target.value;
        renderNetwork();
      });
    }
  }

  let toastTimer = 0;
  let toastHideTimer = 0;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    requestAnimationFrame(() => el.classList.add('show'));

    toastTimer = window.setTimeout(() => {
      el.classList.remove('show');
      toastHideTimer = window.setTimeout(() => {
        el.hidden = true;
      }, 220);
    }, 2200);
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  initCharts();
  initExplorer();
  initProcessUI();
  bindUI();
  setLive(false);
  restorePageState();
  loadInfo();
  loadHealth();
  loadProcesses();
  loadRemote();
  connect();

  // 便于在控制台 / 自动化测试中查看实时数据
  window.__tm = { charts, state, showView, setPage, renderRemote, renderUsers, renderServices, renderNetwork };
})();
