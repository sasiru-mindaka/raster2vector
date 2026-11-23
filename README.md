# Vector Studio — Hybrid Vectorization Engine (v4)

Plain HTML + CSS + JS modules. No CDN, no WASM, no backend, no internet needed. Run: `./run-linux.sh` → http://localhost:8000 (not via file://).

## How the hybrid engine works (`assets/js/core/engine.js`)
1. Error-driven palette: variance splitting + k-means until the fidelity target (PSNR) or colour cap is reached.
2. A pixel becomes **vector** only if its colour is within a tolerance of its palette colour (set by *Fidelity target*) AND it belongs to a same-colour region of at least *Minimum vector region* px.
3. Each vector colour = exact pixel-edge boundary tracing (with holes) → RDP simplification → corner-aware quadratic curves, painted large-to-small with a 0.7 px same-colour stroke (no seams).
4. Everything else (texture / noise / anti-aliased edge pixels) stays as an alpha-masked PNG underneath, grown by *Seam protection* px.

## Measured end-to-end (real Chromium, upload → convert → render SVG → compare to source)
| Image | Vector % | PSNR | SSIM | SVG size |
|---|---|---|---|---|
| Flat logo (600×400) | 96% | 40.3 dB | 0.993 | 167 KB |
| Photo, defaults (512²) | 32–58% | 43 dB | 0.97–0.98 | 1.4–1.6 MB |
| Photo, Fidelity 100 | 13% | 48 dB | 0.998 | 0.8 MB |

A photograph cannot be both mostly-vector and pixel-identical: raising fidelity moves pixels to the raster layer. Pure-vector photo output was tried (stacked layers): 82 MB and still only 40 dB.

## v4.1 notes
- Edge pixels that are blends of two neighbouring vector colours are absorbed into the nearer vector region (3 passes), so edges stay sharp when zoomed. Costs ~1–3 dB PSNR versus the soft version.
- `assets/vendor/buzz-dee-vtrace-2.0.0-0.tgz` (embedded-WASM VTracer) was tested offline: alone it scored 25.5 dB on the flat logo vs 37.6–38.7 dB for the built-in engine, so it is **not** used. It is kept only for future experiments.
- Real-image results (Chromium end-to-end): Sinhala banner crops 35–37 dB / SSIM 0.98 with 81–96% vector; logo 37.6 dB; photo 40 dB with 44% vector.
- Preview panes: placeholders are now truly hidden, so the full image is shown.

## v4.2 — sub-pixel contours
Region boundaries are now marching-squares contours over per-pixel *coverage* (anti-aliased edge pixels contribute their blend fraction), so edges land at sub-pixel positions instead of pixel staircases. Default Fidelity target is 90%.
Measured (Chromium e2e, default settings): user banner 1080² 33.2 dB / vec 42%; Sinhala crops 37.7–38.9 dB; logo 44.9 dB; photo 42.4 dB. The earlier hybrid SVG from the user's own run scored 25.65 dB on the same banner.
Known remaining artefact: very faint 1-px contour lines inside smooth blurred gradients where a vector patch meets raster (raise Fidelity target to shrink them, at the cost of vector %).
