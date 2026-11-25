#!/usr/bin/env python3
"""Local real-image E2E tests for WebGPU, WebGL2 and CPU conversion paths."""
from __future__ import annotations

import json
import os
import shutil
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
FIXTURE_NAMES = ["astronaut.png", "coffee.png", "chelsea.png", "rocket.png", "flat-graphic.png"]
CASES = [
    *((name, preference, "hybrid") for name, preference in [
        ("astronaut.png", "auto"),
        ("astronaut.png", "webgpu"),
        ("astronaut.png", "webgl2"),
        ("astronaut.png", "cpu"),
        *((name, "auto") for name in FIXTURE_NAMES if name != "astronaut.png"),
    ]),
    ("astronaut.png", "auto", "photo"),
    ("coffee.png", "cpu", "photo"),
    ("chelsea.png", "auto", "photo"),
]


def set_input(page, selector: str, value: object) -> None:
    page.locator(selector).evaluate(
        "(element, nextValue) => { element.value = String(nextValue); "
        "element.dispatchEvent(new Event('input', { bubbles: true })); "
        "element.dispatchEvent(new Event('change', { bubbles: true })); }",
        value,
    )


def main() -> int:
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    failures: list[str] = []
    results: list[dict[str, object]] = []

    try:
        with sync_playwright() as playwright:
            browser_options = {
                "headless": True,
                "args": [
                    "--no-sandbox",
                    "--enable-webgl",
                    "--enable-features=Vulkan,WebGPU",
                ],
            }
            if os.environ.get("RASTER2VECTOR_SWIFTSHADER") == "1":
                browser_options["args"].extend(["--enable-unsafe-swiftshader", "--use-angle=swiftshader"])
            system_chromium = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
            if system_chromium:
                browser_options["executable_path"] = system_chromium
            browser = playwright.chromium.launch(**browser_options)
            for image_name, preference, output_mode in CASES:
                page = browser.new_page(viewport={"width": 1440, "height": 1000})
                page_errors: list[str] = []
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                try:
                    page.goto(f"http://127.0.0.1:{port}/", wait_until="networkidle")
                except Exception as error:
                    if "ERR_BLOCKED_BY_ADMINISTRATOR" in str(error):
                        print("BLOCKED: this environment's managed Chromium policy prevents local-page navigation.")
                        print("The browser GPU checks were not executed here; run this test on the local desktop browser.")
                        page.close()
                        browser.close()
                        return 2
                    raise
                capabilities = page.evaluate(
                    "() => ({ webgpu: Boolean(navigator.gpu), "
                    "webgl2: Boolean(document.createElement('canvas').getContext('webgl2')) })"
                )
                page.select_option("#gpuBackend", preference)
                page.set_input_files("#fileInput", str(FIXTURES / image_name))
                page.wait_for_function(
                    "() => !document.querySelector('#traceButton').disabled", timeout=30_000
                )
                if output_mode == "photo":
                    page.locator("#photoModeCard").click()
                    set_input(page, "#colorCount", 512)
                    set_input(page, "#curveSmoothness", 0.65)
                else:
                    page.select_option("#presetSelect", "logo" if image_name == "flat-graphic.png" else "photo")
                    set_input(page, "#colorCount", 64)
                    set_input(page, "#curveSmoothness", 0.8)
                    set_input(page, "#detailProtection", 90)
                    set_input(page, "#minVectorArea", 12)
                    set_input(page, "#edgeOverlap", 1)
                    page.locator("#useGradients").uncheck()
                page.locator("#traceButton").click()
                page.wait_for_function(
                    "() => !document.querySelector('#downloadButton').disabled || "
                    "/failed|error/i.test(document.querySelector('#statusTitle')?.textContent || '')",
                    timeout=180_000,
                )
                status = page.locator("#statusTitle").inner_text()
                message = page.locator("#statusMessage").inner_text()
                key = f"{image_name} / {preference} / {output_mode}"
                if status != "SVG created and validated":
                    failures.append(f"{key}: {status} — {message}")
                else:
                    svg = page.evaluate(
                        "async () => { const image = document.querySelector('#resultPreview'); "
                        "return await (await fetch(image.src)).text(); }"
                    )
                    if output_mode == "photo":
                        if "<svg" not in svg or "<image" in svg.lower() or "data:image/" in svg.lower():
                            failures.append(f"{key}: pure-vector SVG has an embedded or missing raster resource")
                        if page.locator("#metricVector").inner_text() != "100%" or page.locator("#metricRaster").inner_text() != "0%":
                            failures.append(f"{key}: pure-vector coverage metrics are not 100% / 0%")
                    elif "<svg" not in svg or "data:image/png;base64," not in svg:
                        failures.append(f"{key}: missing valid hybrid SVG underlay")
                    metric_time = page.locator("#metricTime").inner_text()
                    backend = message.split("GPU: ", 1)[1].split(".", 1)[0] if "GPU: " in message else "not reported"
                    results.append(
                        {
                            "image": image_name,
                            "requested": preference,
                            "mode": output_mode,
                            "backend": backend,
                            "webgpu_available": capabilities["webgpu"],
                            "webgl2_available": capabilities["webgl2"],
                            "convert_time": metric_time,
                            "svg_bytes": len(svg.encode("utf-8")),
                        }
                    )
                if page_errors:
                    failures.append(f"{key}: browser errors: {'; '.join(page_errors)}")
                state = "FAIL" if any(item.startswith(key + ":") for item in failures) else "PASS"
                print(f"{state} {key} → {results[-1]['backend'] if results and results[-1]['image'] == image_name and results[-1]['requested'] == preference and results[-1]['mode'] == output_mode else status}", flush=True)
                page.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    print("\nGPU/browser test summary")
    print(json.dumps(results, indent=2))
    if failures:
        print("\nFailures:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print(f"\n{len(results)}/{len(CASES)} browser conversion checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
