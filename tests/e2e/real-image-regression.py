#!/usr/bin/env python3
"""Trace checked-in photographs in Node and measure rendered hybrid SVG fidelity."""
from __future__ import annotations

import base64
import json
import subprocess
import tempfile
from pathlib import Path

import cairosvg
import numpy as np
from PIL import Image
from skimage.metrics import peak_signal_noise_ratio, structural_similarity

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
IMAGES = ["astronaut.png", "coffee.png", "chelsea.png", "rocket.png", "flat-graphic.png"]


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="vector-studio-real-images-") as temporary:
        temp = Path(temporary)
        manifest = []
        originals: dict[str, np.ndarray] = {}
        for name in IMAGES:
            source = Image.open(FIXTURES / name).convert("RGBA")
            width, height = source.size
            raw_name = f"{Path(name).stem}.rgba"
            source.save(temp / f"{Path(name).stem}.png")
            (temp / raw_name).write_bytes(source.tobytes())
            manifest.append({"name": Path(name).stem, "width": width, "height": height, "raw": raw_name})
            originals[Path(name).stem] = np.asarray(source.convert("RGB"), dtype=np.uint8)
        (temp / "manifest.json").write_text(json.dumps(manifest))
        process = subprocess.run(
            ["node", str(ROOT / "tests" / "real-image-regression.mjs"), str(temp)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        records = json.loads(process.stdout)
        print("Real-image hybrid tracing regression (CPU engine + GPU LUT reference)")
        print("Image              Size         Colors  Paths  Vector%  Quant PSNR  SVG PSNR  SSIM    Time")
        all_ok = True
        for item in records:
            name = item["image"]
            vector_svg = (temp / "svg" / f"{name}.svg").read_text()
            svg_start = vector_svg.find('<svg')
            body_start = vector_svg.find('>', svg_start) + 1
            vector_body = vector_svg[body_start:vector_svg.rfind('</svg>')]
            original_png = (temp / f"{name}.png").read_bytes()
            embedded = base64.b64encode(original_png).decode("ascii")
            width, height = map(int, item["dimensions"].split("x"))
            hybrid_svg = (
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
                f'viewBox="0 0 {width} {height}">'
                f'<image x="0" y="0" width="{width}" height="{height}" '
                f'href="data:image/png;base64,{embedded}" preserveAspectRatio="none"/>'
                f'{vector_body}</svg>'
            )
            rendered = cairosvg.svg2png(bytestring=hybrid_svg.encode("utf-8"), output_width=width, output_height=height)
            rendered_path = temp / f"{name}-rendered.png"
            rendered_path.write_bytes(rendered)
            candidate = np.asarray(Image.open(rendered_path).convert("RGB"), dtype=np.uint8)
            reference = originals[name]
            psnr = peak_signal_noise_ratio(reference, candidate, data_range=255)
            ssim = structural_similarity(reference, candidate, channel_axis=2, data_range=255)
            passed = bool(item["lutMatchesCpu"] and item["paths"] > 0 and np.isfinite(psnr) and ssim > 0.85)
            all_ok &= passed
            print(
                f'{name:18} {item["dimensions"]:12} {item["colours"]:7} {item["paths"]:6} '
                f'{item["vectorPercent"]:7.2f} {item["quantPsnrDb"]:9.2f} '
                f'{psnr:8.2f} {ssim:6.4f} {item["traceSeconds"]:6.2f}s'
            )
            if not passed:
                print(f"  FAILED: LUT equivalence, path generation, or SSIM threshold for {name}")
        print(f"\n{len(records)} real images traced; LUT/CPU palette assignments matched.")
        return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
