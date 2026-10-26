'use strict';

const $ = (id) => document.getElementById(id);
let settings = null;
let currentUrl = '';
let currentInfo = null;
const rows = new Map(); // jobId -> { el, opts, file }

window.addEventListener('DOMContentLoaded', init);

async function init() {
  if (navigator.platform && navigator.platform.includes('Mac')) document.body.classList.add('mac');
  settings = await window.api.getSettings();

  $('dirLabel').textContent = settings.downloadDir;
  $('dirInput').value = settings.downloadDir;
  $('concurrencySel').value = String(settings.maxConcurrent);
  $('cookiesSel').value = settings.cookiesBrowser || 'none';
  $('subLangsInput').value = settings.subLangs || 'en.*';
  $('embedSubsChk').checked = !!settings.embedSubs;
  $('embedThumbChk').checked = !!settings.embedThumbnail;
  $('embedMetaChk').checked = !!settings.embedMetadata;

  window.api.onDownloadEvent(onDownloadEvent);
  window.api.onEngineStatus(onEngineStatus);

  $('fetchBtn').addEventListener('click', fetchInfo);
  $('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchInfo(); });
  $('pasteBtn').addEventListener('click', pasteAndFetch);
  $('downloadBtn').addEventListener('click', startQuickDownload);
  $('qualitySel').addEventListener('change', syncOptionVisibility);
  $('settingsBtn').addEventListener('click', () => $('settingsModal').classList.remove('hidden'));
  $('closeSettingsBtn').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
  $('browseBtn').addEventListener('click', async () => {
    const folder = await window.api.selectFolder();
    if (folder) $('dirInput').value = folder;
  });
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('updateEngineBtn').addEventListener('click', updateEngine);

  // Global paste: paste a URL anywhere to fetch it instantly
  document.addEventListener('paste', (e) => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    const text = (e.clipboardData || window.clipboardData).getData('text') || '';
    if (/^https?:\/\//i.test(text.trim())) {
      $('urlInput').value = text.trim();
      fetchInfo();
    }
  });
}

/* ---------- fetching ---------- */
async function fetchInfo() {
  const url = $('urlInput').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('Please paste a valid URL starting with http(s)://');
  currentUrl = url;
  currentInfo = null;
  $('fetchBtn').disabled = true;
  $('fetchBtn').textContent = 'Fetching…';
  hideInfo();
  try {
    const result = await window.api.fetchInfo(url);
    result.type === 'playlist' ? renderPlaylistCard(result) : renderVideoCard(result.video);
  } catch (err) {
    toast(cleanError(err.message));
  }
  $('fetchBtn').disabled = false;
  $('fetchBtn').textContent = 'Fetch';
}

function hideInfo() {
  $('infoCard').classList.add('hidden');
  $('formatsCard').classList.add('hidden');
}

function renderVideoCard(v) {
  currentInfo = v;
  $('infoCard').classList.remove('hidden');
  $('thumb').classList.remove('hidden');
  $('thumb').src = v.thumbnail || '';
  $('videoTitle').textContent = v.title || 'Untitled';

  const bits = [];
  if (v.uploader || v.channel) bits.push(v.uploader || v.channel);
  if (v.duration) bits.push(fmtDuration(v.duration));
  if (v.view_count != null) bits.push(v.view_count.toLocaleString() + ' views');
  if (v.extractor) bits.push(v.extractor.split(':')[0]);
  $('videoMeta').textContent = bits.join('  ·  ');

  $('playlistLabel').classList.toggle('hidden', !/[?&]list=/.test(currentUrl));
  $('playlistChk').checked = false;
  syncOptionVisibility();

  // Full format table
  const body = $('formatsBody');
  body.innerHTML = '';
  const formats = (v.formats || []).filter(
    (f) => (f.vcodec && f.vcodec !== 'none') || (f.acodec && f.acodec !== 'none')
  );
  const shown = formats
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))
    .slice(0, 40);

  for (const f of shown) {
    const isVideo = f.vcodec && f.vcodec !== 'none';
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><span class="badge ' + (isVideo ? 'badge-video' : 'badge-audio') + '">' + (isVideo ? 'video' : 'audio') + '</span></td>' +
      '<td>' + (f.ext || '') + '</td>' +
      '<td>' + (f.resolution || (f.abr ? f.abr + ' kbps' : '') || '—') + '</td>' +
      '<td>' + (f.fps || '—') + '</td>' +
      '<td>' + codecName(isVideo ? f.vcodec : f.acodec) + '</td>' +
      '<td>' + (f.filesize ? fmtBytes(f.filesize) : (f.filesize_approx ? '~' + fmtBytes(f.filesize_approx) : '—')) + '</td>' +
      '<td><button class="mini" title="Download this format">⬇</button></td>';
    tr.querySelector('button').addEventListener('click', () =>
      startDownload({
        url: currentUrl,
        title: v.title,
        kind: isVideo ? 'video' : 'audio',
        exactFormat: f.format_id,
        exactIsAudio: !isVideo,
        container: '',
      })
    );
    body.appendChild(tr);
  }
  $('formatsCard').classList.toggle('hidden', shown.length === 0);
}

function renderPlaylistCard(p) {
  $('infoCard').classList.remove('hidden');
  $('thumb').classList.add('hidden');
  $('videoTitle').textContent = p.title;
  $('videoMeta').textContent = (p.count === 1 ? '1 video' : p.count + ' videos') + ' · playlist';
  $('playlistLabel').classList.remove('hidden');
  $('playlistChk').checked = true;
  $('formatsCard').classList.add('hidden');
  syncOptionVisibility();
}

function syncOptionVisibility() {
  const audio = $('qualitySel').value === 'audio';
  $('codecSel').parentElement.classList.toggle('hidden', audio);
  $('containerSel').parentElement.classList.toggle('hidden', audio);
  $('audioFmtLabel').classList.toggle('hidden', !audio);
}

/* ---------- downloads ---------- */
async function startQuickDownload() {
  const url = currentUrl || $('urlInput').value.trim();
  if (!url) return;
  const q = $('qualitySel').value;
  const audio = q === 'audio';
  startDownload({
    url,
    title: currentInfo ? currentInfo.title : ($('videoTitle').textContent || url),
    kind: audio ? 'audio' : 'video',
    height: parseInt(q, 10) || 0,
    vcodec: $('codecSel').value,
    container: $('containerSel').value,
    audioFormat: $('audioFmtSel').value,
    playlist: $('playlistChk').checked,
  });
}

async function startDownload(opts) {
  try {
    const id = await window.api.startDownload(opts);
    addRow(id, opts);
    toast('Added to downloads ✓');
  } catch (err) {
    toast(cleanError(err.message));
  }
}

function addRow(id, opts) {
  const empty = document.querySelector('#downloadsEmpty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'dl-row';
  el.innerHTML =
    '<div class="dl-top">' +
      '<span class="dl-title">' + escapeHtml(opts.title || opts.url) + (opts.playlist ? ' <span class="badge badge-video">playlist</span>' : '') + '</span>' +
      '<span class="dl-actions"></span>' +
    '</div>' +
    '<div class="dl-bar"><div class="dl-fill"></div></div>' +
    '<div class="dl-status"><span class="dl-text">Queued…</span></div>';
  $('downloadsList').prepend(el);
  rows.set(id, { el, opts, file: null });
  setActions(el, id, 'cancel');
}

function mkBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.className = 'mini';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function setActions(el, id, mode, file, opts) {
  const actions = el.querySelector('.dl-actions');
  actions.innerHTML = '';
  if (mode === 'cancel') {
    actions.appendChild(mkBtn('✕', 'Cancel', () => window.api.cancelDownload(id)));
  } else if (mode === 'done' && file) {
    actions.appendChild(mkBtn('📂', 'Show in folder', () => window.api.showInFolder(file)));
    actions.appendChild(mkBtn('▶', 'Open file', () => window.api.openPath(file)));
  } else if (mode === 'retry') {
    actions.appendChild(mkBtn('↻', 'Retry', () => { el.remove(); rows.delete(id); startDownload(opts); }));
  }
}

function onDownloadEvent(ev) {
  const row = rows.get(ev.id);
  if (!row) return;
  const el = row.el;
  const text = el.querySelector('.dl-text');
  const fill = el.querySelector('.dl-fill');

  switch (ev.type) {
    case 'starting':
      text.textContent = 'Starting…';
      break;
    case 'item':
      text.textContent = 'Downloading item ' + ev.index + ' of ' + ev.total + '…';
      break;
    case 'progress': {
      const pct = Math.min(100, Math.max(0, ev.pct || 0));
      fill.style.width = pct.toFixed(1) + '%';
      const parts = [pct.toFixed(1) + '%'];
      if (ev.size) parts.push(ev.size);
      if (ev.speed && ev.speed !== 'Unknown B/s') parts.push(ev.speed);
      if (ev.eta) parts.push('ETA ' + ev.eta);
      text.textContent = parts.join('  ·  ');
      break;
    }
    case 'merging':
      el.classList.add('processing');
      fill.style.width = '100%';
      text.textContent = 'Merging video + audio streams…';
      break;
    case 'processing':
      el.classList.add('processing');
      fill.style.width = '100%';
      text.textContent = 'Post-processing…';
      break;
    case 'file':
      row.file = ev.file;
      break;
    case 'complete':
      el.classList.remove('processing');
      el.classList.add('done');
      fill.style.width = '100%';
      text.textContent = 'Completed ✓';
      setActions(el, ev.id, 'done', ev.file || row.file);
      break;
    case 'error':
      el.classList.add('failed');
      text.textContent = '✕ ' + cleanError(ev.message);
      setActions(el, ev.id, 'retry', null, row.opts);
      break;
    case 'cancelled':
      el.classList.add('failed');
      text.textContent = 'Cancelled';
      setActions(el, ev.id, 'retry', null, row.opts);
      break;
  }
}

function onEngineStatus(st) {
  const banner = $('engineBanner');
  if (st.status === 'ready') return banner.classList.add('hidden');
  banner.classList.remove('hidden');
  if (st.status === 'downloading') {
    const pct = st.total ? Math.round((st.got / st.total) * 100) : 0;
    banner.textContent = '⚙ ' + st.message + ' ' + (st.total ? pct + '%' : '');
  } else if (st.status === 'error') {
    banner.textContent = '⚠ ' + st.message;
  }
}

/* ---------- settings ---------- */
async function saveSettings() {
  settings = await window.api.setSettings({
    downloadDir: $('dirInput').value || settings.downloadDir,
    maxConcurrent: parseInt($('concurrencySel').value, 10) || 2,
    cookiesBrowser: $('cookiesSel').value,
    subLangs: $('subLangsInput').value.trim() || 'en.*',
    embedSubs: $('embedSubsChk').checked,
    embedThumbnail: $('embedThumbChk').checked,
    embedMetadata: $('embedMetaChk').checked,
  });
  $('dirLabel').textContent = settings.downloadDir;
  $('settingsModal').classList.add('hidden');
  toast('Settings saved ✓');
}

async function updateEngine() {
  const btn = $('updateEngineBtn'), msg = $('engineMsg');
  btn.disabled = true;
  msg.textContent = 'Checking for updates…';
  try { msg.textContent = await window.api.updateEngine(); }
  catch (err) { msg.textContent = cleanError(err.message); }
  btn.disabled = false;
}

async function pasteAndFetch() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { $('urlInput').value = text.trim(); fetchInfo(); }
  } catch { toast('Clipboard access denied'); }
}

/* ---------- helpers ---------- */
function cleanError(msg) {
  return String(msg || 'Unknown error')
    .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '')
    .replace(/^ERROR:\s*/i, '')
    .slice(0, 300);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
  if (!n || n < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function codecName(c) {
  if (!c) return '—';
  const p = String(c).toLowerCase();
  if (p.startsWith('avc1') || p.startsWith('h264')) return 'H.264';
  if (p.startsWith('vp09') || p.startsWith('vp9')) return 'VP9';
  if (p.startsWith('av01')) return 'AV1';
  if (p.startsWith('mp4a')) return 'AAC';
  if (p.startsWith('opus')) return 'Opus';
  return c.split('.')[0];
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}
