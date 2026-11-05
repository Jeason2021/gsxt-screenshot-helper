const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

function createHarness(dataUrl, renameDownload = false) {
  const state = {};
  const listeners = {};
  let nextId = 1;
  let lastFilename = '';
  let lastSaveAs = false;
  const downloadInfo = new Map();
  const chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: {addListener(fn) { listeners.message = fn; }},
      onInstalled: {addListener() {}},
      onStartup: {addListener() {}}
    },
    storage: {local: {
      async get(defaults) { return {...defaults, ...structuredClone(state)}; },
      async set(changes) { Object.assign(state, structuredClone(changes)); }
    }},
    downloads: {
      onChanged: {addListener(fn) { listeners.downloadChanged = fn; }},
      onDeterminingFilename: {addListener(fn) { listeners.determineFilename = fn; }},
      async download({url,filename,saveAs}) {
        listeners.determineFilename({byExtensionId:chrome.runtime.id,url}, suggestion => {
          if (suggestion?.filename) filename = suggestion.filename;
        });
        lastFilename = filename;
        lastSaveAs = saveAs;
        const id = nextId++;
        const actual = renameDownload ? filename.replace(/\.jpg$/, ' (1).jpg') : filename;
        downloadInfo.set(id, {id, state:'complete', filename:`C:\\Downloads\\${actual.replaceAll('/', '\\')}`});
        return id;
      },
      async search({id}) {
        if (id !== undefined) return downloadInfo.has(id) ? [downloadInfo.get(id)] : [];
        return [...downloadInfo.values()];
      }
    },
    tabs: {
      async get(id) { return {id, active:true, windowId:2, url:'https://shiming.gsxt.gov.cn/detail.html'}; },
      async captureVisibleTab() { return dataUrl; },
      async update() {}
    }
  };
  const context = vm.createContext({chrome, crypto:webcrypto, atob, console, Date, setTimeout});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  async function send(type, payload) {
    return new Promise(resolve => listeners.message(
      {type, payload}, {id:chrome.runtime.id, tab:{id:7, active:true, windowId:2}}, resolve
    ));
  }
  return {state, send, downloadInfo, get lastFilename() {return lastFilename;}, get lastSaveAs(){return lastSaveAs;}};
}

const fixture = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'fixture.jpg')).toString('base64');

test('valid JPG download completes once with actual saved filename', async () => {
  const h = createHarness(fixture);
  const payload = {name:'安徽测试科技有限公司.jpg', observedName:'安徽测试科技有限公司', creditCode:'913401001234567890', verifiedDetail:true, visibleLicense:true};
  const first = await h.send('CAPTURE', payload);
  assert.equal(first.ok, true);
  assert.equal(h.lastFilename, '企业信息截图/安徽测试科技有限公司.jpg');
  assert.equal(h.state.records['安徽测试科技有限公司'].status, 'done');
  assert.match(h.state.records['安徽测试科技有限公司'].file, /安徽测试科技有限公司\.jpg$/);
  const duplicate = await h.send('CAPTURE', payload);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /已经保存/);
  assert.equal(Object.keys(h.state.records).length, 1);
});

test('wrong name or missing visible license is rejected', async () => {
  const h = createHarness(fixture);
  const payload = {name:'安徽甲科技有限公司', observedName:'安徽乙科技有限公司', verifiedDetail:true, visibleLicense:true};
  assert.equal((await h.send('CAPTURE', payload)).ok, false);
  assert.equal((await h.send('CAPTURE', {...payload, observedName:payload.name, visibleLicense:false})).ok, false);
  assert.equal(Object.keys(h.state.records || {}).length, 0);
});

test('invalid JPG is rejected before any download or success record', async () => {
  const h = createHarness('data:image/jpeg;base64,AAAA');
  const result = await h.send('CAPTURE', {name:'安徽测试科技有限公司', observedName:'安徽测试科技有限公司', verifiedDetail:true, visibleLicense:true});
  assert.equal(result.ok, false);
  assert.match(result.error, /JPG/);
  assert.equal(h.lastFilename, '');
});

test('pause prevents opening the next queued company', async () => {
  const h = createHarness(fixture);
  h.state.queue = ['安徽测试科技有限公司'];
  h.state.paused = true;
  const result = await h.send('NEXT');
  assert.equal(result.ok, false);
  assert.match(result.error, /暂停/);
});

test('browser-renamed conflict is not counted as a successful exact-name screenshot', async () => {
  const h = createHarness(fixture, true);
  const name = '安徽测试科技有限公司';
  const result = await h.send('CAPTURE', {name, observedName:name, verifiedDetail:true, visibleLicense:true});
  assert.equal(result.ok, false);
  assert.equal(h.state.records[name].status, 'failed');
  assert.match(h.state.records[name].error, /实际文件名/);
});

test('configured subfolder and Save As choice are passed to Edge', async () => {
  const h = createHarness(fixture);
  h.state.downloadSubdir = '项目A/截图';
  h.state.saveAs = true;
  const name = '安徽测试科技有限公司';
  const result = await h.send('CAPTURE', {name, observedName:name, verifiedDetail:true, visibleLicense:true});
  assert.equal(result.ok, true);
  assert.equal(h.lastFilename, '项目A/截图/安徽测试科技有限公司.jpg');
  assert.equal(h.lastSaveAs, true);
});

test('download history duplicate is rejected before capture', async () => {
  const h = createHarness(fixture);
  h.downloadInfo.set(99,{id:99,state:'complete',exists:true,filename:'C:\\Downloads\\安徽测试科技有限公司.jpg'});
  const name = '安徽测试科技有限公司';
  const result = await h.send('CAPTURE', {name, observedName:name, verifiedDetail:true, visibleLicense:true});
  assert.equal(result.ok, false);
  assert.match(result.error, /下载记录中已存在/);
});

test('exact image duplicate is rejected under a different enterprise name', async () => {
  const h = createHarness(fixture);
  const first = '安徽测试科技有限公司';
  const second = '安徽另家科技有限公司';
  assert.equal((await h.send('CAPTURE', {name:first, observedName:first, verifiedDetail:true, visibleLicense:true})).ok, true);
  const result = await h.send('CAPTURE', {name:second, observedName:second, verifiedDetail:true, visibleLicense:true});
  assert.equal(result.ok, false);
  assert.match(result.error, /图片完全相同/);
});

test('selected folder duplicate name and JPG bytes are rejected', async () => {
  const name = '安徽测试科技有限公司';
  const h1 = createHarness(fixture);
  h1.state.scannedNames = [name];
  assert.match((await h1.send('CAPTURE', {name, observedName:name, verifiedDetail:true, visibleLicense:true})).error, /已选文件夹/);
  const h2 = createHarness(fixture);
  const digest = await webcrypto.subtle.digest('SHA-256', fs.readFileSync(path.join(__dirname, 'fixture.jpg')));
  h2.state.scannedHashes = [Buffer.from(digest).toString('hex')];
  assert.match((await h2.send('CAPTURE', {name, observedName:name, verifiedDetail:true, visibleLicense:true})).error, /已扫描文件夹/);
});
