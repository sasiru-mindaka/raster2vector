# Vector Studio v7.3.0

A local-first raster-to-SVG workspace built with HTML, CSS, JavaScript and TypeScript. Images are processed in the browser and its dedicated Web Worker; the application has no backend, analytics, CDN dependency or cloud image upload.

## Output modes

- **Pure Vector Photo (default):** reconstructs visible image areas using editable SVG paths and gradients. It embeds no PNG/JPEG layer, so the vector geometry remains sharp when zoomed. This is a visual approximation, not a pixel-identical conversion.
- **Hybrid Vector:** combines editable vector regions with a masked PNG layer to retain photographic texture. The raster portion can soften when enlarged.
- **Pixel-Exact:** represents decoded pixels as SVG geometry and preserves alpha. Complex images can reach the configured region limit; use another mode for very detailed images.

Pure Vector Photo currently requires fully opaque visible pixels. It rejects partially transparent pixels with an explanation rather than silently changing their alpha. Fully transparent source areas remain transparent.

## Processing architecture

1. The browser validates the image file signature and size, decodes it locally, and prepares the working image.
2. The Worker validates request IDs, dimensions, exact RGBA buffer length and bounded settings before allocating image or GPU resources.
3. Palette preparation builds a 6-bit RGB histogram, a compact palette and a 64³ nearest-colour lookup table.
4. Pixel labels and Sobel edge information are calculated with WebGPU, WebGL2 or the CPU fallback.
5. The CPU contour pipeline builds SVG paths, cubic Bézier or quadratic curves, optional fitted gradients and tiles for larger images.
6. The selected mode is checked before its SVG is returned. The browser applies a second DOM-based SVG allowlist validation before preview and export.

GPU APIs are optional. CPU processing remains available when a browser or device does not support WebGPU/WebGL2 or a GPU operation fails.

## Run locally

Use a local web server rather than opening `index.html` with `file://`:

```bash
./run-linux.sh
```

Then open <http://localhost:8000>.

For development and tests:

```bash
npm install
npm run build
npm test
```

The TypeScript sources are in `src/`. Compiled browser modules are committed under `assets/js/generated/` so the app can also run directly after extraction.

## Tests

| Command | What it checks |
|---|---|
| `npm test` | TypeScript build, 30 unit tests, Worker smoke checks, UI mode checks, contour-gap regression and runtime import audit |
| `npm run test:photo` | Five local real images through the actual application Worker in Pure Vector Photo mode; renders SVGs and measures PSNR/SSIM |
| `npm run test:hybrid` | Five local real images through the hybrid contour engine; checks LUT/CPU palette equivalence and rendered-image quality |
| `npm run test:e2e` | Chromium UI tests for WebGPU, WebGL2 and CPU-requested conversion paths |
| `npm run typecheck` | TypeScript validation without emitting files |

The real-image fixtures are stored under `tests/fixtures/`, so the CPU regressions do not require network access. `npm run test:photo` uses Inkscape when installed and otherwise CairoSVG to render the generated SVGs at the source dimensions. It asserts that the Pure Vector output contains no embedded raster image, reaches 100% visible-pixel vector coverage, and remains fully opaque for fully opaque sources. PSNR and SSIM quantify visual similarity; they do not prove pixel identity.

The browser GPU test requires Playwright and a compatible Chromium installation. Install the optional test dependencies with:

```bash
python3 -m pip install -r requirements-test.txt
python3 -m playwright install chromium
```

A browser/device may legitimately fall back to CPU when a requested GPU API is unavailable. Hardware acceleration results should be read from the test output, not inferred from a successful CPU fallback.

### Current real-image reference results

Pure Vector Photo, rendered at each source's native dimensions using the current 512-colour palette limit:

| Fixture | Paths | Gradients | SVG size | PSNR | SSIM |
|---|---:|---:|---:|---:|---:|
| Astronaut | 554 | 41 | 8.78 MB | 32.56 dB | 0.9290 |
| Coffee | 561 | 48 | 9.58 MB | 33.47 dB | 0.9404 |
| Chelsea cat | 528 | 15 | 5.72 MB | 36.80 dB | 0.9635 |
| Rocket | 534 | 21 | 5.30 MB | 36.47 dB | 0.9709 |
| Flat graphic | 10 | 5 | 0.11 MB | 30.99 dB | 0.9817 |

Hybrid CPU/LUT-reference checks also pass on the same five fixtures. Since Hybrid intentionally retains a raster layer, its vector-share percentage varies by image and should not be interpreted as Pure Vector coverage.

## Security and privacy notes

- Images are processed locally; there is no upload endpoint or remote conversion service.
- File signatures, byte size, source dimensions, Worker payload shape and settings are validated.
- SVG inspection rejects active elements, event handlers, XML entities/DOCTYPE, external resource URLs and unsupported attributes.
- Only the intended embedded PNG resource is accepted in Hybrid output. Pure Vector Photo rejects `<image>` elements and `data:image` resources.
- The app enforces a 25 MB input-file limit and a 12-megapixel processing limit. Pixel-Exact mode also has a geometry-complexity limit.

These controls reduce input and SVG-content risks; they are not a guarantee against a compromised browser, operating system or malicious extension.

## Project layout

```text
index.html
assets/
  css/                 Application stylesheets
  js/
    app.js             Browser UI and application state
    core/              Image handling, tracing, SVG validation/composition
    generated/         Compiled TypeScript modules
    ui/                Theme setup
    workers/           Background tracing Worker
src/                   TypeScript source for GPU and payload validation
tests/
  e2e/                 Optional browser and image-quality tests
  fixtures/            Local real-image regression fixtures
```

## v7.3.0 cleanup

- Removed unused legacy VTrace and hybrid-analysis modules, their orphaned tests, and an unreferenced vendor archive.
- Removed an unused diagnostic PNG-mask helper, an unreferenced one-off zoom script, an unused local variable and previously generated test-result files from the release package.
- Added a runtime import audit that checks every shipped JavaScript module is reachable from the browser app or Worker and that every shipped stylesheet is linked from the HTML entry point.
- Retained the active SVG safety, Pure Vector seam protection, Hybrid raster composition and Pixel-Exact alpha handling paths.
