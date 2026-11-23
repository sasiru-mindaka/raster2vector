# Vector Studio v7.2 — source audit report

**Audit date:** 23 November 2026  
**Package:** Vector Studio v7.2 / application version 3.2.2

## Scope

The audit reviewed the 35 original textual project files (4,808 lines; this generated report is not counted) covering the HTML entry point, both stylesheets, application state and DOM handling, image import/decoding, Worker client and Worker pipeline, SVG generation/composition/validation, tracing algorithms, TypeScript GPU and security sources, generated TypeScript modules, tests, scripts, package configuration and documentation. Binary image fixtures and the archived vendor `.tgz` were not counted as source lines. Runtime imports were checked to distinguish active app/Worker modules from legacy test-only modules.

## Findings fixed in this release

1. **Pixel-Exact alpha export rejected by the browser validator.** Generated `fill-opacity` was not in the browser SVG attribute allowlist. Added it with numeric range validation (0–1) and Worker regression coverage.
2. **Hybrid semi-transparent pixels could be treated as opaque gradient/vector regions.** Gradient candidate selection now excludes partial-alpha pixels, retaining them in the alpha-preserving PNG fallback. Pure Vector Photo rejects partial alpha with a clear explanation instead of silently changing opacity.
3. **Stale conversion results could overwrite newer UI state.** Image selections and trace runs are now tokenized; the Worker uses the source bitmap snapshot taken at run start. New file selection, removal, cancellation or settings changes invalidate pending work.
4. **Worker failures could leave work pending or affect a replacement Worker.** Added `messageerror` handling, rejection of pending work, termination of the broken Worker, and guards against late events from old Workers.
5. **Artwork profile selector was inert.** Photo, Illustration, Poster and Logo now apply distinct hybrid tracing thresholds.
6. **WebGL2 palette quantization had a float-boundary risk.** RGBA8 texture samples are rounded back to byte values before 6-bit palette bucketing.
7. **WebGL2 readback failures could be missed.** Added an explicit GL error check after `readPixels` so failed readback falls back rather than silently consuming an all-zero/invalid result.
8. **Closed-contour corner detection had a disabled backward-neighbour check.** Restored a symmetric local-maximum check to avoid duplicate corner candidates.
9. **The development server was listening on all interfaces by default.** The supplied launcher and `npm run serve` now bind to `127.0.0.1`.
10. **Generated test clutter could enter the project archive.** Added ignore rules for Python bytecode, OS metadata and generated test results.

The v7.1 SVG namespace false-positive fix is retained: the exact standard SVG and XLink namespace declarations on the root element are accepted, while unsafe URL values and unsupported content remain rejected.

## Verification performed

- `npm test`: **38/38 Node tests passed**, followed by three Worker smoke scenarios (pure-vector conversion, partial-alpha rejection in Pure Vector Photo, and Pixel-Exact alpha output).
- `npm run test:photo`: **5/5 real-image pure-vector regressions passed**; all produced SVGs without embedded raster images.
- `python3 tests/e2e/real-image-regression.py`: **5/5 hybrid real-image regressions passed**; the GPU-equivalent palette LUT labels matched the CPU reference.
- `npm run build` and `npm run typecheck`: passed.
- `node --check` over project JavaScript/ES modules and `python3 -m py_compile` over the Python test tools: passed.
- Local HTTP server smoke test: `127.0.0.1:8000` returned HTTP 200.
- The user-supplied 1672×941 image was sent through the actual Worker handler in CPU mode: 6.18 s, 165 paths, 101 gradients, 11.05 MB SVG, zero embedded raster images. XML parsing succeeded. Rendering the SVG back to 1672×941 produced PSNR **33.86 dB** and SSIM **0.9632** against the source image.

## Tests not completed in this environment

`npm run test:e2e` was attempted, but the managed Chromium policy blocked navigation to the local test page (`ERR_BLOCKED_BY_ADMINISTRATOR`). Therefore, this environment did **not** compile or dispatch the WGSL/WebGPU or GLSL/WebGL2 shaders on an actual browser GPU. The hybrid real-image test uses the CPU contour engine and the same quantized lookup-table reference; it is not a hardware-GPU test. Browser-driven UI race tests are also not fully exercised here. Run the documented Playwright GPU smoke test on a normal desktop browser to complete those checks.

## Remaining product limitations

- Pure Vector Photo does not yet reconstruct partially transparent pixels; use Hybrid or Pixel-Exact mode when partial alpha must be preserved.
- Pure Vector Photo is a palette/curve approximation, not lossless pixel identity; the included PSNR/SSIM checks quantify similarity, not exact equivalence.
- GPU work is limited to per-pixel palette lookup and Sobel edge detection. Palette construction, connected-region extraction, gradient fitting, contour tracing and SVG composition remain on the CPU Worker.
- The application enforces a 25 MB input-file limit and a 12-megapixel processing limit. Pixel-Exact mode also enforces a geometry-complexity limit.

This audit found and corrected the issues listed above, but passing the available tests is not proof that no undiscovered defects exist. The hardware GPU/browser checks remain outstanding.
