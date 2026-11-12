"""The chef: turns a gathered post into a recipe card with Claude.

build_brief() writes the text the chef reads. cook_with_api() sends it with the images
to the Claude API. The scheduled chef (a Claude Code routine, see CHEF_ROUTINE.md) reads
the same brief and images from queue/, so both paths make the same cards.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

from common import PIPELINE, SCHEMA, check_schema

INSTRUCTIONS = (PIPELINE / "chef_instructions.md").read_text(encoding="utf-8")
DEFAULT_MODEL = "claude-opus-5-5"
# List prices in dollars per million tokens (input, output), for the cost line in the logs.
PRICES = {"claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0), "claude-haiku-5-5": (0.10, 0.50)}


class ChefError(Exception):
    pass


def build_brief(src: dict, labels: list[str], extra: str = "") -> str:
    parts = [f"Platform: {src['platform']}", f"Link: {src['url']}"]
    if src.get("author"):
        parts.append(f"Creator: {src['author']}")
    if src.get("title"):
        parts.append(f"Title: {src['title']}")
    if src.get("text"):
        parts.append(f"Caption / description / post text:\n{src['text']}")
    if src.get("comments"):
        parts.append("Comments:\n" + "\n---\n".join(c[:2000] for c in src["comments"]))
    if src.get("transcript"):
        parts.append(f"Transcript of the video's audio (machine-made):\n{src['transcript']}")
    if src.get("structured"):
        parts.append("Structured recipe data from the page:\n"
                     + json.dumps(src["structured"], ensure_ascii=False, indent=1)[:8000])
    if extra:
        parts.append(f"Details the household pasted in (these win over everything else):\n{extra}")
    parts.append("Images attached, in order: " + (", ".join(labels) if labels else "none"))
    if not any(src.get(k) for k in ("text", "comments", "transcript", "structured")) and not extra:
        parts.append("Note: nothing but images could be read from this post.")
    return "\n\n".join(parts)


def cook_with_api(brief: str, images: list[tuple[str, Path]]) -> tuple[dict, str]:
    """Returns (recipe fields, one-line usage note). Raises ChefError on failure."""
    import anthropic

    model = os.environ.get("CHEF_MODEL") or DEFAULT_MODEL
    content: list[dict] = []
    for label, path in images:
        data = base64.standard_b64encode(Path(path).read_bytes()).decode()
        content.append({"type": "text", "text": f"[{label}]"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}})
    content.append({"type": "text", "text": brief})

    request = dict(
        model=model,
        max_tokens=16000,
        system=INSTRUCTIONS,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": os.environ.get("CHEF_EFFORT", "medium"),
                       "format": {"type": "json_schema", "schema": SCHEMA}},
    )
    client = anthropic.Anthropic()
    try:
        if model.startswith("claude-haiku"):
            response = client.messages.create(**request)
        else:
            # If a safety check declines the request, the API retries it on a fallback model.
            response = client.beta.messages.create(
                **request, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    except anthropic.APIStatusError as e:
        raise ChefError(f"Claude API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise ChefError(f"couldn't reach the Claude API: {e}") from e

    if response.stop_reason == "refusal":
        raise ChefError("the chef declined this post")
    if response.stop_reason == "max_tokens":
        raise ChefError("the recipe card ran out of room")
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        recipe = json.loads(text)
    except ValueError as e:
        raise ChefError("the chef's answer wasn't valid JSON") from e
    problems = check_schema(recipe)
    if problems:
        raise ChefError("; ".join(problems[:5]))

    u = response.usage
    price_in, price_out = PRICES.get(model, (0, 0))
    cost = (u.input_tokens * price_in + u.output_tokens * price_out) / 1e6
    return recipe, f"{model}: {u.input_tokens} in / {u.output_tokens} out tokens, about ${cost:.3f}"
