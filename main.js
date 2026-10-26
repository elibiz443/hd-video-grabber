'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
let win = null;

/* ---------- bundled binaries ---------- */
const BIN_DIR = path.join(app.getPath('userData'), 'bin');
const YTDLP_PATH = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
const FFMPEG_PATH = (() => {
  try {
    const p = require('ffmpeg-static');
    // Inside a packaged app the binary lives in app.asar.unpacked
    return p ? p.replace('app.asar', 'app.asar.unpacked') : null;
  } catch { return null; }
})();

/* ---------- settings ---------- */
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  downloadDir: path.join(app.getPath('downloads'), 'HD Video Grabber'),
  maxConcurrent: 2,
  embedSubs: false,
  embedThumbnail: false,
  embedMetadata: true,
  subLangs: 'en.*',
  cookiesBrowser: 'none',
};
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { /* first run */ }
}
function persistSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- yt-dlp engine: auto-download + update ---------- */
let engineReady = false;
let enginePromise = null;

function httpDownload(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'hd-video-grabber' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpDownload(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' while downloading ' + url));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (c) => { received += c.length; onProgress && onProgress(received, total); });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function ensureEngine() {
  if (engineReady) return Promise.resolve(YTDLP_PATH);
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    if (fs.existsSync(YTDLP_PATH)) { engineReady = true; return YTDLP_PATH; }
    fs.mkdirSync(BIN_DIR, { recursive: true });
    send('engine-status', { status: 'downloading', message: 'Downloading the yt-dlp engine…' });
    // Standalone binaries — no Python required
    const sources = IS_WIN
      ? ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe']
      : ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
         'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'];
    let lastErr = null;
    for (const url of sources) {
      try {
        await httpDownload(url, YTDLP_PATH, (got, total) =>
          send('engine-status', { status: 'downloading', got, total, message: 'Downloading the yt-dlp engine…' }));
        if (!IS_WIN) fs.chmodSync(YTDLP_PATH, 0o755);
        engineReady = true;
        send('engine-status', { status: 'ready' });
        return YTDLP_PATH;
      } catch (e) { lastErr = e; }
    }
    enginePromise = null;
    send('engine-status', { status: 'error', message: 'Could not download yt-dlp — check your internet connection.' });
    throw lastErr || new Error('engine download failed');
  })();
  return enginePromise;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    ensureEngine().then((bin) => {
      const child = spawn(bin, args, { windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) return resolve(stdout);
        const errLine = (stderr + stdout).split(/\r?\n/).find((l) => l.startsWith('ERROR'))
          || ('yt-dlp exited with code ' + code);
        reject(new Error(errLine));
      });
    }).catch(reject);
  });
}

/* ---------- IPC: info fetching ---------- */
ipcMain.handle('fetch-info', async (evt, rawUrl) => {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Please enter a valid http(s) URL.');

  // Pure playlist URLs → quick flat listing
  if (/list=|playlist/i.test(url) && !/[?&]v=/.test(url)) {
    const out = await runYtDlp(['-J', '--flat-playlist', '--playlist-items', '1-500', '--no-warnings', url]);
    const data = JSON.parse(out);
    if (data._type === 'playlist' && Array.isArray(data.entries)) {
      return { type: 'playlist', title: data.title || 'Playlist', count: data.entries.length };
    }
  }
  const out = await runYtDlp(['-J', '--no-playlist', '--no-warnings', url]);
  const info = JSON.parse(out);
  if (info._type === 'playlist' && Array.isArray(info.entries)) {
    return { type: 'playlist', title: info.title || 'Playlist', count: info.entries.length };
  }
  return { type: 'video', video: info };
});

/* ---------- download queue ---------- */
const queue = [];
const active = new Map();

function emit(job, payload) {
  send('download-event', { id: job.id, title: job.title, ...payload });
}

function buildArgs(job) {
  const args = [
    '--no-warnings', '--no-color', '--newline', '--no-mtime',
    '--retries', '10', '--fragment-retries', '10',
    '--concurrent-fragments', '4',
    '--print', 'after_move:filepath',
  ];
  if (FFMPEG_PATH) args.push('--ffmpeg-location', FFMPEG_PATH);
  if (settings.cookiesBrowser && settings.cookiesBrowser !== 'none') {
    args.push('--cookies-from-browser', settings.cookiesBrowser);
  }

  const template = job.playlist
    ? path.join(settings.downloadDir, '%(playlist_title).80B', '%(playlist_index)03d - %(title).150B [%(id)s].%(ext)s')
    : path.join(settings.downloadDir, '%(title).150B [%(id)s].%(ext)s');
  args.push('-o', template);
  args.push(job.playlist ? '--yes-playlist' : '--no-playlist');

  if (job.exactFormat) {
    args.push('-f', job.exactIsAudio ? job.exactFormat : (job.exactFormat + '+bestaudio/' + job.exactFormat));
    if (job.container) args.push('--merge-output-format', job.container);
  } else if (job.kind === 'audio') {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', job.audioFormat, '--audio-quality', '0');
  } else {
    const h = job.height > 0 ? ('[height<=' + job.height + ']') : '';
    const vc = job.vcodec && job.vcodec !== 'any' ? ('[vcodec^=' + job.vcodec + ']') : '';
    args.push('-f', 'bestvideo' + h + vc + '+bestaudio/bestvideo' + h + '+bestaudio/best' + h + '/best');
    if (job.container) args.push('--merge-output-format', job.container);
  }

  if (job.kind !== 'audio') {
    if (settings.embedSubs) args.push('--write-subs', '--sub-langs', settings.subLangs || 'en.*', '--embed-subs');
    if (settings.embedThumbnail) args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  }
  if (settings.embedMetadata) args.push('--embed-metadata');
  args.push(job.url);
  return args;
}

function handleLine(job, line) {
  let m;
  if (line.startsWith('ERROR')) { job.errors.push(line); return; }
  if ((m = line.match(/\[download\] Downloading item (\d+) of (\d+)/))) {
    return emit(job, { type: 'item', index: +m[1], total: +m[2] });
  }
  if ((m = line.match(/\[download\]\s+([\d.]+)% of\s+(.+)$/))) {
    const rest = m[2];
    const size = (rest.match(/~?\s*[\d.]+\s*\w+/) || [''])[0].replace('~', '').trim();
    const speed = (rest.match(/at\s+([\d.]+\s*\w+\/s|Unknown B\/s)/) || [])[1];
    const eta = (rest.match(/ETA\s+([\d:]+)/) || [])[1];
    return emit(job, { type: 'progress', pct: parseFloat(m[1]), size, speed, eta });
  }
  if ((m = line.match(/\[Merger\] Merging formats into\s+"?([^"]+?)"?\s*$/))) {
    job.lastFile = m[1].trim();
    return emit(job, { type: 'merging' });
  }
  if ((m = line.match(/\[(ExtractAudio|VideoConvertor|VideoRemuxer)\] Destination:\s+(.+)$/))) {
    job.lastFile = m[2].trim();
    return emit(job, { type: 'processing', stage: m[1] });
  }
  if (/has already been downloaded/.test(line)) {
    return emit(job, { type: 'progress', pct: 100, size: '', speed: '', eta: '' });
  }
  // Plain (bracket-less) line = final filepath printed by --print after_move:filepath
  if (!line.startsWith('[')) {
    job.lastFile = line.trim();
    return emit(job, { type: 'file', file: job.lastFile });
  }
}

function startJob(job) {
  active.set(job.id, job);
  job.errors = [];
  ensureEngine().then((bin) => {
    emit(job, { type: 'starting' });
    const child = spawn(bin, buildArgs(job), { windowsHide: true });
    job.child = child;
    const onLine = (l) => l.trim() && handleLine(job, l.trim());
    child.stdout.on('data', (buf) => buf.toString().split(/\r?\n/).forEach(onLine));
    child.stderr.on('data', (buf) => buf.toString().split(/\r?\n/).forEach(onLine));
    child.on('close', (code) => {
      active.delete(job.id);
      if (job.cancelled) emit(job, { type: 'cancelled' });
      else if (code === 0) emit(job, { type: 'complete', file: job.lastFile || null });
      else emit(job, { type: 'error', message: job.errors[0] || ('Download failed (exit code ' + code + ').') });
      pumpQueue();
    });
  }).catch((err) => {
    active.delete(job.id);
    emit(job, { type: 'error', message: err.message });
    pumpQueue();
  });
}

function pumpQueue() {
  const max = Math.max(1, Math.min(4, settings.maxConcurrent || 2));
  while (active.size < max && queue.length) startJob(queue.shift());
}

ipcMain.handle('start-download', async (evt, opts) => {
  if (!opts || !/^https?:\/\//i.test(String(opts.url))) throw new Error('Invalid URL');
  const job = {
    id: crypto.randomUUID(),
    url: String(opts.url).trim(),
    title: opts.title || 'Untitled',
    kind: opts.kind || 'video',
    height: parseInt(opts.height, 10) || 0,
    vcodec: opts.vcodec || 'any',
    container: opts.container || '',
    audioFormat: opts.audioFormat || 'mp3',
    exactFormat: opts.exactFormat || '',
    exactIsAudio: !!opts.exactIsAudio,
    playlist: !!opts.playlist,
  };
  fs.mkdirSync(settings.downloadDir, { recursive: true });
  queue.push(job);
  pumpQueue();
  return job.id;
});

ipcMain.on('cancel-download', (evt, id) => {
  const job = active.get(id);
  if (job && job.child) {
    job.cancelled = true;
    if (IS_WIN && job.child.pid) spawn('taskkill', ['/pid', String(job.child.pid), '/T', '/F']);
    else job.child.kill('SIGTERM');
  } else {
    const i = queue.findIndex((j) => j.id === id);
    if (i >= 0) {
      queue.splice(i, 1);
      send('download-event', { id, type: 'cancelled' });
    }
  }
});

/* ---------- IPC: settings & misc ---------- */
ipcMain.handle('get-settings', () => ({ ...settings, ffmpegAvailable: !!FFMPEG_PATH }));

ipcMain.handle('set-settings', (evt, next) => {
  settings = { ...settings, ...next };
  persistSettings();
  pumpQueue();
  return { ...settings };
});

ipcMain.handle('select-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.on('show-in-folder', (evt, p) => p && shell.showItemInFolder(p));
ipcMain.on('open-path', (evt, p) => p && shell.openPath(p));

ipcMain.handle('update-engine', async () => {
  const bin = await ensureEngine();
  const out = await new Promise((resolve, reject) => {
    const child = spawn(bin, ['-U'], { windowsHide: true });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(text.trim()) : reject(new Error(text.trim() || 'update failed'))));
  });
  const m = out.match(/yt-dlp is up to date|Updated yt-dlp to \S+/i);
  return m ? m[0] : out.split('\n').slice(-2).join(' ');
});

/* ---------- app lifecycle ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1160, height: 820, minWidth: 900, minHeight: 640,
    backgroundColor: '#0e1016',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  ensureEngine().catch(() => {}); // pre-warm engine download
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', () => {
  for (const job of active.values()) {
    if (job.child) {
      if (IS_WIN && job.child.pid) spawn('taskkill', ['/pid', String(job.child.pid), '/T', '/F']);
      else job.child.kill('SIGKILL');
    }
  }
});
