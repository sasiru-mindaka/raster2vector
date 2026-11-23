# Vector Studio v7.3.0 — Code cleanup and verification report

**Audit date:** 24 November 2026  
**Package version:** 3.3.0  
**Review basis:** the supplied Vector Studio v7.2.3 clean-up ZIP and the user's supplied 1672 × 941 artwork.

## Executive result

The active browser and Worker code paths were retained. Unreferenced legacy modules, a vendor archive that was not part of the runtime dependency graph, dead diagnostic helpers, an unused local variable, and generated test-output clutter were removed. A repeatable runtime import audit was added so future shipped JavaScript modules cannot silently become orphaned without failing the test suite.

No production conversion algorithm was rewritten as part of this cleanup. The aim was to reduce unused surface area while preserving the already-tested Pure Vector, Hybrid and Pixel-Exact implementations.

## Review method — two independent passes

### Pass 1: runtime reachability

- Started from the two actual runtime entry points: `assets/js/app.js` and `assets/js/workers/trace-worker.js`.
- Followed static local JavaScript imports recursively and checked that each import resolved to an existing file.
- Checked that every JavaScript file shipped under `assets/js/` was reachable from one of those entry points.
- Checked that every stylesheet under `assets/css/` was linked from `index.html`.
- Result: **11 reachable JavaScript modules, 2 linked stylesheets, 0 unresolved imports, 0 orphaned runtime JavaScript files and 0 orphaned stylesheets.**

### Pass 2: repository-wide reference confirmation

For each removal candidate, searched the complete project (runtime code, tests, docs, package scripts and HTML) for direct and named references, then checked the runtime graph separately. Removed only the candidates that were test-only, unreferenced or generated artifacts. The same runtime graph audit is now executable as `tests/runtime-import-audit.mjs` and is part of `npm test`.

## Removed dead or obsolete code

| Removed item | Why it was safe to remove |
|---|---|
| `assets/js/core/vtrace-adapter.js` | Referenced only by its four legacy unit tests; not imported by the browser app or Worker. |
| `assets/vendor/buzz-dee-vtrace-2.0.0-0.tgz` | No runtime import, package dependency, build step or documented install path referenced this archive. |
| `assets/js/core/hybrid-analysis.js` | Old standalone classifier was referenced only by four unit tests; the current Worker uses the active `engine.js` + `hybrid-composer.js` path instead. |
| `createMaskPreviewDataUrl()` in `hybrid-composer.js` | Exported diagnostic helper had no caller anywhere in the project. |
| `tests/e2e/zoom.py` | One-off screenshot helper was not invoked by package scripts or documented test flows. |
| `tests/results/` | Generated comparison images and metrics, not source or required fixtures; the test scripts recreate them. |
| `const file = sourceFile` in `app.js` | The local variable was never read in `runTrace()`; `sourceFile` itself remains used by download naming and state handling. |

Eight tests that exercised only the removed legacy modules were removed with those modules. The active-code unit tests remain, and the import-graph test was added. The final active-code suite contains **30 unit tests**.

## Retained code and assets

- `engine.js`, `lossless.js`, `hybrid-composer.js`, `svg-utils.js`, `image-utils.js` and `trace-client.js` remain in the active Worker/UI graph.
- TypeScript GPU and Worker-payload validation sources remain in `src/`, with their compiled JavaScript retained under `assets/js/generated/` for direct browser execution.
- Source maps and declarations remain generated development artifacts; they are associated with the active TypeScript outputs and were not mistaken for runtime modules.
- The five local real-image fixtures remain because both the Pure Vector and Hybrid regression suites use them.
- `tests/e2e/bench.py` remains because it is documented as an optional image-quality comparison utility.

## Code and project maintenance changes

- Added `tests/runtime-import-audit.mjs` and included it in `npm test`.
- Added `npm run test:hybrid` as a named entry point for the existing real-image Hybrid regression.
- Updated `package.json` to version `3.3.0`.
- Rewrote the README around current application modes, actual test commands, processing limitations and project layout.
- Removed test results and Python bytecode from the release archive; `tests/results/` remains ignored and is recreated by regression runs.

## Verification performed

### Automated tests

| Check | Result |
|---|---|
| `npm test` | **30/30 unit tests passed**; 3 Worker smoke scenarios passed; UI-mode regression passed; contour-gap regression passed; runtime import audit passed |
| `npm run typecheck` | Passed |
| JavaScript/ES module syntax checks (`node --check`) | Passed for all shipped JS/MJS files |
| Python test script compilation (`py_compile`) | Passed |
| `bash -n run-linux.sh` | Passed |
| `npm run test:photo` | **5/5 real images passed**; no embedded raster images; 100% vector coverage |
| `npm run test:hybrid` | **5/5 real images passed**; LUT-reference assignments matched CPU assignments |

### User-supplied artwork

The supplied fully opaque **1672 × 941** PNG was processed through the actual application Worker with CPU processing selected:

- Output: **259 SVG paths**, 101 reported gradient pieces.
- Visible-pixel vector coverage: **100%**; raster coverage: **0%**.
- Embedded SVG raster image elements: **0**.
- SVG document: **16,000,555 bytes**; XML parsing succeeded.
- Inkscape native-size render: **1672 × 941**, transparent pixels **0**, partial-alpha pixels **0**.
- Inkscape 2× render: **3344 × 1882**, transparent pixels **0**, partial-alpha pixels **0**.

The test confirms that this particular opaque input produces a valid bitmap-free SVG that renders without transparent seam gaps at both tested scales. Pure Vector is a palette/curve approximation and is not a lossless pixel copy.

### Browser GPU test limitation

`npm run test:e2e` was attempted. Chromium returned `ERR_BLOCKED_BY_ADMINISTRATOR` when the test tried to navigate to the local app, so the browser UI and hardware WebGPU/WebGL2 scenarios could not be executed in this environment. No hardware-GPU PASS is claimed. The Node Worker/CPU paths, real-image raster render tests and CPU/LUT-reference equivalence tests did run successfully.

## Known limitations

- Pure Vector Photo currently rejects partially transparent pixels. Use Hybrid or Pixel-Exact when partial alpha must be preserved.
- Pure Vector Photo approximates photographs with a bounded palette, vector paths and gradients; fine texture and subtle colour transitions may differ from the source.
- Hybrid mode embeds a masked PNG for photographic detail; raster-covered areas can soften when zoomed.
- Browser GPU behaviour remains device/driver dependent and should be checked with `npm run test:e2e` on a normal local desktop browser.

## Conclusion

The cleanup removed only modules/helpers verified as unused by the runtime and project reference checks. Active conversion logic and five real-image fixture sets were retained and retested. The current package passes all tests available in this environment except the browser GPU suite, which was blocked by the managed Chromium policy and is explicitly recorded as not completed.
