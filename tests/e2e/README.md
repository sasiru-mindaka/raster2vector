# Raster2Vector image and browser tests

These optional quality tests use local sample images. They do not upload source images.

> **Python is for testing only.** The Raster2Vector website, conversion engine and SVG export do not use Python. Python is required only by the Python-based test scripts in this folder.

## Chromium GPU/UI smoke test

Install the Python test packages and Playwright's Chromium build, then run:

```bash
python3 -m pip install "playwright>=1.48" "Pillow>=10.0" "numpy>=1.26" "scikit-image>=0.23" "CairoSVG>=2.7"
python3 -m playwright install chromium
npm run test:e2e
```

The script also detects a system Chromium executable. It tests Auto, WebGPU-preferred, WebGL2-preferred and CPU-only Hybrid Vector paths against local image fixtures. It checks Pure Vector Photo output on the astronaut, coffee and cat images, including the requirement that no `<image>` or `data:image` raster resource is embedded. A requested GPU backend may report a CPU fallback when the host does not expose the API; the test reports the backend actually used. A managed Chromium policy that blocks navigation to local pages prevents this suite from running.

For a software-only compatibility run, prefix the command with `RASTER2VECTOR_SWIFTSHADER=1`. This is not a hardware performance test.

## Pure Vector Photo real-image regression

Run:

```bash
npm run test:photo
```

The script processes five checked-in images through the actual application Worker using CPU processing, renders the generated bitmap-free SVG with Inkscape (or CairoSVG as fallback), and compares it with the source at native dimensions. It asserts 100% visible-pixel vector coverage, zero embedded raster images and full opacity for fully opaque inputs. PSNR and SSIM measure approximation quality, not pixel identity. The comparison sheet and metrics report are written to the ignored `tests/results/` directory.

## Hybrid real-image regression

Run:

```bash
npm run test:hybrid
```

This traces the five local image fixtures with the CPU contour pipeline, constructs the same quantized 64³ lookup-table labels used by the GPU classifier, and checks that the LUT-reference and CPU palette assignments produce identical vector output. It renders the hybrid SVG with CairoSVG and reports PSNR / SSIM. This does not execute WebGPU or WebGL2 shaders; use the Chromium GPU/UI smoke test for that.

## Interactive quality benchmark

With Python packages `playwright`, `numpy`, `scikit-image` and Chromium installed:

```bash
python3 tests/e2e/bench.py tests/fixtures/astronaut.png,tests/fixtures/coffee.png \
  '{"CPU":{"gpuBackend":"cpu","colorCount":64,"useGradients":false},"Auto GPU":{"gpuBackend":"auto","colorCount":64,"useGradients":false}}'
```

The benchmark renders the exported SVG in Chromium and reports PSNR / SSIM against each original image. It writes rendered files to `tests/results/`.
