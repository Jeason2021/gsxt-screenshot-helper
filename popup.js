'use strict';

const SEARCH_URL = 'https://shiming.gsxt.gov.cn/corp-query-search-1.html';
const $ = id => document.getElementById(id);
const message = (s, error=false) => {
  $('message').textContent = s;
  $('message').className = `message ${error ? 'error' : 'success'}`;
};
const readState = async () => chrome.storage.local.get({
  queue:[], activeName:'', records:{}, skips:{}, target:500, autoSubmit:false, paused:false,
  downloadSubdir:'企业信息截图', saveAs:false,
  scannedNames:[], scannedHashes:[], scannedFolder:'', scannedAt:''
});
const norm = s => String(s || '').replace(/\s+/g,'').trim();

async function refresh() {
  const s = await readState();
  const done = Object.values(s.records).filter(x => x.status === 'done').length;
  const failed = Object.values(s.records).filter(x => x.status === 'failed').length;
  const skipped = Object.keys(s.skips).length;
  const total = new Set([...s.queue.map(norm), ...Object.keys(s.records).map(norm)]).size;
  $('done').textContent = done;
  $('target').textContent = s.target;
  $('percentage').textContent = `${Math.min(100, Math.round(100 * done / Math.max(1,s.target)))}%`;
  $('progress').style.width = `${Math.min(100, 100 * done / Math.max(1,s.target))}%`;
  $('queue-info').textContent = `候选队列 ${s.queue.length} 家 · 跳过 ${skipped} 家 · 下载失败 ${failed} 家`;
  $('task-info').textContent = `任务总数 ${total} · 未完成 ${Math.max(0,total-done)} · 失败 ${failed}`;
  $('pause').textContent = s.paused ? '继续任务' : '暂停任务';
  $('next').disabled = s.paused;
  $('done-list').textContent = Object.values(s.records).filter(x => x.status === 'done')
    .map(x => x.name).join('\n') || '暂无';
  $('failed-list').textContent = Object.values(s.records).filter(x => x.status === 'failed')
    .map(x => `${x.name}：${x.error || '下载失败'}`).join('\n') || '暂无';
  $('active').textContent = `当前任务：${s.activeName || '自由采集模式'}`;
  $('auto-submit').checked = s.autoSubmit;
  if (document.activeElement !== $('download-subdir')) $('download-subdir').value = s.downloadSubdir;
  $('save-as').checked = s.saveAs;
  $('scan-info').textContent = s.scannedAt
    ? `已扫描：${s.scannedFolder} · ${s.scannedNames.length} 个 JPG · ${new Date(s.scannedAt).toLocaleString('zh-CN')}。新增文件后请重新扫描。`
    : '尚未扫描文件夹。扫描只读取文件名和 JPG 哈希，不上传图片；新增文件后需重新扫描。';
}

function parseNames(content) {
  // CSV first column or plain TXT, with basic support for CSV quoted columns.
  const rows = content.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => {
    const s = line.trim();
    if (!s) return '';
    if (s.startsWith('"')) {
      const m = s.match(/^"((?:[^"]|"")*)"/);
      return m ? m[1].replace(/""/g, '"') : s;
    }
    return s.split(',')[0].split('，')[0].trim();
  });
  return [...new Set(rows.map(x => x.trim()).filter(x =>
    x.length >= 4 && !/^(企业名称|公司名称|名称|name|company)$/i.test(x)
  ))];
}

$('scan').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab?.id || !/^https:\/\/([a-z0-9-]+\.)?gsxt\.gov\.cn\//i.test(tab.url || '')) {
      return message('请先切换到公示系统的企业搜索结果页。', true);
    }
    const res = await chrome.tabs.sendMessage(tab.id, {type:'SCAN_RESULTS'});
    if (!res?.ok) return message(res?.error || '无法识别当前页面。', true);
    if (!res.names?.length) return message('当前页没有识别出可信的企业结果卡片。可更换关键词，或直接在文本框粘贴公司名称。', true);
    const existed = new Set(parseNames($('names').value).map(norm));
    const fresh = res.names.filter(n => !existed.has(norm(n)) && existed.add(norm(n)));
    $('names').value = [ $('names').value.trim(), ...fresh ].filter(Boolean).join('\n');
    message(`识别出 ${res.names.length} 家企业，其中新增 ${fresh.length} 家。请核对文本框，再点「合并导入」。`);
  } catch(e) { message(`读取结果页失败：${e?.message || e}。请刷新该网页再试。`, true); }
});
$('clear-names').addEventListener('click', () => { $('names').value=''; message('已清空待导入的候选文本，不影响已保存任务。'); });

$('import').addEventListener('click', async () => {
  try {
    const names = parseNames($('names').value);
    if (!names.length) return message('没有识别到有效企业名称。请从结果页提取，或者每行输入一个完整名称。', true);
    const state = await readState();
    const existing = new Set(state.queue.map(norm));
    const newly = names.filter(x => !existing.has(norm(x)) && existing.add(norm(x)));
    const queue = [...state.queue, ...newly];
    await chrome.storage.local.set({queue});
    $('names').value = '';
    await refresh();
    message(`已导入 ${newly.length} 家新企业，名单合计 ${queue.length} 家。`);
  } catch (e) { message(e.message, true); }
});

$('file').addEventListener('change', async ev => {
  const f = ev.target.files?.[0];
  if (!f) return;
  $('names').value = await f.text();
  message(`已读取文件：${f.name}。点击「合并导入」确认。`);
});

$('next').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({type:'NEXT_FROM_POPUP'});
  if (!res?.ok) message(res?.error || '未能打开下一家', true);
  else { message(`正在准备检索：${res.name}`); await refresh(); }
});
$('pause').addEventListener('click', async () => {
  const state = await readState();
  await chrome.storage.local.set({paused: !state.paused});
  await refresh();
  message(state.paused ? '已继续任务。' : '已暂停打开下一家；当前下载仍会正常完成。');
});
$('open').addEventListener('click', async () => {
  await chrome.tabs.create({url:SEARCH_URL});
  window.close();
});
$('clear-active').addEventListener('click', async () => {
  await chrome.storage.local.set({activeName:''});
  await refresh();
  message('已进入自由采集模式，可手动查询任意企业并截图。');
});
$('auto-submit').addEventListener('change', async ev => {
  await chrome.storage.local.set({autoSubmit:ev.target.checked});
  message(ev.target.checked ? '已开启单次自动提交（不重复重试）。' : '已关闭自动提交。');
});
$('save-path').addEventListener('click', async () => {
  const raw = $('download-subdir').value.trim().replace(/\\/g, '/');
  const parts = raw ? raw.split('/') : [];
  if (parts.length > 4 || parts.some(part => !part || part === '.' || part === '..' ||
      /[<>:"|?*\x00-\x1F]/.test(part) || /[. ]$/.test(part))) {
    return message('子文件夹只能填写相对路径，不能含盘符、空层级或 ..。', true);
  }
  await chrome.storage.local.set({downloadSubdir:parts.join('/'), saveAs:$('save-as').checked});
  message($('save-as').checked ? '已保存：每张图片弹出“另存为”。' : `已保存：Edge 默认下载目录/${parts.join('/') || '(根目录)'}`);
});
$('scan-folder').addEventListener('change', async event => {
  const files = [...(event.target.files || [])].filter(file => /\.jpe?g$/i.test(file.name));
  if (!files.length) return message('所选文件夹中没有 JPG 图片。', true);
  if (files.length > 5000) return message('文件夹中 JPG 超过 5000 张，请选择更小的文件夹。', true);
  const names = new Set();
  const hashes = new Set();
  let duplicateNames = 0, duplicateImages = 0, skipped = 0;
  try {
    for (const file of files) {
      if (file.size > 50 * 1024 * 1024) { skipped++; continue; }
      const name = file.name.replace(/\.jpe?g$/i, '');
      if (names.has(norm(name))) duplicateNames++;
      names.add(norm(name));
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (hashes.has(hash)) duplicateImages++;
      hashes.add(hash);
    }
    const folder = files[0].webkitRelativePath?.split('/')[0] || '所选文件夹';
    await chrome.storage.local.set({
      scannedNames:[...names], scannedHashes:[...hashes], scannedFolder:folder,
      scannedAt:new Date().toISOString()
    });
    await refresh();
    message(`扫描 ${files.length} 张 JPG：文件名重复 ${duplicateNames}、图片内容完全相同 ${duplicateImages}、超大文件跳过 ${skipped}。后续保存会检查这些记录。`);
  } catch (error) {
    message(`扫描失败：${error.message || error}`, true);
  }
});

function quoteCSV(x) {
  const value = String(x ?? '');
  const safe = /^[\s\t\r\n]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
$('export').addEventListener('click', async () => {
  const state = await readState();
  const head = ['企业名称','统一社会信用代码','截图文件名','截图状态','采集时间','企业详情页URL','失败原因'];
  const rows = Object.values(state.records).sort((a,b) => String(a.name).localeCompare(String(b.name), 'zh'))
    .map(r => [r.name, r.creditCode, r.file, r.status, r.completedAt || r.queuedAt, r.url, r.error]);
  for (const name of Object.keys(state.skips)) {
    if (!state.records[name]) rows.push([name,'','','skipped',state.skips[name].time,'',state.skips[name].reason]);
  }
  if (!rows.length) return message('暂时没有可导出的记录。', true);
  const csv = '\uFEFF' + [head,...rows].map(row => row.map(quoteCSV).join(',')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = '企业截图采集记录.csv';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  message(`已导出 ${rows.length} 条采集记录。`);
});
$('retry').addEventListener('click', async () => {
  const state = await readState();
  const count = Object.keys(state.skips).length;
  await chrome.storage.local.set({skips:{},activeName:''});
  await refresh();
  message(`已恢复 ${count} 家跳过企业，下一次点击「打开下一家」可继续尝试。`);
});
$('reset').addEventListener('click', async () => {
  if (!confirm('确定清空名单、进度、已完成标记和失败记录吗？下载到电脑的 JPG 文件不会删除。')) return;
  await chrome.storage.local.set({queue:[], activeName:'', records:{}, skips:{}, pendingDownloads:{}, paused:false,
    scannedNames:[], scannedHashes:[], scannedFolder:'', scannedAt:''});
  await refresh();
  message('助手记录已清空，已下载的 JPG 保留在磁盘。');
});

chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') refresh(); });
refresh();
