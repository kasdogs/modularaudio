#!/usr/bin/env python3
"""Headless runner for the Modular Audio test suite.

Usage:  pip install playwright && playwright install chromium
        python3 _tests/run.py            # exits non-zero if any test fails
Options: --chrome PATH   use an installed Chrome/Chromium instead of Playwright's
"""
import argparse, asyncio, functools, http.server, os, sys, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    handler = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

async def main(chrome):
    from playwright.async_api import async_playwright
    srv = serve()
    url = f"http://127.0.0.1:{srv.server_port}/_tests/?autorun"
    async with async_playwright() as p:
        kw = {"args": ["--autoplay-policy=no-user-gesture-required"]}
        if chrome: kw["executable_path"] = chrome
        browser = await p.chromium.launch(**kw)
        page = await browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.route("**/fonts.googleapis.com/**", lambda r: r.abort())
        await page.goto(url)
        await page.wait_for_function("window.__testResults", timeout=600000)
        results = await page.evaluate("window.__testResults")
        await browser.close()
    width = max(len(r["name"]) for r in results)
    for r in results:
        mark = "PASS" if r["pass"] else "FAIL"
        print(f"{mark}  {r['name']:<{width}}  {r['ms']:>6} ms")
        if r["error"]: print(f"      {r['error']}")
    failed = [r for r in results if not r["pass"]]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    for e in errors: print("page error:", e)
    return 1 if failed or errors else 0

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", help="path to a Chrome/Chromium binary")
    sys.exit(asyncio.run(main(ap.parse_args().chrome)))
