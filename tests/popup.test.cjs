const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

test('CSV export contains completed record and neutralizes spreadsheet formulas', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value:'', checked:false, style:{}, classList:{add(){},remove(){}},
      addEventListener(_event, callback) { this.handler = callback; }
    });
    return elements.get(id);
  };
  let exportedBlob;
  const state = {
    records: {'=TEST有限公司': {
      name:'=TEST有限公司', creditCode:'913401001234567890',
      file:'C:\\Downloads\\企业信息截图\\=TEST有限公司.jpg', status:'done',
      completedAt:'2026-11-03T00:00:00Z', url:'https://shiming.gsxt.gov.cn/detail', error:''
    }}
  };
  const chrome = {
    storage: {
      local:{async get(defaults){return {...defaults,...state};},async set(x){Object.assign(state,x);}},
      onChanged:{addListener(){}}
    },
    tabs:{},runtime:{}
  };
  const document = {
    getElementById:element,
    createElement(){return {click(){},remove(){}};},
    body:{appendChild(){}}
  };
  const context = vm.createContext({chrome,document,Blob,crypto:webcrypto,URL:{createObjectURL(blob){exportedBlob=blob;return 'blob:test';},revokeObjectURL(){}},setTimeout,confirm(){return false;}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','popup.js'),'utf8'),context);
  await element('export').handler();
  const csv = await exportedBlob.text();
  assert.match(csv,/企业名称,?/);
  assert.match(csv,/状态|截图状态/);
  assert.match(csv,/'=TEST有限公司/);
  assert.match(csv,/913401001234567890/);
  assert.match(csv,/C:\\Downloads\\企业信息截图/);
  element('download-subdir').value = '项目A/截图';
  element('save-as').checked = true;
  await element('save-path').handler();
  assert.equal(state.downloadSubdir, '项目A/截图');
  assert.equal(state.saveAs, true);
  const fixture = fs.readFileSync(path.join(__dirname, 'fixture.jpg'));
  const file = {name:'安徽测试科技有限公司.jpg', size:fixture.length, webkitRelativePath:'企业信息截图/安徽测试科技有限公司.jpg',
    async arrayBuffer(){return fixture.buffer.slice(fixture.byteOffset,fixture.byteOffset+fixture.byteLength);}};
  await element('scan-folder').handler({target:{files:[file,file]}});
  assert.equal(state.scannedNames.length, 1);
  assert.equal(state.scannedHashes.length, 1);
  assert.equal(state.scannedFolder, '企业信息截图');
});
