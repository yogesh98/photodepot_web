#!/usr/bin/env python3
"""Make honest app-feature camera animations from retained screenshots.

Requires Pillow. Use the bundled workspace Python runtime or another Python with
Pillow installed. Default outputs are ../ai-FEATURE.gif and ../ai-FEATURE-poster.png.
The JSON manifest records every crop rectangle and timing. Crops always preserve
the output aspect ratio; the source UI and photo pixels are never rearranged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def ease(progress: float) -> float:
    return progress * progress * (3.0 - 2.0 * progress)


def interpolate(a: tuple[float, ...], b: tuple[float, ...], p: float) -> tuple[float, ...]:
    return tuple(x + (y - x) * ease(p) for x, y in zip(a, b))


def render(source: Image.Image, rect: tuple[float, ...], size: tuple[int, int]) -> Image.Image:
    # EXTENT accepts fractional source coordinates, keeping camera motion smooth.
    return source.transform(size, Image.Transform.EXTENT, rect, Image.Resampling.BICUBIC)


def validate_rect(rect: tuple[float, ...], source_size: tuple[int, int], size: tuple[int, int]) -> None:
    left, top, right, bottom = rect
    if min(left, top) < 0 or right > source_size[0] or bottom > source_size[1]:
        raise ValueError(f"Camera rectangle leaves source: {rect}")
    if not math.isclose((right - left) / (bottom - top), size[0] / size[1], abs_tol=0.0001):
        raise ValueError(f"Camera rectangle has wrong aspect ratio: {rect}")


def build_frames(source: Image.Image, feature: dict, spec: dict):
    size = tuple(spec["output_size"])
    wide = (0.0, 0.0, float(source.width), float(source.height))
    detail = tuple(feature["detail_rect"])
    second = tuple(feature["second_detail_rect"]) if "second_detail_rect" in feature else None
    for rect in (wide, detail, second):
        if rect:
            validate_rect(rect, source.size, size)
    frames, durations, cameras = [], [], []

    def append(rect, duration):
        frames.append(render(source, rect, size))
        durations.append(duration)
        cameras.append(rect)

    def move(start, end, duration):
        count = round(duration / spec["frame_ms"])
        for i in range(1, count + 1):
            append(interpolate(start, end, i / count), spec["frame_ms"])

    append(wide, spec["wide_hold_ms"])
    move(wide, detail, spec["zoom_ms"])
    detail_index = len(frames) - 1
    durations[-1] += feature.get("detail_hold_ms", spec["detail_hold_ms"])
    if second:
        move(detail, second, feature["pan_ms"])
        second_index = len(frames) - 1
        durations[-1] += feature["second_detail_hold_ms"]
    else:
        second_index = None
    move(second or detail, wide, spec["return_ms"])
    return frames, durations, cameras, detail_index, second_index


def global_palette(frames: list[Image.Image], colors: int, preserved: list[tuple[int, int, int]]) -> Image.Image:
    sampled = frames[::max(1, len(frames) // 12)]
    swatches = [frame.resize((240, 158), Image.Resampling.LANCZOS) for frame in sampled]
    montage = Image.new("RGB", (240 * len(swatches), 158))
    for i, swatch in enumerate(swatches):
        montage.paste(swatch, (240 * i, 0))
    # Reserve a few observed source colors so a photographic palette does not
    # turn native selection outlines or black/white controls into nearby tones.
    preserved = list(dict.fromkeys(preserved))
    palette = montage.quantize(colors=colors - len(preserved), method=Image.Quantize.MEDIANCUT)
    entries = palette.getpalette()[:3 * (colors - len(preserved))]
    entries.extend(channel for color in preserved for channel in color)
    entries.extend([0] * (768 - len(entries)))
    palette.putpalette(entries)
    return palette


def encode(frames, durations, target: Path, colors: int, preserved=()) -> None:
    palette = global_palette(frames, colors, list(preserved))
    indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    indexed[0].save(
        target, save_all=True, append_images=indexed[1:], duration=durations,
        loop=0, disposal=1, optimize=True,
    )


def contact_sheet(frames, cameras, spec, detail_index, second_index, target):
    indices = [0, max(1, detail_index // 2), detail_index]
    labels = ["Wide / start", "Zoom / middle", "First detail"]
    if second_index is not None:
        indices.append(second_index)
        labels.append("Second feature detail")
    indices.append(len(frames) - 1)
    labels.append("Return / loop")
    width, height = 384, 252
    result = Image.new("RGB", (width * len(indices), height + 34), "#ece9e1")
    draw = ImageDraw.Draw(result)
    font = ImageFont.load_default(size=13)
    for col, (index, label) in enumerate(zip(indices, labels)):
        result.paste(frames[index].resize((width, height), Image.Resampling.LANCZOS), (col * width, 0))
        draw.text((col * width + 10, height + 10), label, fill="#171717", font=font)
    result.save(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("animation-manifest.json"))
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--qa-dir", type=Path, default=Path("/private/tmp/photodepot-ai-gif-qa"))
    parser.add_argument("--features", nargs="*", help="Generate only these feature IDs")
    args = parser.parse_args()
    spec = json.loads(args.manifest.read_text())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.qa_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for name, feature in spec["features"].items():
        if args.features and name not in args.features:
            continue
        source_path = args.manifest.parent / feature["source"]
        source = Image.open(source_path).convert("RGB")
        frames, durations, cameras, detail_index, second_index = build_frames(source, feature, spec)
        preserved = [source.getpixel(tuple(point)) for point in feature.get("palette_source_samples", [])]
        target = args.output_dir / f"ai-{name}.gif"
        for colors in spec["palette_colors"]:
            encode(frames, durations, target, colors, preserved)
            if target.stat().st_size <= spec["max_bytes"]:
                break
        poster = args.output_dir / f"ai-{name}-poster.png"
        poster_size = tuple(spec.get("poster_size", spec["output_size"]))
        poster_stage = feature.get("poster_stage", "first")
        if poster_stage not in ("first", "second") or (poster_stage == "second" and second_index is None):
            raise ValueError(f"Invalid poster stage for {name}: {poster_stage}")
        poster_index = second_index if poster_stage == "second" else detail_index
        render(source, cameras[poster_index], poster_size).save(poster, optimize=True)
        qa = args.qa_dir / f"ai-{name}-contact.png"
        check = Image.open(target)
        encoded_durations = []
        for index in range(check.n_frames):
            check.seek(index)
            encoded_durations.append(check.info.get("duration", 0))
        # Inspect the encoded colors and playback, rather than just RGB input.
        decoded = []
        elapsed = 0
        encoded_index = 0
        encoded_end = encoded_durations[0]
        for duration in durations:
            sample_time = elapsed + duration / 2
            while sample_time >= encoded_end and encoded_index < check.n_frames - 1:
                encoded_index += 1
                encoded_end += encoded_durations[encoded_index]
            check.seek(encoded_index)
            decoded.append(check.convert("RGB"))
            elapsed += duration
        contact_sheet(decoded, cameras, spec, detail_index, second_index, qa)
        for label, index in [("wide", 0), ("middle", max(1, detail_index // 2)),
                             ("detail", detail_index), ("return", len(decoded) - 1)]:
            decoded[index].save(args.qa_dir / f"ai-{name}-{label}.png")
        if second_index is not None:
            decoded[second_index].save(args.qa_dir / f"ai-{name}-second-detail.png")
        item = {
            "feature": name, "source": feature["source"],
            "source_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
            "output": str(target), "poster": str(poster), "qa": str(qa),
            "dimensions": list(check.size), "bytes": target.stat().st_size,
            "poster_dimensions": list(poster_size), "poster_bytes": poster.stat().st_size,
            "poster_stage": poster_stage, "poster_rect": list(cameras[poster_index]),
            "palette_colors": colors, "frames": check.n_frames,
            "preserved_source_colors": [list(color) for color in preserved],
            "duration_ms": sum(encoded_durations), "loop": check.info.get("loop"),
            "first_detail_rect": list(cameras[detail_index]),
            "second_detail_rect": list(cameras[second_index]) if second_index is not None else None,
        }
        results.append(item)
        print(json.dumps(item), flush=True)
    (args.output_dir / "local-ai-source" if args.output_dir == Path(__file__).resolve().parent.parent else args.output_dir).mkdir(exist_ok=True)
    report_dir = args.output_dir / "local-ai-source" if args.output_dir == Path(__file__).resolve().parent.parent else args.output_dir
    (report_dir / "animation-report.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
