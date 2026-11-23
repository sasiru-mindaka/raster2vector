# Browser regression tests

These tests use local Chromium and real image fixtures. They do not upload images to a server.

## GPU smoke test

Install the Python test packages and Playwright's Chromium build, then run:

```bash
python3 -m pip install -r requirements-test.txt
python3 -m playwright install chromium
npm run build
npm run test:e2e
```

The script also detects a system Chromium executable when one is already installed. It prefers the desktop GPU and does not force software rendering. For a software-only compatibility run, prefix the command with `VECTOR_STUDIO_SWIFTSHADER=1`; do not use that mode for hardware benchmarks.

It exercises Auto, WebGPU-preferred, WebGL2-preferred and CPU-only Hybrid Vector paths against the astronaut, coffee, cat, rocket and flat-graphic fixtures. It also checks Pure Vector Photo output on astronaut, coffee and cat, including the requirement that no `<image>` or `data:image` raster embed appears. A selected GPU path may report a CPU fallback when the host browser/device does not expose that API; successful SVG output is still required. A managed Chromium policy that blocks navigation to local pages prevents this test from running; use a normal local Chromium profile.

## Quality benchmark

With Python packages `playwright`, `numpy`, `scikit-image` and a Chromium install:

```bash
python3 tests/e2e/bench.py tests/fixtures/astronaut.png,tests/fixtures/coffee.png \
  '{"CPU":{"gpuBackend":"cpu","colorCount":64,"useGradients":false},"Auto GPU":{"gpuBackend":"auto","colorCount":64,"useGradients":false}}'
```

The benchmark renders the exported SVG in Chromium and reports PSNR / SSIM against each original image. It writes rendered files to `tests/results/`.

## Real-image tracing regression (no browser required)

This runs the CPU contour engine against all five local photographs/graphics, constructs the quantized GPU lookup-table mapping, and verifies byte-identical SVG output against the CPU palette-assignment reference. It does not execute the GPU shader. It embeds the original PNG as the full underlay, renders the resulting SVG with CairoSVG, and reports PSNR / SSIM:

```bash
python3 tests/e2e/real-image-regression.py
```

## Pure-vector photo regression

Run `npm run test:photo`. This processes the five checked-in real images through the pure-vector engine, uses the GPU-equivalent palette lookup mapping, renders the generated SVG with Inkscape (or CairoSVG as fallback), and measures PSNR / SSIM against the original at native dimensions. It asserts 100% vector coverage and zero embedded raster resources. The comparison sheet and metrics report are saved in `tests/results/`. This sends each real image through the actual application Worker handler with CPU processing selected. It is not a hardware shader test.
