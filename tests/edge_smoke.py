"""Isolated Edge + local routed GSXT fixture. Never accesses the live website."""
from pathlib import Path
import os
import time
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT.parent / "gsxt_extension_review" / f"edge_smoke_profile_v122_{os.getpid()}"
URL = "https://shiming.gsxt.gov.cn/mock-detail"
NAME = "安徽测试科技有限公司"
HTML = f"""<!doctype html><meta charset='utf-8'><title>模拟企业详情</title>
<style>body{{margin:0;font:18px Arial}}.bar{{height:32px;background:#dd2244}}
main{{padding:16px}}table{{border-collapse:collapse}}th,td{{border:1px solid #555;padding:8px}}
</style><div class='bar'></div><main><h2>营业执照信息</h2><table>
<tr><th>企业名称</th><td>{NAME}</td></tr>
<tr><th>统一社会信用代码</th><td>913401001234567890</td></tr>
<tr><th>法定代表人</th><td>张三</td></tr>
<tr><th>成立日期</th><td>2020-01-01</td></tr>
<tr><th>注册资本</th><td>100万元</td></tr>
</table></main><script>window.pageClicks=0;document.addEventListener('click',()=>window.pageClicks++);</script>"""

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        str(PROFILE), executable_path=r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        headless=False, accept_downloads=True,
        viewport={"width": 1280, "height": 900},
        args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"],
    )
    try:
        context.route(URL, lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=HTML))
        page = context.new_page()
        page.goto(URL, wait_until="domcontentloaded")
        page.locator("#gsxt-enterprise-shot-helper-root").wait_for(timeout=15000)
        worker = context.service_workers[0]
        extension_id = worker.url.split('/')[2]
        popup = context.new_page()
        popup.goto(f"chrome-extension://{extension_id}/popup.html")
        popup.locator("#download-subdir").fill("模拟截图")
        popup.locator("#save-path").click()
        assert worker.evaluate("chrome.storage.local.get('downloadSubdir').then(x => x.downloadSubdir)") == "模拟截图"
        popup.locator("#scan-folder").set_input_files(str(ROOT / "tests"))
        popup.wait_for_function("() => document.querySelector('#scan-info').textContent.includes('已扫描')", timeout=10000)
        assert worker.evaluate("chrome.storage.local.get('scannedNames').then(x => x.scannedNames.includes('fixture'))")
        popup.close()
        before = page.evaluate("window.scrollY")
        button = page.locator("#gsxt-enterprise-shot-helper-root #save")
        button.click()
        after = page.evaluate("window.scrollY")
        assert before == after, f"scroll changed: {before} -> {after}"
        assert page.evaluate("window.pageClicks") == 0, "helper click leaked to page handler"
        record = None
        for _ in range(50):
            records = worker.evaluate("chrome.storage.local.get('records').then(x => x.records || {})")
            record = records.get(NAME)
            if record and record["status"] in ("done", "failed"):
                break
            time.sleep(0.2)
        print("record:", record)
        downloads = worker.evaluate("chrome.downloads.search({}).then(items => items.map(x => ({filename:x.filename,state:x.state,error:x.error})))")
        print("downloads:", downloads)
        assert record and record["status"] in ("done", "failed"), record
        assert record["requestedFile"] == f"模拟截图/{NAME}.jpg", record["requestedFile"]
        image_path = record["file"]
        assert Path(image_path).is_file(), image_path
        with Image.open(image_path) as image:
            image.verify()
        with Image.open(image_path) as image:
            assert image.format == "JPEG"
            assert image.width >= 320 and image.height >= 240
            pixel = image.getpixel((100, 15))
            assert pixel[0] > pixel[1] * 1.5, f"wrong page content: {pixel}"
        print("PASS: extension and popup loaded; path setting and folder scan worked; button visible; no scroll; no page click leakage; valid captured page image")
        print("NOTE: Playwright redirects extension downloads to an artifact UUID, so browser download filename and success status require ordinary Edge validation")
        print("download:", image_path, "size:", Path(image_path).stat().st_size)
    finally:
        context.close()
