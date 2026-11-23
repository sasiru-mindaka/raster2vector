#!/usr/bin/env python3
"""Generate and compare pure-vector SVGs against real photograph fixtures."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
from skimage.metrics import peak_signal_noise_ratio, structural_similarity

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
RESULTS = ROOT / "tests" / "results"
IMAGES = ["astronaut.png", "coffee.png", "chelsea.png", "rocket.png", "flat-graphic.png"]


def render_svg(svg_path: Path, png_path: Path, width: int, height: int) -> float:
    inkscape = shutil.which("inkscape")
    started = time.perf_counter()
    if inkscape:
        subprocess.run(
            [inkscape, str(svg_path), "--export-type=png", f"--export-filename={png_path}",
             f"--export-width={width}", f"--export-height={height}"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        try:
            import cairosvg
        except ImportError as exc:
            raise RuntimeError("Install Inkscape or the Python CairoSVG package to render the SVGs.") from exc
        cairosvg.svg2png(url=str(svg_path), write_to=str(png_path), output_width=width, output_height=height)
    return time.perf_counter() - started


def make_contact_sheet(records: list[dict], temp: Path, output: Path) -> None:
    cell_w, cell_h = 360, 240
    gutter, label_h, metric_h = 16, 26, 24
    row_h = label_h + cell_h + metric_h + gutter
    sheet = Image.new("RGB", (gutter + 2 * cell_w + gutter, gutter + len(records) * row_h), "#edf0f4")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 16)
        small_font = ImageFont.truetype("DejaVuSans.ttf", 12)
    except OSError:
        font = ImageFont.load_default()
        small_font = ImageFont.load_default()

    for row, item in enumerate(records):
        y = gutter + row * row_h
        name = item["image"].replace("-", " ").title()
        draw.text((gutter, y), f"{name} — ORIGINAL", fill="#20242b", font=font)
        draw.text((gutter + cell_w, y), f"{name} — PURE VECTOR SVG", fill="#20242b", font=font)
        original = Image.open(FIXTURES / f"{item['image']}.png").convert("RGB")
        vector = Image.open(temp / f"{item['image']}-rendered.png").convert("RGB")
        original = ImageOps.contain(original, (cell_w, cell_h), Image.Resampling.LANCZOS)
        vector = ImageOps.contain(vector, (cell_w, cell_h), Image.Resampling.LANCZOS)
        left = Image.new("RGB", (cell_w, cell_h), "white")
        right = Image.new("RGB", (cell_w, cell_h), "white")
        left.paste(original, ((cell_w - original.width) // 2, (cell_h - original.height) // 2))
        right.paste(vector, ((cell_w - vector.width) // 2, (cell_h - vector.height) // 2))
        sheet.paste(left, (gutter, y + label_h))
        sheet.paste(right, (gutter + cell_w, y + label_h))
        metrics = f"PSNR {item['psnrDb']:.2f} dB  ·  SSIM {item['ssim']:.4f}  ·  {item['svgSizeMB']:.2f} MB"
        draw.text((gutter + cell_w + 8, y + label_h + cell_h + 4), metrics, fill="#394150", font=small_font)
    sheet.save(output, quality=92, optimize=True)


def main() -> int:
    RESULTS.mkdir(parents=True, exist_ok=True)
    inkscape = shutil.which("inkscape")
    renderer_name = "Inkscape" if inkscape else "CairoSVG"

    with tempfile.TemporaryDirectory(prefix="vector-studio-pure-vector-") as temporary:
        temp = Path(temporary)
        manifest = []
        originals: dict[str, np.ndarray] = {}
        for filename in IMAGES:
            name = Path(filename).stem
            source = Image.open(FIXTURES / filename).convert("RGBA")
            width, height = source.size
            raw_name = f"{name}.rgba"
            (temp / raw_name).write_bytes(source.tobytes())
            manifest.append({"name": name, "width": width, "height": height, "raw": raw_name})
            originals[name] = np.asarray(source.convert("RGB"), dtype=np.uint8)
        (temp / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        process = subprocess.run(
            ["node", str(ROOT / "tests" / "pure-vector-regression.mjs"), str(temp)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        traced_records = json.loads(process.stdout)
        final_records: list[dict] = []
        all_ok = True
        print("Pure-vector photo regression (512-colour palette, SVG paths + gradients, no raster embeds)")
        print("Image              Size         Paths  Gradients  SVG MB  PSNR dB  SSIM    Trace  Render")

        for item in traced_records:
            svg_path = temp / "svg" / f"{item['image']}.svg"
            svg_text = svg_path.read_text(encoding="utf-8")
            if "<image" in svg_text.lower() or "data:image/" in svg_text.lower():
                raise RuntimeError(f"{item['image']}: embedded raster image detected in SVG.")
            rendered_path = temp / f"{item['image']}-rendered.png"
            width, height = map(int, item["dimensions"].split("x"))
            render_seconds = render_svg(svg_path, rendered_path, width, height)
            candidate = np.asarray(Image.open(rendered_path).convert("RGB"), dtype=np.uint8)
            reference = originals[item["image"]]
            psnr = float(peak_signal_noise_ratio(reference, candidate, data_range=255))
            ssim = float(structural_similarity(reference, candidate, channel_axis=2, data_range=255))
            passed = (
                item["embeddedRasterImages"] == 0
                and item["vectorPercent"] == 100.0
                and item["rasterPercent"] == 0.0
                and item["pathCount"] > 0
                and np.isfinite(psnr)
                and psnr > 30.0
                and ssim > 0.90
            )
            all_ok &= passed
            record = {
                **{key: value for key, value in item.items() if key != "svgPath"},
                "psnrDb": round(psnr, 3),
                "ssim": round(ssim, 5),
                "svgSizeMB": round(item["svgBytes"] / 1_000_000, 3),
                "renderSeconds": round(render_seconds, 2),
                "passed": passed,
            }
            final_records.append(record)
            print(
                f"{item['image']:18} {item['dimensions']:12} {item['pathCount']:6d} "
                f"{item['gradientPieces']:10d} {record['svgSizeMB']:7.2f} "
                f"{psnr:8.2f} {ssim:6.4f} {item['traceSeconds']:6.2f}s {render_seconds:6.2f}s"
            )
            if not passed:
                print(f"  FAILED: vector purity or image-similarity acceptance criteria for {item['image']}")

        make_contact_sheet(final_records, temp, RESULTS / "pure-vector-comparison.jpg")
        (RESULTS / "pure-vector-results.json").write_text(json.dumps(final_records, indent=2), encoding="utf-8")
        report = [
            "# Pure-vector photo regression results",
            "",
            f"Renderer: {renderer_name}",
            "Settings: 512-colour maximum palette, cubic Bézier contours, fitted SVG gradients, no embedded raster images.",
            "PSNR and SSIM compare the rendered SVG at the original fixture dimensions against the original raster.",
            "These metrics measure visual approximation, not exact pixel identity.",
            "",
            "| Fixture | Dimensions | Paths | Gradients | SVG size | PSNR | SSIM | Vector | Raster embeds |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for item in final_records:
            report.append(
                f"| {item['image']} | {item['dimensions']} | {item['pathCount']} | {item['gradientPieces']} "
                f"| {item['svgSizeMB']:.2f} MB | {item['psnrDb']:.2f} dB | {item['ssim']:.4f} "
                f"| {item['vectorPercent']:.1f}% | {item['embeddedRasterImages']} |"
            )
        report.extend([
            "",
            "All fixture SVGs were checked for image elements and data-image references. Every visible source pixel is assigned to an SVG path or gradient layer; palette quantization means the result is an approximation, not lossless reproduction.",
        ])
        (RESULTS / "pure-vector-results.md").write_text("\n".join(report) + "\n", encoding="utf-8")
        print(f"\nContact sheet: {RESULTS / 'pure-vector-comparison.jpg'}")
        print(f"Report: {RESULTS / 'pure-vector-results.md'}")
        print(f"\n{len(final_records)} real images traced and rendered; no embedded raster images.")
        return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
