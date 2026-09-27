#!/usr/bin/env python3
"""Import public Bilibili opus articles into BIFROST content."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = "Mozilla/5.0 BIFROST-Import/1.0"
INITIAL_STATE_PREFIX = "window.__INITIAL_STATE__="


def fetch(url: str, referer: str = "") -> bytes:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
    }
    if referer:
        headers["Referer"] = referer
    request = urllib.request.Request(url, headers=headers)
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"下载失败：{url}") from last_error


def parse_initial_state(html: str) -> dict:
    start = html.index(INITIAL_STATE_PREFIX) + len(INITIAL_STATE_PREFIX)
    payload, _ = json.JSONDecoder().raw_decode(html[start:])
    return payload


def module(modules: list[dict], module_type: str, default=None):
    key = f"module_{module_type.removeprefix('MODULE_TYPE_').lower()}"
    return next((item.get(key) for item in modules if item.get("module_type") == module_type), default)


def node_text(node: dict) -> str:
    if node.get("type") == "TEXT_NODE_TYPE_WORD":
        word = node.get("word") or {}
        value = str(word.get("words") or "")
        style = word.get("style") or {}
        if style.get("bold") and value.strip():
            value = f"**{value}**"
        if style.get("italic") and value.strip():
            value = f"*{value}*"
        if style.get("strikethrough") and value.strip():
            value = f"~~{value}~~"
        return value
    if node.get("type") == "TEXT_NODE_TYPE_EMOJI":
        return str((node.get("emoji") or {}).get("text") or "")
    if node.get("type") == "RICH_TEXT_NODE_TYPE_TEXT":
        return str(node.get("text") or "")
    return str(node.get("text") or node.get("word", {}).get("words") or "")


def paragraph_text(paragraph: dict) -> str:
    return "".join(node_text(node) for node in (paragraph.get("text") or {}).get("nodes", []))


def render_paragraph(paragraph: dict, image_paths: list[str], image_index: int) -> tuple[str, int]:
    paragraph_type = paragraph.get("para_type")
    if paragraph_type == 1:
        value = paragraph_text(paragraph).strip()
        return (value, image_index)
    if paragraph_type == 2:
        lines = []
        for pic in (paragraph.get("pic") or {}).get("pics") or []:
            if image_index >= len(image_paths):
                continue
            alt = f"活动记录照片 {image_index + 1}"
            lines.append(f"![{alt}]({image_paths[image_index]})")
            image_index += 1
        return ("\n\n".join(lines), image_index)
    if paragraph_type == 4:
        children = (paragraph.get("blockquote") or {}).get("children") or []
        lines = []
        for child in children:
            value, image_index = render_paragraph(child, image_paths, image_index)
            if value:
                lines.extend(f"> {line}" for line in value.splitlines())
        return ("\n".join(lines), image_index)
    return ("", image_index)


def slugify(value: str) -> str:
    value = re.sub(r"[^\w\u3400-\u9fff]+", "-", value, flags=re.UNICODE).strip("-").lower()
    return value[:90] or "bilibili-opus"


def public_date(value: str) -> str:
    match = re.search(r"(\d{4})年(\d{2})月(\d{2})日", value)
    if not match:
        return datetime.now().date().isoformat()
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"


def download_image(url: str, target: Path, referer: str) -> tuple[str, int]:
    data = fetch(url, referer)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return hashlib.sha256(data).hexdigest(), len(data)


def web_image(source: Path, target: Path, max_width: int = 1600) -> None:
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image)
        if image.width > max_width:
            height = round(image.height * max_width / image.width)
            image = image.resize((max_width, height), Image.Resampling.LANCZOS)
        if image.mode in ("RGBA", "LA", "P"):
            background = Image.new("RGB", image.size, "white")
            converted = image.convert("RGBA")
            background.paste(converted, mask=converted.getchannel("A"))
            image = background
        else:
            image = image.convert("RGB")
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, "WEBP", quality=84, method=5)


def import_opus(url: str, tags: list[str]) -> dict:
    opus_id = urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1]
    if not opus_id.isdigit():
        raise ValueError(f"无法从链接解析 opus id：{url}")

    html = fetch(url).decode("utf-8", errors="replace")
    state = parse_initial_state(html)
    modules = state["detail"]["modules"]
    title = module(modules, "MODULE_TYPE_TITLE", {}).get("text", "").strip()
    author = module(modules, "MODULE_TYPE_AUTHOR", {})
    content = module(modules, "MODULE_TYPE_CONTENT", {})
    publish_time = author.get("pub_time", "")
    date = public_date(publish_time)
    if not title:
        raise ValueError(f"{url} 没有标题。")

    raw_dir = ROOT / "imports" / "fantasy" / "raw" / "bilibili" / opus_id
    web_dir = ROOT / "assets" / "media" / "bilibili" / opus_id
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / "opus.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    image_urls = []
    for paragraph in content.get("paragraphs", []):
        if paragraph.get("para_type") != 2:
            continue
        for pic in (paragraph.get("pic") or {}).get("pics") or []:
            if pic.get("url"):
                image_urls.append(pic["url"])

    markdown_images = []
    manifest_images = []
    for index, image_url in enumerate(image_urls, 1):
        extension = Path(urllib.parse.urlparse(image_url).path).suffix.lower() or ".jpg"
        raw_path = raw_dir / "images" / f"{index:02d}{extension}"
        digest, size = download_image(image_url, raw_path, url)
        web_name = f"{index:02d}.webp"
        web_path = web_dir / web_name
        web_image(raw_path, web_path)
        relative = f"../../../assets/media/bilibili/{opus_id}/{web_name}"
        markdown_images.append(relative)
        manifest_images.append(
            {
                "order": index,
                "sourceUrl": image_url,
                "rawPath": str(raw_path.relative_to(ROOT)).replace("\\", "/"),
                "webPath": str(web_path.relative_to(ROOT)).replace("\\", "/"),
                "sha256": digest,
                "rawBytes": size,
                "webBytes": web_path.stat().st_size,
            }
        )

    body_lines = []
    image_index = 0
    for paragraph in content.get("paragraphs", []):
        rendered, image_index = render_paragraph(paragraph, markdown_images, image_index)
        if rendered:
            body_lines.append(rendered)
    body = "\n\n".join(body_lines).strip()
    summary = next(
        (
            re.sub(r"[*_~\[\]()]", "", paragraph_text(paragraph)).strip()
            for paragraph in content.get("paragraphs", [])
            if paragraph.get("para_type") == 1 and paragraph_text(paragraph).strip()
        ),
        "",
    )
    summary = summary[:100]
    slug = slugify(title)
    output = ROOT / "content-src" / "fantasy" / "article" / f"{date}-{slug}.md"
    output.parent.mkdir(parents=True, exist_ok=True)
    cover = f"/assets/media/bilibili/{opus_id}/{Path(markdown_images[0]).name}" if markdown_images else ""
    markdown = f"""---
title: {title}
date: {date}
type: article
kind: standard
tags: {", ".join(tags)}
summary: {summary}
cover: {cover}
source_provider: bilibili
source_id: {opus_id}
source_url: {url}
syndication_author: {author.get("name", "")}
syndication_url: {url}
---

# {title}

{body}

> 本文原发布于哔哩哔哩，作者：{author.get("name", "")}。[查看原帖]({url})
"""
    output.write_text(markdown, encoding="utf-8")
    return {
        "id": opus_id,
        "title": title,
        "date": date,
        "author": author.get("name", ""),
        "sourceUrl": url,
        "output": str(output.relative_to(ROOT)).replace("\\", "/"),
        "images": manifest_images,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+", help="Bilibili opus URLs")
    parser.add_argument("--tags", default="FMT,声优见面会,活动记录")
    args = parser.parse_args()
    tags = [item.strip() for item in args.tags.split(",") if item.strip()]
    results = [import_opus(url, tags) for url in args.urls]
    manifest_path = ROOT / "imports" / "fantasy" / "bilibili-source-manifest.json"
    existing = []
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8")).get("articles", [])
        except json.JSONDecodeError:
            existing = []
    merged = {item["id"]: item for item in existing}
    merged.update({item["id"]: item for item in results})
    manifest_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "updatedAt": datetime.now().astimezone().isoformat(),
                "articles": sorted(merged.values(), key=lambda item: item["date"], reverse=True),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
