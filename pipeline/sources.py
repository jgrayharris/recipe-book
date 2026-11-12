"""Gather everything a post says about a dish: caption, comments, video, images.

gather(url, workdir) returns a plain dict (the "source"). Nothing here calls the AI.
Each fetcher is best-effort: when one fails it adds a note and the next one tries.
"""
from __future__ import annotations

import html as htmllib
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

import requests

from common import VIDEO_PLATFORMS, canonical_url, platform_of

BROWSER_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
              "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
DESKTOP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
MAX_VIDEO_BYTES = 250 * 1024 * 1024
REDDIT_UA = "harris-recipe-book/1.0 (personal recipe saver)"
TIMEOUT = 25
MAX_TEXT = 12000


def new_source(url: str) -> dict:
    return {
        "url": url,
        "canonical_url": canonical_url(url),
        "platform": platform_of(url),
        "title": "",
        "author": "",
        "text": "",            # caption, description or post body
        "comments": [],        # creator's own comments first, then top comments
        "transcript": "",
        "structured": None,    # schema.org Recipe from a web page, trimmed
        "cover": None,         # local path of the cover/thumbnail image
        "images": [],          # local paths of photos in the post
        "video": None,         # local path of the downloaded video
        "duration": 0,
        "notes": [],           # what didn't work, for the issue comment
    }


def gather(url: str, workdir: Path) -> dict:
    workdir.mkdir(parents=True, exist_ok=True)
    src = new_source(url)
    platform = src["platform"]
    if platform == "reddit":
        _reddit(src, workdir)
    if platform == "tiktok":
        _tiktok_page(src, workdir)
    is_video = src.pop("is_video", False)   # set by _reddit for video posts
    slideshow = platform == "tiktok" and src["images"]
    if (platform in VIDEO_PLATFORMS or is_video) and not src["video"] and not slideshow:
        _ytdlp(src, workdir)
    if platform != "reddit" and not (src["text"] or src["structured"] or src["video"]):
        _webpage(src, workdir)
    src["text"] = src["text"][:MAX_TEXT]
    return src


# ---------- downloads ----------

def download(url: str, dest: Path, ua: str = BROWSER_UA) -> Path | None:
    try:
        r = requests.get(url, headers={"User-Agent": ua}, timeout=TIMEOUT)
        r.raise_for_status()
        ctype = r.headers.get("content-type", "")
        ext = ".png" if "png" in ctype else ".webp" if "webp" in ctype else ".jpg"
        path = dest.with_suffix(ext)
        path.write_bytes(r.content)
        return path
    except requests.RequestException:
        return None


# ---------- video sites (TikTok, Instagram, YouTube, Facebook, Reddit video) ----------

class _Quiet:
    """yt-dlp prints its own errors; we already record them as notes."""
    def debug(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass


def _ytdlp(src: dict, workdir: Path) -> None:
    try:
        import yt_dlp
    except ImportError:
        src["notes"].append("yt-dlp isn't installed")
        return
    opts = {
        "outtmpl": str(workdir / "video.%(ext)s"),
        "format": "best[height<=720][ext=mp4]/best[height<=720]/best",
        "quiet": True,
        "no_warnings": True,
        "logger": _Quiet(),
        "noplaylist": True,
        "max_filesize": 250 * 1024 * 1024,
        "socket_timeout": 30,
        "retries": 2,
    }
    info = None
    for download_video in (True, False):
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(src["url"], download=download_video)
            break
        except Exception as e:  # yt-dlp raises many kinds; any failure means "try the next way"
            src["notes"].append(f"video {'download' if download_video else 'info'} failed: {str(e)[:160]}")
    if not info:
        return
    if info.get("_type") == "playlist":  # carousels: use the post's text, first video entry
        entries = [e for e in (info.get("entries") or []) if e]
        first = next((e for e in entries if e.get("duration")), entries[0] if entries else {})
        info = {**first, "description": info.get("description") or first.get("description")}
    src["title"] = src["title"] or (info.get("title") or "")
    src["author"] = src["author"] or (info.get("uploader") or info.get("channel") or info.get("uploader_id") or "")
    desc = info.get("description") or ""
    if desc and desc not in src["text"]:
        src["text"] = (src["text"] + "\n\n" + desc).strip()
    src["duration"] = int(info.get("duration") or 0)
    if info.get("webpage_url"):
        src["canonical_url"] = canonical_url(info["webpage_url"])
    files = sorted(p for p in workdir.glob("video.*") if p.suffix not in (".part", ".ytdl"))
    if files:
        src["video"] = str(files[0])
    thumb = info.get("thumbnail")
    if thumb and not src["cover"]:
        path = download(thumb, workdir / "cover")
        src["cover"] = str(path) if path else None


def _tiktok_page(src: dict, workdir: Path) -> None:
    """TikTok's own page carries the post as JSON: caption, creator, cover, video or slideshow."""
    session = requests.Session()   # the video link only works with the page's cookies
    session.headers.update({"User-Agent": DESKTOP_UA, "Accept-Language": "en-US,en"})
    try:
        r = session.get(src["url"], timeout=TIMEOUT)
        r.raise_for_status()
        m = re.search(r'<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', r.text, re.S)
        scope = json.loads(m.group(1))["__DEFAULT_SCOPE__"] if m else {}
        item = next((v["itemInfo"]["itemStruct"] for v in scope.values()
                     if isinstance(v, dict) and (v.get("itemInfo") or {}).get("itemStruct")), None)
    except (requests.RequestException, ValueError, KeyError) as e:
        src["notes"].append(f"TikTok page failed: {str(e)[:120]}")
        return
    if not item:
        src["notes"].append("TikTok page had no post data")
        return
    src["canonical_url"] = canonical_url(r.url)
    src["text"] = item.get("desc", "")
    author = item.get("author") or {}
    src["author"] = f"@{author['uniqueId']}" if author.get("uniqueId") else author.get("nickname", "")
    video = item.get("video") or {}
    src["duration"] = int(video.get("duration") or 0)
    cover = video.get("originCover") or video.get("cover")
    if cover:
        p = download(cover, workdir / "cover", DESKTOP_UA)
        src["cover"] = str(p) if p else None
    slides = ((item.get("imagePost") or {}).get("images")) or []
    for i, slide in enumerate(slides[:8], start=1):   # a photo slideshow instead of a video
        urls = (slide.get("imageURL") or {}).get("urlList") or []
        p = download(urls[0], workdir / f"image-{i}", DESKTOP_UA) if urls else None
        if p:
            src["images"].append(str(p))
    play = video.get("playAddr") or video.get("downloadAddr")
    if play and not slides:
        try:
            with session.get(play, headers={"Referer": "https://www.tiktok.com/"}, timeout=90, stream=True) as v:
                v.raise_for_status()
                path, size = workdir / "video.mp4", 0
                with open(path, "wb") as f:
                    for chunk in v.iter_content(1 << 20):
                        size += len(chunk)
                        if size > MAX_VIDEO_BYTES:
                            raise ValueError("video is too big")
                        f.write(chunk)
            src["video"] = str(path)
        except (requests.RequestException, ValueError, OSError) as e:
            src["notes"].append(f"TikTok video download failed: {str(e)[:120]}")


# ---------- Reddit ----------

def _reddit(src: dict, workdir: Path) -> None:
    url = src["url"]
    try:  # share links (/s/abc, redd.it) redirect to the real post
        if "/s/" in url or "redd.it" in urlparse(url).netloc:
            url = requests.get(url, headers={"User-Agent": BROWSER_UA}, timeout=TIMEOUT,
                               allow_redirects=True).url
            src["canonical_url"] = canonical_url(url)
    except requests.RequestException:
        pass
    path = urlparse(url).path.rstrip("/")
    # Reddit's official API when the repo has Reddit app credentials, else its public JSON,
    # which Reddit often refuses. Then the card asks for the post text to be pasted in.
    headers, host = {"User-Agent": REDDIT_UA}, "https://www.reddit.com"
    token = _reddit_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
        host = "https://oauth.reddit.com"
    data = None
    try:
        r = requests.get(f"{host}{path}.json", params={"raw_json": 1, "limit": 40}, headers=headers, timeout=TIMEOUT)
        if r.ok:
            data = r.json()
        else:
            src["notes"].append(f"Reddit answered {r.status_code}; paste the post text into the card")
    except (requests.RequestException, ValueError) as e:
        src["notes"].append(f"Reddit failed: {str(e)[:120]}")
    if not isinstance(data, list) or not data:
        return
    post = data[0]["data"]["children"][0]["data"]
    op = post.get("author", "")
    src["title"] = post.get("title", "")
    src["author"] = f"u/{op}" if op else ""
    src["text"] = post.get("selftext", "")
    comments = [c["data"] for c in (data[1]["data"]["children"] if len(data) > 1 else [])
                if c.get("kind") == "t1"]
    mine = [c.get("body", "") for c in comments if c.get("author") == op]
    others = [c.get("body", "") for c in comments if c.get("author") != op][:6]
    src["comments"] = [f"(creator) {b}" for b in mine] + others
    src["is_video"] = bool(post.get("is_video"))
    # photos: a single image, a gallery, or the preview image
    urls = []
    if re.search(r"\.(jpe?g|png|webp)$", post.get("url", ""), re.I):
        urls.append(post["url"])
    for item in (post.get("media_metadata") or {}).values():
        u = (item.get("s") or {}).get("u")
        if u:
            urls.append(u)
    for img in ((post.get("preview") or {}).get("images") or [])[:1]:
        u = (img.get("source") or {}).get("url")
        if u:
            urls.append(u)
    for i, u in enumerate(dict.fromkeys(urls)):
        if i >= 4:
            break
        p = download(htmllib.unescape(u), workdir / f"image-{i + 1}")
        if p:
            src["images"].append(str(p))


def _reddit_token() -> str | None:
    """App-only access to Reddit's API, if REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set."""
    cid, secret = os.environ.get("REDDIT_CLIENT_ID"), os.environ.get("REDDIT_CLIENT_SECRET")
    if not (cid and secret):
        return None
    try:
        r = requests.post("https://www.reddit.com/api/v1/access_token", auth=(cid, secret),
                          data={"grant_type": "client_credentials"}, headers={"User-Agent": REDDIT_UA},
                          timeout=TIMEOUT)
        r.raise_for_status()
        return r.json().get("access_token")
    except (requests.RequestException, ValueError):
        return None


# ---------- any web page (recipe blogs, Instagram/Pinterest previews) ----------

def _webpage(src: dict, workdir: Path) -> None:
    try:
        r = requests.get(src["url"], headers={"User-Agent": BROWSER_UA, "Accept-Language": "en-US,en"},
                         timeout=TIMEOUT)
        r.raise_for_status()
        page = r.text
    except requests.RequestException as e:
        src["notes"].append(f"page fetch failed: {str(e)[:120]}")
        return
    src["canonical_url"] = canonical_url(r.url) if src["platform"] == "web" else src["canonical_url"]
    recipe = _find_jsonld_recipe(page)
    meta = _meta_tags(page)
    src["title"] = src["title"] or (recipe or {}).get("name") or meta.get("og:title", "")
    if recipe:
        src["structured"] = _trim_recipe(recipe)
    desc = meta.get("og:description") or meta.get("description") or ""
    if desc:
        src["text"] = (src["text"] + "\n\n" + desc).strip()
    if not recipe and src["platform"] == "web":
        src["text"] = (src["text"] + "\n\n" + _visible_text(page)).strip()
    image = _first_image((recipe or {}).get("image")) or meta.get("og:image")
    if image and not src["cover"]:
        p = download(htmllib.unescape(image), workdir / "cover")
        src["cover"] = str(p) if p else None


def _meta_tags(page: str) -> dict:
    out = {}
    for m in re.finditer(r"<meta\s+[^>]*>", page, re.I):
        tag = m.group(0)
        key = re.search(r'(?:property|name)\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        val = re.search(r'content\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        if key and val:
            out.setdefault(key.group(1).lower(), htmllib.unescape(val.group(1)))
    return out


def _find_jsonld_recipe(page: str) -> dict | None:
    for m in re.finditer(r"<script[^>]+application/ld\+json[^>]*>(.*?)</script>", page, re.S | re.I):
        try:
            data = json.loads(m.group(1).strip())
        except ValueError:
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                kind = node.get("@type")
                kinds = kind if isinstance(kind, list) else [kind]
                if "Recipe" in kinds:
                    return node
                stack.extend(v for k, v in node.items() if k in ("@graph", "mainEntity", "itemListElement"))
    return None


def _first_image(image) -> str | None:
    if isinstance(image, str):
        return image
    if isinstance(image, list) and image:
        return _first_image(image[0])
    if isinstance(image, dict):
        return image.get("url")
    return None


def _flatten_steps(steps) -> list[str]:
    out = []
    if isinstance(steps, str):
        return [s.strip() for s in re.split(r"\n+", steps) if s.strip()]
    for s in steps or []:
        if isinstance(s, str):
            out.append(s)
        elif isinstance(s, dict):
            if s.get("@type") == "HowToSection":
                out += _flatten_steps(s.get("itemListElement"))
            elif s.get("text"):
                out.append(s["text"])
    return [htmllib.unescape(re.sub(r"<[^>]+>", "", s)).strip() for s in out]


def _trim_recipe(r: dict) -> dict:
    return {
        "name": r.get("name"),
        "description": r.get("description"),
        "yield": r.get("recipeYield"),
        "prepTime": r.get("prepTime"),
        "cookTime": r.get("cookTime"),
        "totalTime": r.get("totalTime"),
        "ingredients": r.get("recipeIngredient") or r.get("ingredients") or [],
        "steps": _flatten_steps(r.get("recipeInstructions")),
    }


def _visible_text(page: str) -> str:
    page = re.sub(r"(?is)<(script|style|noscript|svg|nav|footer|header)[^>]*>.*?</\1>", " ", page)
    text = htmllib.unescape(re.sub(r"<[^>]+>", " ", page))
    return re.sub(r"\s+", " ", text).strip()[:MAX_TEXT]
