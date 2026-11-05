'use strict';

const SEARCH_URL = 'https://shiming.gsxt.gov.cn/corp-query-search-1.html';
let captureBusy = false;
let currentFilenameSuggestion = null;

const readState = async () => chrome.storage.local.get({
  queue: [], activeName: '', records: {}, skips: {}, pendingDownloads: {}, target: 500,
  autoSubmit: false, paused: false, downloadSubdir: '企业信息截图', saveAs: false,
  scannedNames: [], scannedHashes: []
});

const normalize = (s) => String(s ?? '').replace(/\s+/g, '').trim();
const safeFileName = (s) => String(s ?? '')
  .replace(/\.jpe?g$/i, '')
  .replace(/[<>:"/\\|?*\x00-\x1F]/g, '＿')
  .replace(/[. ]+$/g, '')
  .slice(0, 120).trim();

function safeSubdir(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  const parts = raw.split('/');
  if (parts.length > 4 || parts.some(part => !part || part === '.' || part === '..' ||
      /[<>:"|?*\x00-\x1F]/.test(part) || /[. ]$/.test(part))) {
    throw new Error('下载子目录无效。只可填写 Edge 默认下载目录下的相对文件夹，不能填写盘符或 ..。');
  }
  return parts.join('/');
}

async function jpegHash(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function jpegSize(dataUrl) {
  if (!/^data:image\/jpeg;base64,/i.test(dataUrl || '')) throw new Error('浏览器未返回 JPG 图片。');
  const bytes = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  if (bytes.length < 4096 || bytes.charCodeAt(0) !== 255 || bytes.charCodeAt(1) !== 216 ||
      bytes.charCodeAt(bytes.length - 2) !== 255 || bytes.charCodeAt(bytes.length - 1) !== 217) {
    throw new Error('截图 JPG 数据不完整，未保存。');
  }
  let pos = 2;
  while (pos + 9 < bytes.length) {
    if (bytes.charCodeAt(pos) !== 255) { pos++; continue; }
    const marker = bytes.charCodeAt(pos + 1);
    if (marker === 0xD9 || marker === 0xDA) break;
    if (marker === 0xFF || marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { pos += 2; continue; }
    const len = (bytes.charCodeAt(pos + 2) << 8) | bytes.charCodeAt(pos + 3);
    if (len < 2) break;
    if ([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker)) {
      const height = (bytes.charCodeAt(pos + 5) << 8) | bytes.charCodeAt(pos + 6);
      const width = (bytes.charCodeAt(pos + 7) << 8) | bytes.charCodeAt(pos + 8);
      if (width < 320 || height < 240) throw new Error('截图尺寸过小，未保存。');
      return {width, height};
    }
    pos += 2 + len;
  }
  throw new Error('无法验证 JPG 尺寸，未保存。');
}

async function getNextName() {
  const state = await readState();
  const candidate = state.queue.find(name => !state.skips[name] &&
    !['done', 'downloading'].includes(state.records[name]?.status));
  await chrome.storage.local.set({activeName: candidate || ''});
  return candidate || '';
}

async function finalizeDownload(id, stateString, errorString, downloadInfo) {
  const state = await readState();
  const job = state.pendingDownloads[id];
  if (!job) return;
  const now = new Date().toISOString();
  const actualBase = String(downloadInfo?.filename || '').split(/[\\/]/).pop();
  const expectedBase = job.file.split('/').pop();
  const validPath = actualBase === expectedBase;
  const status = stateString === 'complete' && validPath ? 'done' : 'failed';
  state.records[job.name] = {
    ...state.records[job.name], ...job, status, completedAt: now,
    file: downloadInfo?.filename || job.file,
    error: status === 'failed' ? (errorString || (stateString === 'complete'
      ? `实际文件名「${actualBase || '未知'}」与预期「${expectedBase}」不符；请核对是否有其他下载脚本或浏览器扩展改名`
      : '下载未完成')) : ''
  };
  delete state.pendingDownloads[id];
  await chrome.storage.local.set({
    records: state.records,
    pendingDownloads: state.pendingDownloads
  });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;
  try {
    const [info] = await chrome.downloads.search({id: delta.id});
    await finalizeDownload(String(delta.id), delta.state.current, delta.error?.current, info);
  }
  catch (e) { console.error('更新下载记录失败：', e); }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const ownCapture = currentFilenameSuggestion && item.byExtensionId === chrome.runtime.id &&
    item.url === currentFilenameSuggestion.url;
  if (ownCapture) suggest({filename: currentFilenameSuggestion.filename, conflictAction:'uniquify'});
  else suggest();
});

async function startCapture(payload, tab) {
  if (captureBusy) throw new Error('上一张截图正在处理，请稍后重试。');
  captureBusy = true;
  try {
    if (!tab?.id || !tab.active || !tab.windowId) throw new Error('请在当前激活的企业详情页操作。');
    const tabInfo = await chrome.tabs.get(tab.id);
    if (!tabInfo.active || tabInfo.windowId !== tab.windowId) throw new Error('截图前页面已切换，请回到企业详情页重试。');
    const url = tabInfo.url || '';
    if (!/^https:\/\/([a-z0-9-]+\.)?gsxt\.gov\.cn\//i.test(url)) {
      throw new Error('当前页面不属于国家企业信用信息公示系统。');
    }
    if (!payload?.verifiedDetail || !payload?.visibleLicense) throw new Error('未确认当前可视区域包含企业名称和营业执照信息。');

    const state = await readState();
    const submittedName = String(payload.name || '').trim().replace(/\.jpe?g$/i, '');
    const actual = normalize(submittedName);
    if (!actual || actual.length < 4 || !payload.observedName || normalize(payload.observedName) !== actual) {
      throw new Error('企业名称无法从详情页可靠核对，已阻止截图。');
    }
    if (state.activeName && normalize(state.activeName) !== actual) {
      throw new Error(`当前任务为「${state.activeName}」，截图名称却是「${payload.name}」，请核对是否选错企业。`);
    }
    const name = state.activeName || submittedName;
    if (Object.values(state.records).some(item => ['done', 'downloading'].includes(item.status) &&
        normalize(item.name) === actual)) {
      throw new Error(`「${name}」已经保存或正在下载，请勿重复采集。`);
    }
    const creditCode = String(payload.creditCode || '').trim();
    if (creditCode && Object.values(state.records).some(item => ['done', 'downloading'].includes(item.status) &&
        item.creditCode === creditCode)) throw new Error(`统一社会信用代码「${creditCode}」已采集，请勿重复。`);
    const safeName = safeFileName(name);
    if (!safeName) throw new Error('企业名称无法作为文件名。');
    if (state.scannedNames.some(existing => normalize(existing) === normalize(safeName))) {
      throw new Error(`已选文件夹中存在「${safeName}.jpg」，请勿重复保存。`);
    }
    const subdir = safeSubdir(state.downloadSubdir);
    const filename = `${subdir ? subdir + '/' : ''}${safeName}.jpg`;
    const priorDownloads = await chrome.downloads.search({state:'complete', orderBy:['-startTime'], limit:1000});
    if (priorDownloads.some(item => item.exists !== false &&
        String(item.filename || '').split(/[\\/]/).pop().toLowerCase() === `${safeName}.jpg`.toLowerCase())) {
      throw new Error(`下载记录中已存在「${safeName}.jpg」。请核对文件夹和采集记录后再决定是否重试。`);
    }
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg', quality: 92
      });
    } catch (e) {
      const detail = String(e?.message || e);
      if (/either the.*all_urls|activetab.*permission|permission.*denied|not.*permission/i.test(detail)) {
        throw new Error('尚未获得截图权限。请重新加载 v1.2.2 扩展，并在扩展详情中检查站点访问授权。原始错误：' + detail);
      }
      throw e;
    }
    const dimensions = jpegSize(dataUrl);
    const imageHash = await jpegHash(dataUrl);
    if (Object.values(state.records).some(item => ['done', 'downloading'].includes(item.status) && item.imageHash === imageHash)) {
      throw new Error('当前截图与已采集图片完全相同，已阻止重复保存。');
    }
    if (state.scannedHashes.includes(imageHash)) {
      throw new Error('当前截图与已扫描文件夹中的 JPG 完全相同，已阻止重复保存。');
    }
    const afterCapture = await chrome.tabs.get(tab.id);
    if (!afterCapture.active || afterCapture.windowId !== tab.windowId || afterCapture.url !== url) {
      throw new Error('截图期间标签页发生切换，已丢弃图片。请留在当前企业页面重试。');
    }
    currentFilenameSuggestion = {url:dataUrl, filename};
    const downloadId = await chrome.downloads.download({
      url: dataUrl, filename, conflictAction: 'uniquify', saveAs: !!state.saveAs
    });
    const item = {
      name, observedName: payload.observedName || '',
      creditCode, url, file: filename, requestedFile: filename, imageHash,
      queuedAt: new Date().toISOString(), downloadId, status: 'downloading', dimensions
    };
    const next = await readState();
    next.records[name] = item;
    next.pendingDownloads[String(downloadId)] = item;
    await chrome.storage.local.set({
      records: next.records,
      pendingDownloads: next.pendingDownloads
    });
    // The download can complete before the storage update above finishes.
    const results = await chrome.downloads.search({id: downloadId});
    if (results?.[0]?.state === 'complete') await finalizeDownload(String(downloadId), 'complete', '', results[0]);
    if (results?.[0]?.state === 'interrupted') {
      await finalizeDownload(String(downloadId), 'interrupted', results[0].error, results[0]);
    }
    const recorded = (await readState()).records[name];
    if (recorded?.status === 'failed') throw new Error(recorded.error || '下载失败');
    return {ok: true, name, filename, status: recorded?.status || 'downloading', file: recorded?.file || filename};
  } finally { currentFilenameSuggestion = null; captureBusy = false; }
}

async function nextAndOpen(tabId) {
  const state = await readState();
  if (state.paused) return {ok: false, error: '任务已暂停，请在扩展弹窗中继续。'};
  const name = await getNextName();
  if (!name) return {ok: false, error: '目前没有待处理的候选企业。请在官网结果页识别并导入企业，或直接手动进入企业详情页截图。'};
  await chrome.tabs.update(tabId, {url: SEARCH_URL, active: true});
  return {ok: true, name};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_STATE': return {ok: true, state: await readState()};
      case 'CAPTURE':
        if (!sender.tab?.id || sender.id !== chrome.runtime.id) throw new Error('截图请求来源无效。');
        return await startCapture(message.payload, sender.tab);
      case 'NEXT': {
        if (!sender.tab?.id) throw new Error('无法识别页面标签页。');
        return await nextAndOpen(sender.tab.id);
      }
      case 'NEXT_FROM_POPUP': {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        if (!tab?.id) throw new Error('未找到当前浏览器标签页。');
        return await nextAndOpen(tab.id);
      }
      case 'SKIP': {
        const state = await readState();
        if (!state.activeName) throw new Error('当前没有待处理的名单任务。');
        state.skips[state.activeName] = {reason: '人工跳过', time: new Date().toISOString()};
        await chrome.storage.local.set({skips: state.skips});
        if (sender.tab?.id) return await nextAndOpen(sender.tab.id);
        return {ok: true};
      }
      default: return {ok: false, error: '未知指令'};
    }
  })().then(sendResponse).catch(e => sendResponse({ok: false, error: String(e?.message || e)}));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('企业信息截图助手已安装；仅在用户操作后查询及截图。');
});

async function reconcilePendingDownloads() {
  const state = await readState();
  for (const [id, job] of Object.entries(state.pendingDownloads)) {
    const [info] = await chrome.downloads.search({id: Number(id)});
    if (info?.state === 'complete' || info?.state === 'interrupted') {
      await finalizeDownload(id, info.state, info.error, info);
    } else if (!info) {
      await finalizeDownload(id, 'interrupted', '浏览器重启后未找到下载任务');
    }
  }
}
chrome.runtime.onStartup.addListener(() => reconcilePendingDownloads().catch(console.error));
reconcilePendingDownloads().catch(console.error);
