# Vector Studio — Hybrid + Pure Photo Vector Engine (v7.2)

## v7.2 audit fixes (3.2.2)

- Fixed Pixel-Exact alpha SVG exports by allowing the generated `fill-opacity` attribute and validating its numeric range.
- Kept partially transparent Hybrid pixels in the PNG fallback even when gradient reconstruction is enabled; Pure Vector Photo rejects partial alpha explicitly rather than silently changing it.
- Prevented stale image selections and completed Worker requests from overwriting newer UI state; settings edits cancel an active trace and invalidate stale results.
- Added Worker `messageerror` handling and guards against delayed errors from replaced Workers.
- Connected the Artwork profile selector to real tracing thresholds (Photo is more conservative; Poster and Logo favour vector regions).
- Rounded WebGL2 RGBA8 samples back to byte values before 6-bit palette bucketing, avoiding float boundary underflow.
- Restored symmetric neighbour checks when identifying sharp corners on closed contours.
- Expanded regression coverage and ignored Python bytecode / generated test results in the source archive.

## v7.1 hotfix (3.2.1)

- Fixed a false-positive in the browser-side SVG security validator: the exact standard SVG and XLink namespace declarations on the root `<svg>` element are now accepted as XML metadata, while external URLs, script schemes, event-handler attributes, and other unsafe values remain rejected.
- Added a regression test for both trusted namespace declarations and rejected unsafe attribute values.

A local-first raster-to-vector studio built with HTML, CSS, JavaScript and TypeScript. It runs in the browser with no backend, CDN, analytics, or external image upload. Open it through a local web server (`./run-linux.sh`) rather than `file://`.

## Processing architecture

1. **Palette construction (CPU):** a 6-bit RGB histogram, error-driven variance splitting and k-means refinement build a compact palette and a 64³ nearest-colour lookup table.
2. **GPU pixel classification (WebGPU / WGSL):** a compute shader looks up the palette label for every pixel and runs Sobel edge detection in the same dispatch.
3. **WebGL2 fallback (GLSL ES 3.00):** an offscreen fragment shader performs the same lookup + Sobel pass when WebGPU is unavailable.
4. **CPU fallback:** unsupported devices or shader/context errors fall back to the existing deterministic CPU classification and contour pipeline. Conversion does not depend on a discrete GPU.
5. **Hybrid mode:** vector-friendly coherent regions become editable SVG paths; texture and protected edge pixels remain in an embedded PNG layer.
6. **Pure Vector Photo mode:** every visible source pixel is represented by SVG vector geometry. Smooth regions can be reconstructed as fitted SVG linear gradients; detailed regions use palette-colour contours and cubic Bézier curves. The pure-vector branch explicitly rejects `<image>` elements and embedded raster data.
7. **Tracing / composition:** marching-squares contours, cubic Bézier or quadratic fitting, optional gradients, large-image tiles and the hybrid raster underlay remain available.

The GPU does not brute-force every pixel against all 512 colours. It performs a constant-time 64³ lookup per pixel; this avoids a potentially expensive `pixels × palette-colours` scan. GPU output is read back to the Worker for the existing region/contour pipeline.


## Pure-vector photo reconstruction

Choose **Pure Vector Photo** under Output mode to create a bitmap-free SVG. The current photo pipeline:

- Builds a 6-bit RGB histogram and an error-driven palette (up to 512 colours).
- Uses the same 64³ palette lookup table as the WebGPU/WebGL2/CPU classification pipeline.
- Detects locally smooth regions and fits real SVG `linearGradient` fills where a gradient model is a good fit.
- Converts the remaining palette regions to closed contours and smooth cubic Bézier paths.
- Assigns every fully opaque source pixel to vector geometry and rejects the export if an `<image>` element or `data:image` resource appears. Fully transparent pixels remain transparent; partially transparent pixels are rejected with a clear message because alpha-preserving path reconstruction is not yet implemented.

**What “100% vector” means here:** all visible image area is represented by SVG paths and gradients; the SVG contains no embedded PNG/JPEG. It is a high-fidelity approximation, not a lossless pixel copy. The 512-colour palette, curve fitting and gradients necessarily alter some fine colour/texture detail. Pure photo SVGs are larger than hybrid SVGs, and render time grows with image dimensions.

The application does not call a cloud AI model. This is a deterministic, local vector reconstruction pipeline; source images stay in the browser.

## Pure-vector photo quality regression

Run the real-image comparison with:

```bash
npm run test:photo
```

It traces the included astronaut, coffee, cat, rocket and flat-graphic fixtures, renders the pure SVGs at the original dimensions, and compares them against the source using PSNR and SSIM. It also verifies 100% vector coverage and zero embedded raster images. Inkscape is used as the renderer when installed; CairoSVG is the fallback. The comparison sheet and report are written to `tests/results/`.

Measured in this environment with 512 palette colours:

| Fixture | SVG paths | SVG gradients | SVG size | PSNR | SSIM | Vector coverage | Embedded raster |
|---|---:|---:|---:|---:|---:|---:|---:|
| Astronaut | 553 | 41 | 8.11 MB | 35.04 dB | 0.9523 | 100% | 0 |
| Coffee | 560 | 48 | 9.42 MB | 34.70 dB | 0.9462 | 100% | 0 |
| Chelsea cat | 527 | 15 | 5.44 MB | 37.14 dB | 0.9591 | 100% | 0 |
| Rocket | 533 | 21 | 5.60 MB | 36.67 dB | 0.9693 | 100% | 0 |
| Flat graphic | 9 | 5 | 0.04 MB | 32.21 dB | 0.9854 | 100% | 0 |

PSNR/SSIM are rendered-image similarity metrics. They do not prove pixel identity, and visual results depend on image subject, detail and source resolution.

## GPU selection

Use **GPU processing** in the sidebar:

- **Auto:** WebGPU first, then WebGL2, then CPU.
- **Prefer WebGPU:** try WebGPU; fall back to CPU if unavailable or if shader/device processing fails.
- **Prefer WebGL2:** try WebGL2; fall back to CPU if unavailable.
- **CPU only:** bypass GPU processing.

WebGPU requires a secure context (localhost is trusted) and browser/device support. WebGL2 is used only when an OffscreenCanvas WebGL2 context is available to the tracing Worker. GPU APIs are optional; CPU mode remains supported.

## TypeScript and security controls

- TypeScript sources live in `src/`; compiled browser modules are committed under `assets/js/generated/`.
- Worker requests validate request IDs, exact RGBA buffer length, safe dimensions, 12 MP cap, and bounded/allowlisted settings before allocating `ImageData` or GPU buffers.
- GPU inputs validate palette lookup length and every label before upload; output labels are checked before use.
- Image import validates byte size and file signatures before browser decoding.
- SVG inspection rejects active/unsupported elements, event handlers, XML entities/DOCTYPE, external resource references and unsafe paint URLs. The browser performs a second DOM-based allowlist validation before preview/export.
- User images stay local; the app does not send them to a server.

No client-only application can guarantee security against a compromised browser or OS. These checks are input/resource hardening and output-content restrictions, not a substitute for keeping the browser updated.

## Build and run

```bash
npm install
npm run build
npm test
./run-linux.sh
```

For browser GPU tests, install the optional Python test tools and Playwright's Chromium build:

```bash
python3 -m pip install -r requirements-test.txt
python3 -m playwright install chromium
npm run test:e2e
```

The supplied local server scripts bind to `127.0.0.1` so the development server is not exposed to the local network. Open `http://localhost:8000`. TypeScript is compiled to `assets/js/generated/`; those generated JS modules are included so the app can run directly from the checked-in files after building.

## Regression tests

### Unit tests

`npm test` compiles TypeScript and runs pure Node tests for exact SVG generation, SVG safety, hybrid segmentation, Bézier/quadratic curves, gradient fitting, tiles, underlay masks, GPU/CPU fallback contracts and TypeScript input validation.

### Real-image browser tests

`python3 tests/e2e/gpu-smoke.py` runs Chromium against local fixtures:

- NASA astronaut photograph (public domain / no known copyright restrictions)
- Coffee photograph (CC0, Rachel Michetti)
- Chelsea cat photograph (CC0, Stefan van der Walt)
- SpaceX launch photograph (released into the public domain)
- Generated flat-colour artwork

The suite exercises Auto, WebGPU-preferred, WebGL2-preferred and CPU-only hybrid runs, plus pure-vector photo runs, and verifies both masked-raster and bitmap-free SVG output. The automated real-image photo regression also invokes the application Worker message handler directly, rather than only calling the tracing function. It does not force software rendering by default, so a compatible desktop GPU can be used; GPU-preferred runs may correctly report CPU fallback on hosts without the requested API. Set `VECTOR_STUDIO_SWIFTSHADER=1` to force a software compatibility run (not a hardware performance test). A managed browser policy that blocks localhost navigation will prevent this test from starting; run it on a normal local Chromium installation.

For the hybrid real-image contour and SVG-quality regression (no browser required), run `python3 tests/e2e/real-image-regression.py`. It exercises the CPU contour engine and GPU-equivalent LUT mapping, then compares the hybrid SVG with its original raster underlay. For bitmap-free photo conversion, use `npm run test:photo` as described above. It sends each real fixture through the application Worker handler with CPU processing selected. Neither CPU regression executes a hardware WebGPU/WebGL shader; the separate Chromium smoke test does that. Measured results in this environment (64-colour cap):

| Fixture | Vector share | SVG PSNR | SSIM |
|---|---:|---:|---:|
| Astronaut | 32.48% | 44.09 dB | 0.9786 |
| Coffee | 30.07% | 44.31 dB | 0.9810 |
| Chelsea cat | 22.58% | 45.61 dB | 0.9877 |
| Rocket | 60.49% | 43.54 dB | 0.9825 |
| Flat graphic | 100.00% | 32.54 dB | 0.9859 |

For an interactive browser/CPU comparison, use `tests/e2e/bench.py` (requires Python `playwright`, `numpy`, and `scikit-image`):

```bash
python3 tests/e2e/bench.py tests/fixtures/astronaut.png,tests/fixtures/coffee.png \
  '{"CPU":{"gpuBackend":"cpu","colorCount":64,"useGradients":false},"Auto GPU":{"gpuBackend":"auto","colorCount":64,"useGradients":false}}'
```

The benchmark renders the generated SVG in Chromium and reports PSNR, SSIM, high-error pixel share, vector percentage, SVG size and render time. Output is written to `tests/results/`.

## Known limitations

- GPU palette lookup and Sobel are parallel; connected-region extraction, gradient fitting and contour construction still run on the CPU Worker.
- GPU readback adds memory traffic. It can be slower on small images or integrated/software-rendered GPUs; choose CPU mode for a quick small-image conversion.
- WebGPU availability varies by browser, OS, driver, secure-context status and headless mode. WebGL2 and CPU fallback paths are deliberate, not errors.
- Pure Vector Photo mode is not lossless: a 512-colour palette and smooth curve fitting approximate fine photographic texture. Hybrid mode remains the better choice when exact photographic texture, transparency preservation and smaller/safer editing output matter more than removing every raster image. Hybrid mode retains partially transparent pixels in its PNG fallback layer.
