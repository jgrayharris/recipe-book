"""The kitchen: everything between "a link was shared" and "it's in the book".

Commands (run from the repo's top folder):
  python pipeline/kitchen.py process [--retry-failed]   cook every waiting "Add recipe" issue (GitHub Actions runs this)
  python pipeline/kitchen.py try <url> [--queue]        cook one link on this computer, without GitHub
  python pipeline/kitchen.py queue                       list links waiting for the scheduled chef
  python pipeline/kitchen.py finish <queue-id>           file the scheduled chef's card from queue/<id>/chef.json
  python pipeline/kitchen.py index                       rebuild data/recipes.json
  python pipeline/kitchen.py site <folder>               assemble the website for GitHub Pages
  python pipeline/kitchen.py preview [port]              build the website and serve it on this computer
  python pipeline/kitchen.py test                        run the self-checks

How a link travels: the phone opens a GitHub issue titled "Add recipe" with the link in it.
`process` gathers the post (sources.py), pulls stills and a transcript (media.py), and has the
chef write the card (chef.py). With an ANTHROPIC_API_KEY the card is written at once; without
one the prepped link waits in queue/ for the scheduled chef (CHEF_ROUTINE.md).
"""
from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (DATA, IMAGES, QUEUE, RECIPES, ROOT, canonical_url, check_schema, find_urls,
                    link_words, load_json, save_json, short_hash, slugify)

LABELS = {
    "cooking": ("f2c14e", "The kitchen is working on it"),
    "needs-chef": ("8ab4f8", "Prepped; waiting for the scheduled chef"),
    "failed": ("e2553d", "Something went wrong; see the comment"),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def has_api_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


# ---------- the book on disk ----------

def all_recipes() -> list[dict]:
    return [r for r in (load_json(p) for p in sorted(RECIPES.glob("*.json"))) if r]


def find_existing(url: str) -> dict | None:
    want = canonical_url(url)
    for r in all_recipes():
        src = r.get("source", {})
        if want in (src.get("canonical_url"), canonical_url(src.get("url", "x:"))):
            return r
    return None


def queue_items() -> list[dict]:
    return [i for i in (load_json(p) for p in sorted(QUEUE.glob("*/item.json"))) if i]


def unique_id(title: str, canonical: str) -> str:
    base = slugify(title, 40)
    rid = f"{base}-{short_hash(canonical)}"
    if (RECIPES / f"{rid}.json").exists():
        rid = f"{base}-{short_hash(canonical, 8)}"
    return rid


def book_link(recipe_id: str = "") -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "jgrayharris/recipe-book")
    owner, name = repo.split("/", 1)
    return f"https://{owner.lower()}.github.io/{name}/" + (f"#/r/{recipe_id}" if recipe_id else "")


def pick_photo(label: str, files: dict[str, Path]) -> Path | None:
    if label in files:
        return files[label]
    for fallback in ["cover", "image-1"] + sorted((k for k in files if k.startswith("frame-")),
                                                  key=lambda k: -int(k.split("-")[1])):
        if fallback in files:
            return files[fallback]
    return None


PLATFORM_NAMES = {"tiktok": "TikTok", "instagram": "Instagram", "reddit": "Reddit", "youtube": "YouTube",
                  "facebook": "Facebook", "pinterest": "Pinterest"}


def nothing_read(src: dict, labelled: list, extra: str = "") -> bool:
    """True when the site shared nothing at all (no words, pictures or video) and nothing was pasted."""
    return not (extra or labelled or src.get("video")
                or any(src.get(k) for k in ("title", "text", "comments", "transcript", "structured")))


def placeholder_card(meta: dict) -> dict:
    """A card for a post nobody could read, so the link isn't lost. It's marked needs details,
    and the book asks for the recipe text to be pasted in. The household saved it as a recipe."""
    url, src = meta["url"], meta.get("source") or {}
    site = PLATFORM_NAMES.get(src.get("platform"), "") or urlparse(url).netloc.removeprefix("www.") or "The site"
    sub = re.search(r"/r/([A-Za-z0-9_]+)", urlparse(url).path)
    title = link_words(url) or (f"Saved from r/{sub.group(1)}" if sub else f"Saved {site} post")
    return {
        "is_recipe": True, "title": title, "summary": "",
        "servings": 0, "total_minutes": 0, "active_minutes": 0,
        "difficulty": "Easy", "difficulty_reason": "",
        "meal": [], "cuisine": "", "protein": "none", "cravings": [],
        "ingredients": [], "steps": [], "equipment": [], "tips": [],
        "photo": "none", "completeness": "thin",
        "missing": f"{site} wouldn't share this post, so there's no recipe yet.",
        "source_notes": f"{site} wouldn't share the post, so only the link was saved.",
    }


def finalize(fields: dict, meta: dict, photo: Path | None) -> dict | None:
    """Turn the chef's card into a recipe file. Returns None when it wasn't a recipe."""
    from media import save_photo

    if not fields.get("is_recipe"):
        if not meta.get("unreadable"):
            return None
        # The chef had only the link to judge by: keep it as a card waiting for the recipe text.
        fields, photo = placeholder_card(meta), None
    existing = load_json(RECIPES / f"{meta['recook_id']}.json") if meta.get("recook_id") else None
    rid = existing["id"] if existing else unique_id(fields["title"], meta["source"]["canonical_url"])
    has_photo = bool(existing and existing.get("photo"))
    if photo and save_photo(photo, rid, IMAGES):
        has_photo = True
    issues = set((existing or {}).get("issues", []))
    if meta.get("issue"):
        issues.add(meta["issue"])
    recipe = {
        "id": rid,
        **{k: v for k, v in fields.items() if k not in ("is_recipe", "photo")},
        "needs_details": fields["completeness"] == "thin",
        "photo": has_photo,
        "source": existing["source"] if existing else meta["source"],
        "added_by": existing["added_by"] if existing else meta.get("added_by", ""),
        "added_at": existing["added_at"] if existing else now_iso(),
        "updated_at": now_iso(),
        "issues": sorted(issues),
    }
    save_json(RECIPES / f"{rid}.json", recipe)
    return recipe


# ---------- cooking one link ----------

def source_meta(src: dict) -> dict:
    return {k: src.get(k, "") for k in ("url", "canonical_url", "platform", "author", "title")}


def cook_one(url: str, *, added_by: str = "", issue: int | None = None, recook_id: str = "",
             extra: str = "", use_api: bool | None = None) -> tuple[str, object]:
    """Returns (outcome, detail). Outcomes: added, updated, duplicate, not-recipe, queued."""
    from chef import build_brief, cook_with_api
    from media import originals, prepare_media
    from sources import gather

    use_api = has_api_key() if use_api is None else use_api
    if not recook_id and (dup := find_existing(url)):
        return "duplicate", dup
    for item in queue_items():
        if item["url"] == url and not recook_id:
            return "queued", item["qid"]
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        src = gather(url, work)
        if not recook_id and (dup := find_existing(src["canonical_url"])):
            return "duplicate", dup
        labelled = prepare_media(src, work)
        brief = build_brief(src, [label for label, _ in labelled], extra)
        unreadable = nothing_read(src, labelled, extra)
        meta = {"url": url, "issue": issue, "added_by": added_by, "recook_id": recook_id,
                "source": source_meta(src), "notes": src["notes"], "unreadable": unreadable}
        if unreadable and not recook_id and not link_words(url):
            # Nothing for the chef to work from: file the waiting card now instead of after its next run.
            return "added", finalize(placeholder_card(meta), meta, None)
        full = {**dict(labelled), **originals(work)}
        if not use_api:
            return "queued", enqueue(meta, brief, labelled, full)
        fields, usage = cook_with_api(brief, labelled)
        print(f"  chef: {usage}")
        recipe = finalize(fields, meta, pick_photo(fields["photo"], full))
        if not recipe:
            return "not-recipe", src
        return ("updated" if recook_id else "added"), recipe


def enqueue(meta: dict, brief: str, labelled: list[tuple[str, Path]], full: dict[str, Path]) -> str:
    """Save a prepped link for the scheduled chef: the brief plus images at a size good for a photo."""
    from media import to_jpg

    qid = datetime.now(timezone.utc).strftime("%Y%m%d") + "-" + short_hash(meta["url"] + now_iso(), 6)
    folder = QUEUE / qid
    folder.mkdir(parents=True, exist_ok=True)
    images = []
    for label, small in labelled:
        dest = folder / f"{label}.jpg"
        if to_jpg(full.get(label, small), dest, 720) or to_jpg(small, dest, 720):
            images.append(dest.name)
    save_json(folder / "item.json", {**meta, "qid": qid, "queued_at": now_iso(), "brief": brief,
                                     "images": images})
    return qid


def finish(qid: str, chef_file: str | None = None) -> int:
    """File the scheduled chef's card for one queue item. Exit code 1 means fix chef.json and rerun."""
    folder = QUEUE / qid
    item = load_json(folder / "item.json")
    if not item:
        print(f"No queue item {qid}")
        return 1
    fields = load_json(Path(chef_file) if chef_file else folder / "chef.json")
    if fields is None:
        print(f"Write the card to queue/{qid}/chef.json first")
        return 1
    problems = check_schema(fields)
    if problems:
        print("The card doesn't match pipeline/recipe.schema.json:\n  " + "\n  ".join(problems))
        return 1
    files = {p.stem: p for p in folder.glob("*.jpg")}
    recipe = finalize(fields, item, pick_photo(fields["photo"], files))
    if recipe:
        print(f"Added {recipe['title']} ({recipe['id']})")
    else:
        print("Not a recipe; nothing added")
        mark_not_recipe(item)
    shutil.rmtree(folder)
    return 0


DONE = QUEUE / "_done"   # notes from the chef that a queued link wasn't a recipe


def mark_not_recipe(item: dict) -> None:
    """Leave proof for reconcile(), so the issue is closed with the right message."""
    if item.get("issue"):
        save_json(DONE / f"{item['qid']}.json", {"issue": item["issue"], "url": item["url"]})


def cook_queue_with_api() -> None:
    """With an API key, links already waiting in queue/ are cooked straight away."""
    from chef import cook_with_api

    for item in queue_items():
        folder = QUEUE / item["qid"]
        labelled = [(Path(name).stem, folder / name) for name in item["images"]]
        try:
            fields, usage = cook_with_api(item["brief"], labelled)
        except Exception as e:
            print(f"  queue item {item['qid']} still waiting: {e}")
            continue
        print(f"  chef ({item['qid']}): {usage}")
        if not finalize(fields, item, pick_photo(fields["photo"], dict(labelled))):
            mark_not_recipe(item)
        shutil.rmtree(folder)


# ---------- GitHub issues: the inbox ----------

class GitHub:
    def __init__(self):
        import requests

        self.http = requests.Session()
        self.http.headers.update({
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        self.base = f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}"

    def call(self, method: str, path: str, **kw):
        r = self.http.request(method, self.base + path, timeout=30, **kw)
        if r.status_code >= 400 and not (method == "DELETE" and r.status_code == 404):
            raise RuntimeError(f"GitHub {method} {path}: {r.status_code} {r.text[:200]}")
        return r.json() if r.content else None

    def open_issues(self) -> list[dict]:
        issues = self.call("GET", "/issues", params={"state": "open", "per_page": 100})
        return [i for i in issues if "pull_request" not in i]

    def ensure_labels(self) -> None:
        have = {l["name"] for l in self.call("GET", "/labels", params={"per_page": 100})}
        for name, (color, desc) in LABELS.items():
            if name not in have:
                self.call("POST", "/labels", json={"name": name, "color": color, "description": desc})

    def comment(self, n: int, body: str) -> None:
        self.call("POST", f"/issues/{n}/comments", json={"body": body})

    def label(self, n: int, add=(), remove=()) -> None:
        for name in remove:
            self.call("DELETE", f"/issues/{n}/labels/{name}")
        if add:
            self.call("POST", f"/issues/{n}/labels", json={"labels": list(add)})

    def close(self, n: int, completed: bool = True) -> None:
        self.call("PATCH", f"/issues/{n}", json={"state": "closed",
                                                  "state_reason": "completed" if completed else "not_planned"})


def parse_body(body: str) -> tuple[list[str], str, str]:
    """Links, who sent it ("from: Lauren"), and any other text (pasted details)."""
    who, rest = "", []
    for line in (body or "").splitlines():
        m = re.match(r"\s*(from|via)\s*:\s*(.+)", line, re.I)
        if m:
            if m.group(1).lower() == "from":
                who = m.group(2).strip()
            continue
        rest.append(line)
    text = "\n".join(rest).strip()
    return find_urls(text), who, text


def describe(outcome: str, detail, url: str) -> str:
    if outcome in ("added", "updated", "duplicate"):
        r = detail
        what = {"added": "🍳 Added", "updated": "✏️ Updated", "duplicate": "📎 Already in the book:"}[outcome]
        if not r.get("steps"):   # a card waiting for the recipe text
            return (f"{what} **[{r['title']}]({book_link(r['id'])})**, but {r.get('missing', '')} "
                    "Open it in the book and paste the recipe in.")
        extra = " It needs details: open it in the book to paste them in." if r.get("needs_details") else ""
        return (f"{what} **[{r['title']}]({book_link(r['id'])})** "
                f"({r['difficulty']} · {r['total_minutes']} min).{extra}")
    if outcome == "queued":
        return f"⏳ Prepped {url}. The scheduled chef will write the card on its next run."
    if outcome == "not-recipe":
        return f"🤔 {url} didn't look like a recipe, so nothing was added."
    return f"⚠️ Couldn't cook {url}: {detail}"


def handle_issue(gh: GitHub, issue: dict) -> None:
    n, title = issue["number"], issue["title"].strip()
    urls, who, text = parse_body(issue.get("body") or "")
    print(f"#{n} {title}: {len(urls)} link(s) from {who or 'someone'}")
    gh.label(n, add=["cooking"], remove=[l["name"] for l in issue["labels"] if l["name"] == "failed"])
    lines, failed, queued = [], False, False

    jobs = []
    m = re.match(r"(?i)add details\s*:\s*(\S+)", title)
    if m:
        recipe = load_json(RECIPES / f"{m.group(1)}.json")
        if not recipe:
            lines.append(f"⚠️ There's no recipe called `{m.group(1)}` in the book.")
        else:
            jobs.append((recipe["source"]["url"], dict(recook_id=recipe["id"], extra=text)))
    else:
        # One link plus pasted text: the text is the recipe (for posts a site won't share).
        extra = text.replace(urls[0], "").strip() if len(urls) == 1 else ""
        jobs = [(u, {"extra": extra} if extra else {}) for u in urls]
        if not urls:
            lines.append("⚠️ I couldn't find a link in this issue.")

    for url, opts in jobs:
        try:
            outcome, detail = cook_one(url, added_by=who, issue=n, **opts)
        except Exception as e:  # keep going with the other links; this one gets retried later
            outcome, detail = "failed", str(e)[:300]
        print(f"  {outcome}: {url}")
        failed |= outcome == "failed"
        queued |= outcome == "queued"
        lines.append(describe(outcome, detail, url))

    gh.comment(n, "\n\n".join(lines) or "Nothing to do.")
    if failed:
        gh.label(n, add=["failed"], remove=["cooking"])
    elif queued:
        gh.label(n, add=["needs-chef"], remove=["cooking"])
    else:
        gh.label(n, remove=["cooking"])
        gh.close(n, completed=any(l.startswith(("🍳", "✏️", "📎")) for l in lines))


def reconcile(gh: GitHub, issues: list[dict]) -> None:
    """Close "needs-chef" issues once the scheduled chef has handled all their links.

    Closes only on proof: a recipe that names the issue, or the chef's not-a-recipe note.
    A missing queue item alone proves nothing, so the issue stays open.
    """
    waiting = {i["issue"] for i in queue_items()}
    recipes = all_recipes()
    notes = {p: load_json(p) for p in DONE.glob("*.json")}
    for issue in issues:
        n = issue["number"]
        if "needs-chef" not in {l["name"] for l in issue["labels"]} or n in waiting:
            continue
        done = [r for r in recipes if n in r.get("issues", [])]
        not_recipes = [p for p, note in notes.items() if note and note.get("issue") == n]
        if not done and not not_recipes:
            continue
        lines = [describe("added", r, r["source"]["url"]) for r in done]
        lines += [describe("not-recipe", None, notes[p]["url"]) for p in not_recipes]
        gh.comment(n, "\n\n".join(lines))
        gh.label(n, remove=["needs-chef"])
        gh.close(n, completed=bool(done))
        for p in not_recipes:
            p.unlink()


def process(retry_failed: bool = False) -> None:
    gh = GitHub()
    gh.ensure_labels()
    if has_api_key() and queue_items():
        cook_queue_with_api()
    issues = gh.open_issues()
    reconcile(gh, issues)
    for issue in issues:
        labels = {l["name"] for l in issue["labels"]}
        if issue.get("author_association") not in ("OWNER", "MEMBER", "COLLABORATOR"):
            continue  # the repo is public: only the household's own issues get cooked
        if not re.match(r"(?i)add (recipe|details)", issue["title"].strip()):
            continue
        if "needs-chef" in labels or ("failed" in labels and not retry_failed):
            continue
        handle_issue(gh, issue)


# ---------- the website ----------

def build_index(out: Path = DATA / "recipes.json") -> int:
    recipes = all_recipes()
    recipes.sort(key=lambda r: r.get("added_at", ""), reverse=True)
    save_json(out, {"generated_at": now_iso(), "recipes": recipes})
    return len(recipes)


def build_site(out: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "app", out)
    (out / "images").mkdir()
    for p in IMAGES.glob("*.jpg"):
        shutil.copy2(p, out / "images" / p.name)
    (out / "data").mkdir()
    household = DATA / "household.json"
    if household.exists():
        shutil.copy2(household, out / "data" / "household.json")
    count = build_index(out / "data" / "recipes.json")
    print(f"Built the site in {out} with {count} recipes")


def preview(port: int = 8000) -> None:
    import functools
    import http.server

    out = ROOT / "_site"
    build_site(out)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(out))
    print(f"Serving http://127.0.0.1:{port}/  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()


# ---------- self-checks ----------

def selftest() -> None:
    assert find_urls("look https://vm.tiktok.com/ZM123/ and (https://a.com/x).") == \
        ["https://vm.tiktok.com/ZM123/", "https://a.com/x"]
    assert canonical_url("https://www.instagram.com/reel/Cabc123/?igsh=xyz") == "https://instagram.com/p/Cabc123"
    assert canonical_url("https://old.reddit.com/r/recipes/comments/1abcd/some_title/") == \
        "https://reddit.com/comments/1abcd"
    assert canonical_url("https://youtu.be/dQw4w9WgXcQ?si=1") == canonical_url(
        "https://www.youtube.com/shorts/dQw4w9WgXcQ")
    assert canonical_url("https://www.tiktok.com/@chef/video/123?is_from_webapp=1") == \
        "https://tiktok.com/@chef/video/123"
    urls, who, text = parse_body("https://x.com/a\nfrom: Lauren\nvia: email")
    assert urls == ["https://x.com/a"] and who == "Lauren" and text == "https://x.com/a"
    assert slugify("Crispy Gochujang Chicken!! 🔥") == "crispy-gochujang-chicken"
    good = load_json(ROOT / "pipeline" / "sample-card.json")
    assert check_schema(good) == [], check_schema(good)
    bad = {**good, "difficulty": "Hard"}
    bad.pop("tips")
    assert len(check_schema(bad)) == 2
    files = {"cover": Path("c.jpg"), "frame-2": Path("2.jpg"), "frame-9": Path("9.jpg")}
    assert pick_photo("frame-2", files).name == "2.jpg"
    assert pick_photo("none", files).name == "c.jpg"
    assert pick_photo("none", {"frame-2": Path("2"), "frame-9": Path("9")}).name == "9"
    # Links that can't be read: named from their own words when they have any, else kept as a waiting card.
    assert link_words("https://www.reddit.com/r/soup/s/ecqWzcoq7R") == ""
    assert link_words("https://www.reddit.com/r/slow_cooking/s/abc123") == ""
    assert link_words("https://www.tiktok.com/@chef_jane/video/123") == ""
    assert link_words("https://www.instagram.com/reel/Cabc_123/") == ""
    assert link_words("https://old.reddit.com/r/recipes/comments/1abcd/creamy_tuscan_chicken_pasta/") == \
        "Creamy Tuscan Chicken Pasta"
    assert link_words("https://blog.example.com/2024/05/best-beef-chili-2024.html") == "Best Beef Chili"
    blank = {"title": "", "text": "", "comments": [], "transcript": "", "structured": None, "video": None}
    assert nothing_read(blank, []) and not nothing_read(blank, [], "pasted recipe")
    assert not nothing_read({**blank, "text": "caption"}, []) and not nothing_read(blank, [("cover", Path("c"))])
    meta = {"url": "https://www.reddit.com/r/soup/s/ecqWzcoq7R", "source": {"platform": "reddit"}}
    card = placeholder_card(meta)
    assert check_schema(card) == [], check_schema(card)
    assert card["title"] == "Saved from r/soup" and card["completeness"] == "thin" and card["is_recipe"]
    assert "Reddit wouldn't share" in card["missing"]
    assert placeholder_card({"url": "https://www.instagram.com/reel/Cabc/", "source": {"platform": "instagram"}})[
        "title"] == "Saved Instagram post"
    stub = {**card, "id": "saved-from-r-soup-ab12", "needs_details": True}
    assert "(Easy · 0 min)" not in describe("added", stub, meta["url"])
    assert "paste the recipe in" in describe("added", stub, meta["url"])
    print("All kitchen self-checks passed")


def main(argv: list[str]) -> int:
    cmd, args = (argv[0], argv[1:]) if argv else ("help", [])
    if cmd == "process":
        process(retry_failed="--retry-failed" in args)
    elif cmd == "try":
        outcome, detail = cook_one(args[0], added_by="test", use_api=False if "--queue" in args else None)
        print(outcome, detail if isinstance(detail, str) else detail.get("id", ""))
    elif cmd == "queue":
        items = queue_items()
        print("The queue is empty." if not items else "\n".join(
            f"{i['qid']}  {i['url']}  images: {', '.join(i['images']) or 'none'}" for i in items))
    elif cmd == "finish":
        return finish(args[0], args[1] if len(args) > 1 else None)
    elif cmd == "index":
        print(f"Indexed {build_index()} recipes")
    elif cmd == "site":
        build_site(Path(args[0]))
    elif cmd == "preview":
        preview(int(args[0]) if args else 8000)
    elif cmd == "test":
        selftest()
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
