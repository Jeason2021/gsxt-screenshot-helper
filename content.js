'use strict';

(() => {
  if (window.__gsxtCollectorLoaded) return;
  window.__gsxtCollectorLoaded = true;
  const ROOT_ID = 'gsxt-enterprise-shot-helper-root';
  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.cssText = 'position:fixed;right:17px;bottom:18px;z-index:2147483647;';
  const shadow = host.attachShadow({mode: 'open'});
  shadow.innerHTML = `
  <style>
  * { box-sizing: border-box; }
  .panel { font-family: 'Microsoft YaHei', Arial, sans-serif; width: 320px; background: #fff;
    border: 1px solid #d7dce5; box-shadow: 0 7px 25px #2224; border-radius: 12px;
    color: #1e293b; padding: 13px; font-size: 13px; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  strong { font-size:14px; }
  .count { font-size:12px; color:#64748b; }
  .name { width:100%; padding:9px 10px; border:1px solid #cbd5e1;
    border-radius:7px; margin-bottom:9px; font-size:13px; }
  .row { display:flex; gap:7px; }
  button { cursor:pointer; font-size:12px; padding:8px 10px; border-radius:7px; border:1px solid #d7dee8;
    background:#f8fafc; color:#0f172a; white-space:nowrap; }
  button.primary { background:#0866d7; color:white; border-color:#0866d7; flex:1; font-weight:700; }
  button:hover { filter:brightness(.96); }
  .message { margin-top:9px; line-height:1.45; color:#64748b; overflow-wrap:anywhere; }
  .error { color:#b91c1c; } .success { color:#167449; }
  .small { font-size:11px; color:#64748b; margin:6px 0 8px; }
  .hidden { display:none; }
  .minibutton { border-radius:20px; background:#0866d7; color:white; box-shadow:0 3px 14px #2224; }
  </style>
  <div id="panel" class="panel">
    <header><strong>企业信息截图助手 v1.2.2</strong><span class="count" id="count">0 / 500</span></header>
    <input class="name" id="enterprise-name" type="text" placeholder="自动识别企业名称，必要时可修改" />
    <div class="row">
      <button type="button" class="primary" id="save">保存当前页 JPG</button>
      <button type="button" id="next">下一家</button>
      <button type="button" id="skip">跳过</button>
      <button type="button" id="hide">—</button>
    </div>
    <div class="message" id="message">请打开企业详情页后保存。截图时自动隐藏工具栏。</div>
    <div class="small" id="detail-status"></div>
  </div>
  <button type="button" class="minibutton hidden" id="restore">企业截图</button>
  `;
  (document.body || document.documentElement).appendChild(host);
  const $ = id => shadow.getElementById(id);
  for (const eventName of ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
    shadow.addEventListener(eventName, event => event.stopPropagation());
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = x => String(x || '').replace(/\s+/g, '').trim();
  let edited = false;
  let lastName = '';
  let lastPrefilled = '';
  let lastDownloadStatus = '';

  function textOfPage() {
    // The helper is inside a shadow root, and is not included in body.innerText.
    return document.body?.innerText || '';
  }
  function cleanName(s) {
    return String(s || '').replace(/^[\s:：]+/, '').replace(/[\s:：]+$/, '')
      .replace(/\.jpe?g$/i, '').replace(/[\u0000-\u001f]/g, '').trim();
  }
  function looksEnterprise(s) {
    return s && s.length >= 4 && s.length <= 120 &&
      /(公司|企业|事务所|合作社|经营部|工作室|合伙企业|厂|中心|商行)$/.test(s);
  }
  function detailReady() {
    const s = textOfPage();
    return s.includes('营业执照信息') &&
      s.includes('统一社会信用代码') &&
      /(?:统一社会信用代码|注册号)\s*[:：]?\s*[0-9A-Z]{18}/.test(s) &&
      (s.includes('成立日期') || s.includes('法定代表人')) &&
      (s.includes('注册资本') || s.includes('登记机关'));
  }
  function readTableCompanyName() {
    // Usually the label and value are adjacent table cells.
    const items = [...document.querySelectorAll('td,th,dt,dd,span,div,label')];
    for (const el of items) {
      if (el.closest(`#${ROOT_ID}`)) continue;
      const label = cleanName(el.innerText);
      if (!/^企业名称[:：]?$/.test(label)) continue;
      const next = el.nextElementSibling;
      if (next) {
        const value = cleanName(next.innerText.split('\n')[0]);
        if (looksEnterprise(value)) return value;
      }
      const parentNext = el.parentElement?.nextElementSibling;
      if (parentNext) {
        const value = cleanName(parentNext.innerText.split('\n')[0]);
        if (looksEnterprise(value)) return value;
      }
    }
    return '';
  }
  function detectNameFromDetail() {
    if (!detailReady()) return '';
    const fromTable = readTableCompanyName();
    if (fromTable) return fromTable;
    const selectors = '[class*="companyName"],[class*="company-name"],[class*="entName"],[class*="ent-name"]';
    for (const el of document.querySelectorAll(selectors)) {
      const t = cleanName(el.innerText.split('\n')[0]);
      if (looksEnterprise(t)) return t;
    }
    const body = textOfPage();
    const match = body.match(/企业名称\s*[:：]\s*\n?\s*([^\n]{4,100})/);
    if (match && looksEnterprise(cleanName(match[1]))) return cleanName(match[1]);
    return '';
  }
  function visibleText() {
    const items = document.querySelectorAll('td,th,dt,dd,span,label,p,h1,h2,h3,h4,div');
    const lines = [];
    for (const el of items) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > innerHeight ||
          rect.right < 0 || rect.left > innerWidth) continue;
      const value = (el.innerText || '').trim();
      if (value && value.length < 160) lines.push(value);
    }
    return lines.join('\n');
  }
  function licenseVisible(name) {
    const s = visibleText();
    return norm(s).includes(norm(name)) && /统一社会信用代码/.test(s) &&
      /[0-9A-Z]{18}/.test(s) && /营业执照信息|法定代表人|成立日期|登记机关|注册资本/.test(s);
  }
  function detectCode() {
    const text = textOfPage();
    const match = text.match(/(?:统一社会信用代码|注册号)\s*[:：]?\s*([0-9A-Z]{18})/);
    return match ? match[1] : '';
  }
  function showMessage(message, type='') {
    $('message').textContent = message;
    $('message').className = `message ${type}`;
  }
  async function refresh() {
    try {
      const state = await chrome.storage.local.get({queue:[], activeName:'', records:{}, target:500, autoSubmit:false});
      const count = Object.values(state.records).filter(x => x.status === 'done').length;
      $('count').textContent = `${count} / ${state.target}`;
      const candidate = detectNameFromDetail();
      const expected = state.activeName || '';
      const record = state.records[expected || candidate];
      const statusKey = record ? `${record.name}:${record.status}:${record.completedAt || ''}` : '';
      if (statusKey && statusKey !== lastDownloadStatus && ['done', 'failed'].includes(record.status)) {
        showMessage(record.status === 'done'
          ? `JPG 下载完成：${record.file}`
          : `下载未计入成功：${record.error || '下载失败'}；实际文件：${record.file || '未知'}`,
          record.status === 'done' ? 'success' : 'error');
      }
      lastDownloadStatus = statusKey;
      if (!edited && (candidate || expected)) $('enterprise-name').value = candidate || expected;
      $('detail-status').textContent = detailReady()
        ? `已识别企业详情页${candidate ? '：' + candidate : ''}${expected ? '；名单任务：' + expected : ''}`
        : `尚未识别企业详情页${expected ? '；下一家：' + expected : ''}`;
      if (expected && !detailReady()) prefillSearch(expected, state.autoSubmit);
    } catch (e) { console.debug('助手读取状态：', e); }
  }
  async function prefillSearch(company, autoSubmit) {
    if (detailReady() || !company || lastPrefilled === company) return;
    const inputs = [...document.querySelectorAll('input[type="text"],input:not([type])')]
      .filter(x => /企业名称|统一社会信用代码|注册号/.test(x.placeholder || '') && x.offsetWidth > 0);
    const el = inputs[0];
    if (!el) return;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setValue) setValue.call(el, company); else el.value = company;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    lastPrefilled = company;
    showMessage(`已填写「${company}」。请检查检索结果，打开名称完全一致的企业详情页。`);
    if (!autoSubmit) return;
    await wait(250);
    // Optional: one search per user-issued "next" action. No repeated automatic retries.
    const rect = el.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('button,[type="submit"]')]
      .filter(btn => btn.offsetWidth > 0 && !btn.closest(`#${ROOT_ID}`))
      .filter(btn => {
        const b = btn.getBoundingClientRect();
        return b.left >= rect.right - 10 && b.left <= rect.right + 120 &&
          Math.abs((b.top + b.height / 2) - (rect.top + rect.height / 2)) < 65;
      });
    if (buttons[0]) buttons[0].click();
    else el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true}));
  }
  // Extract names only from visible search-result cards with business metadata.
  // This does not send network requests, auto-paginate, click cards, or bypass a challenge.
  function scanCurrentResults() {
    if (detailReady()) return {ok:false,error:'当前是企业详情页。请返回企业搜索结果列表后使用此功能。'};
    const metaPattern = /统一社会信用代码|注册号/;
    const secondMetaPattern = /法定代表人|成立日期|成立时间|登记状态|注册资本/;
    const namePattern = /([\u3400-\u9fffA-Za-z0-9（）()·&＆\-\s]{2,115}?(?:(?:有限责任公司|股份有限公司|集团有限公司|有限公司)(?:[\u3400-\u9fffA-Za-z0-9（）()·&＆\-]{1,35}分公司)?|分公司|合伙企业|普通合伙|特殊普通合伙|合作社|事务所|研究院|经营部|工作室|商行|制造厂|加工厂|总厂|公司))/g;
    function displayable(el) {
      if (el.closest(`#${ROOT_ID}`)) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    }
    function getCard(el) {
      let node = el;
      for (let depth=0; node && depth<6; depth++,node=node.parentElement) {
        const t=(node.innerText || '').trim();
        if (t.length > 20 && t.length < 650 && metaPattern.test(t) && secondMetaPattern.test(t)) return node;
      }
      return null;
    }
    function extractName(txt) {
      const lines = String(txt||'').split(/\n/).map(v=>v.trim()).filter(Boolean);
      const choices = lines.slice(0, 8);
      for (const line of choices) {
        const safeLine = line.replace(/^(?:企业名称|公司名称|名称)\s*[:：]?\s*/, '').replace(/^[\d.、\s]+/, '');
        const found = [...safeLine.matchAll(namePattern)];
        for (const match of found) {
          const candidate = cleanName(match[1]);
          if (looksEnterprise(candidate) && !/^(搜索|查询|企业信用|国家企业信用)/.test(candidate)) return candidate;
        }
      }
      return '';
    }
    const found = new Map();
    // Prefer clickable entries so that headings, sidebar suggestions and recent views are excluded.
    const clicks = [...document.querySelectorAll('a,[role="link"],[onclick],h3,h4')].slice(0,3500);
    for (const el of clicks) {
      if (!displayable(el)) continue;
      const card = getCard(el);
      if (!card) continue;
      const name = extractName(el.innerText) || extractName(card.innerText);
      if (!name) continue;
      const codeMatch = card.innerText.match(/(?:统一社会信用代码|注册号)\s*[:：]?\s*([0-9A-Z]{15,18})/);
      const key=norm(name);
      if (!found.has(key)) found.set(key, {name, code:codeMatch?.[1] || ''});
    }
    // Fallback for result cards using divs without links.
    if (!found.size) {
      const cards = [...document.querySelectorAll('li,article,[class*="result-item"],[class*="search-item"],[class*="search_list_item"],[class*="searchList"]')].slice(0,2500);
      for (const card of cards) {
        if (!displayable(card)) continue;
        const t=(card.innerText||'').trim();
        if (t.length < 20 || t.length > 650 || !metaPattern.test(t) || !secondMetaPattern.test(t)) continue;
        const name = extractName(t);
        if (name) found.set(norm(name), {name});
      }
    }
    return {ok:true, names:[...found.values()].map(x=>x.name).slice(0,150), detected:found.size};
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'SCAN_RESULTS') sendResponse(scanCurrentResults());
  });

  $('enterprise-name').addEventListener('input', () => { edited = true; });
  $('save').addEventListener('click', async event => {
    event.preventDefault();
    if (!detailReady()) {
      showMessage('未找到完整营业执照信息：请进入企业详情页，确认信息加载完成后再保存。', 'error');
      return;
    }
    const name = cleanName($('enterprise-name').value);
    const observedName = detectNameFromDetail();
    if (!looksEnterprise(name)) {
      showMessage('企业名称不完整或不符合常见企业名称格式，请填写完整名称。', 'error');
      return;
    }
    if (!observedName) {
      showMessage('无法从营业执照区域可靠识别企业名称，已阻止保存。', 'error');
      return;
    }
    if (norm(name) !== norm(observedName)) {
      showMessage(`名称不匹配：页面显示「${observedName}」，输入的是「${name}」。请核对。`, 'error');
      return;
    }
    if (!norm(textOfPage()).includes(norm(name))) {
      showMessage('企业名称未在页面正文中出现，请确认不是搜索结果页或错误企业。', 'error');
      return;
    }
    const saveButton = $('save');
    saveButton.disabled = true;
    showMessage('正在生成 JPG……');
    try {
      if (!licenseVisible(name)) throw new Error('当前画面未同时显示企业名称和营业执照字段。请自行滚动或调整缩放比例后重试；助手不会自动滚动。');
      host.style.visibility = 'hidden';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const response = await chrome.runtime.sendMessage({type:'CAPTURE', payload:{
        name, observedName, creditCode:detectCode(), verifiedDetail:true, visibleLicense:true
      }});
      host.style.visibility = 'visible';
      if (!response?.ok) throw new Error(response?.error || '截图失败');
      edited = false;
      showMessage(response.status === 'done'
        ? `JPG 下载完成：${response.file}`
        : `已提交下载：${response.filename}。完成后计入成功数量。`, 'success');
      await refresh();
    } catch (e) {
      host.style.visibility = 'visible';
      showMessage(`截图失败：${e.message || e}`, 'error');
    } finally { saveButton.disabled = false; }
  });
  $('next').addEventListener('click', async () => {
    showMessage('正在打开下一家企业的搜索页……');
    const res = await chrome.runtime.sendMessage({type:'NEXT'});
    if (!res?.ok) showMessage(res?.error || '未能打开下一家', 'error');
  });
  $('skip').addEventListener('click', async () => {
    if (!confirm('确定跳过当前名单中的企业吗？可在扩展面板重新导入或清除跳过记录。')) return;
    const res = await chrome.runtime.sendMessage({type:'SKIP'});
    if (!res?.ok) showMessage(res?.error || '跳过失败', 'error');
  });
  $('hide').addEventListener('click', () => {
    $('panel').classList.add('hidden');
    $('restore').classList.remove('hidden');
  });
  $('restore').addEventListener('click', () => {
    $('restore').classList.add('hidden');
    $('panel').classList.remove('hidden');
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.activeName) { edited = false; lastPrefilled = ''; }
    refresh();
  });
  refresh();
  // Some pages load detail fields asynchronously.
  let rounds = 0;
  const watcher = setInterval(() => {
    refresh();
    if (++rounds > 25) clearInterval(watcher);
  }, 800);
})();
