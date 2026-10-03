#!/usr/bin/env python3
"""Render smooth, reproducible camera tours over native light-mode screenshots.

Requires Pillow, ffmpeg, and gifsicle. Source pixels, UI results, and photographs are never
retouched. All camera coordinates remain fractional until Lanczos resampling.
Usage: python3 scripts/generate-demo-gifs.py [--features workflow-ingest ...]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "public/screenshots/demo-source"
OUTPUT_DIR = ROOT / "public/screenshots"
ASSET_MANIFEST = ROOT / "components/landing/demo-assets.json"


def publish_assets(name, output, poster, entry):
    # The URL changes whenever the encoded bytes change, so a browser cannot
    # reuse media from an earlier release under the new filename.
    output_hash = hashlib.sha256(output.read_bytes()).hexdigest()
    poster_hash = hashlib.sha256(poster.read_bytes()).hexdigest()
    versioned_output = output.with_name(f"{name}.{output_hash[:12]}.gif")
    versioned_poster = poster.with_name(f"{name}-poster.{poster_hash[:12]}.png")
    if output != versioned_output:
        output.replace(versioned_output)
    if poster != versioned_poster:
        poster.replace(versioned_poster)
    return {**entry, "output": versioned_output.name, "poster": versioned_poster.name,
            "output_sha256": output_hash, "poster_sha256": poster_hash}


def save_report_and_assets(report, report_path):
    # Publish references only after their files exist. Partial regeneration
    # retains the report and URL entries for every untouched demo.
    assets = {name: {"image": f"/screenshots/{entry['output']}",
                     "poster": f"/screenshots/{entry['poster']}"}
              for name, entry in report.items()}
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    ASSET_MANIFEST.write_text(json.dumps(assets, indent=2, sort_keys=True) + "\n")


def ease(t):
    # Quintic smoothstep has zero velocity AND acceleration at both ends.
    return t * t * t * (t * (t * 6 - 15) + 10)


def camera_frames(feature, frame_ms):
    views = feature["views"]
    frames = [tuple(views[0]["rect"])] * (views[0]["hold_ms"] // frame_ms)
    for previous, view in zip(views, views[1:]):
        start, end = previous["rect"], view["rect"]
        count = view["move_ms"] // frame_ms
        for i in range(1, count + 1):
            t = ease(i / count)
            frames.append(tuple(a + (b - a) * t for a, b in zip(start, end)))
        frames.extend([tuple(end)] * (view["hold_ms"] // frame_ms))
    if frames[0] != frames[-1]:
        raise ValueError("Every tour must return to its exact opening camera")
    return frames


def render(source, rect, size):
    return source.resize(size, Image.Resampling.LANCZOS, box=rect)


def make_palette(source, cameras, size, target):
    # One palette for the entire loop prevents frame-to-frame color flicker.
    sample_count = 24
    sample_size = (240, 150)
    samples = Image.new("RGB", (240 * 6, 150 * 4), "white")
    for i in range(sample_count):
        camera = cameras[round(i * (len(cameras) - 1) / (sample_count - 1))]
        samples.paste(render(source, camera, sample_size), ((i % 6) * 240, (i // 6) * 150))
    # Keep the native white canvas, black lettering, grays, and selection gold.
    reserved = [(255, 255, 255), (0, 0, 0), (26, 26, 26), (51, 51, 51),
                (128, 128, 128), (245, 245, 245), (250, 250, 250), (181, 139, 30)]
    palette = samples.quantize(colors=256 - len(reserved), method=Image.Quantize.MEDIANCUT)
    entries = palette.getpalette()[:3 * (256 - len(reserved))]
    entries += [channel for color in reserved for channel in color]
    strip = Image.new("RGB", (16, 16))
    strip.putdata([tuple(entries[i:i + 3]) for i in range(0, 768, 3)])
    strip.save(target)


def validate(feature, source, size, frame_ms):
    if not feature["source"].endswith("-light.png"):
        raise ValueError("Only supplied light-mode screenshots may be used")
    for view in feature["views"]:
        left, top, right, bottom = view["rect"]
        if not (0 <= left < right <= source.width and 0 <= top < bottom <= source.height):
            raise ValueError(f"Camera leaves source pixels: {view['rect']}")
        if not math.isclose((right - left) / (bottom - top), size[0] / size[1], abs_tol=0.0001):
            raise ValueError(f"Camera aspect ratio mismatch: {view['rect']}")
        for duration in (view.get("move_ms", 0), view["hold_ms"]):
            if duration % frame_ms:
                raise ValueError("Timings must be exact multiples of the GIF frame delay")


def encode(source, cameras, size, palette, output, ffmpeg, frame_ms):
    # GIF delays have centisecond precision. A constant 20ms/50fps cadence avoids
    # the alternating 10/20ms frame delays required to approximate 60fps.
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-threads", "2",
               "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{size[0]}x{size[1]}",
               "-framerate", str(1000 // frame_ms), "-i", "pipe:0", "-i", str(palette),
               "-filter_complex", "[0:v][1:v]paletteuse=dither=none:diff_mode=rectangle",
               "-filter_complex_threads", "1", "-an", "-loop", "0", "-final_delay", str(frame_ms // 10),
               "-gifflags", "+offsetting+transdiff", str(output)]
    # Streaming bounds memory even at 50fps; no array of hundreds of RGB frames.
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=errors)
        try:
            for camera in cameras:
                process.stdin.write(render(source, camera, size).tobytes())
            process.stdin.close()
            returncode = process.wait()
        except BaseException:
            process.kill()
            process.wait()
            errors.seek(0)
            raise RuntimeError(errors.read().decode())
        if returncode:
            errors.seek(0)
            raise RuntimeError(errors.read().decode())


def compress_gif(path, gifsicle, lossiness):
    with tempfile.TemporaryDirectory(prefix="photodepot-compress-") as work:
        compressed = Path(work) / "compressed.gif"
        subprocess.run([gifsicle, "-O3", f"--lossy={lossiness}", str(path), "-o", str(compressed)], check=True)
        # Lossy delta compression can choose slightly different colors on the
        # return. Replace the last hold with the exact decoded opening frame,
        # then optimize losslessly so the loop has no pixel jump whatsoever.
        with Image.open(compressed) as gif:
            first = gif.convert("RGB").quantize(colors=256)
            gif.seek(gif.n_frames - 1)
            closing_delay = gif.info["duration"] // 10
            last_index = gif.n_frames - 2
        closing = Path(work) / "closing.gif"
        first.save(closing, optimize=False, duration=closing_delay * 10)
        subprocess.run([gifsicle, "-O3", "--loopcount=0", str(compressed), f"#0-{last_index}",
                        f"--delay={closing_delay}", str(closing), "-o", str(path)], check=True)


def inspect_gif(path, frame_ms, expected_frames):
    durations = []
    with Image.open(path) as gif:
        first = gif.convert("RGB")
        for i in range(gif.n_frames):
            gif.seek(i)
            durations.append(gif.info["duration"])
        last = gif.convert("RGB")
        if any(duration < frame_ms or duration % frame_ms for duration in durations):
            raise ValueError(f"Uneven frame pacing in {path.name}")
        if sum(durations) != expected_frames * frame_ms or gif.info.get("loop") != 0:
            raise ValueError(f"Incorrect frame count or loop in {path.name}")
        if ImageChops.difference(first, last).getbbox():
            raise ValueError(f"Loop boundary changes pixels in {path.name}")
        return {"frames": gif.n_frames, "duration_ms": sum(durations), "loop": 0,
                "motion_frame_ms": frame_ms, "motion_fps": 1000 // frame_ms,
                "dimensions": list(gif.size), "bytes": path.stat().st_size,
                "loop_boundary_identical": True}


def contact_sheet(gif_path, feature, frame_ms, path):
    views = feature["views"]
    thumb = (384, 240)
    sheet = Image.new("RGB", (thumb[0] * len(views), thumb[1] + 34), "#ece9e1")
    draw = ImageDraw.Draw(sheet)
    timestamps, elapsed = [], 0
    for view in views:
        elapsed += view.get("move_ms", 0)
        timestamps.append(elapsed + min(frame_ms, view["hold_ms"]))
        elapsed += view["hold_ms"]
    with Image.open(gif_path) as gif:
        for col, (timestamp, view) in enumerate(zip(timestamps, views)):
            elapsed = 0
            for i in range(gif.n_frames):
                gif.seek(i)
                elapsed += gif.info["duration"]
                if elapsed > timestamp:
                    break
            sheet.paste(gif.convert("RGB").resize(thumb, Image.Resampling.LANCZOS), (thumb[0] * col, 0))
            draw.text((thumb[0] * col + 12, thumb[1] + 10), view["label"], fill="#171717")
    sheet.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=SOURCE_DIR / "animation-manifest.json")
    parser.add_argument("--features", nargs="*", help="Generate only these demo names")
    parser.add_argument("--qa-dir", type=Path, default=Path("/private/tmp/photodepot-demo-qa"))
    parser.add_argument("--gifsicle", default=shutil.which("gifsicle"), help="Path to gifsicle if not on PATH")
    parser.add_argument("--version-existing", action="store_true",
                        help="Version retained GIFs and posters without re-encoding their bytes")
    args = parser.parse_args()
    report_path = args.manifest.with_name("animation-report.json")
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    if args.version_existing:
        if not report:
            parser.error("--version-existing requires an existing animation report")
        for name, entry in list(report.items()):
            if args.features and name not in args.features:
                continue
            report[name] = publish_assets(name, OUTPUT_DIR / entry["output"],
                                          OUTPUT_DIR / entry["poster"], entry)
        save_report_and_assets(report, report_path)
        print(json.dumps({"versioned_features": list(report), "assets": str(ASSET_MANIFEST)}), flush=True)
        return
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        parser.error("ffmpeg must be on PATH")
    if not args.gifsicle:
        parser.error("gifsicle must be on PATH or passed with --gifsicle")
    spec = json.loads(args.manifest.read_text())
    size, frame_ms = tuple(spec["output_size"]), spec["frame_ms"]
    args.qa_dir.mkdir(parents=True, exist_ok=True)
    for name, feature in spec["features"].items():
        if args.features and name not in args.features:
            continue
        source_path = args.manifest.parent / feature["source"]
        source = Image.open(source_path).convert("RGB")
        validate(feature, source, size, frame_ms)
        cameras = camera_frames(feature, frame_ms)
        output = OUTPUT_DIR / f"{name}.gif"
        with tempfile.TemporaryDirectory(prefix="photodepot-gif-") as work:
            palette = Path(work) / "palette.png"
            make_palette(source, cameras, size, palette)
            encode(source, cameras, size, palette, output, ffmpeg, frame_ms)
        compress_gif(output, args.gifsicle, spec["lossy"])
        poster_view = feature["views"][feature["poster_view"]]
        poster_size = tuple(spec["poster_size"])
        poster = OUTPUT_DIR / f"{name}-poster.png"
        render(source, poster_view["rect"], poster_size).save(poster, optimize=True)
        contact_sheet(output, feature, frame_ms, args.qa_dir / f"{name}-contact.png")
        entry = {"source": feature["source"],
                 "source_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
                 "palette_colors": 256, "lossy": spec["lossy"],
                 "poster_dimensions": list(poster_size),
                 **inspect_gif(output, frame_ms, len(cameras))}
        report[name] = publish_assets(name, output, poster, entry)
        save_report_and_assets(report, report_path)
        print(json.dumps({"feature": name, **report[name]}), flush=True)


if __name__ == "__main__":
    main()
