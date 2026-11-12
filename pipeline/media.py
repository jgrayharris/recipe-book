"""Video and image work: stills, the audio transcript, and the photos the book shows.

Uses ffmpeg (a command-line video tool, preinstalled on GitHub's runners) and
faster-whisper (speech-to-text that runs on the runner's own CPU, so it's free).
Everything here degrades gracefully: no ffmpeg means no stills or transcript.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

FRAME_WIDTH = 540      # stills sent to the chef
PHOTO_WIDTH = 900      # the recipe page photo
THUMB_WIDTH = 420      # the browsing grid photo
MAX_TRANSCRIBE_SECONDS = 20 * 60


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=600)


def duration(video: Path) -> float:
    out = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1", str(video)])
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def to_jpg(src: Path, dst: Path, width: int, at: float | None = None) -> Path | None:
    """Save an image (or the video frame at `at` seconds) as a JPEG no wider than `width`."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not have_ffmpeg():
        if at is None and Path(src).suffix.lower() in (".jpg", ".jpeg"):
            shutil.copyfile(src, dst)  # can't resize without ffmpeg; keep the original
            return dst
        return None
    args = ["ffmpeg", "-y", "-loglevel", "error"]
    if at is not None:
        args += ["-ss", f"{at:.2f}"]
    args += ["-i", str(src), "-frames:v", "1",
             "-vf", f"scale='min({width},iw)':-2", "-q:v", "3", str(dst)]
    out = _run(args)
    return dst if out.returncode == 0 and dst.exists() else None


def extract_frames(video: Path, outdir: Path, count: int) -> list[Path]:
    """`count` stills spread across the video, plus one near the very end (the finished dish)."""
    length = duration(video)
    if length <= 0:
        return []
    times = [length * (i + 0.5) / count for i in range(count)]
    times.append(max(0.0, length - 0.6))
    frames = []
    for i, t in enumerate(times, start=1):
        f = to_jpg(video, outdir / f"frame-{i}.jpg", 720, at=t)
        if f:
            frames.append(f)
    return frames


def transcribe(video: Path, workdir: Path) -> str:
    if not have_ffmpeg():
        return ""
    audio = workdir / "audio.wav"
    out = _run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-vn", "-ac", "1",
                "-ar", "16000", "-t", str(MAX_TRANSCRIBE_SECONDS), str(audio)])
    if out.returncode != 0 or not audio.exists():
        return ""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return ""
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8")
    segments, _info = model.transcribe(str(audio), vad_filter=True, beam_size=1)
    return " ".join(s.text.strip() for s in segments).strip()


def prepare_media(src: dict, workdir: Path) -> list[tuple[str, Path]]:
    """Fill in the transcript and return the labelled images the chef will see.

    Labels match chef_instructions.md: cover, frame-N, image-N.
    """
    labelled: list[tuple[str, Path]] = []
    chef_dir = workdir / "chef"
    if src.get("cover"):
        p = to_jpg(Path(src["cover"]), chef_dir / "cover.jpg", FRAME_WIDTH)
        if p:
            labelled.append(("cover", p))
    for i, path in enumerate(src.get("images") or [], start=1):
        p = to_jpg(Path(path), chef_dir / f"image-{i}.jpg", FRAME_WIDTH)
        if p:
            labelled.append((f"image-{i}", p))
    video = Path(src["video"]) if src.get("video") else None
    if video and have_ffmpeg():
        src["transcript"] = transcribe(video, workdir)
        words = len(src["transcript"].split())
        count = 8 if words >= 40 else 14   # little talking: the recipe is probably on screen
        for f in extract_frames(video, workdir / "frames", count):
            p = to_jpg(f, chef_dir / f.name, FRAME_WIDTH)
            if p:
                labelled.append((f.stem, p))
    elif video:
        src["notes"].append("ffmpeg isn't installed, so no stills or transcript")
    return labelled


def originals(workdir: Path) -> dict[str, Path]:
    """Full-size versions of each labelled image, for the photo the book shows."""
    out = {}
    for p in (workdir / "frames").glob("frame-*.jpg"):
        out[p.stem] = p
    for p in workdir.glob("cover.*"):
        out["cover"] = p
    for p in workdir.glob("image-*.*"):
        out[p.stem] = p
    return out


def save_photo(original: Path, recipe_id: str, images_dir: Path) -> bool:
    big = to_jpg(original, images_dir / f"{recipe_id}.jpg", PHOTO_WIDTH)
    small = to_jpg(original, images_dir / f"{recipe_id}-sm.jpg", THUMB_WIDTH)
    return bool(big and small)
