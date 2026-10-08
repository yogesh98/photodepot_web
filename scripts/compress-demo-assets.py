#!/usr/bin/env python3
"""Publish small MP4 camera tours and lossless WebP posters from retained masters.

Requires Pillow, ffmpeg, ffprobe, and cwebp. The original screenshot camera path,
dimensions, and 50fps timing are reused without a GIF palette conversion.
Usage: python3 scripts/compress-demo-assets.py [--features workflow-ingest ...]
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "public/screenshots"
SOURCE_DIR = OUTPUT_DIR / "demo-source"
SOURCE_MANIFEST = SOURCE_DIR / "animation-manifest.json"
SOURCE_REPORT = SOURCE_DIR / "animation-report.json"
COMPRESSION_REPORT = SOURCE_DIR / "compression-report.json"
ASSET_MANIFEST = ROOT / "components/landing/demo-assets.json"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_renderer():
    # Import functions only; the original GIF command never runs on import.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(
        "photodepot_demo_renderer", ROOT / "scripts/generate-demo-gifs.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def encode_video(renderer, source, cameras, size, frame_ms, output, ffmpeg, crf):
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
               "-f", "rawvideo", "-pixel_format", "rgb24",
               "-video_size", f"{size[0]}x{size[1]}",
               "-framerate", str(1000 // frame_ms), "-i", "pipe:0",
               "-an", "-c:v", "libx264", "-preset", "slow", "-crf", str(crf),
               "-threads", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
               "-map_metadata", "-1", str(output)]
    # Stream rendered frames to bound memory, including exact repeated holds.
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=errors)
        try:
            for camera in cameras:
                process.stdin.write(renderer.render(source, camera, size).tobytes())
            process.stdin.close()
            returncode = process.wait()
        except BaseException:
            process.kill()
            process.wait()
            errors.seek(0)
            diagnostic = errors.read().decode()
            if diagnostic:
                raise RuntimeError(diagnostic)
            raise
        if returncode:
            errors.seek(0)
            raise RuntimeError(errors.read().decode())


def inspect_video(path, ffprobe, size, expected_frames, frame_ms):
    result = subprocess.run(
        [ffprobe, "-v", "error", "-count_frames", "-show_streams", "-show_format",
         "-of", "json", str(path)], capture_output=True, text=True, check=True)
    probe = json.loads(result.stdout)
    if len(probe["streams"]) != 1:
        raise ValueError(f"Expected one silent video stream: {path.name}")
    video = probe["streams"][0]
    expected_duration_ms = expected_frames * frame_ms
    dimensions = [video["width"], video["height"]]
    if video["codec_name"] != "h264" or video["pix_fmt"] != "yuv420p":
        raise ValueError(f"Unexpected video codec or pixel format: {path.name}")
    if dimensions != list(size) or int(video["nb_read_frames"]) != expected_frames:
        raise ValueError(f"Video dimensions or frame count changed: {path.name}")
    if Fraction(video["avg_frame_rate"]) != Fraction(1000, frame_ms):
        raise ValueError(f"Video cadence changed: {path.name}")
    for duration in (video["duration"], probe["format"]["duration"]):
        if abs(Fraction(duration) * 1000 - expected_duration_ms) > Fraction(1, 1000):
            raise ValueError(f"Video duration changed: {path.name}")
    # Metadata precedes media data so playback starts before download completes.
    contents = path.read_bytes()
    if not 0 <= contents.find(b"moov") < contents.find(b"mdat"):
        raise ValueError(f"MP4 faststart metadata missing: {path.name}")
    return {"dimensions": dimensions, "frames": expected_frames,
            "duration_ms": expected_duration_ms, "motion_frame_ms": frame_ms,
            "motion_fps": 1000 // frame_ms, "codec": "h264",
            "pixel_format": "yuv420p", "audio_streams": 0, "faststart": True}


def compress_poster(poster, output, cwebp):
    subprocess.run([cwebp, "-quiet", "-lossless", "-exact", "-m", "6",
                    "-metadata", "none", str(poster), "-o", str(output)], check=True)
    with Image.open(poster) as before, Image.open(output) as after:
        before, after = before.convert("RGBA"), after.convert("RGBA")
        # RGBA getbbox can miss RGB differences when the alpha difference is 0.
        if (before.size != after.size
                or ImageChops.difference(before.convert("RGB"), after.convert("RGB")).getbbox()
                or ImageChops.difference(before.getchannel("A"), after.getchannel("A")).getbbox()):
            raise ValueError(f"Lossless poster changed pixels: {poster.name}")
        return list(before.size)


def publish(path, name):
    digest = sha256(path)
    target = OUTPUT_DIR / f"{name}.{digest[:12]}{path.suffix}"
    path.replace(target)
    return target, digest


def contact_sheet(renderer, source, cameras, size, feature, frame_ms, video, ffmpeg, path):
    """Compare each camera hold against decoded output for visual review."""
    thumbnail = (384, 240)
    row_height = thumbnail[1] + 34
    sheet = Image.new("RGB", (thumbnail[0] * 2, row_height * len(feature["views"])), "#ece9e1")
    draw = ImageDraw.Draw(sheet)
    elapsed_ms = 0
    for row, view in enumerate(feature["views"]):
        elapsed_ms += view.get("move_ms", 0)
        frame = min(elapsed_ms // frame_ms, len(cameras) - 1)
        with tempfile.TemporaryDirectory(prefix="photodepot-frame-") as work:
            decoded_path = Path(work) / "frame.png"
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                            "-i", str(video), "-vf", f"select='eq(n,{frame})'",
                            "-frames:v", "1", str(decoded_path)], check=True)
            native = renderer.render(source, cameras[frame], size)
            with Image.open(decoded_path) as decoded:
                for column, image in enumerate((native, decoded)):
                    sheet.paste(image.resize(thumbnail, Image.Resampling.LANCZOS),
                                (column * thumbnail[0], row * row_height))
            caption_y = row * row_height + thumbnail[1] + 10
            draw.text((12, caption_y), f"Source: {view['label']}", fill="#171717")
            draw.text((thumbnail[0] + 12, caption_y), "Compressed MP4", fill="#171717")
        elapsed_ms += view["hold_ms"]
    sheet.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--features", nargs="+", help="Regenerate only these demo names")
    parser.add_argument("--crf", type=int, default=20, help="H.264 quality (default: 20)")
    parser.add_argument("--qa-dir", type=Path, default=Path("/private/tmp/photodepot-compressed-demo-qa"))
    args = parser.parse_args()
    if not 0 <= args.crf <= 51:
        parser.error("--crf must be between 0 and 51")
    binaries = {name: shutil.which(name) for name in ("ffmpeg", "ffprobe", "cwebp")}
    if not all(binaries.values()):
        parser.error("ffmpeg, ffprobe, and cwebp must be on PATH")
    spec = json.loads(SOURCE_MANIFEST.read_text())
    masters = json.loads(SOURCE_REPORT.read_text())
    if args.features and set(args.features) - spec["features"].keys():
        parser.error("Unknown feature name")
    size, frame_ms = tuple(spec["output_size"]), spec["frame_ms"]
    if size != (768, 480) or frame_ms != 20:
        raise ValueError("Expected the retained 768x480, 50fps camera tours")
    renderer = load_renderer()
    assets = json.loads(ASSET_MANIFEST.read_text())
    report = json.loads(COMPRESSION_REPORT.read_text()) if COMPRESSION_REPORT.exists() else {}
    args.qa_dir.mkdir(parents=True, exist_ok=True)
    encoder_version = subprocess.run([binaries["ffmpeg"], "-version"], capture_output=True,
                                     text=True, check=True).stdout.splitlines()[0]
    for name, feature in spec["features"].items():
        if args.features and name not in args.features:
            continue
        print(json.dumps({"feature": name, "status": "encoding"}), flush=True)
        master = masters[name]
        source_path = SOURCE_DIR / feature["source"]
        gif, poster = OUTPUT_DIR / master["output"], OUTPUT_DIR / master["poster"]
        source_hash, gif_hash, poster_hash = sha256(source_path), sha256(gif), sha256(poster)
        if (source_hash != master["source_sha256"] or gif_hash != master["output_sha256"]
                or poster_hash != master["poster_sha256"]):
            raise ValueError(f"Retained master checksum changed: {name}")
        with Image.open(source_path) as image:
            source = image.convert("RGB")
        renderer.validate(feature, source, size, frame_ms)
        cameras = renderer.camera_frames(feature, frame_ms)
        if ImageChops.difference(renderer.render(source, cameras[0], size),
                                 renderer.render(source, cameras[-1], size)).getbbox():
            raise ValueError(f"Original camera loop changes pixels: {name}")
        original = renderer.inspect_gif(gif, frame_ms, len(cameras))
        with tempfile.TemporaryDirectory(prefix="photodepot-mp4-") as work:
            animation, still = Path(work) / "animation.mp4", Path(work) / "poster.webp"
            encode_video(renderer, source, cameras, size, frame_ms, animation,
                         binaries["ffmpeg"], args.crf)
            encoded = inspect_video(animation, binaries["ffprobe"], size, len(cameras), frame_ms)
            poster_dimensions = compress_poster(poster, still, binaries["cwebp"])
            if animation.stat().st_size >= gif.stat().st_size:
                raise ValueError(f"Video compression did not reduce size: {name}")
            if sha256(source_path) != source_hash:
                raise ValueError(f"Source screenshot changed during encoding: {name}")
            contact_sheet(renderer, source, cameras, size, feature, frame_ms, animation,
                          binaries["ffmpeg"], args.qa_dir / f"{name}-comparison.png")
            animation_path, animation_hash = publish(animation, name)
            poster_path, compressed_poster_hash = publish(still, f"{name}-poster")
        camera_spec = {"output_size": list(size), "frame_ms": frame_ms, "views": feature["views"]}
        report[name] = {
            "source": feature["source"], "source_sha256": source_hash,
            "source_camera_path_sha256": hashlib.sha256(json.dumps(camera_spec, sort_keys=True).encode()).hexdigest(),
            "source_loop_boundary_identical": True,
            "source_gif": gif.name, "source_gif_sha256": gif_hash,
            "source_gif_frames": original["frames"], "original_bytes": gif.stat().st_size,
            "output": animation_path.name, "output_sha256": animation_hash,
            "bytes": animation_path.stat().st_size,
            "encoding": {"encoder": "libx264", "preset": "slow", "crf": args.crf,
                         "threads": 2, "input": "native screenshot RGB camera frames",
                         "ffmpeg_version": encoder_version}, **encoded,
            "source_poster": poster.name, "source_poster_sha256": poster_hash,
            "original_poster_bytes": poster.stat().st_size,
            "poster": poster_path.name, "poster_sha256": compressed_poster_hash,
            "poster_bytes": poster_path.stat().st_size, "poster_dimensions": poster_dimensions,
            "poster_lossless": True, "poster_pixels_identical": True,
        }
        assets[name] = {"video": f"/screenshots/{animation_path.name}",
                        "poster": f"/screenshots/{poster_path.name}"}
        print(json.dumps({"feature": name, "before_bytes": gif.stat().st_size,
                          "after_bytes": animation_path.stat().st_size,
                          "poster_before_bytes": poster.stat().st_size,
                          "poster_after_bytes": poster_path.stat().st_size}), flush=True)
    # References change only after every selected file has passed validation.
    COMPRESSION_REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    ASSET_MANIFEST.write_text(json.dumps(assets, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
