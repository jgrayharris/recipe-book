"""Shared helpers: folder paths, JSON files, links, and a tiny schema checker."""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

ROOT = Path(__file__).resolve().parent.parent
PIPELINE = ROOT / "pipeline"
RECIPES = ROOT / "recipes"      # one JSON file per recipe: the source of truth
IMAGES = ROOT / "images"        # <id>.jpg (large) and <id>-sm.jpg (grid)
QUEUE = ROOT / "queue"          # prepped links waiting for the scheduled chef
DATA = ROOT / "data"            # recipes.json (built) and household.json (app)

SCHEMA = json.loads((PIPELINE / "recipe.schema.json").read_text(encoding="utf-8"))


# ---------- JSON files ----------

def load_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# ---------- text ----------

def slugify(text: str, maxlen: int = 48) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:maxlen].rstrip("-") or "recipe"


def short_hash(text: str, n: int = 4) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:n]


# ---------- links ----------

URL_RE = re.compile(r"https?://[^\s<>\"'\)\]\}]+", re.I)


def find_urls(text: str) -> list[str]:
    """Every http(s) link in the text, in order, without duplicates."""
    seen, out = set(), []
    for m in URL_RE.finditer(text or ""):
        url = m.group(0).rstrip(".,;:!?*")
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out


def platform_of(url: str) -> str:
    host = urlparse(url).netloc.lower()
    for name, keys in (
        ("tiktok", ("tiktok.com",)),
        ("instagram", ("instagram.com", "instagr.am")),
        ("reddit", ("reddit.com", "redd.it")),
        ("youtube", ("youtube.com", "youtu.be")),
        ("facebook", ("facebook.com", "fb.watch")),
        ("pinterest", ("pinterest.", "pin.it")),
    ):
        if any(k in host for k in keys):
            return name
    return "web"


VIDEO_PLATFORMS = {"tiktok", "instagram", "youtube", "facebook"}
_KEEP_QUERY = {"youtube": {"v"}, "facebook": {"v", "story_fbid", "id"}}


def canonical_url(url: str) -> str:
    """A stable form of a link, used to spot recipes that are already in the book."""
    p = urlparse(url.strip())
    host = p.netloc.lower()
    for prefix in ("www.", "m.", "old.", "new.", "np.", "vm.", "vt."):
        if host.startswith(prefix) and host.count(".") >= 2:
            host = host[len(prefix):]
    platform = platform_of(url)
    keep = _KEEP_QUERY.get(platform, set())
    query = {k: v for k, v in parse_qs(p.query).items() if k in keep}
    path = re.sub(r"/+$", "", p.path) or "/"
    if platform == "youtube" and host == "youtu.be":
        query, host, path = {"v": [path.strip("/")]}, "youtube.com", "/watch"
    if platform == "youtube" and path.startswith("/shorts/"):
        query, path = {"v": [path.split("/")[2]]}, "/watch"
    if platform == "reddit":
        # /r/sub/comments/<id>/<slug> -> /comments/<id>
        m = re.search(r"/comments/([a-z0-9]+)", path)
        if m:
            path = f"/comments/{m.group(1)}"
    if platform == "instagram":
        m = re.search(r"/(p|reel|reels|tv)/([^/]+)", path)
        if m:
            path = f"/p/{m.group(2)}"
    return urlunparse(("https", host, path, "", urlencode(query, doseq=True), ""))


# ---------- the recipe schema (a small checker for the subset we use) ----------

def check_schema(value, schema=None, where="recipe") -> list[str]:
    """Return a list of problems; empty means the value matches the schema."""
    schema = schema or SCHEMA
    problems: list[str] = []
    kind = schema.get("type")
    types = {"object": dict, "array": list, "string": str, "boolean": bool}
    if kind == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            return [f"{where}: expected a whole number"]
    elif kind in types and not isinstance(value, types[kind]):
        return [f"{where}: expected {kind}"]
    if "enum" in schema and value not in schema["enum"]:
        problems.append(f"{where}: {value!r} is not one of {schema['enum']}")
    if kind == "object":
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                problems.append(f"{where}: missing {key}")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    problems.append(f"{where}: unexpected field {key}")
        for key, sub in props.items():
            if key in value:
                problems += check_schema(value[key], sub, f"{where}.{key}")
    if kind == "array":
        for i, item in enumerate(value):
            problems += check_schema(item, schema.get("items", {}), f"{where}[{i}]")
    return problems
