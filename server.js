'use strict';

/**
 * 任务管理器（Web 版）—— 采样本机 CPU / 内存 / 磁盘读写速率
 * 数据全部来自 Linux 的 /proc 与 /sys，无任何第三方依赖。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8777);
const HOST = process.env.HOST || '0.0.0.0';
const SAMPLE_MS = Math.max(500, Number(process.env.SAMPLE_MS || 1000));
const WINDOW = 60; // 保留最近 60 个采样点
const PUBLIC_DIR = path.join(__dirname, 'public');

// 只统计整块物理磁盘，排除分区、loop、dm、md 等
const DISK_RE = /^(?:sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round = (v, d = 0) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/* ------------------------------------------------------------------ */
/* 基础读取工具                                                        */
/* ------------------------------------------------------------------ */

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function readTrim(file, fallback = '') {
  const text = readText(file, fallback);
  return text ? text.trim() : fallback;
}

function readNum(file, fallback = 0) {
  const n = Number(readTrim(file, ''));
  return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------------ */
/* CPU                                                                 */
/* ------------------------------------------------------------------ */

function readCpuStat() {
  const lines = readText('/proc/stat').split('\n');
  const parse = (line) => {
    const nums = line.trim().split(/\s+/).slice(1).map(Number);
    let total = 0;
    for (let i = 0; i < 8; i += 1) total += nums[i] || 0;
    return { total, idle: (nums[3] || 0) + (nums[4] || 0) };
  };

  const overall = parse(lines[0]);
  const cores = [];
  for (const line of lines) {
    if (/^cpu\d+\s/.test(line)) cores.push(parse(line));
  }
  return { overall, cores };
}

function cpuUsage(prev, cur) {
  const total = cur.total - prev.total;
  const idle = cur.idle - prev.idle;
  if (total <= 0) return 0;
  return clamp((1 - idle / total) * 100, 0, 100);
}

function readCpuSpeedMHz() {
  const base = '/sys/devices/system/cpu';
  let sum = 0;
  let count = 0;
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!/^cpu\d+$/.test(dir)) continue;
      const khz = readNum(`${base}/${dir}/cpufreq/scaling_cur_freq`, 0);
      if (khz > 0) {
        sum += khz / 1000;
        count += 1;
      }
    }
  } catch {
    /* ignore */
  }
  if (count > 0) return Math.round(sum / count);

  const mhz = [...readText('/proc/cpuinfo').matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((m) => Number(m[1]));
  return mhz.length ? Math.round(mhz.reduce((a, b) => a + b, 0) / mhz.length) : 0;
}

function readCpuInfo() {
  const text = readText('/proc/cpuinfo');
  const model = (/^model name\s*:\s*(.+)$/m.exec(text) || [])[1] || '未知处理器';
  const logical = (text.match(/^processor\s*:/gm) || []).length || os.cpus().length || 1;
  const cores = [...text.matchAll(/^cpu cores\s*:\s*(\d+)$/gm)].map((m) => Number(m[1]));
  const physical = cores.length ? Math.max(...cores) : Math.max(1, Math.round(logical / 2));
  const base = /@\s*([\d.]+)\s*GHz/i.exec(model);
  return {
    model,
    logical,
    physical,
    baseMHz: base ? Math.round(Number(base[1]) * 1000) : 0,
    caches: readCaches(),
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = i === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[i]}`;
}

function formatCacheSize(raw) {
  const m = /^(\d+)([KMG])$/.exec(raw.trim());
  if (!m) return raw || '—';
  const n = Number(m[1]);
  const mult = m[2] === 'K' ? 1024 : m[2] === 'M' ? 1024 * 1024 : 1024 * 1024 * 1024;
  return formatBytes(n * mult);
}

function readCaches() {
  const caches = {};
  const base = '/sys/devices/system/cpu/cpu0/cache';
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!/^index\d+$/.test(dir)) continue;
      const level = readTrim(`${base}/${dir}/level`);
      const size = readTrim(`${base}/${dir}/size`);
      if (!level || !size) continue;
      caches[`L${level}`] = formatCacheSize(size);
    }
  } catch {
    /* ignore */
  }
  return caches;
}

let procCache = { procs: 0, threads: 0 };
let procScannedAt = 0;

function scanProcessCounts(now) {
  if (now - procScannedAt < 5000) return procCache;

  let procs = 0;
  let threads = 0;
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return procCache;
  }

  for (const name of entries) {
    const code = name.charCodeAt(0);
    if (!(code >= 48 && code <= 57)) continue;
    procs += 1;
    const status = readText(`/proc/${name}/status`);
    const m = /^Threads:\s*(\d+)/m.exec(status);
    if (m) threads += Number(m[1]);
  }

  procCache = { procs, threads };
  procScannedAt = now;
  return procCache;
}

/* ------------------------------------------------------------------ */
/* 内存                                                                */
/* ------------------------------------------------------------------ */

function readMem() {
  const values = {};
  for (const line of readText('/proc/meminfo').split('\n')) {
    const m = /^(\w+):\s+(\d+) kB/.exec(line);
    if (m) values[m[1]] = Number(m[2]) * 1024;
  }

  const total = values.MemTotal || 0;
  const available = values.MemAvailable ?? values.MemFree ?? 0;
  const swapTotal = values.SwapTotal || 0;
  const swapFree = values.SwapFree || 0;

  return {
    total,
    available,
    used: Math.max(0, total - available),
    cached: (values.Cached || 0) + (values.SReclaimable || 0),
    buffers: values.Buffers || 0,
    swapTotal,
    swapUsed: Math.max(0, swapTotal - swapFree),
  };
}

/* ------------------------------------------------------------------ */
/* 磁盘                                                                */
/* ------------------------------------------------------------------ */

let devices = [];
let deviceSignature = '';

function decodeMountPath(value) {
  return value.replace(/\\(040|011|012|134)/g, (_, code) =>
    String.fromCharCode(parseInt(code, 8))
  );
}

function parseMounts() {
  const entries = [];
  for (const line of readText('/proc/mounts').split('\n')) {
    const parts = line.split(' ');
    if (parts.length < 4) continue;
    entries.push({
      dev: decodeMountPath(parts[0]),
      mount: decodeMountPath(parts[1]),
      fsType: parts[2],
      options: parts[3].split(','),
    });
  }
  return entries;
}

function deviceOwns(name, devPath) {
  const base = devPath.slice('/dev/'.length);
  if (base === name) return true;
  if (!base.startsWith(name)) return false;
  return /^p?\d+$/.test(base.slice(name.length));
}

function primaryMount(mounts) {
  if (!mounts || !mounts.length) return null;
  return mounts.find((m) => m === '/') ||
    mounts.find((m) => !m.startsWith('/boot')) ||
    mounts[0];
}

function statMount(mountPoint) {
  try {
    const st = fs.statfsSync(mountPoint);
    const total = st.bsize * st.blocks;
    const free = st.bsize * st.bfree;
    const available = st.bsize * st.bavail;
    const used = Math.max(0, total - free);
    return {
      mount: mountPoint,
      totalBytes: total,
      freeBytes: available,
      usedBytes: used,
      usedPct: total > 0 ? round((used / total) * 100, 1) : 0,
      reservedBytes: Math.max(0, free - available),
    };
  } catch {
    return null;
  }
}

function scanDevices() {
  const entries = parseMounts().filter((entry) => entry.dev.startsWith('/dev/'));
  let names = [];
  try {
    names = fs.readdirSync('/sys/block').filter((n) => DISK_RE.test(n));
  } catch {
    names = [];
  }
  const order = (name) => {
    if (name.startsWith('sd')) return 0;
    if (name.startsWith('hd')) return 1;
    if (name.startsWith('vd') || name.startsWith('xvd')) return 2;
    if (name.startsWith('nvme')) return 3;
    if (name.startsWith('mmcblk')) return 4;
    return 9;
  };
  names.sort((a, b) => order(a) - order(b) || a.localeCompare(b));

  return names.map((name, index) => {
    const model =
      readTrim(`/sys/block/${name}/device/model`) ||
      readTrim(`/sys/block/${name}/device/name`) ||
      name.toUpperCase();
    const sizeBytes = readNum(`/sys/block/${name}/size`) * 512;
    const rotational = readNum(`/sys/block/${name}/queue/rotational`, 1) !== 0;

    const own = entries.filter((entry) => deviceOwns(name, entry.dev));
    const mount = [...new Set(own.map((entry) => entry.mount))];
    const primary = primaryMount(mount);
    const primaryEntry = own.find((entry) => entry.mount === primary);
    const usage = primary ? statMount(primary) : null;

    return {
      name,
      index,
      label: `磁盘 ${index} (${name})`,
      model,
      sizeBytes,
      mount,
      mountPrimary: primary,
      fsType: primaryEntry ? primaryEntry.fsType : null,
      readOnly: primaryEntry ? primaryEntry.options.includes('ro') : false,
      removable: readNum(`/sys/block/${name}/removable`, 0) === 1,
      usage,
      type: rotational ? 'HDD' : 'SSD',
    };
  });
}

/* 文件路径 -> 整块磁盘名，用于跨盘拷贝探测 */
let mountIndex = [];

function buildMountIndex() {
  const list = [];
  for (const entry of parseMounts()) {
    let disk = null;
    if (entry.dev.startsWith('/dev/')) {
      const found = devices.find((dev) => deviceOwns(dev.name, entry.dev));
      if (found) disk = found.name;
    }
    list.push({ dev: entry.dev, mount: entry.mount, disk });
  }
  list.sort((a, b) => b.mount.length - a.mount.length);
  mountIndex = list;
}

function diskForPath(filePath) {
  if (!filePath || filePath[0] !== '/') return null;
  for (const entry of mountIndex) {
    if (filePath === entry.mount) return entry.disk;
    const prefix = entry.mount === '/' ? '/' : `${entry.mount}/`;
    if (filePath.startsWith(prefix)) return entry.disk;
  }
  return null;
}

function readDiskStats() {
  const map = new Map();
  for (const line of readText('/proc/diskstats').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    map.set(p[2], {
      reads: Number(p[3]),
      readSectors: Number(p[5]),
      readMs: Number(p[6]),
      writes: Number(p[7]),
      writeSectors: Number(p[9]),
      writeMs: Number(p[10]),
      ioMs: Number(p[12]),
      inFlight: Number(p[11]),
    });
  }
  return map;
}

function scanStaticInfo() {
  const now = Date.now();
  const nextDevices = scanDevices();
  const signature = nextDevices.map((d) => `${d.name}:${d.sizeBytes}`).join('|');
  const changed = signature !== deviceSignature;
  deviceSignature = signature;
  devices = nextDevices;
  buildMountIndex();

  const cpu = readCpuInfo();
  const mem = readMem();

  infoCache = {
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    cpu,
    mem: { total: mem.total, swapTotal: mem.swapTotal },
    devices,
    window: WINDOW,
    sampleMs: SAMPLE_MS,
  };
  staticAt = now;
  return changed;
}

let infoCache = null;
let staticAt = 0;

function refreshStatic(force = false) {
  if (!force && infoCache && Date.now() - staticAt < 15000) return false;
  return scanStaticInfo();
}

function getInfo() {
  if (!infoCache) refreshStatic(true);
  return infoCache;
}

/* ------------------------------------------------------------------ */
/* 跨盘拷贝探测                                                        */
/* ------------------------------------------------------------------ */
/*
 * 思路：每 500ms 读取一次 /proc/<pid>/io 与 /proc/<pid>/fd，
 * 找出「同时持有来源盘只读 fd 和另一块盘可写 fd」的进程；
 * 对于 rsync 这类把读写拆到多个进程的工具，再解析其命令行中的源/目标路径。
 */

const procIoState = new Map();
const transferState = new Map();
const COPY_TOOL_NAMES = new Set(['cp', 'mv', 'rsync', 'dd', 'gio']);
const copyListCache = new Map();
let lastTransfers = [];
let lastDiskDevices = [];
let lastDetectionAt = 0;

function readProcIo(pid) {
  const text = readText(`/proc/${pid}/io`);
  if (!text) return null;
  const rchar = /^rchar:\s*(\d+)/m.exec(text);
  const wchar = /^wchar:\s*(\d+)/m.exec(text);
  return {
    rchar: rchar ? Number(rchar[1]) : 0,
    wchar: wchar ? Number(wchar[1]) : 0,
  };
}

function readCmdline(pid) {
  const raw = readText(`/proc/${pid}/cmdline`);
  if (!raw) return null;
  return raw.split('\0').filter(Boolean);
}

function resolveArg(arg, cwd) {
  if (!arg || arg.startsWith('-') || arg.includes('://') || arg.includes('@')) return null;
  if (arg.startsWith('/')) return path.normalize(arg);
  if (!cwd) return null;
  return path.resolve(cwd, arg);
}

function parseCopyCommand(argv, cwd) {
  if (!argv || !argv.length) return null;
  const command = path.basename(argv[0]);
  const args = argv.slice(1);

  if (command === 'dd') {
    let from = null;
    let to = null;
    for (const arg of args) {
      if (arg.startsWith('if=')) from = resolveArg(arg.slice(3), cwd);
      else if (arg.startsWith('of=')) to = resolveArg(arg.slice(3), cwd);
    }
    return from && to ? { from, to } : null;
  }

  if (command === 'cp' || command === 'mv') {
    const paths = args.map((arg) => resolveArg(arg, cwd)).filter(Boolean);
    if (paths.length < 2) return null;
    const to = paths[paths.length - 1];
    const from = paths.slice(0, -1).find((p) => fs.existsSync(p)) || paths[0];
    return from && to ? { from, to } : null;
  }

  if (command === 'rsync') {
    const paths = args.map((arg) => resolveArg(arg, cwd)).filter(Boolean);
    if (paths.length < 2) return null;
    const to = paths[paths.length - 1];
    const from = paths.find((p) => fs.existsSync(p)) || paths[0];
    return from && to ? { from, to } : null;
  }

  if (command === 'gio') {
    const idx = args.indexOf('copy');
    if (idx < 0 || args.length < idx + 3) return null;
    const from = resolveArg(args[idx + 1], cwd);
    const to = resolveArg(args[idx + 2], cwd);
    return from && to ? { from, to } : null;
  }

  return null;
}

function prettyFileName(filePath) {
  const base = path.basename(filePath || '');
  const temp = /^\.(.+?)\.[A-Za-z0-9]{6}$/.exec(base);
  if (temp) return temp[1];
  return base.replace(/ \(deleted\)$/, '');
}

function pickDisk(filesByDisk, rates, preferRate) {
  let best = null;
  for (const [disk, files] of filesByDisk) {
    const rate = rates.get(disk) || 0;
    const size = files.reduce((max, file) => Math.max(max, file.size), 0);
    const candidate = { disk, rate, size };
    if (!best) {
      best = candidate;
      continue;
    }
    if (preferRate) {
      if (
        candidate.rate > best.rate ||
        (candidate.rate === best.rate && candidate.size > best.size)
      ) {
        best = candidate;
      }
    } else if (candidate.size > best.size) {
      best = candidate;
    }
  }
  return best;
}

function pickFile(filesByDisk, disk) {
  const files = filesByDisk.get(disk);
  if (!files || !files.length) return '';
  let best = files[0];
  for (const file of files) if (file.size > best.size) best = file;
  return prettyFileName(best.path);
}

function estimateBps(measured, writeRate, readRate) {
  const cap = Math.max(writeRate || 0, readRate || 0);
  let bps = measured;
  if (!(bps > 0)) bps = cap * 0.6;
  if (cap > 0) bps = Math.min(bps, cap * 1.6);
  return Math.max(0, Math.round(bps));
}

function inspectProcess(pid) {
  const dir = `/proc/${pid}/fd`;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const readable = new Map();
  const writable = new Map();

  for (const fd of entries) {
    // 跳过 stdin/stdout/stderr，避免把重定向的日志文件当成拷贝目标
    if (fd === '0' || fd === '1' || fd === '2') continue;
    let target;
    try {
      target = fs.readlinkSync(`${dir}/${fd}`);
    } catch {
      continue;
    }
    if (!target.startsWith('/')) continue;
    const clean = target.replace(/ \(deleted\)$/, '');
    const disk = diskForPath(clean);
    if (!disk) continue;

    let flagsText = '';
    try {
      flagsText = readText(`/proc/${pid}/fdinfo/${fd}`);
    } catch {
      continue;
    }
    const flagsMatch = /^flags:\s*(\d+)/m.exec(flagsText);
    if (!flagsMatch) continue;
    const mode = parseInt(flagsMatch[1], 8) & 3;
    if (mode !== 0 && mode !== 1 && mode !== 2) continue;

    let stat;
    try {
      stat = fs.statSync(`${dir}/${fd}`);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const item = { path: clean, size: stat.size };
    if (mode === 0 || mode === 2) {
      if (!readable.has(disk)) readable.set(disk, []);
      readable.get(disk).push(item);
    }
    if (mode === 1 || mode === 2) {
      if (!writable.has(disk)) writable.set(disk, []);
      writable.get(disk).push(item);
    }
  }

  return { readable, writable };
}

function describeCopyFile(cmd, pair) {
  const filesFrom = cmd.find((arg) => arg.startsWith('--files-from='));
  if (filesFrom) {
    const listPath = resolveArg(filesFrom.slice('--files-from='.length), process.cwd());
    if (listPath) {
      try {
        const stat = fs.statSync(listPath);
        const cacheKey = `${listPath}|${stat.mtimeMs}|${stat.size}`;
        let count = copyListCache.get(cacheKey);
        if (count == null) {
          const text = readText(listPath);
          count = text ? text.split(/\r?\n/).filter(Boolean).length : 0;
          if (copyListCache.size > 30) copyListCache.clear();
          copyListCache.set(cacheKey, count);
        }
        if (count) return `${path.basename(listPath)}（${count} 个文件）`;
      } catch {
        /* ignore unavailable list */
      }
    }
  }
  return path.basename(pair.to) || path.basename(pair.from) || '文件拷贝';
}

function detectTransfers(now, diskDevices, dtSeconds) {
  const dt = Math.max(0.2, dtSeconds || 0.5);
  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return lastTransfers;
  }

  const pidSet = new Set(pids);
  const activePids = new Set([...transferState.values()].map((t) => t.pid));
  const writeRates = new Map(diskDevices.map((d) => [d.name, d.writeBps]));
  const readRates = new Map(diskDevices.map((d) => [d.name, d.readBps]));
  const scanned = new Map();
  const rootCopyPids = [];

  for (const pid of pids) {
    const io = readProcIo(pid);
    if (!io) {
      procIoState.delete(pid);
      const comm = readTrim(`/proc/${pid}/comm`, '');
      if (COPY_TOOL_NAMES.has(comm)) rootCopyPids.push(pid);
      continue;
    }
    const prev = procIoState.get(pid);
    procIoState.set(pid, io);
    const dR = prev ? Math.max(0, io.rchar - prev.rchar) : 0;
    const dW = prev ? Math.max(0, io.wchar - prev.wchar) : 0;

    const active = activePids.has(pid);
    if (!active && dR + dW < 128 * 1024) continue;

    const fds = inspectProcess(pid);
    if (!fds) continue;

    let cwd = '';
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = '';
    }

    scanned.set(pid, {
      ...fds,
      cmd: readCmdline(pid),
      comm: readTrim(`/proc/${pid}/comm`, '?'),
      cwd,
      dR,
      dW,
    });
  }

  for (const pid of procIoState.keys()) {
    if (!pidSet.has(pid)) procIoState.delete(pid);
  }

  const found = new Map();
  const addTransfer = (transfer) => {
    const id = `${transfer.from}->${transfer.to}`;
    const previous = found.get(id);
    if (!previous || transfer.bps > previous.bps) {
      found.set(id, { ...transfer, id });
    }
  };

  /* root 发起的 rsync/cp：无法读取 io/fd，退化为 cmdline 路径 + 磁盘读写速率 */
  for (const pid of rootCopyPids) {
    const cmd = readCmdline(pid);
    if (!cmd) continue;
    const pair = parseCopyCommand(cmd, '');
    if (!pair) continue;
    const from = diskForPath(pair.from);
    const to = diskForPath(pair.to);
    if (!from || !to || from === to) continue;

    const bps = Math.max(writeRates.get(to) || 0, readRates.get(from) || 0);
    if (bps < 96 * 1024) continue;

    addTransfer({
      from,
      to,
      pid,
      proc: readTrim(`/proc/${pid}/comm`, '?'),
      file: describeCopyFile(cmd, pair),
      bps,
    });
  }

  /* 同一进程里直接持有来源 / 目标 fd（文件管理器、未知拷贝工具） */
  for (const [pid, info] of scanned) {
    // rsync / cp / dd 等已知工具交给命令行路径识别，避免把日志 fd、内部管道误判成拷贝
    if (COPY_TOOL_NAMES.has(info.comm) || parseCopyCommand(info.cmd, info.cwd)) continue;
    if (!info.writable.size || !info.readable.size) continue;
    const target = pickDisk(info.writable, writeRates, true);
    if (!target) continue;

    const readableOther = new Map(
      [...info.readable].filter(([disk]) => disk !== target.disk)
    );
    const source = pickDisk(readableOther, readRates, true);
    if (!source) continue;

    // 目标盘 / 来源盘必须确实有较明显的读写，避免把日志文件、内部管道误判成拷贝
    if (target.rate < 512 * 1024 || source.rate < 512 * 1024) continue;

    const bps = estimateBps(
      Math.min(info.dW / dt, target.rate),
      target.rate,
      source.rate
    );
    if (bps < 96 * 1024) continue;

    addTransfer({
      from: source.disk,
      to: target.disk,
      pid,
      proc: info.comm,
      file: pickFile(info.writable, target.disk),
      bps,
    });
  }

  /* rsync / cp / mv / dd / gio 的命令行路径（rsync 的读写常在不同进程） */
  for (const [pid, info] of scanned) {
    const pair = parseCopyCommand(info.cmd, info.cwd);
    if (!pair) continue;
    const from = diskForPath(pair.from);
    const to = diskForPath(pair.to);
    if (!from || !to || from === to) continue;

    const measured = Math.max(info.dR, info.dW) / dt;
    const bps = estimateBps(measured, writeRates.get(to) || 0, readRates.get(from) || 0);
    if (bps < 96 * 1024) continue;

    let file = '';
    const key = info.cmd.join('\0');
    for (const [, other] of scanned) {
      if (other.cmd.join('\0') !== key) continue;
      file = pickFile(other.writable, to);
      if (file) break;
    }
    if (!file) file = path.basename(pair.to) || path.basename(pair.from);

    addTransfer({
      from,
      to,
      pid,
      proc: info.comm,
      file,
      bps,
    });
  }

  for (const [id, transfer] of found) {
    const old = transferState.get(id);
    transferState.set(id, {
      ...transfer,
      id,
      bps: old ? Math.round(old.bps * 0.4 + transfer.bps * 0.6) : transfer.bps,
      since: old ? old.since : now,
      lastSeen: now,
    });
  }

  for (const [id, transfer] of transferState) {
    if (!found.has(id) && now - transfer.lastSeen > 3000) {
      transferState.delete(id);
    }
  }

  lastTransfers = [...transferState.values()]
    .map((transfer) => ({
      ...transfer,
      active: now - transfer.lastSeen < 1000,
    }))
    .sort((a, b) => b.bps - a.bps)
    .slice(0, 6);

  return lastTransfers;
}

/* ------------------------------------------------------------------ */
/* 磁盘健康检查                                                        */
/* ------------------------------------------------------------------ */
/*
 * 优先通过 UDisks2 的 Drive.Ata 接口读取 SMART（无需 root，由 udisksd 提供）；
 * USB 桥接盘 / SD 卡没有该接口时，退化为挂载状态、剩余空间、内核 I/O 错误等基础检查。
 */

let healthState = { at: 0, date: '', refreshing: false, disks: {} };
const HEALTH_STATE_FILE = path.join(__dirname, 'data', 'health-state.json');

function healthDay() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function loadHealthState() {
  try {
    const data = JSON.parse(fs.readFileSync(HEALTH_STATE_FILE, 'utf8'));
    if (data && data.at && data.disks) {
      healthState = { ...data, refreshing: false };
    }
  } catch {
    /* 没有历史健康状态 */
  }
}

function saveHealthState() {
  try {
    fs.mkdirSync(path.dirname(HEALTH_STATE_FILE), { recursive: true });
    fs.writeFileSync(
      HEALTH_STATE_FILE,
      JSON.stringify({ ...healthState, refreshing: false }, null, 2)
    );
  } catch (err) {
    console.error('[health] 保存状态失败', err.message);
  }
}
let kernelCache = { at: 0, errors: {} };

async function runCommand(command, args, timeout = 8000) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout || '';
  } catch (err) {
    return err && err.stdout ? err.stdout : '';
  }
}

async function readSmartUdisks2(name) {
  const blockPath = `/org/freedesktop/UDisks2/block_devices/${name}`;
  const driveOut = await runCommand('gdbus', [
    'call',
    '--system',
    '--dest',
    'org.freedesktop.UDisks2',
    '--object-path',
    blockPath,
    '--method',
    'org.freedesktop.DBus.Properties.Get',
    'org.freedesktop.UDisks2.Block',
    'Drive',
  ]);
  const driveMatch = /'(\/org\/freedesktop\/UDisks2\/drives\/[^']+)'/.exec(driveOut);
  if (!driveMatch) return null;

  const propsOut = await runCommand('gdbus', [
    'call',
    '--system',
    '--dest',
    'org.freedesktop.UDisks2',
    '--object-path',
    driveMatch[1],
    '--method',
    'org.freedesktop.DBus.Properties.GetAll',
    'org.freedesktop.UDisks2.Drive.Ata',
  ]);
  if (!propsOut || !propsOut.includes('SmartSupported')) return null;

  const values = {};
  const re = /'([^']+)':\s*<([^>]*)>/g;
  let match;
  while ((match = re.exec(propsOut))) values[match[1]] = match[2].trim();

  const bool = (key) => values[key] === 'true';
  const str = (key) => (values[key] || '').replace(/^'|'$/g, '');
  const num = (key) => {
    if (values[key] == null) return null;
    const raw = values[key].replace(/^[A-Za-z0-9]+\s+/, '').replace(/^'|'$/g, '');
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const tempK = num('SmartTemperature');
  const powerSeconds = num('SmartPowerOnSeconds');

  return {
    supported: bool('SmartSupported'),
    enabled: bool('SmartEnabled'),
    failing: bool('SmartFailing'),
    updatedAt: num('SmartUpdated') ? num('SmartUpdated') * 1000 : null,
    temperatureC: tempK ? round(tempK - 273.15, 1) : null,
    powerOnHours: powerSeconds ? Math.round(powerSeconds / 3600) : null,
    badSectors: num('SmartNumBadSectors'),
    attributesFailing: num('SmartNumAttributesFailing'),
    attributesFailedPast: num('SmartNumAttributesFailedInThePast'),
    selftest: str('SmartSelftestStatus') || null,
  };
}


const SMARTCTL_IMAGE = 'alpine:3.20';
const SMART_HELPER_NAME = 'tm-smart-helper';
const smartctlCache = new Map();

async function ensureSmartHelper() {
  const running = (await runCommand('docker', ['inspect', '-f', '{{.State.Running}}', SMART_HELPER_NAME], 3000)).trim();
  if (running === 'true') return true;
  const exists = (await runCommand('docker', ['inspect', '-f', '{{.Id}}', SMART_HELPER_NAME], 3000)).trim();
  if (exists) {
    await runCommand('docker', ['start', SMART_HELPER_NAME], 8000);
    return true;
  }
  await runCommand(
    'docker',
    [
      'run', '-d', '--name', SMART_HELPER_NAME,
      '--restart', 'unless-stopped',
      '--privileged', '-v', '/dev:/dev',
      '--entrypoint', 'sh', SMARTCTL_IMAGE,
      '-c', 'apk add --no-cache smartmontools >/dev/null 2>&1 && sleep infinity',
    ],
    120000
  );
  return true;
}

async function readSmartctl(name) {
  const cached = smartctlCache.get(name);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;
  const script =
    'apk add --no-cache smartmontools >/dev/null 2>&1; ' +
    `smartctl -a -j -d sat /dev/${name} 2>/dev/null || true`;
  const out = await runCommand(
    'docker',
    ['run', '--rm', '--privileged', '-v', '/dev:/dev', '--entrypoint', 'sh', SMARTCTL_IMAGE, '-c', script],
    120000
  );
  const text = String(out || '');
  const begin = text.indexOf('{');
  const finish = text.lastIndexOf('}');
  if (begin < 0 || finish <= begin) {
    smartctlCache.set(name, { at: Date.now(), value: null });
    return null;
  }
  let data;
  try {
    data = JSON.parse(text.slice(begin, finish + 1));
  } catch {
    smartctlCache.set(name, { at: Date.now(), value: null });
    return null;
  }
  if (!data.smart_support && !data.ata_smart_attributes && !data.smart_status) {
    smartctlCache.set(name, { at: Date.now(), value: null });
    return null;
  }
  const table = (data.ata_smart_attributes && data.ata_smart_attributes.table) || [];
  const get = (id) => table.find((item) => item.id === id) || null;
  const raw = (id) => {
    const item = get(id);
    return item && item.raw ? Number(item.raw.value) : null;
  };
  const normalized = (id) => {
    const item = get(id);
    return item ? Number(item.value) : null;
  };
  const passed = data.smart_status ? data.smart_status.passed !== false : true;
  const powerOnHours = (data.power_on_time && data.power_on_time.hours) || raw(9) || null;
  const temp = (data.temperature && data.temperature.current) || raw(194) || null;
  const reallocated = raw(5) || 0;
  const pending = raw(197) || 0;
  const offline = raw(198) || 0;
  const reported = raw(187) || 0;
  const commandTimeout = raw(188) || 0;
  const loadCycles = raw(193) || 0;
  const loadValue = normalized(193);
  const crc = raw(199) || 0;
  const warnings = [];
  if (reported > 0) warnings.push(`不可纠正错误 ${reported}`);
  if (pending > 0) warnings.push(`待映射扇区 ${pending}`);
  if (offline > 0) warnings.push(`离线不可纠正扇区 ${offline}`);
  if (crc > 0) warnings.push(`UDMA CRC 错误 ${crc}`);
  if (loadCycles > 0 && loadValue != null && loadValue <= 5) {
    warnings.push(`负载/卸载周期 ${loadCycles}，归一化值 ${loadValue}/100`);
  }
  if (commandTimeout > 0) warnings.push(`命令超时属性最差值 ${(get(188) && get(188).worst) ?? '—'}/100`);
  if (!passed) warnings.push('SMART 整体健康自检失败');
  const value = {
    supported: Boolean(data.smart_support ? data.smart_support.available !== false : true),
    enabled: Boolean(data.smart_support ? data.smart_support.enabled !== false : true),
    failing: !passed,
    updatedAt: Date.now(),
    temperatureC: temp != null ? Math.round(Number(temp)) : null,
    powerOnHours: powerOnHours != null ? Math.round(Number(powerOnHours)) : null,
    badSectors: reallocated + pending + offline,
    attributesFailing: 0,
    attributesFailedPast: 0,
    selftest: (data.ata_smart_data && data.ata_smart_data.self_test && data.ata_smart_data.self_test.status && data.ata_smart_data.self_test.status.string) || null,
    warnings,
    loadCycleCount: loadCycles || null,
    loadCycleValue: loadValue,
    reportedUncorrect: reported || null,
    commandTimeout: commandTimeout || null,
    source: 'smartctl',
    model: data.model_name || '',
    serial: data.serial_number || '',
    exitStatus: data.smartctl ? data.smartctl.exit_status : null,
  };
  smartctlCache.set(name, { at: Date.now(), value });
  return value;
}

async function readSmart(name) {
  let smart = null;
  try {
    smart = await readSmartUdisks2(name);
  } catch {
    smart = null;
  }
  if (smart && smart.supported) return smart;
  try {
    const fallback = await readSmartctl(name);
    return fallback || smart;
  } catch {
    return smart;
  }
}

async function scanKernelErrors(deviceNames) {
  if (Date.now() - kernelCache.at < 5 * 60 * 1000) return kernelCache.errors;

  const out = await runCommand(
    'journalctl',
    ['-k', '--since', '7 days ago', '-o', 'cat', '--no-pager', '-n', '40000'],
    25000
  );

  const errors = {};
  const patterns =
    /I\/O error|critical medium error|Buffer I\/O error|blk_update_request|EXT4-fs.*(?:error|warning: mounting fs with errors)|XFS .*error|ata[0-9.]+:.*(?:error|failed)|SMART.*(?:error|failure)|medium error|command failed|link is slow|reset (?:high|full) speed|error count since last fsck|initial error at time|last error at time|fsck/i;

  for (const line of out.split('\n')) {
    if (!line || !patterns.test(line)) continue;
    for (const name of deviceNames) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${name}(?:p?\\d+)?([^A-Za-z0-9]|$)`);
      if (!re.test(line)) continue;
      errors[name] = (errors[name] || 0) + 1;
      errors[`${name}Last`] = line.trim().slice(0, 220);
      const fsCount = /error count since last fsck:\s*(\d+)/i.exec(line);
      if (fsCount) {
        errors[`${name}FsCount`] = Math.max(errors[`${name}FsCount`] || 0, Number(fsCount[1]));
      }
    }
  }

  kernelCache = { at: Date.now(), errors };
  return errors;
}

function basicChecks(dev, kernel) {
  const usage = dev.usage;
  const freePct =
    usage && usage.totalBytes
      ? round((usage.freeBytes / usage.totalBytes) * 100, 1)
      : null;

  return {
    mounted: Boolean(usage),
    mount: dev.mountPrimary || null,
    fsType: dev.fsType || null,
    readOnly: Boolean(dev.readOnly),
    usage,
    freePct,
    kernelErrors: kernel[dev.name] || 0,
    kernelLast: kernel[`${dev.name}Last`] || null,
    fsErrorCount: kernel[`${dev.name}FsCount`] || 0,
  };
}

function composeHealth(dev, smart, basic) {
  const issues = [];
  let status = 'good';

  const raise = (level, message) => {
    if (level === 'critical') status = 'critical';
    else if (level === 'warning' && status !== 'critical') status = 'warning';
    issues.push(message);
  };

  const smartUsable = Boolean(smart && smart.supported);

  if (smartUsable) {
    if (smart.failing) raise('critical', 'SMART 整体健康自检失败');
    if (smart.attributesFailing > 0) {
      raise('critical', `${smart.attributesFailing} 个 SMART 属性超出阈值`);
    }
    if (smart.badSectors > 0) {
      raise('warning', `检测到 ${smart.badSectors} 个坏扇区`);
    }
    const selftestOk =
      !smart.selftest || /success|completed without error|unknown|passed/i.test(smart.selftest);
    if (!selftestOk) {
      raise('warning', `上次自检状态：${smart.selftest}`);
    }
    if (Array.isArray(smart.warnings)) {
      for (const warning of smart.warnings) raise('warning', warning);
    }
    if (smart.temperatureC != null) {
      if (smart.temperatureC >= 65) {
        raise('critical', `温度过高（${smart.temperatureC}°C）`);
      } else if (smart.temperatureC >= 55) {
        raise('warning', `温度偏高（${smart.temperatureC}°C）`);
      }
    }
  }

  if (basic.readOnly) raise('warning', '文件系统当前为只读挂载');
  if (basic.freePct != null) {
    if (basic.freePct < 3) raise('critical', `剩余空间不足（${basic.freePct}%）`);
    else if (basic.freePct < 10) raise('warning', `剩余空间偏低（${basic.freePct}%）`);
  }
  if (basic.fsErrorCount > 0) {
    raise('warning', `文件系统错误记录 ${basic.fsErrorCount} 次，建议运行 e2fsck`);
  }
  if (basic.kernelErrors > 0) {
    raise(
      basic.kernelErrors >= 5 ? 'critical' : 'warning',
      `内核日志中有 ${basic.kernelErrors} 条 I/O/文件系统错误`
    );
  }

  if (!basic.mounted && !smartUsable) status = 'unknown';

  const labels = { good: '良好', warning: '注意', critical: '严重', unknown: '未知' };
  let summary;
  if (status === 'good') {
    summary = smartUsable
      ? `SMART 正常${smart.temperatureC != null ? ` · ${smart.temperatureC}°C` : ''} · 坏扇区 ${
          smart.badSectors ?? 0
        }`
      : '基础检查通过 · SMART 不可用';
  } else if (status === 'unknown') {
    summary = '未挂载，无法完成检查';
  } else {
    summary = issues[0];
  }

  return {
    status,
    label: labels[status],
    summary,
    source: smartUsable ? (smart && smart.source === 'smartctl' ? 'smartctl' : 'smart') : 'basic',
    smartUsable,
    issues,
    checkedAt: Date.now(),
    smart,
    basic,
  };
}

async function refreshHealth(force = false) {
  if (healthState.refreshing) return healthState;
  const today = healthDay();
  if (!force && healthState.at && healthState.date === today) return healthState;

  healthState = { ...healthState, refreshing: true, error: null };
  broadcast('health', healthState);

  const startedAt = Date.now();
  try {
    refreshStatic(true);
    const list = devices.slice();
    const kernel = await scanKernelErrors(list.map((dev) => dev.name));
    const disks = {};

    await Promise.all(
      list.map(async (dev) => {
        let smart = null;
        try {
          smart = await readSmart(dev.name);
        } catch {
          smart = null;
        }
        disks[dev.name] = composeHealth(dev, smart, basicChecks(dev, kernel));
      })
    );

    healthState = {
      at: Date.now(),
      date: today,
      refreshing: false,
      disks,
      durationMs: Date.now() - startedAt,
    };
    saveHealthState();
    broadcast('health', healthState);
    console.log(
      `[health] 检查完成：${list.length} 块磁盘，用时 ${Date.now() - startedAt}ms`
    );
  } catch (err) {
    healthState = { ...healthState, refreshing: false, error: String(err) };
    broadcast('health', healthState);
    console.error('[health]', err);
  }

  return healthState;
}

/* ------------------------------------------------------------------ */
/* 进程                                                                */
/* ------------------------------------------------------------------ */

const HZ = 100; // Linux USER_HZ，x86 上固定为 100
const PAGE_SIZE = 4096;
const CPU_COUNT = Math.max(1, os.cpus().length);
const procCpuPrev = new Map();
const procDiskPrev = new Map();
let userMap = null;
let processScanAt = 0;
let processSnapshot = {
  at: 0,
  total: 0,
  cpuCount: CPU_COUNT,
  memTotal: 0,
  list: [],
};

function loadUserMap() {
  if (userMap) return userMap;
  userMap = new Map();
  for (const line of readText('/etc/passwd').split('\n')) {
    const parts = line.split(':');
    if (parts.length >= 3 && /^\d+$/.test(parts[2])) {
      userMap.set(Number(parts[2]), parts[0]);
    }
  }
  return userMap;
}

function readProcessStat(pid) {
  const raw = readText(`/proc/${pid}/stat`);
  if (!raw) return null;
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const name = raw.slice(open + 1, close);
  const rest = raw.slice(close + 2).trim().split(/\s+/);
  if (rest.length < 22) return null;
  return {
    name,
    state: rest[0],
    ppid: Number(rest[1]) || 0,
    utime: Number(rest[11]) || 0,
    stime: Number(rest[12]) || 0,
    threads: Number(rest[17]) || 0,
    starttime: Number(rest[19]) || 0,
    rssPages: Number(rest[21]) || 0,
  };
}

function readProcessDetails(pid) {
  const status = readText(`/proc/${pid}/status`);
  const uidMatch = /^Uid:\s+(\d+)/m.exec(status);
  const rawCmd = readText(`/proc/${pid}/cmdline`);
  const cmd = rawCmd ? rawCmd.split('\0').filter(Boolean).join(' ').slice(0, 400) : '';
  return { uid: uidMatch ? Number(uidMatch[1]) : null, cmd };
}

function readProcessIo(pid) {
  const text = readText(`/proc/${pid}/io`);
  if (!text) return null;
  const read = /^read_bytes:\s*(\d+)/m.exec(text);
  const write = /^write_bytes:\s*(\d+)/m.exec(text);
  return { read: read ? Number(read[1]) : 0, write: write ? Number(write[1]) : 0 };
}

let treeScanAt = 0;
const procTreeCpuPrev = new Map();

function collectProcessTree(now) {
  const dt = treeScanAt ? Math.max((now - treeScanAt) / 1000, 0.2) : 3;
  treeScanAt = now;

  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    pids = [];
  }

  const all = [];
  for (const pid of pids) {
    const stat = readProcessStat(pid);
    if (!stat) continue;
    const ticks = stat.utime + stat.stime;
    const prev = procTreeCpuPrev.get(pid);
    let cpuPct = 0;
    if (prev && prev.starttime === stat.starttime) {
      const delta = Math.max(0, ticks - prev.ticks);
      cpuPct = (delta / HZ / dt / CPU_COUNT) * 100;
    }
    procTreeCpuPrev.set(pid, { ticks, starttime: stat.starttime });
    all.push({
      pid: Number(pid),
      ppid: stat.ppid,
      name: stat.name,
      displayName: stat.name,
      state: stat.state,
      threads: stat.threads,
      cpuPct,
      rssBytes: stat.rssPages * PAGE_SIZE,
      memPct: 0,
      uid: null,
      user: '',
      cmd: '',
      startTime: stat.starttime,
    });
  }

  const alive = new Set(pids);
  for (const pid of procTreeCpuPrev.keys()) {
    if (!alive.has(pid)) procTreeCpuPrev.delete(pid);
  }

  const mem = readMem();
  const totalMem = mem.total || 1;
  loadUserMap();

  for (const proc of all) {
    proc.memPct = (proc.rssBytes / totalMem) * 100;
    const details = readProcessDetails(proc.pid);
    proc.uid = details.uid;
    proc.cmd = details.cmd;
    proc.user =
      details.uid != null ? userMap.get(details.uid) || String(details.uid) : '';

    const cmdParts = details.cmd ? details.cmd.split(/\s+/).filter(Boolean) : [];
    const firstToken = cmdParts[0] || '';
    const cmdBase = firstToken ? path.basename(firstToken) : '';
    let displayName =
      (proc.name === 'MainThread' || !proc.name) && cmdBase ? cmdBase : proc.name;

    if (proc.name === 'MainThread' || proc.name === 'node' || cmdBase === 'node') {
      const script = cmdParts.slice(1).find((part) => !part.startsWith('-')) || '';
      if (/@deepseek-ai\/dsh|dsh\/lib\/bin\.js/i.test(details.cmd)) {
        displayName = 'DSH Web 服务';
      } else if (/server\.js\b/.test(details.cmd)) {
        displayName = '任务管理器 Web 服务';
      } else if (/code-server/.test(details.cmd)) {
        displayName = 'code-server';
      } else if (/pm2/.test(details.cmd)) {
        displayName = 'pm2';
      } else if (script) {
        displayName = `node (${path.basename(script)})`;
      }
    }
    proc.displayName = displayName;
  }

  all.sort((a, b) => a.pid - b.pid);
  return { at: now, total: all.length, cpuCount: CPU_COUNT, memTotal: totalMem, list: all };
}

function collectProcesses(now) {
  const dt = processScanAt ? Math.max((now - processScanAt) / 1000, 0.2) : 2;
  processScanAt = now;

  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    pids = [];
  }

  const all = [];
  for (const pid of pids) {
    const stat = readProcessStat(pid);
    if (!stat) continue;
    const ticks = stat.utime + stat.stime;
    const prev = procCpuPrev.get(pid);
    let cpuPct = 0;
    if (prev && prev.starttime === stat.starttime) {
      const delta = Math.max(0, ticks - prev.ticks);
      cpuPct = (delta / HZ / dt / CPU_COUNT) * 100;
    }
    procCpuPrev.set(pid, { ticks, starttime: stat.starttime });
    all.push({
      pid: Number(pid),
      name: stat.name,
      state: stat.state,
      threads: stat.threads,
      cpuPct,
      rssBytes: stat.rssPages * PAGE_SIZE,
      memPct: 0,
      uid: null,
      user: '',
      cmd: '',
      readBps: 0,
      writeBps: 0,
    });
  }

  const alive = new Set(pids);
  for (const pid of procCpuPrev.keys()) {
    if (!alive.has(pid)) procCpuPrev.delete(pid);
  }

  const mem = readMem();
  const totalMem = mem.total || 1;

  // 取 CPU 占用最高的 60 个 + 内存最高的 60 个，取并集
  const selected = new Map();
  for (const proc of [...all].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 60)) {
    selected.set(proc.pid, proc);
  }
  for (const proc of [...all].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 60)) {
    selected.set(proc.pid, proc);
  }

  loadUserMap();
  const keep = new Set(selected.keys());
  for (const pid of procDiskPrev.keys()) {
    if (!keep.has(pid)) procDiskPrev.delete(pid);
  }

  for (const proc of selected.values()) {
    proc.memPct = (proc.rssBytes / totalMem) * 100;

    const details = readProcessDetails(proc.pid);
    proc.uid = details.uid;
    proc.cmd = details.cmd;
    proc.user =
      details.uid != null ? userMap.get(details.uid) || String(details.uid) : '';

    const cmdParts = details.cmd ? details.cmd.split(/\s+/).filter(Boolean) : [];
    const firstToken = cmdParts[0] || '';
    const cmdBase = firstToken ? path.basename(firstToken) : '';
    let displayName =
      (proc.name === 'MainThread' || !proc.name) && cmdBase ? cmdBase : proc.name;

    if (proc.name === 'MainThread' || proc.name === 'node' || cmdBase === 'node') {
      const script = cmdParts.slice(1).find((part) => !part.startsWith('-')) || '';
      if (/@deepseek-ai\/dsh|dsh\/lib\/bin\.js/i.test(details.cmd)) {
        displayName = 'DSH Web 服务';
      } else if (/server\.js\b/.test(details.cmd)) {
        displayName = '任务管理器 Web 服务';
      } else if (/code-server/.test(details.cmd)) {
        displayName = 'code-server';
      } else if (/pm2/.test(details.cmd)) {
        displayName = 'pm2';
      } else if (script) {
        displayName = `node (${path.basename(script)})`;
      }
    }
    proc.displayName = displayName;

    const io = readProcessIo(proc.pid);
    if (io) {
      const prev = procDiskPrev.get(proc.pid);
      if (prev) {
        proc.readBps = Math.max(0, (io.read - prev.read) / dt);
        proc.writeBps = Math.max(0, (io.write - prev.write) / dt);
      }
      procDiskPrev.set(proc.pid, { read: io.read, write: io.write });
    }

    proc.cpuPct = round(proc.cpuPct, 1);
    proc.memPct = round(proc.memPct, 1);
    proc.readBps = Math.round(proc.readBps);
    proc.writeBps = Math.round(proc.writeBps);
    proc.rssBytes = Math.round(proc.rssBytes);
  }

  processSnapshot = {
    at: now,
    total: pids.length,
    cpuCount: CPU_COUNT,
    memTotal: totalMem,
    list: [...selected.values()],
  };
  return processSnapshot;
}

/* ------------------------------------------------------------------ */
/* 远程文件传输                                                        */
/* ------------------------------------------------------------------ */

const FILE_PORT_NAMES = {
  21: 'FTP',
  22: 'SFTP',
  80: 'HTTP',
  139: 'SMB',
  443: 'HTTPS',
  445: 'SMB',
  2049: 'NFS',
  5244: 'OpenList',
  8080: 'HTTP',
  8443: 'HTTPS',
  8888: 'HTTP',
  8899: 'HTTP',
  9000: 'HTTP',
};

// 这些协议通常是长期文件共享会话，空闲时也展示；SSH/HTTP 只在真正有流量时展示
const PASSIVE_FILE_PORTS = new Set([21, 139, 445, 2049, 5244]);
// NAS / 文件共享端口用更低的触发阈值，普通 HTTP 保持较高阈值避免网页流量误报
const FILE_SHARE_PORTS = new Set([21, 22, 139, 445, 2049, 5244]);
const REMOTE_ACTIVE_BPS = 8 * 1024;
const REMOTE_HTTP_ACTIVE_BPS = 256 * 1024;
const REMOTE_ACTIVE_GRACE_MS = 10000;
const REMOTE_DISK_MIN_BPS = 32 * 1024;
const INCLUDE_CONTAINERS = process.env.REMOTE_INCLUDE_CONTAINERS === '1';

const TYPE_LABELS = { phone: '手机', tablet: '平板', computer: '电脑', device: '设备' };

const remoteConnPrev = new Map();
const remoteConnSeen = new Map();
const remoteGroups = new Map();
const CLI_DOWNLOAD_RE = /^(curl|wget)$/i;
const cliDownloadPrev = new Map();
let cliDownloadAt = 0;

function scanCliDownloads(now) {
  const downloads = [];
  const dt = cliDownloadAt ? Math.max((now - cliDownloadAt) / 1000, 0.2) : 1;
  cliDownloadAt = now;
  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    pids = [];
  }

  for (const pid of pids) {
    const comm = readText(`/proc/${pid}/comm`).trim();
    if (!CLI_DOWNLOAD_RE.test(comm)) continue;
    const rawCmd = readText(`/proc/${pid}/cmdline`);
    const cmd = rawCmd ? rawCmd.split('\0').filter(Boolean).join(' ') : '';
    if (!/(https?:|ftp:)/i.test(cmd)) continue;

    let filePath = null;
    try {
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        let link = '';
        try {
          link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        if (!link || !link.startsWith('/') || link.includes(' (deleted)')) continue;
        const info = readText(`/proc/${pid}/fdinfo/${fd}`);
        const flags = /^flags:\s*(\d+)/m.exec(info);
        const mode = flags ? parseInt(flags[1], 8) & 3 : 0;
        if (mode !== 1 && mode !== 2) continue;
        let st;
        try {
          st = fs.statSync(link);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size <= 0) continue;
        filePath = link;
        break;
      }
    } catch {
      continue;
    }
    if (!filePath) continue;
    const disk = findDiskForPath(filePath);
    if (!disk) continue;
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      continue;
    }
    const prev = cliDownloadPrev.get(pid);
    const bps = prev && size >= prev.size
      ? Math.round((size - prev.size) / dt)
      : 0;
    cliDownloadPrev.set(pid, { size, at: now });
    const urlMatch = /(https?:\/\/[^\s'"]+)/i.exec(cmd);
    const url = urlMatch ? urlMatch[1] : '';
    let host = '';
    try {
      host = url ? new URL(url).host : '';
    } catch {
      host = '';
    }
    downloads.push({
      pid: Number(pid),
      name: comm,
      file: path.basename(filePath),
      path: filePath,
      disk,
      host,
      size,
      bps,
      active: true,
      at: now,
    });
  }

  const alive = new Set(downloads.map((item) => String(item.pid)));
  for (const pid of cliDownloadPrev.keys()) {
    if (!alive.has(pid)) cliDownloadPrev.delete(pid);
  }
  return downloads;
}

const FILE_SERVICE_CLIENT_PORTS = { jellyfin: 8096, photoprism: 2342 };
const fileServiceClients = new Map();
let fileServiceClientAt = 0;

function clientPortFor(name) {
  const key = Object.keys(FILE_SERVICE_CLIENT_PORTS).find((part) => name.toLowerCase().includes(part));
  return key ? FILE_SERVICE_CLIENT_PORTS[key] : 0;
}

async function scanFileServiceClients() {
  const now = Date.now();
  if (now - fileServiceClientAt < 2000) return;
  fileServiceClientAt = now;
  const names = [...containerFileTransfers.keys()].filter((name) => clientPortFor(name) > 0);
  for (const name of names) {
    const port = clientPortFor(name);
    const clients = new Set();
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const out = await runCommand('docker', ['exec', name, 'cat', file], 4000);
      for (const line of String(out || '').split('\n')) {
        const m = /^\s*\d+:\s+([0-9A-Fa-f]+):([0-9A-Fa-f]+)\s+([0-9A-Fa-f]+):([0-9A-Fa-f]+)\s+01\b/.exec(line);
        if (!m) continue;
        if (parseInt(m[2], 16) !== port) continue;
        let remoteHex = m[3];
        if (!remoteHex || remoteHex === '00000000') continue;
        if (file.endsWith('tcp6')) {
          if (!remoteHex.startsWith('0000000000000000FFFF0000')) continue;
          remoteHex = remoteHex.slice(-8);
        }
        const ip = remoteHex.match(/../g).reverse().map((part) => parseInt(part, 16)).join('.');
        if (!ip || ip.startsWith('127.') || ip === '0.0.0.0') continue;
        clients.add(ip);
      }
    }
    fileServiceClients.set(name, [...clients]);
  }
}

const containerFileTransfers = new Map();
const fileServiceDiskCache = new Map();
const FILE_SERVICE_DISK_FILE = path.join(__dirname, 'data', 'file-service-disks.json');

function loadFileServiceDiskCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE_SERVICE_DISK_FILE, 'utf8'));
    for (const [name, disk] of Object.entries(raw)) {
      if (typeof disk === 'string' && disk) fileServiceDiskCache.set(name, disk);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[file-service-disk] load', err.message);
  }
}

function saveFileServiceDiskCache() {
  try {
    fs.mkdirSync(path.dirname(FILE_SERVICE_DISK_FILE), { recursive: true });
    fs.writeFileSync(FILE_SERVICE_DISK_FILE, JSON.stringify(Object.fromEntries(fileServiceDiskCache), null, 2));
  } catch (err) {
    console.error('[file-service-disk] save', err.message);
  }
}

loadFileServiceDiskCache();

const SMB_HELPER_NAME = 'tm-smb-helper';
const SMB_HELPER_IMAGE = 'openlistteam/openlist:latest';
const smbExact = new Map();
let smbExactBusy = false;

async function ensureSmbHelper() {
  const running = (await runCommand('docker', ['inspect', '-f', '{{.State.Running}}', SMB_HELPER_NAME], 3000)).trim();
  if (running === 'true') return true;
  const exists = (await runCommand('docker', ['inspect', '-f', '{{.Id}}', SMB_HELPER_NAME], 3000)).trim();
  if (exists) {
    await runCommand('docker', ['start', SMB_HELPER_NAME], 5000);
    return true;
  }
  await runCommand('docker', [
    'run', '-d', '--name', SMB_HELPER_NAME,
    '--restart', 'unless-stopped',
    '--pid=host', '--privileged', '--user', '0',
    '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
    '--net=host', '-v', '/:/host',
    '--entrypoint', 'sleep', SMB_HELPER_IMAGE, 'infinity',
  ], 20000);
  return true;
}

function parseSmbSessions(stdout) {
  const sessions = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^(\d+)\s+\S+\s+\S+\s+(\d+\.\d+\.\d+\.\d+)/);
    if (m) sessions.set(Number(m[1]), m[2]);
  }
  return sessions;
}

function parseSmbLocks(stdout) {
  const locks = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^(\d+)\s+\d+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+(\S+)\s+(.+?)\s+\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s*$/);
    if (m) locks.push({ pid: Number(m[1]), rw: m[2], share: m[3], name: m[4] });
  }
  return locks;
}

async function scanSmbExact() {
  if (smbExactBusy) return;
  smbExactBusy = true;
  try {
    await ensureSmbHelper();
    const [sessionsOut, locksOut] = await Promise.all([
      runCommand('docker', ['exec', SMB_HELPER_NAME, 'chroot', '/host', 'smbstatus', '-b'], 5000),
      runCommand('docker', ['exec', SMB_HELPER_NAME, 'chroot', '/host', 'smbstatus', '-L'], 5000),
    ]);
    const sessions = parseSmbSessions(sessionsOut);
    const next = new Map();
    const ensure = (ip, pid) => {
      let state = next.get(ip);
      if (!state) {
        state = { ip, pid, read: [], write: [], disks: new Set() };
        next.set(ip, state);
      }
      return state;
    };

    for (const lock of parseSmbLocks(locksOut)) {
      const ip = sessions.get(lock.pid);
      if (!ip) continue;
      const hostPath = lock.share + '/' + lock.name;
      const disk = findDiskForPath(hostPath);
      if (!disk || disk === 'sdb') continue;
      const state = ensure(ip, lock.pid);
      state.disks.add(disk);
      const item = { path: lock.name, disk, pid: lock.pid };
      if (lock.rw === 'RDONLY' || lock.rw === 'RDWR') state.read.push(item);
      if (lock.rw === 'WRONLY' || lock.rw === 'RDWR') state.write.push(item);
    }

    for (const [pid, ip] of sessions) {
      const script = `
pid="$1"
for f in /proc/$pid/fd/*; do
  t=$(readlink "$f" 2>/dev/null) || continue
  case "$t" in
    /home/kaiqiang/share/*) ;;
    *) continue ;;
  esac
  info=$(echo "$f" | sed 's#/fd/#/fdinfo/#')
  flags=$(awk '/^flags:/{print $2}' "$info" 2>/dev/null)
  echo "$t|$flags"
done
`;
      const out = await runCommand('docker', ['exec', SMB_HELPER_NAME, 'chroot', '/host', 'sh', '-c', script, 'sh', String(pid)], 5000);
      for (const line of String(out || '').split('\n')) {
        if (!line.trim()) continue;
        const [file, flagsText] = line.split('|');
        if (!file || !file.startsWith('/home/kaiqiang/share/')) continue;
        const disk = findDiskForPath(file);
        if (!disk || disk === 'sdb') continue;
        const flags = parseInt(flagsText, 8);
        if (!Number.isFinite(flags)) continue;
        const mode = flags & 3;
        if (mode === 0 || mode === 2) {
          const rel = file.slice('/home/kaiqiang/share/'.length);
          const state = ensure(ip, pid);
          state.disks.add(disk);
          if (!state.read.some((f) => f.path === rel && f.disk === disk)) {
            state.read.push({ path: rel, disk, pid });
          }
        }
        if (mode === 1 || mode === 2) {
          const rel = file.slice('/home/kaiqiang/share/'.length);
          const state = ensure(ip, pid);
          state.disks.add(disk);
          if (!state.write.some((f) => f.path === rel && f.disk === disk)) {
            state.write.push({ path: rel, disk, pid });
          }
        }
      }
    }

    for (const [ip, state] of next) {
      state.readDisk = state.read[0] ? state.read[0].disk : null;
      state.writeDisk = state.write[0] ? state.write[0].disk : null;
      state.file = state.read[0] ? state.read[0].path : state.write[0] ? state.write[0].path : '';
    }
    smbExact.clear();
    for (const [ip, state] of next) smbExact.set(ip, state);
  } catch (err) {
    console.error('[smb-exact]', err.message);
  } finally {
    smbExactBusy = false;
  }
}

setInterval(() => {
  scanSmbExact().catch(() => {});
}, 2500);

let fileServiceOpenState = { at: 0, container: '', disk: null, file: '', files: [] };
const fileServiceOpenStates = new Map();
const containerMountCache = new Map();
let fileServiceOpenBusy = false;

function findDiskForPath(hostPath) {
  let best = null;
  for (const device of devices || []) {
    for (const mnt of device.mount || []) {
      const prefix = String(mnt).replace(/\/$/, '');
      if (hostPath === prefix || hostPath.startsWith(prefix + '/')) {
        if (!best || prefix.length > best.length) best = { name: device.name, length: prefix.length };
      }
    }
  }
  return best ? best.name : null;
}

async function getContainerMounts(name) {
  const cached = containerMountCache.get(name);
  if (cached && Date.now() - cached.at < 60000) return cached.mounts;
  const stdout = await runCommand('docker', ['inspect', name, '--format', '{{json .Mounts}}'], 5000);
  let mounts = [];
  try {
    mounts = JSON.parse(stdout);
  } catch {}
  containerMountCache.set(name, { at: Date.now(), mounts });
  return mounts;
}

async function scanFileServiceOpenFiles() {
  if (fileServiceOpenBusy) return;
  const now = Date.now();
  const names = [];
  for (const [name, item] of containerFileTransfers) {
    if (now - item.lastActive < 10000) names.push(name);
  }
  if (!names.length) return;
  fileServiceOpenBusy = true;
  try {
    for (const name of names) {
      const state = fileServiceOpenStates.get(name) || {
        at: 0,
        container: name,
        disk: null,
        file: '',
        files: [],
      };
      fileServiceOpenStates.set(name, state);
      const mounts = await getContainerMounts(name);
      const shares = mounts.filter((m) => m.Destination && m.Source);
      if (!shares.length) continue;

      const script = `
dest="$1"
for f in /proc/[0-9]*/fd/*; do
  t=$(readlink "$f" 2>/dev/null) || continue
  case "$t" in
    "$dest"/*) ;;
    *) continue ;;
  esac
  info=$(echo "$f" | sed 's#/fd/#/fdinfo/#')
  flags=$(awk '/^flags:/{print $2}' "$info" 2>/dev/null)
  echo "$f|$t|$flags"
done
`;
      const files = [];
      for (const share of shares) {
        const stdout = await runCommand('docker', ['exec', name, 'sh', '-c', script, 'sh', share.Destination], 5000);
        for (const line of String(stdout || '').split('\n')) {
          if (!line.trim()) continue;
          const [fd, containerPath, flagsText] = line.split('|');
          if (!containerPath || !containerPath.startsWith(share.Destination + '/')) continue;
          if (containerPath.startsWith(share.Destination + '/data/')) continue; // OpenList 自身数据/配置
          const flags = parseInt(flagsText, 8);
          const mode = Number.isFinite(flags) ? flags & 3 : 0;
          if (mode !== 0) continue; // 只看只读打开的源文件
          const hostPath = share.Source + containerPath.slice(share.Destination.length);
          const disk = findDiskForPath(hostPath);
          if (!disk || disk === 'sdb') continue; // 系统盘不作为媒体源
          const relative = hostPath.startsWith(share.Source + '/')
            ? hostPath.slice(share.Source.length + 1)
            : hostPath;
          files.push({ fd, hostPath, disk, relative });
        }
      }

      // Jellyfin 的媒体文件通常由 ffmpeg 子进程短暂打开，fd 扫描容易错过；
      // 回退到 Jellyfin 日志里最近一次播放的 file:"..." 路径。
      if (/jellyfin/i.test(name) && !files.length) {
        const logOut = await runCommand(
          'docker',
          ['exec', name, 'sh', '-c', "grep -ho 'file:[^ ]*' /config/log/log_*.log 2>/dev/null | tail -3"],
          5000
        );
        const paths = [...String(logOut || '').matchAll(/file:\\?"([^"\\]+)\\?"/g)]
          .map((m) => m[1])
          .reverse();
        for (const containerPath of paths) {
          const share = shares.find((m) => containerPath.startsWith(m.Destination + '/'));
          if (!share) continue;
          const hostPath = share.Source + containerPath.slice(share.Destination.length);
          const disk = findDiskForPath(hostPath);
          if (!disk || disk === 'sdb') continue;
          const relative = hostPath.startsWith(share.Source + '/')
            ? hostPath.slice(share.Source.length + 1)
            : hostPath;
          files.push({ fd: 'log', hostPath, disk, relative });
          break;
        }
      }

      if (!files.length) {
        // 某些服务（如 PhotoPrism）用 mmap/缓存读图，fd 抓不到；
        // 回退到挂载点所在磁盘，保证至少能画出「磁盘 → 客户端」的线
        const share = shares.find((m) => m.Destination && m.Source);
        if (share) {
          const hostPath = share.Source;
          const disk = findDiskForPath(hostPath);
          if (disk && disk !== 'sdb') {
            state.at = Date.now();
            state.container = name;
            state.disk = disk;
            state.file = '';
            state.files = [];
            fileServiceOpenState = state;
          }
        }
      }

      if (files.length) {
        const counts = new Map();
        for (const f of files) counts.set(f.disk, (counts.get(f.disk) || 0) + 1);
        const cached = fileServiceDiskCache.get(name);
        let disk = cached && counts.has(cached) ? cached : null;
        if (!disk) {
          let best = 0;
          for (const [d, c] of counts) {
            if (c > best) { best = c; disk = d; }
          }
        }
        const selected = files.find((f) => f.disk === disk) || files[0];
        state.at = Date.now();
        state.container = name;
        state.disk = selected.disk;
        state.file = selected.relative;
        state.files = files.slice(0, 8);
        fileServiceOpenState = state;
      }
    }
  } catch (err) {
    console.error('[file-service-open]', err.message);
  } finally {
    fileServiceOpenBusy = false;
  }
}

setInterval(() => {
  scanFileServiceOpenFiles().catch(() => {});
}, 2000);

const remoteExternalState = {
  active: false,
  lastActive: 0,
  lastSeen: 0,
  lastDownload: 0,
  lastUpload: 0,
  lastDisk: null,
  downloadBps: 0,
  uploadBps: 0,
  connections: 0,
  peers: new Set(),
  seen: false,
};
const deviceCache = new Map();
const uaCache = new Map();
let neighborCache = { at: 0, map: new Map() };
let remoteBusy = false;
let remoteLastAt = 0;
let remoteSnapshot = {
  at: 0,
  devices: [],
  external: {
    active: false,
    downloadBps: 0,
    uploadBps: 0,
    connections: 0,
    disk: null,
    peers: [],
    lastSeen: 0,
  },
};

const OUI_MAP = (() => {
  const map = new Map();
  const text = readText('/usr/share/nmap/nmap-mac-prefixes');
  if (text) {
    for (const line of text.split('\n')) {
      const m = /^([0-9A-Fa-f]{6})\s+(.+)$/.exec(line.trim());
      if (m) map.set(m[1].toUpperCase(), m[2].trim());
    }
  }
  return map;
})();

const LOCAL_IPS = new Set();
for (const addresses of Object.values(os.networkInterfaces())) {
  for (const address of addresses || []) {
    LOCAL_IPS.add(normalizeRemoteIp(address.address));
  }
}

function normalizeRemoteIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

function isPrivateIp(ip) {
  if (!ip) return false;
  if (ip.includes(':')) return /^(fe80|fc|fd)/i.test(ip);
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254)
  );
}

function ouiVendor(mac) {
  if (!mac) return '';
  const hex = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 6);
  return OUI_MAP.get(hex) || '';
}

function isLocallyAdministered(mac) {
  const first = Number.parseInt((mac || '').split(':')[0], 16);
  return Number.isFinite(first) && (first & 0x02) !== 0;
}

function cleanVendorName(vendor) {
  if (!vendor) return '';
  return (
    vendor
      .replace(
        /\s+(Device|Devices|Corporate|Corporation|Inc\.?|Incorporated|Co\.?,?\s*Ltd\.?|Company|Technologies?|Technology|Electronics?|Communications?)$/i,
        ''
      )
      .replace(/[,;]+$/, '')
      .trim() || vendor
  );
}

function shortIp(ip) {
  if (!ip) return '';
  if (ip.includes(':') && ip.length > 26) {
    const parts = ip.split(':');
    return `${parts.slice(0, 2).join(':')}…${parts.slice(-2).join(':')}`;
  }
  return ip;
}

async function getNeighbors() {
  if (Date.now() - neighborCache.at < 3000) return neighborCache.map;
  const text = await runCommand('ip', ['neigh', 'show'], 3000);
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+dev\s+(\S+)(?:\s+lladdr\s+(\S+))?/.exec(line.trim());
    if (!m) continue;
    map.set(normalizeRemoteIp(m[1]), { dev: m[2], mac: m[3] || '' });
  }
  neighborCache = { at: Date.now(), map };
  return map;
}

function classifyPeer(ip, neighbor) {
  if (!ip || isLoopbackIp(ip) || LOCAL_IPS.has(ip)) return 'self';
  if (neighbor && /^(docker|br-|veth|virbr)/.test(neighbor.dev)) {
    return INCLUDE_CONTAINERS ? 'lan' : 'container';
  }
  if (neighbor && neighbor.mac) return 'lan';
  if (isPrivateIp(ip)) return 'lan';
  return 'external';
}

function parseEndpoint(value) {
  if (!value) return { host: '', port: 0 };
  const idx = value.lastIndexOf(':');
  if (idx < 0) return { host: normalizeRemoteIp(value), port: 0 };
  let host = value.slice(0, idx);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host: normalizeRemoteIp(host), port: Number(value.slice(idx + 1)) || 0 };
}

function parseSsOutput(text) {
  const connections = [];
  let current = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^[A-Z][A-Z-]+\s+\d+\s+\d+\s+/.test(line)) {
      if (current) connections.push(current);
      current = null;

      const parts = line.split(/\s+/);
      const state = parts[0];
      if (state !== 'ESTAB') continue;

      const local = parseEndpoint(parts[3]);
      const peer = parseEndpoint(parts[4]);
      const service = FILE_PORT_NAMES[local.port];
      if (!service || !peer.host) continue;

      current = {
        localPort: local.port,
        remoteIp: peer.host,
        remotePort: peer.port,
        service,
        sent: 0,
        received: 0,
      };
    }

    if (current) {
      const sent = /bytes_sent:(\d+)/.exec(line);
      const received = /bytes_received:(\d+)/.exec(line);
      if (sent) current.sent = Number(sent[1]);
      if (received) current.received = Number(received[1]);
    }
  }
  if (current) connections.push(current);
  return connections;
}

function parseUserAgent(ua) {
  if (!ua) return null;
  const text = String(ua);

  if (/iPhone/i.test(text)) return { type: 'phone', vendor: 'Apple', model: 'iPhone' };
  if (/iPad/i.test(text)) return { type: 'tablet', vendor: 'Apple', model: 'iPad' };
  if (/Android/i.test(text)) {
    const tablet = !/Mobile/i.test(text);
    let vendor = 'Android';
    let model = tablet ? 'Android 平板' : 'Android 手机';

    if (/Samsung|SM-|SAMSUNG/i.test(text)) {
      vendor = 'Samsung';
      model = tablet ? 'Samsung 平板' : 'Samsung 手机';
    } else if (/Huawei|HONOR/i.test(text)) {
      vendor = 'Huawei';
      model = tablet ? '华为平板' : '华为手机';
    } else if (/Xiaomi|Redmi|POCO/i.test(text)) {
      vendor = 'Xiaomi';
      model = tablet ? '小米平板' : '小米手机';
    } else if (/OPPO|CPH\d/i.test(text)) {
      vendor = 'OPPO';
      model = tablet ? 'OPPO 平板' : 'OPPO 手机';
    } else if (/vivo|V\d{4}/i.test(text)) {
      vendor = 'vivo';
      model = tablet ? 'vivo 平板' : 'vivo 手机';
    } else if (/OnePlus/i.test(text)) {
      vendor = 'OnePlus';
      model = tablet ? 'OnePlus 平板' : 'OnePlus 手机';
    } else if (/Pixel/i.test(text)) {
      vendor = 'Google';
      model = tablet ? 'Pixel 平板' : 'Pixel 手机';
    } else if (/Lenovo|TB-|YT-/i.test(text)) {
      vendor = 'Lenovo';
      model = tablet ? '联想平板' : '联想手机';
    }
    return { type: tablet ? 'tablet' : 'phone', vendor, model };
  }
  if (/Windows/i.test(text)) return { type: 'computer', vendor: 'Microsoft', model: 'Windows 电脑' };
  if (/Macintosh|Mac OS X/i.test(text)) return { type: 'computer', vendor: 'Apple', model: 'Mac' };
  if (/CrOS/i.test(text)) return { type: 'computer', vendor: 'Google', model: 'Chromebook' };
  if (/Linux/i.test(text)) return { type: 'computer', vendor: 'Linux', model: 'Linux 电脑' };
  return null;
}

async function resolveHostname(ip) {
  let name = '';

  const avahi = await runCommand('avahi-resolve-address', [ip], 1500);
  const match = /^(\S+)\s+(\S+)/.exec(avahi.trim());
  if (match && match[2] && match[2] !== ip && !match[2].includes(':')) {
    name = match[2].replace(/\.local$/, '');
  }

  if (!name && !ip.includes(':')) {
    const nbt = await runCommand('nmblookup', ['-A', ip], 1200);
    const nm = /^\s*(\S+)\s+<00>\s+-\s+[BM]\s+<ACTIVE>/m.exec(nbt);
    if (nm) name = nm[1];
  }
  return name;
}

function deviceInfo(ip, neighbor) {
  let cached = deviceCache.get(ip);
  if (!cached) {
    cached = { ip, hostname: '', hostnameTried: false, at: 0 };
    deviceCache.set(ip, cached);
  }

  const uaEntry = uaCache.get(ip);
  const uaInfo = uaEntry ? parseUserAgent(uaEntry.ua) : null;
  const mac = (neighbor && neighbor.mac) || cached.mac || '';
  const oui = ouiVendor(mac);
  const randomMac = mac ? isLocallyAdministered(mac) : false;

  let type = uaInfo ? uaInfo.type : '';
  let vendor = uaInfo ? uaInfo.vendor : '';
  let model = uaInfo ? uaInfo.model : '';

  const hostname = cached.hostname || '';
  const hn = hostname.toLowerCase();
  if (!type) {
    if (/iphone|ipod/.test(hn)) type = 'phone';
    else if (/ipad/.test(hn)) type = 'tablet';
    else if (/macbook|imac|mac mini|mac studio|mac pro/.test(hn)) type = 'computer';
    else if (/android/.test(hn)) type = /tab|pad/.test(hn) ? 'tablet' : 'phone';
    else if (/desktop|laptop|notebook|windows|win-/.test(hn)) type = 'computer';
    else if (/tab|pad/.test(hn)) type = 'tablet';
  }
  if (!type && oui) {
    const v = oui.toLowerCase();
    if (/intel|dell|lenovo|hewlett|hp |asus|acer|micro-star|msi|microsoft|razer|gigabyte|asrock/.test(v)) type = 'computer';
    else if (/samsung|huawei|xiaomi|oppo|vivo|oneplus|google|motorola|honor|realme|tcl|zte/.test(v)) type = 'phone';
  }
  if (!type) type = 'device';
  if (!vendor) vendor = oui || (randomMac ? '随机 MAC' : '未知');
  vendor = cleanVendorName(vendor);

  const typeLabel = TYPE_LABELS[type] || '设备';
  let name = hostname || model;
  if (!name) {
    name = vendor && vendor !== '未知' && vendor !== '随机 MAC'
      ? `${vendor} ${typeLabel}`
      : shortIp(ip);
  }

  if (!cached.hostnameTried) {
    cached.hostnameTried = true;
    resolveHostname(ip)
      .then((resolved) => {
        if (resolved) {
          cached.hostname = resolved;
          cached.hostnameTried = true;
        }
      })
      .catch(() => {});
  }

  Object.assign(cached, { mac, type, vendor, model, name, typeLabel, at: Date.now() });
  return cached;
}

function pickRemoteDisk(mode, exclude = null, minRate = 0) {
  if (!lastDiskDevices || !lastDiskDevices.length) return null;
  let best = null;
  for (const disk of lastDiskDevices) {
    if (exclude && exclude.has(disk.name)) continue;
    const rate = mode === 'read' ? disk.readBps : disk.writeBps;
    if (rate < minRate) continue;
    if (!best || rate > best.rate) best = { name: disk.name, rate };
  }
  if (!best) return null;
  if (best.rate >= REMOTE_DISK_MIN_BPS) return best.name;
  // 小文件传输时磁盘速率可能很低，仍然映射到当前最忙的盘，保证曲线能画出来
  return best.rate > 0 ? best.name : null;
}

async function collectRemote() {
  if (remoteBusy) return;
  remoteBusy = true;

  try {
    const now = Date.now();
    const dt = remoteLastAt ? Math.max((now - remoteLastAt) / 1000, 0.2) : 0.5;
    remoteLastAt = now;

    const [ssOut, neighbors] = await Promise.all([
      runCommand('ss', ['-tinp'], 5000),
      getNeighbors(),
    ]);

    const connections = parseSsOutput(ssOut);

    // 每轮先清零当前速率，历史速率 / 最后活动时间保留在持久 group 里
    for (const group of remoteGroups.values()) {
      group.downloadBps = 0;
      group.uploadBps = 0;
      group.connections = 0;
      group.seen = false;
    }
    const external = remoteExternalState;
    external.downloadBps = 0;
    external.uploadBps = 0;
    external.connections = 0;
    external.peers = new Set();
    external.seen = false;

    for (const conn of connections) {
      const key = `${conn.localPort}:${conn.remoteIp}:${conn.remotePort}`;
      const prev = remoteConnPrev.get(key);
      const sentRate = prev ? Math.max(0, (conn.sent - prev.sent) / dt) : 0;
      const receivedRate = prev ? Math.max(0, (conn.received - prev.received) / dt) : 0;
      remoteConnPrev.set(key, { sent: conn.sent, received: conn.received, at: now });

      const threshold = FILE_SHARE_PORTS.has(conn.localPort)
        ? REMOTE_ACTIVE_BPS
        : REMOTE_HTTP_ACTIVE_BPS;
      const active = sentRate + receivedRate >= threshold;
      if (active) {
        remoteConnSeen.set(key, {
          at: now,
          sentRate,
          receivedRate,
          service: conn.service,
          remoteIp: conn.remoteIp,
        });
      }

      if (!active && !PASSIVE_FILE_PORTS.has(conn.localPort)) continue;

      const neighbor = neighbors.get(conn.remoteIp);
      const kind = classifyPeer(conn.remoteIp, neighbor);
      if (kind === 'self') continue;
      if (kind === 'container' && !INCLUDE_CONTAINERS) continue;

      if (kind === 'lan') {
        let group = remoteGroups.get(conn.remoteIp);
        if (!group) {
          group = {
            ip: conn.remoteIp,
            neighbor,
            services: new Set(),
            connections: 0,
            downloadBps: 0,
            uploadBps: 0,
            lastActive: 0,
            lastDownload: 0,
            lastUpload: 0,
            lastDisk: null,
            lastSeen: 0,
            seen: false,
          };
          remoteGroups.set(conn.remoteIp, group);
        }
        group.neighbor = neighbor;
        group.seen = true;
        group.lastSeen = now;
        group.services.add(conn.service);
        group.connections += 1;
        group.downloadBps += sentRate;
        group.uploadBps += receivedRate;
        if (active) {
          group.lastActive = now;
          group.lastDownload = group.downloadBps;
          group.lastUpload = group.uploadBps;
        }
      } else {
        external.seen = true;
        external.lastSeen = now;
        external.connections += 1;
        external.downloadBps += sentRate;
        external.uploadBps += receivedRate;
        external.peers.add(conn.remoteIp);
        if (active) {
          external.lastActive = now;
          external.lastDownload = external.downloadBps;
          external.lastUpload = external.uploadBps;
        }
      }
    }

    // 清理已经断开且超出保持时间的设备
    for (const [ip, group] of remoteGroups) {
      const active = now - group.lastActive < REMOTE_ACTIVE_GRACE_MS;
      if (!group.seen && !active && now - group.lastSeen > REMOTE_ACTIVE_GRACE_MS) {
        remoteGroups.delete(ip);
      }
    }

    for (const [key, value] of remoteConnPrev) {
      if (now - value.at > 10000) remoteConnPrev.delete(key);
    }
    for (const [key, value] of remoteConnSeen) {
      if (now - value.at > 5000) remoteConnSeen.delete(key);
    }
    for (const [ip, entry] of uaCache) {
      if (now - entry.at > 3600 * 1000) uaCache.delete(ip);
    }
    for (const [ip, entry] of deviceCache) {
      if (now - entry.at > 3600 * 1000) deviceCache.delete(ip);
    }

    const devices = [];
    for (const [ip, group] of remoteGroups) {
      const active = now - group.lastActive < REMOTE_ACTIVE_GRACE_MS;
      if (!group.seen && !active) continue;

      const info = deviceInfo(ip, group.neighbor);
      const downloadBps = active
        ? Math.max(group.downloadBps, group.lastDownload || 0)
        : group.downloadBps;
      const uploadBps = active
        ? Math.max(group.uploadBps, group.lastUpload || 0)
        : group.uploadBps;
      const download = downloadBps >= uploadBps;
      const exact = smbExact.get(ip);
      const readDisk = active
        ? (exact && exact.readDisk ? exact.readDisk : pickRemoteDisk('read'))
        : null;
      const writeDisk = active
        ? (exact && exact.writeDisk ? exact.writeDisk : pickRemoteDisk('write'))
        : null;

      let disk = download ? readDisk : writeDisk;
      if (disk) group.lastDisk = disk;
      if (active && !disk) disk = group.lastDisk || null;

      devices.push({
        id: ip,
        ip,
        ipLabel: shortIp(ip),
        name: info.name,
        vendor: info.vendor,
        type: info.type,
        typeLabel: info.typeLabel,
        mac: info.mac,
        hostname: info.hostname,
        services: [...group.services],
        connections: group.connections,
        downloadBps: Math.round(downloadBps),
        uploadBps: Math.round(uploadBps),
        active,
        disk,
        readDisk,
        writeDisk,
        readFile: exact && exact.read[0] ? exact.read[0].path : '',
        writeFile: exact && exact.write[0] ? exact.write[0].path : '',
        lastSeen: group.lastActive || now,
      });
    }

    const mediaItems = [...containerFileTransfers.values()].filter(
      (item) => clientPortFor(item.name) > 0 && now - item.lastActive < 10000
    );
    const mediaCards = [];
    for (const item of mediaItems) {
      const clients = fileServiceClients.get(item.name) || [];
      const openState = fileServiceOpenStates.get(item.name);
      const open = openState && now - openState.at < 8000 ? openState : null;
      const disk = open && open.disk ? open.disk : item.disk || null;
      const file = open && open.file ? open.file : '';
      mediaCards.push({
        id: `container:${item.name}`,
        ip: clients[0] || 'docker',
        ipLabel: clients[0] || 'Docker 网络',
        name: clients[0] || item.app || 'Jellyfin',
        vendor: /openlist/i.test(item.name)
          ? 'OpenList 客户端'
          : /photoprism/i.test(item.name)
            ? 'PhotoPrism 客户端'
            : 'Jellyfin 客户端',
        type: 'container',
        typeLabel: /openlist/i.test(item.name)
          ? '网盘播放'
          : /photoprism/i.test(item.name)
            ? '照片/视频'
            : '媒体服务',
        services: [
          /openlist/i.test(item.name)
            ? 'OpenList'
            : /photoprism/i.test(item.name)
              ? 'PhotoPrism'
              : 'Jellyfin',
        ],
        connections: clients.length || 1,
        downloadBps: Math.round(Math.max(item.sendBps || 0, item.lastSend || 0)),
        uploadBps: Math.round(Math.max(item.recvBps || 0, item.lastRecv || 0)),
        active: true,
        disk,
        readDisk: disk,
        writeDisk: null,
        readFile: file,
        writeFile: '',
        clients,
        lastSeen: now,
        streams: [{
          service: /openlist/i.test(item.name)
            ? 'OpenList'
            : /photoprism/i.test(item.name)
              ? 'PhotoPrism'
              : 'Jellyfin',
          file,
          disk,
          bps: Math.round(Math.max(item.sendBps || 0, item.lastSend || 0)),
        }],
      });
    }

    devices.push(...mediaCards);

    if (mediaItems.length && now - fileServiceOpenState.at > 2000) {
      scanFileServiceOpenFiles().catch(() => {});
    }

    devices.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.downloadBps + b.uploadBps - (a.downloadBps + a.uploadBps);
    });

    // LAN 设备下载正在读取的磁盘，避免 OpenList 外部上传把源盘认错
    const claimedReadDisks = new Set(
      devices
        .filter((device) => device.active && (device.downloadBps || 0) > 256 * 1024 && device.readDisk)
        .map((device) => device.readDisk)
    );

    let extActive = Boolean(external.active) && now - external.lastSeen < REMOTE_ACTIVE_GRACE_MS;
    let extDownload = extActive
      ? Math.max(external.downloadBps, external.lastDownload || 0)
      : external.downloadBps;
    let extUpload = extActive
      ? Math.max(external.uploadBps, external.lastUpload || 0)
      : external.uploadBps;
    let extDisk = extActive ? pickRemoteDisk(extDownload >= extUpload ? 'read' : 'write') : null;
    if (extDisk) external.lastDisk = extDisk;
    if (extActive && !extDisk) extDisk = external.lastDisk || null;

    let extPeers = [...external.peers].slice(0, 5);
    let aria2Active = false;
    if (
      aria2State.at &&
      now - aria2State.at < 3500 &&
      aria2State.active &&
      now - aria2State.lastActive < REMOTE_ACTIVE_GRACE_MS
    ) {
      aria2Active = true;
      extActive = true;
      extDownload += Math.max(aria2State.speed || 0, aria2State.lastSpeed || 0);
      extUpload += aria2State.upload || 0;
      if (!extDisk) extDisk = aria2State.disk || aria2State.lastDisk || pickRemoteDisk('write');
      extPeers = [...new Set([...extPeers, ...(aria2State.peers || [])])].slice(0, 5);
    }

    let fileServiceActive = false;
    let fileServiceName = '';
    let fileServiceSend = 0;
    let fileServiceRecv = 0;
    let fileServiceDisk = null;
    let fileServiceFile = '';
    for (const item of containerFileTransfers.values()) {
      if (now - item.lastActive > 10000) continue;
      if (clientPortFor(item.name) > 0) continue;
      fileServiceActive = true;
      if (!fileServiceName) fileServiceName = item.app;
      fileServiceSend += item.sendBps || 0;
      fileServiceRecv += item.recvBps || 0;

      const open = fileServiceOpenState.container === item.name &&
        now - fileServiceOpenState.at < 8000
        ? fileServiceOpenState
        : null;

      if (open && open.disk) {
        if (item.disk !== open.disk) {
          item.disk = open.disk;
          fileServiceDiskCache.set(item.name, open.disk);
          saveFileServiceDiskCache();
        }
        if (!fileServiceFile && open.file) fileServiceFile = open.file;
      } else if (!item.disk) {
        // 没有打开文件时只使用上次已知磁盘，不再用读写速率猜测
        const cached = fileServiceDiskCache.get(item.name);
        if (cached) item.disk = cached;
      }
      if (!fileServiceDisk && item.disk) fileServiceDisk = item.disk;
    }
    if (fileServiceActive) {
      extActive = true;
      extUpload += fileServiceSend;
      extDownload += fileServiceRecv;
      if (!extDisk) extDisk = fileServiceDisk;
      if (now - fileServiceOpenState.at > 2000) {
        scanFileServiceOpenFiles().catch(() => {});
      }
    }

    scanFileServiceClients().catch(() => {});
    const cliDownloads = scanCliDownloads(now);
    const cliActive = cliDownloads.length > 0;
    if (cliActive) {
      extActive = true;
      extDownload += cliDownloads.reduce((sum, item) => sum + (item.bps || 0), 0);
      if (!extDisk) extDisk = cliDownloads[0].disk;
      extPeers = [...new Set([...extPeers, ...cliDownloads.map((item) => item.host).filter(Boolean)])].slice(0, 5);
    }

    remoteSnapshot = {
      at: now,
      devices: devices.slice(0, 8),
      external: {
        active: extActive,
        downloadBps: Math.round(extDownload),
        uploadBps: Math.round(extUpload),
        connections: external.connections,
        disk: extDisk,
        peers: extPeers,
        aria2: aria2Active,
        aria2Name: aria2Active ? aria2State.name : '',
        aria2Title: aria2Active ? aria2State.title : '',
        aria2Speed: aria2Active ? Math.round(aria2State.speed) : 0,
        fileService: fileServiceActive,
        fileServiceName: fileServiceActive ? fileServiceName : '',
        fileServiceFile: fileServiceActive ? fileServiceFile : '',
        cliDownload: cliActive,
        cliName: cliActive ? cliDownloads[0].name : '',
        cliFile: cliActive ? cliDownloads[0].file : '',
        cliHost: cliActive ? cliDownloads[0].host : '',
        cliDisk: cliActive ? cliDownloads[0].disk : '',
        cliBps: cliActive ? cliDownloads.reduce((sum, item) => sum + (item.bps || 0), 0) : 0,
        cliDownloads: cliActive ? cliDownloads : [],
        lastSeen: Math.max(external.lastSeen || 0, aria2Active ? aria2State.lastActive : 0),
      },
    };

    broadcast('remote', remoteSnapshot);
  } catch (err) {
    console.error('[remote]', err);
  } finally {
    remoteBusy = false;
  }
}
/* ------------------------------------------------------------------ */
/* aria2 容器下载（外部下载）                                          */
/* ------------------------------------------------------------------ */

let aria2Config = null;
let aria2ConfigAt = 0;
let aria2Busy = false;
let aria2DiscoverBusy = false;
let aria2Failures = 0;

const aria2State = {
  at: 0,
  active: false,
  speed: 0,
  upload: 0,
  lastSpeed: 0,
  lastUpload: 0,
  lastActive: 0,
  lastDisk: null,
  disk: null,
  peers: [],
  name: 'aria2',
  title: '',
  numActive: 0,
};

function containerPathToHost(containerPath, mounts) {
  if (!containerPath) return '';
  let best = null;
  for (const mount of mounts || []) {
    const dest = (mount.Destination || '').replace(/\/$/, '');
    if (!dest) continue;
    if (containerPath === dest || containerPath.startsWith(`${dest}/`)) {
      if (!best || dest.length > best.dest.length) {
        best = { dest, source: (mount.Source || '').replace(/\/$/, '') };
      }
    }
  }
  return best ? `${best.source}${containerPath.slice(best.dest.length)}` : containerPath;
}

async function discoverAria2() {
  if (aria2DiscoverBusy) return aria2Config;
  aria2DiscoverBusy = true;
  try {
    const ps = await runCommand('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}'], 4000);
    const candidate = ps
      .split('\n')
      .map((line) => line.split('\t'))
      .find(([name, image]) => /aria2/i.test(name || '') && !/ariang/i.test(name || '') && !/ariang/i.test(image || ''));
    if (!candidate) return null;

    const [name] = candidate;
    const envText = await runCommand(
      'docker',
      ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', name],
      4000
    );
    const env = {};
    for (const line of envText.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
    }

    const port = Number(env.RPC_PORT) || 6800;
    const secret = env.RPC_SECRET || '';
    const mountsText = await runCommand('docker', ['inspect', '--format', '{{json .Mounts}}', name], 4000);
    let mounts = [];
    try {
      mounts = JSON.parse(mountsText.trim() || '[]');
    } catch {
      mounts = [];
    }

    const networkMode = (
      await runCommand('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}}', name], 4000)
    ).trim();

    let endpoint = `http://127.0.0.1:${port}/jsonrpc`;
    if (networkMode !== 'host') {
      let ports = {};
      try {
        ports = JSON.parse(
          (await runCommand('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name], 4000)).trim() || '{}'
        );
      } catch {
        ports = {};
      }
      const binding = ports[`${port}/tcp`];
      if (binding && binding[0] && binding[0].HostPort) {
        endpoint = `http://127.0.0.1:${binding[0].HostPort}/jsonrpc`;
      } else {
        const ip = (
          await runCommand(
            'docker',
            ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name],
            4000
          )
        ).trim();
        if (ip) endpoint = `http://${ip}:${port}/jsonrpc`;
      }
    }

    aria2Config = { name, endpoint, secret, mounts, at: Date.now() };
    aria2ConfigAt = Date.now();
    return aria2Config;
  } catch {
    return null;
  } finally {
    aria2DiscoverBusy = false;
  }
}

async function aria2Call(method, params) {
  const response = await fetch(aria2Config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'tm', method, params }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`aria2 HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'aria2 error');
  return data.result;
}

async function collectAria2() {
  if (aria2Busy) return;
  aria2Busy = true;

  try {
    const now = Date.now();
    if (!aria2Config || now - aria2ConfigAt > 60000) {
      await discoverAria2();
    }
    if (!aria2Config) {
      aria2State.at = now;
      aria2State.active = now - aria2State.lastActive < REMOTE_ACTIVE_GRACE_MS;
      return;
    }

    const auth = aria2Config.secret ? [`token:${aria2Config.secret}`] : [];
    const [stat, active] = await Promise.all([
      aria2Call('aria2.getGlobalStat', auth),
      aria2Call('aria2.tellActive', [...auth, ['gid', 'downloadSpeed', 'dir']]),
    ]);

    const speed = Number(stat.downloadSpeed) || 0;
    const upload = Number(stat.uploadSpeed) || 0;
    const numActive = Number(stat.numActive) || 0;

    let disk = null;
    let title = '';
    const peers = new Set();

    for (const item of active || []) {
      if (!disk) {
        const dir = item.dir || (item.files && item.files[0] && item.files[0].path);
        if (dir) {
          const hostPath = containerPathToHost(dir, aria2Config.mounts);
          disk = diskForPath(hostPath);
        }
      }
      for (const file of item.files || []) {
        if (!title && file.path) title = file.path.split('/').pop();
        for (const uri of file.uris || []) {
          try {
            const parsed = new URL(uri.uri);
            if (parsed.hostname) peers.add(parsed.hostname);
          } catch {
            /* ignore invalid uri */
          }
        }
      }
    }

    const activeNow = numActive > 0 && speed + upload >= 8 * 1024;
    if (activeNow) {
      aria2State.lastActive = now;
      aria2State.lastSpeed = speed;
      aria2State.lastUpload = upload;
      aria2State.lastDisk = disk || aria2State.lastDisk;
    }

    const activeGrace = now - aria2State.lastActive < REMOTE_ACTIVE_GRACE_MS;
    aria2State.at = now;
    aria2State.active = activeNow || activeGrace;
    aria2State.speed = activeNow ? speed : activeGrace ? aria2State.lastSpeed : 0;
    aria2State.upload = activeNow ? upload : activeGrace ? aria2State.lastUpload : 0;
    aria2State.disk = activeNow ? disk || aria2State.lastDisk : activeGrace ? aria2State.lastDisk : null;
    aria2State.peers = [...peers].slice(0, 5);
    aria2State.name = aria2Config.name;
    aria2State.title = title || aria2State.title;
    aria2State.numActive = numActive;
    aria2Failures = 0;
  } catch {
    aria2State.at = Date.now();
    aria2State.active = Date.now() - aria2State.lastActive < REMOTE_ACTIVE_GRACE_MS;
    aria2Failures += 1;
    if (aria2Failures >= 5) {
      aria2ConfigAt = 0;
      aria2Failures = 0;
    }
  } finally {
    aria2Busy = false;
  }
}

/* ------------------------------------------------------------------ */
/* 用户 / 服务 / 网络连接                                              */
/* ------------------------------------------------------------------ */

const NET_PORT_APPS = {
  21: 'FTP',
  22: 'SSH',
  53: 'DNS',
  67: 'DHCP',
  80: 'HTTP',
  139: 'SMB',
  443: 'HTTPS',
  445: 'SMB',
  2049: 'NFS',
  2342: 'PhotoPrism',
  3080: 'DSH Web',
  3081: 'DSH Web',
  3306: 'MariaDB',
  5244: 'OpenList',
  6379: 'Redis',
  6800: 'aria2 RPC',
  8080: 'qBittorrent',
  8081: 'Kodbox',
  8090: 'Halo',
  8091: 'NCM Tool',
  8096: 'Jellyfin',
  8777: '任务管理器 Web',
  9000: 'Portainer',
  9443: 'FreeCut',
  40108: 'Navidrome',
};
const NET_SERVER_PORTS = new Set(Object.keys(NET_PORT_APPS).map(Number));

let usersSnapshot = {
  at: 0,
  groups: [],
  sessions: [],
  summary: { users: 0, sessions: 0, connections: 0, hosts: 0 },
};
let usersBusy = false;

let servicesSnapshot = {
  at: 0,
  services: [],
  summary: { total: 0, running: 0, failed: 0, inactive: 0, exited: 0 },
};
let servicesBusy = false;

let networkSnapshot = {
  at: 0,
  connections: [],
  summary: {
    total: 0,
    inbound: 0,
    outbound: 0,
    listening: 0,
    tcp: 0,
    udp: 0,
    recvBps: 0,
    sendBps: 0,
  },
};
const NET_RATE_WINDOW_MS = 10000;
const networkRateHistory = new Map();
const containerNetHistory = new Map();
let networkLastAt = 0;
let networkBusy = false;

function parseDockerSize(text) {
  const match = /^([\d.]+)\s*([a-zA-Z]+)$/.exec((text || '').trim());
  if (!match) return 0;
  const value = Number(match[1]) || 0;
  const unit = match[2].toLowerCase();
  const factor = unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('k') ? 1024 : 1;
  return Math.round(value * factor);
}

function containerDisplayName(name) {
  const known = {
    jellyfin: 'Jellyfin',
    openlist: 'OpenList',
    qbittorrent: 'qBittorrent',
    'aria2-pro': 'aria2',
    'ncm-tool': 'NCM Tool',
    navidrome: 'Navidrome',
    halo: 'Halo',
    filebrowser: 'FileBrowser',
    kodbox: 'Kodbox',
    photoprism: 'PhotoPrism',
    mariadb: 'MariaDB',
    freecut: 'FreeCut',
    mediago: 'MediaGo',
  };
  const clean = name.replace(/^1Panel-/i, '').replace(/-[A-Za-z0-9]{4}$/, '');
  return known[clean.toLowerCase()] || clean || name;
}

function splitSsEndpoint(value) {
  if (!value) return { host: '', port: 0 };
  const idx = value.lastIndexOf(':');
  if (idx < 0) return { host: value, port: 0 };
  let host = value.slice(0, idx);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.split('%')[0];
  const portText = value.slice(idx + 1);
  return { host, port: portText === '*' ? 0 : Number(portText) || 0 };
}

function formatSsEndpoint(host, port) {
  if (!host) return port ? `:${port}` : '*';
  if (host === '::' || host === '0.0.0.0' || host === '*') {
    return port ? `*:${port}` : '*';
  }
  const h = host.includes(':') ? `[${host}]` : host;
  return port ? `${h}:${port}` : h;
}

function isLoopbackHost(host) {
  return host === '::1' || host === 'localhost' || host.startsWith('127.');
}

function parseSsProcess(text) {
  const match = /users:\(\("([^"]+)",pid=(\d+)/.exec(text || '');
  return match ? { name: match[1], pid: Number(match[2]) } : { name: '', pid: 0 };
}

function parseSsAll(text) {
  const connections = [];
  let current = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^(tcp|udp)\s+/.test(line)) {
      if (current) connections.push(current);
      const parts = line.trim().split(/\s+/);
      const proto = parts[0];
      const state = parts[1];
      const local = splitSsEndpoint(parts[4]);
      const peer = splitSsEndpoint(parts[5]);
      current = {
        proto,
        state,
        local,
        peer,
        process: parts.slice(6).join(' '),
        sent: 0,
        received: 0,
      };
      continue;
    }
    if (current) {
      const sent = /bytes_sent:(\d+)/.exec(line);
      const received = /bytes_received:(\d+)/.exec(line);
      if (sent) current.sent = Number(sent[1]);
      if (received) current.received = Number(received[1]);
    }
  }
  if (current) connections.push(current);
  return connections;
}

async function collectUsers() {
  if (usersBusy) return;
  usersBusy = true;

  try {
    const [whoOut, wOut, ssOut] = await Promise.all([
      runCommand('who', ['-u'], 3000),
      runCommand('w', ['-h'], 3000),
      runCommand('ss', ['-tn'], 3000),
    ]);

    const commands = new Map();
    for (const line of wOut.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      commands.set(`${match[1]}|${match[2]}`, {
        from: match[3],
        idle: match[5],
        what: match[8] || '',
      });
    }

    const clientsByHost = new Map();
    for (const line of ssOut.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] !== 'ESTAB' || parts.length < 5) continue;
      const local = splitSsEndpoint(parts[3]);
      const peer = splitSsEndpoint(parts[4]);
      if (!peer.host || isLoopbackHost(peer.host) || !NET_SERVER_PORTS.has(local.port)) continue;
      let client = clientsByHost.get(peer.host);
      if (!client) {
        client = { count: 0, ports: new Set() };
        clientsByHost.set(peer.host, client);
      }
      client.count += 1;
      client.ports.add(local.port);
    }

    const sessions = [];
    for (const line of whoOut.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\S+)\s+(\d+)\s+\(([^)]*)\)/.exec(line.trim());
      if (!match) continue;
      const user = match[1];
      const tty = match[2];
      const host = match[7] || '';
      const known = commands.get(`${user}|${tty}`);
      sessions.push({
        user,
        tty,
        host,
        hostLabel: host === ':0' ? '本地' : host,
        pid: Number(match[6]),
        loginAt: `${match[3]} ${match[4]}`,
        idle: match[5] === '?' ? '—' : match[5],
        command: (known && known.what) || '—',
      });
    }

    const groups = new Map();
    const loggedHosts = new Set();
    for (const session of sessions) {
      const key = `${session.user}|${session.host}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          user: session.user,
          host: session.host,
          hostLabel: session.hostLabel,
          sessions: 0,
          connections: clientsByHost.get(session.host)?.count || 0,
          ttys: [],
          loginAt: session.loginAt,
          idle: session.idle,
          command: session.command,
          services: session.host === ':0' ? ['本地'] : ['SSH'],
        };
        groups.set(key, group);
      }
      group.sessions += 1;
      group.ttys.push(session.tty);
      if (session.host !== ':0') {
        group.services = ['SSH'];
        loggedHosts.add(session.host);
      }
    }

    for (const [host, client] of clientsByHost) {
      if (loggedHosts.has(host)) continue;
      const services = [...client.ports].map((port) => NET_PORT_APPS[port] || `端口 ${port}`);
      groups.set(`client|${host}`, {
        key: `client|${host}`,
        user: '网络客户端',
        host,
        hostLabel: host,
        sessions: 0,
        connections: client.count,
        ttys: [],
        loginAt: '—',
        idle: '—',
        command: services.join(' / '),
        services,
      });
    }

    const hostSet = new Set();
    let totalConnections = 0;
    for (const host of new Set(sessions.map((session) => session.host))) {
      if (host !== ':0') hostSet.add(host);
    }
    for (const [host, client] of clientsByHost) {
      hostSet.add(host);
      totalConnections += client.count;
    }

    usersSnapshot = {
      at: Date.now(),
      sessions,
      groups: [...groups.values()].sort((a, b) => a.user.localeCompare(b.user) || a.host.localeCompare(b.host)),
      summary: {
        users: new Set(sessions.map((session) => session.user)).size,
        sessions: sessions.length,
        connections: totalConnections,
        hosts: hostSet.size,
      },
    };
    broadcast('users', usersSnapshot);
  } catch (err) {
    console.error('[users]', err);
  } finally {
    usersBusy = false;
  }
}

async function collectServices() {
  if (servicesBusy) return;
  servicesBusy = true;

  try {
    const out = await runCommand(
      'systemctl',
      ['list-units', '--type=service', '--all', '--no-pager', '--no-legend', '--plain'],
      8000
    );
    const services = [];
    const summary = { total: 0, running: 0, failed: 0, inactive: 0, exited: 0 };

    for (const line of out.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const service = {
        name: match[1],
        load: match[2],
        active: match[3],
        sub: match[4],
        description: match[5] || '',
      };
      services.push(service);
      summary.total += 1;
      if (service.active === 'active' && service.sub === 'running') summary.running += 1;
      if (service.active === 'failed' || service.sub === 'failed') summary.failed += 1;
      if (service.active === 'inactive') summary.inactive += 1;
      if (service.sub === 'exited') summary.exited += 1;
    }

    servicesSnapshot = { at: Date.now(), services, summary };
    broadcast('services', servicesSnapshot);
  } catch (err) {
    console.error('[services]', err);
  } finally {
    servicesBusy = false;
  }
}

async function collectNetwork() {
  if (networkBusy) return;
  networkBusy = true;

  try {
    const now = Date.now();
    const dt = networkLastAt ? Math.max((now - networkLastAt) / 1000, 0.5) : 2;
    networkLastAt = now;

    const [out, dockerOut] = await Promise.all([
      runCommand('ss', ['-tunapi'], 5000),
      runCommand('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.NetIO}}'], 5000),
    ]);
    const parsed = parseSsAll(out);
    const connections = [];
    const listenSeen = new Set();
    const summary = {
      total: 0,
      inbound: 0,
      outbound: 0,
      listening: 0,
      tcp: 0,
      udp: 0,
      containers: 0,
      recvBps: 0,
      sendBps: 0,
    };

    for (const conn of parsed) {
      if (conn.proto === 'tcp' && conn.state !== 'ESTAB' && conn.state !== 'LISTEN') continue;
      if (conn.proto === 'udp' && conn.state !== 'ESTAB') continue;
      if (!conn.local.host || isLoopbackHost(conn.local.host)) continue;
      if (conn.peer.host && isLoopbackHost(conn.peer.host)) continue;

      const process = parseSsProcess(conn.process);
      const localService = NET_PORT_APPS[conn.local.port] || '';
      const remoteService = NET_PORT_APPS[conn.peer.port] || '';
      const inbound = conn.state === 'LISTEN' || NET_SERVER_PORTS.has(conn.local.port);
      const direction = conn.state === 'LISTEN' ? '监听' : inbound ? '入站' : '出站';

      let app = localService;
      if (!app && process.name && process.name !== 'MainThread') {
        app = `${process.name}${process.pid ? ` (${process.pid})` : ''}`;
      }
      if (!app && remoteService) app = `${remoteService} 客户端`;
      if (!app && process.name) app = process.name;
      if (!app) app = `端口 ${conn.local.port}`;

      if (conn.state === 'LISTEN') {
        const listenKey = `${conn.proto}|${conn.local.port}|${app}`;
        if (listenSeen.has(listenKey)) continue;
        listenSeen.add(listenKey);
      }

      const key = `${conn.proto}|${conn.local.host}:${conn.local.port}|${conn.peer.host}:${conn.peer.port}`;
      const history = networkRateHistory.get(key) || [];
      history.push({ at: now, rx: conn.received, tx: conn.sent });
      while (history.length > 2 && now - history[0].at > NET_RATE_WINDOW_MS + 2000) history.shift();
      const base = history.find((sample) => now - sample.at >= NET_RATE_WINDOW_MS) || history[0];
      const span = Math.max((now - base.at) / 1000, 0.5);
      const recvBps = Math.max(0, (conn.received - base.rx) / span);
      const sendBps = Math.max(0, (conn.sent - base.tx) / span);
      networkRateHistory.set(key, history);

      const row = {
        id: key,
        proto: conn.proto.toUpperCase(),
        state: conn.state,
        direction,
        app,
        pid: process.pid,
        local: formatSsEndpoint(conn.local.host, conn.local.port),
        remote: formatSsEndpoint(conn.peer.host, conn.peer.port),
        localHost: conn.local.host,
        localPort: conn.local.port,
        remoteHost: conn.peer.host,
        remotePort: conn.peer.port,
        recvBps: Math.round(recvBps),
        sendBps: Math.round(sendBps),
        recvBytes: conn.received,
        sendBytes: conn.sent,
      };
      connections.push(row);
      summary.total += 1;
      if (direction === '入站') summary.inbound += 1;
      if (direction === '出站') summary.outbound += 1;
      if (direction === '监听') summary.listening += 1;
      if (row.proto === 'TCP') summary.tcp += 1;
      if (row.proto === 'UDP') summary.udp += 1;
      summary.recvBps += recvBps;
      summary.sendBps += sendBps;
    }

    const seenContainers = new Set();
    for (const line of dockerOut.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const name = line.slice(0, tab).trim();
      const io = line.slice(tab + 1).trim();
      if (!name || !io) continue;
      const [rxText, txText] = io.split('/');
      if (!rxText || !txText) continue;
      const rx = parseDockerSize(rxText);
      const tx = parseDockerSize(txText);
      seenContainers.add(name);
      const history = containerNetHistory.get(name) || [];
      history.push({ at: now, rx, tx });
      while (history.length > 2 && now - history[0].at > NET_RATE_WINDOW_MS + 2000) history.shift();
      const base = history.find((sample) => now - sample.at >= NET_RATE_WINDOW_MS) || history[0];
      const span = Math.max((now - base.at) / 1000, 0.5);
      const recvBps = Math.max(0, (rx - base.rx) / span);
      const sendBps = Math.max(0, (tx - base.tx) / span);
      containerNetHistory.set(name, history);

      const serviceThreshold = /photoprism/i.test(name) ? 8 * 1024 : 64 * 1024;
      if (/openlist|filebrowser|kodbox|alist|jellyfin|photoprism/i.test(name) && recvBps + sendBps >= serviceThreshold) {
        const previous = containerFileTransfers.get(name);
        containerFileTransfers.set(name, {
          name,
          app: containerDisplayName(name),
          lastActive: now,
          sendBps: Math.round(sendBps),
          recvBps: Math.round(recvBps),
          lastSend: Math.round(sendBps),
          lastRecv: Math.round(recvBps),
          disk: previous ? previous.disk : null,
          lastDisk: previous ? previous.lastDisk : null,
        });
      }

      if (recvBps + sendBps < 1024) continue;

      const app = containerDisplayName(name);
      connections.push({
        id: `docker:${name}`,
        proto: '容器',
        state: '运行中',
        direction: '容器',
        app,
        pid: 0,
        local: 'Docker 网络',
        remote: '—',
        localHost: '',
        localPort: 0,
        remoteHost: '',
        remotePort: 0,
        recvBps: Math.round(recvBps),
        sendBps: Math.round(sendBps),
        recvBytes: rx,
        sendBytes: tx,
        container: name,
      });
      summary.total += 1;
      summary.containers += 1;
      summary.recvBps += recvBps;
      summary.sendBps += sendBps;
    }
    for (const [name, history] of containerNetHistory) {
      const last = history[history.length - 1];
      if (!seenContainers.has(name) || !last || now - last.at > 30000) {
        containerNetHistory.delete(name);
      }
    }
    for (const [name, item] of containerFileTransfers) {
      if (now - item.lastActive > 30000) containerFileTransfers.delete(name);
    }

    for (const [key, history] of networkRateHistory) {
      const last = history[history.length - 1];
      if (!last || now - last.at > 30000) networkRateHistory.delete(key);
    }

    connections.sort((a, b) => b.recvBps + b.sendBps - (a.recvBps + a.sendBps) || a.app.localeCompare(b.app));
    summary.recvBps = Math.round(summary.recvBps);
    summary.sendBps = Math.round(summary.sendBps);

    networkSnapshot = {
      at: now,
      connections: connections.slice(0, 250),
      summary,
    };
    broadcast('network', networkSnapshot);
  } catch (err) {
    console.error('[network]', err);
  } finally {
    networkBusy = false;
  }
}

/* ------------------------------------------------------------------ */
/* 采样                                                                */
/* ------------------------------------------------------------------ */

const history = [];
const clients = new Set();

let prevCpu = null;
let prevDisk = null;
let prevDiskAt = 0;

function buildSample() {
  const now = Date.now();

  /* CPU */
  const cpuStat = readCpuStat();
  let usage = 0;
  let perCore = cpuStat.cores.map(() => 0);
  if (prevCpu) {
    usage = cpuUsage(prevCpu.overall, cpuStat.overall);
    perCore = cpuStat.cores.map((core, i) =>
      prevCpu.cores[i] ? cpuUsage(prevCpu.cores[i], core) : 0
    );
  }
  prevCpu = cpuStat;

  const counts = scanProcessCounts(now);

  /* 内存 */
  const mem = readMem();

  /* 磁盘 */
  const diskStats = readDiskStats();
  const elapsed = prevDisk ? Math.max((now - prevDiskAt) / 1000, 0.001) : 0;

  const diskDevices = devices.map((dev) => {
    const cur = diskStats.get(dev.name);
    const old = prevDisk ? prevDisk.get(dev.name) : null;
    const out = { name: dev.name, readBps: 0, writeBps: 0, busy: 0, iops: 0, latencyMs: 0 };

    if (cur && old && elapsed > 0) {
      out.readBps = Math.max(0, ((cur.readSectors - old.readSectors) * 512) / elapsed);
      out.writeBps = Math.max(0, ((cur.writeSectors - old.writeSectors) * 512) / elapsed);
      out.busy = clamp(((cur.ioMs - old.ioMs) / (elapsed * 1000)) * 100, 0, 100);
      const ops = cur.reads + cur.writes - old.reads - old.writes;
      out.iops = Math.max(0, ops / elapsed);
      if (ops > 0) {
        out.latencyMs = Math.max(
          0,
          ((cur.readMs + cur.writeMs) - (old.readMs + old.writeMs)) / ops
        );
      }
    }

    out.readBps = Math.round(out.readBps);
    out.writeBps = Math.round(out.writeBps);
    out.busy = round(out.busy, 1);
    out.iops = round(out.iops, 1);
    out.latencyMs = round(out.latencyMs, 2);
    return out;
  });

  const total = { readBps: 0, writeBps: 0, busy: 0, iops: 0, latencyMs: 0 };
  let weightedLatency = 0;
  let totalIops = 0;
  for (const d of diskDevices) {
    total.readBps += d.readBps;
    total.writeBps += d.writeBps;
    total.iops += d.iops;
    total.busy = Math.max(total.busy, d.busy);
    weightedLatency += d.latencyMs * d.iops;
    totalIops += d.iops;
  }
  total.iops = round(total.iops, 1);
  total.latencyMs = totalIops > 0 ? round(weightedLatency / totalIops, 2) : 0;

  prevDisk = diskStats;
  prevDiskAt = now;
  lastDiskDevices = diskDevices;

  return {
    t: now,
    up: Math.round(os.uptime()),
    cpu: {
      usage: round(usage, 1),
      perCore: perCore.map((v) => round(v, 1)),
      speedMHz: readCpuSpeedMHz(),
      procs: counts.procs,
      threads: counts.threads,
    },
    mem,
    disk: { total, devices: diskDevices },
    transfers: lastTransfers,
  };
}

function pushSample(sample) {
  history.push(sample);
  if (history.length > WINDOW) history.shift();
  broadcast('sample', sample);
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

function sendEvent(res, event, payload) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* client went away */
  }
}

function broadcast(event, payload) {
  for (const res of clients) sendEvent(res, event, payload);
}

function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  res.write(': connected\n\n');

  clients.add(res);
  sendEvent(res, 'history', {
    info: getInfo(),
    samples: history,
    health: healthState,
    transfers: lastTransfers,
    processes: processSnapshot,
    remote: remoteSnapshot,
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(pathname, res) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    /* keep raw */
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const resolved = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 记录访问本页面的客户端 IP -> User-Agent，用于识别远程设备类型
  const clientIp = normalizeRemoteIp(req.socket.remoteAddress);
  const userAgent = req.headers['user-agent'];
  if (clientIp && !isLoopbackIp(clientIp) && userAgent) {
    uaCache.set(clientIp, { ua: String(userAgent).slice(0, 400), at: Date.now() });
  }

  if (url.pathname === '/api/info') {
    sendJson(res, getInfo());
    return;
  }
  if (url.pathname === '/api/history') {
    sendJson(res, {
      info: getInfo(),
      samples: history,
      health: healthState,
      transfers: lastTransfers,
      processes: processSnapshot,
      remote: remoteSnapshot,
    });
    return;
  }
  if (url.pathname === '/api/remote') {
    sendJson(res, remoteSnapshot);
    return;
  }
  if (url.pathname === '/api/users') {
    sendJson(res, usersSnapshot);
    return;
  }
  if (url.pathname === '/api/services') {
    sendJson(res, servicesSnapshot);
    return;
  }
  if (url.pathname === '/api/network') {
    sendJson(res, networkSnapshot);
    return;
  }
  if (url.pathname === '/api/process-tree') {
    sendJson(res, collectProcessTree(Date.now()));
    return;
  }

  if (url.pathname === '/api/processes') {
    sendJson(res, processSnapshot);
    return;
  }
  if (url.pathname === '/api/health') {
    if ((!healthState.at || healthState.date !== healthDay()) && !healthState.refreshing) {
      refreshHealth(false);
    }
    sendJson(res, healthState);
    return;
  }
  if (url.pathname === '/api/health/refresh') {
    refreshHealth(true);
    sendJson(res, { ok: true, refreshing: true });
    return;
  }
  if (url.pathname === '/api/transfers') {
    sendJson(res, { transfers: lastTransfers });
    return;
  }
  if (url.pathname === '/api/stream') {
    handleStream(req, res);
    return;
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  serveStatic(url.pathname, res);
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

refreshStatic(true);
processSnapshot = collectProcesses(Date.now());

let lastInfoBroadcast = deviceSignature;

setInterval(() => {
  const changed = refreshStatic();
  if (changed && deviceSignature !== lastInfoBroadcast) {
    lastInfoBroadcast = deviceSignature;
    broadcast('info', getInfo());
    refreshHealth(true);
  }
}, SAMPLE_MS);

setInterval(() => {
  try {
    pushSample(buildSample());
  } catch (err) {
    console.error('[sample]', err);
  }
}, SAMPLE_MS);

let lastTransferSignature = '';

setInterval(() => {
  try {
    const now = Date.now();
    const dt = lastDetectionAt ? (now - lastDetectionAt) / 1000 : 0.5;
    lastDetectionAt = now;
    const list = detectTransfers(now, lastDiskDevices, dt);
    const signature = list
      .map((t) => `${t.id}:${Math.round(t.bps / 65536)}:${t.file}:${t.active}`)
      .join('|');
    if (signature !== lastTransferSignature) {
      lastTransferSignature = signature;
      broadcast('transfers', list);
    }
  } catch (err) {
    console.error('[transfers]', err);
  }
}, 500);

loadHealthState();
setTimeout(() => refreshHealth(false), 2500);

setInterval(() => {
  try {
    processSnapshot = collectProcesses(Date.now());
    broadcast('processes', processSnapshot);
  } catch (err) {
    console.error('[processes]', err);
  }
}, 2000);

setTimeout(() => collectRemote(), 2000);
setInterval(() => collectRemote(), 500);

setTimeout(() => collectAria2(), 2500);
setInterval(() => collectAria2(), 1000);

setTimeout(() => collectUsers(), 1500);
setInterval(() => collectUsers(), 5000);

setTimeout(() => collectServices(), 1800);
setInterval(() => collectServices(), 10000);

setTimeout(() => collectNetwork(), 1200);
setInterval(() => collectNetwork(), 2000);

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '0.0.0.0' : HOST;
  console.log(`任务管理器（Web）已启动: http://${shown}:${PORT}`);
  console.log(`采样间隔 ${SAMPLE_MS} ms，保留最近 ${WINDOW} 秒历史`);
});

function shutdown() {
  console.log('\n正在关闭…');
  for (const res of clients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
