#!/usr/bin/env python3
"""Fetch a resumable, category-balanced photo collection from the Unsplash Lite dataset. No API key needed."""

import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import html
import io
import json
import math
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from PIL import Image, ImageDraw, ImageOps, ImageStat

ROOT = Path(__file__).resolve().parent
DATASET_URL = "https://unsplash.com/data/lite/latest"
TERMS_URL = "https://github.com/unsplash/datasets/blob/master/TERMS.md"
TABLES = ["photos.tsv000", "keywords.tsv000", "TERMS.md"]
USER_AGENT = "PixelStretchDataset/2.0 (small internal photo collection; Python urllib)"
MAX_BYTES = 25 * 1024 * 1024
# Keywords (AI confidence >= 80) that mark graphics, artwork or text rather than a photographed scene.
NON_PHOTO_KEYWORDS = {"text", "graphics", "illustration", "poster", "logo", "drawing", "painting", "sketch",
                      "cartoon", "collage", "screenshot", "advertisement", "diagram", "map", "3d"}
NON_PHOTO = re.compile(r"\b(illustration|rendering|render|3d|digital art|painting|drawing|screenshot|text)\b", re.I)
NOT_A_PERSON = re.compile(r"\b(sculpture|statue|memorial|mannequin|doll|figurine|toy|painting|mural)\b", re.I)
IRREGULAR = {"person": ["people"], "man": ["men"], "woman": ["women"], "child": ["children"],
             "leaf": ["leaves"], "shelf": ["shelves"], "cactus": ["cacti"]}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def save_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


class RateLimited(Exception):
    pass


class HTTP:
    def __init__(self):
        self.next_request = {}

    def get(self, url, limit=MAX_BYTES):
        host = urllib.parse.urlsplit(url).hostname
        if urllib.parse.urlsplit(url).scheme != "https":
            raise ValueError("Only HTTPS downloads are accepted")
        for attempt in range(3):
            time.sleep(max(0, self.next_request.get(host, 0) - time.monotonic()))
            self.next_request[host] = time.monotonic() + 0.1
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=30) as response:
                    data = response.read(limit + 1)
                    if len(data) > limit:
                        raise ValueError(f"Response exceeds {limit // 1024 // 1024} MB")
                    return data
            except urllib.error.HTTPError as exc:
                if exc.code == 429:
                    retry = exc.headers.get("Retry-After", "60")
                    try:
                        delay = float(retry)
                    except ValueError:
                        delay = (parsedate_to_datetime(retry) - datetime.now(timezone.utc)).total_seconds()
                    if delay > 60:
                        raise RateLimited(f"{host}: retry after {math.ceil(delay)} seconds; rerun to resume") from exc
                    if attempt == 2:
                        raise RateLimited(f"{host}: rate limit persists; rerun later to resume") from exc
                    print(f"Rate limit from {host}; waiting {max(1, delay):.0f}s", flush=True)
                    self.next_request[host] = time.monotonic() + max(1, delay)
                elif exc.code in (500, 502, 503, 504) and attempt < 2:
                    time.sleep(2 ** attempt)
                else:
                    raise
            except (TimeoutError, urllib.error.URLError):
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError(f"Could not fetch {url}")


def fetch_archive(path):
    """Download the dataset zip into `path`, resuming a partial `.part` file with HTTP ranges."""
    partial = path.with_suffix(path.suffix + ".part")
    for attempt in range(6):
        # The zip directory is written last, so a readable one means the partial file is complete.
        if partial.exists() and zipfile.is_zipfile(partial):
            partial.replace(path)
            return
        offset = partial.stat().st_size if partial.exists() else 0
        headers = {"User-Agent": USER_AGENT}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            with urllib.request.urlopen(urllib.request.Request(DATASET_URL, headers=headers), timeout=60) as response:
                if response.status != 206:
                    offset = 0
                total = offset + int(response.headers.get("Content-Length") or 0)
                print(f"Downloading Unsplash Lite dataset ({total / 1024 ** 2:.0f} MB), resuming at {offset / 1024 ** 2:.0f} MB",
                      flush=True)
                with partial.open("ab" if offset else "wb") as out:
                    reported = offset
                    while chunk := response.read(1 << 20):
                        out.write(chunk)
                        offset += len(chunk)
                        if offset - reported >= 25 * 1024 ** 2:
                            print(f"  {offset / 1024 ** 2:.0f}/{total / 1024 ** 2:.0f} MB", flush=True)
                            reported = offset
        except urllib.error.HTTPError as exc:
            if exc.code != 416:  # 416: nothing left past the partial file's end
                raise
            if not zipfile.is_zipfile(partial):
                partial.unlink()
        except (TimeoutError, urllib.error.URLError, ConnectionError) as exc:
            print(f"  Dataset download interrupted ({exc}); retrying", flush=True)
            time.sleep(2 ** attempt)
    raise RuntimeError("Could not download the Unsplash Lite dataset; rerun to resume")


def dataset_tables(folder):
    tables = folder / "cache" / "unsplash-lite"
    if all((tables / name).exists() for name in TABLES):
        return tables
    archive = folder / "cache" / "unsplash-lite.zip"
    if not archive.exists():
        fetch_archive(archive)
    tables.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for name in TABLES:
            temporary = tables / (name + ".part")
            with bundle.open(name) as source, temporary.open("wb") as target:  # reading verifies each CRC
                shutil.copyfileobj(source, target)
            temporary.replace(tables / name)
    return tables


def read_tsv(path):
    csv.field_size_limit(sys.maxsize)
    with path.open(newline="", encoding="utf-8") as file:
        yield from csv.DictReader(file, delimiter="\t", quoting=csv.QUOTE_NONE)


def term_index(plan):
    """Map each singular/plural word form to its (category, term)."""
    index = {}
    for category, config in plan.items():
        for term in config["terms"]:
            forms = [term, term + "s", term + "es", *IRREGULAR.get(term, [])]
            if term.endswith("y"):
                forms.append(term[:-1] + "ies")
            for form in forms:
                if index.get(form, (category,))[0] != category:
                    raise ValueError(f"Term {form!r} is listed in two categories")
                index.setdefault(form, (category, term))
    return index


def subject(text, index):
    """Captions name the main subject first, so the earliest listed word decides the category."""
    text = re.sub(r"\bbeds? of\b", " ", text.lower())  # "bed of tulips" is not furniture
    for word in re.findall(r"[a-z]+", text):
        if word in index:
            return index[word]
    return None


def load_candidates(tables, plan, args):
    index = term_index(plan)
    keywords = defaultdict(dict)
    for row in read_tsv(tables / "keywords.tsv000"):
        confidence = max(float(row["ai_service_1_confidence"] or 0), float(row["ai_service_2_confidence"] or 0) * 100)
        if confidence >= 60:
            keywords[row["photo_id"]][row["keyword"].lower()] = confidence
    candidates = defaultdict(list)
    for photo in read_tsv(tables / "photos.tsv000"):
        tags = keywords[photo["photo_id"]]
        caption, description = photo["ai_description"].strip(), photo["photo_description"].strip()
        # Photographer descriptions often mention gear or unrelated words; use them only without an AI caption.
        match = subject(caption or description, index)
        width, height = int(photo["photo_width"] or 0), int(photo["photo_height"] or 0)
        if not match or not width or not height:
            continue
        category, term = match
        words = caption + " " + description
        if NON_PHOTO.search(words) or any(tags.get(x, 0) >= 80 for x in NON_PHOTO_KEYWORDS):
            continue
        if category == "people" and NOT_A_PERSON.search(words):
            continue
        if category == "interiors" and tags.get("outdoors", 0) >= 90:
            continue
        if max(width, height) < args.min_long_edge or max(width / height, height / width) > 2.5:
            continue
        name = " ".join(x for x in [photo["photographer_first_name"], photo["photographer_last_name"]] if x)
        candidates[category].append({
            "id": "unsplash-" + photo["photo_id"], "provider": "unsplash",
            "title": caption or description, "description": description,
            "creator": name or photo["photographer_username"],
            "creator_url": "https://unsplash.com/@" + photo["photographer_username"],
            "source_url": photo["photo_url"],
            "download_url": photo["photo_image_url"] + "?" + urllib.parse.urlencode(
                {"w": args.long_edge, "h": args.long_edge, "fit": "max", "fm": "jpg", "q": 85}),
            "original_url": photo["photo_image_url"], "original_width": width, "original_height": height,
            "license": "unsplash-lite-dataset", "license_url": TERMS_URL,
            "featured": photo["photo_featured"] == "t", "downloads": int(photo["stats_downloads"] or 0),
            "views": int(photo["stats_views"] or 0), "country": photo["photo_location_country"],
            "tags": sorted(tags, key=tags.get, reverse=True)[:15],
            "category": category, "term": term,
        })
    return candidates


def creator_key(row):
    return row["creator_url"].rstrip("/").lower()


def orientation(width, height):
    ratio = width / height
    return "square" if 0.9 <= ratio <= 1.1 else "landscape" if ratio > 1 else "portrait"


def fingerprint(image):
    pixels = list(image.convert("L").resize((9, 8)).tobytes())
    bits = [pixels[y * 9 + x] > pixels[y * 9 + x + 1] for y in range(8) for x in range(8)]
    return f"{sum(int(bit) << i for i, bit in enumerate(bits)):016x}"


def hamming(a, b):
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def prepare_people_detector(folder, enabled):
    if not enabled or sys.platform != "darwin" or not shutil.which("swiftc"):
        return None
    source = ROOT / "detect-people.swift"
    binary = folder / "cache" / "detect-people"
    if not binary.exists() or binary.stat().st_mtime < source.stat().st_mtime:
        print("Preparing the local macOS person detector...", flush=True)
        subprocess.run(["swiftc", "-O", str(source), "-o", str(binary)], check=True, timeout=120)
    return binary


def check_people(binary, data, extension, folder):
    digest = hashlib.sha256(data).hexdigest()
    cached = folder / "cache" / f"people-{digest}.json"
    if cached.exists():
        result = json.loads(cached.read_text())
    else:
        with tempfile.NamedTemporaryFile(suffix=extension, dir=folder / "cache") as photo:
            photo.write(data)
            photo.flush()
            output = subprocess.run([str(binary), photo.name], check=True, capture_output=True, text=True, timeout=30)
        result = json.loads(output.stdout)
        if result.get("error"):
            raise ValueError(result["error"])
        result.pop("file", None)
        save_json(cached, result)
    if result.get("faces", 0) + result.get("bodies", 0) == 0:
        raise ValueError("No person detected in a people photo")
    return result


def inspect_image(data, args):
    with Image.open(io.BytesIO(data)) as source:
        if source.format not in ("JPEG", "PNG", "WEBP"):
            raise ValueError("Not a JPEG, PNG or WebP photograph")
        extension = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}[source.format]
        source.verify()
    with Image.open(io.BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        width, height = image.size
        if max(width, height) < args.min_long_edge or min(width, height) < args.min_short_edge:
            raise ValueError(f"Image too small: {width}x{height}")
        thumb = image.copy()
        thumb.thumbnail((360, 280))
        gray = image.convert("L").resize((64, 64))
        stats = ImageStat.Stat(gray)
        hsv = image.resize((64, 64)).convert("HSV")
        saturation = ImageStat.Stat(hsv).mean[1] / 255
        return extension, thumb, {
            "width": width, "height": height, "orientation": orientation(width, height),
            "dhash": fingerprint(image), "brightness": round(stats.mean[0] / 255, 3),
            "contrast": round(stats.stddev[0] / 255, 3), "saturation": round(saturation, 3),
        }


def write_outputs(folder, rows, plan):
    rows = sorted(rows, key=lambda x: (x["category"], x["id"]))
    save_json(folder / "manifest.json", {"version": 2, "updated_at": utc_now(), "images": rows})
    counts = Counter(x["category"] for x in rows)
    summary = {
        "total": len(rows), "target": sum(x["count"] for x in plan.values()),
        "categories": {key: {"downloaded": counts[key], "target": value["count"]} for key, value in plan.items()},
        "orientations": dict(Counter(x["orientation"] for x in rows)),
        "unique_creators": len(set(creator_key(x) for x in rows)),
        "max_images_per_creator": max(Counter(creator_key(x) for x in rows).values(), default=0),
        "unique_countries": len(set(x["country"] for x in rows if x["country"])),
        "bytes": sum(x["bytes"] for x in rows),
        "license": "Unsplash Dataset Lite terms: internal ML training only; do not publish or redistribute. " + TERMS_URL,
        "review_status": "Candidate photos: inspect subject labels and suitability before creating edits. No train/test split assigned.",
    }
    save_json(folder / "summary.json", summary)
    cards = []
    for row in rows:
        esc = html.escape
        cards.append(
            f'<article data-category="{esc(row["category"])}"><a href="{esc(row["file"])}">'
            f'<img loading="lazy" src="{esc(row["thumbnail"])}" alt="{esc(row["title"])}"></a>'
            f'<b>{esc(row["category"])} · {row["width"]} × {row["height"]}</b>'
            f'<p>{esc(row["title"][:180])}</p><small>{esc(row["id"])} · {esc(row["term"])}<br>'
            f'{esc(row["creator"])} · Unsplash · <a href="{esc(row["source_url"])}">Source</a></small></article>'
        )
    options = ''.join(f'<option>{html.escape(c)}</option>' for c in plan)
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PixelStretch training photos</title><style>
body{font:15px system-ui;background:#15171b;color:#e5e7eb;margin:24px}h1{font-size:28px}
header{position:sticky;top:0;background:#15171bf2;padding:12px 0;z-index:1}a{color:#9bbfff}
select,input{font:inherit;padding:9px;margin-right:12px;background:#242831;color:white;border:1px solid #555;border-radius:6px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px}
article{background:#22262e;padding:12px;border-radius:9px;overflow-wrap:anywhere}img{width:100%;height:220px;object-fit:contain;background:#111}
b{display:block;margin-top:10px}p{font-size:13px;min-height:32px}small{color:#adb4c0}article[hidden]{display:none}</style>
<header><h1>PixelStretch · COUNT source photos</h1><p>Unsplash Lite dataset candidates for manual review. Local use only. Click an image to open the downloaded file.</p>
<select id="category"><option value="">All categories</option>OPTIONS</select><input id="search" placeholder="Search title, creator or ID"><span id="count"></span></header>
<main>CARDS</main><script>
const category=document.querySelector('#category'),search=document.querySelector('#search');
function filter(){let n=0;document.querySelectorAll('article').forEach(card=>{card.hidden=!!((category.value&&card.dataset.category!==category.value)||!card.textContent.toLowerCase().includes(search.value.toLowerCase()));if(!card.hidden)n++});document.querySelector('#count').textContent=n+' photos'}
category.addEventListener('change',filter);search.addEventListener('input',filter);filter();</script></html>'''
    (folder / "index.html").write_text(page.replace("COUNT", str(len(rows))).replace("OPTIONS", options).replace("CARDS", '\n'.join(cards)))
    for category in plan:
        group = [row for row in rows if row["category"] == category]
        if not group:
            continue
        columns, cell_w, cell_h = 5, 240, 205
        sheet = Image.new("RGB", (columns * cell_w, math.ceil(len(group) / columns) * cell_h), "#15171b")
        draw = ImageDraw.Draw(sheet)
        for index, row in enumerate(group):
            with Image.open(folder / row["thumbnail"]) as thumb:
                thumb.thumbnail((cell_w - 10, cell_h - 35))
                x, y = (index % columns) * cell_w, (index // columns) * cell_h
                sheet.paste(thumb, (x + (cell_w - thumb.width) // 2, y))
                draw.text((x + 5, y + cell_h - 30), f'{index + 1:02} {row["term"]}'[:32], fill="white")
                draw.text((x + 5, y + cell_h - 16), row["id"][-24:], fill="#aab0bb")
        sheet.save(folder / "contact-sheets" / f"{category}.jpg", quality=85)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT)
    parser.add_argument("--plan", type=Path, default=ROOT / "categories.json")
    parser.add_argument("--limit", type=int, help="Stop after this many total images (useful for a smoke run)")
    parser.add_argument("--category", choices=list(json.loads((ROOT / "categories.json").read_text())))
    parser.add_argument("--max-per-creator", type=int, default=2)
    parser.add_argument("--long-edge", type=int, default=2048, help="Longest edge requested from the Unsplash image CDN")
    parser.add_argument("--min-long-edge", type=int, default=1600)
    parser.add_argument("--min-short-edge", type=int, default=800)
    parser.add_argument("--pool-factor", type=int, default=8,
                        help="Sample from the category's most downloaded photos, this many times its quota")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-people-detector", action="store_true", help="Disable the optional macOS Vision person filter")
    parser.add_argument("--refresh-gallery", action="store_true", help="Rebuild reports without network requests")
    args = parser.parse_args()
    if any(x < 1 for x in [args.max_per_creator, args.long_edge, args.min_long_edge, args.min_short_edge, args.pool_factor]) or (
            args.limit is not None and args.limit < 1):
        parser.error("Counts and dimensions must be positive")
    if args.min_long_edge > args.long_edge:
        parser.error("--min-long-edge cannot exceed --long-edge")
    folder = args.output.resolve()
    for part in ["images", "thumbnails", "contact-sheets", "cache"]:
        (folder / part).mkdir(parents=True, exist_ok=True)
    plan = json.loads(args.plan.read_text())
    for key, config in plan.items():
        if not re.fullmatch(r"[a-z0-9_]+", key) or config["count"] < 1 or not config["terms"]:
            parser.error("Invalid category plan")
    manifest = folder / "manifest.json"
    rows = json.loads(manifest.read_text())["images"] if manifest.exists() else []
    exclusion_file = ROOT / "exclude.json"
    exclusions = json.loads(exclusion_file.read_text()) if exclusion_file.exists() else {}
    # A missing or altered file is re-fetched on resume, rather than counted as complete.
    valid = []
    for row in rows:
        path = folder / row["file"]
        if row["id"] in exclusions:
            if path.exists():
                (folder / "excluded").mkdir(exist_ok=True)
                path.replace(folder / "excluded" / path.name)
            continue
        if row.get("provider") == "unsplash" and path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == row["sha256"]:
            valid.append(row)
    rows = valid
    if args.refresh_gallery:
        print(json.dumps(write_outputs(folder, rows, plan), indent=2))
        return 0
    categories = [args.category] if args.category else list(plan)
    counts = Counter(x["category"] for x in rows)
    if all(counts[c] >= plan[c]["count"] for c in categories) and not (args.limit and len(rows) < args.limit):
        print(json.dumps(write_outputs(folder, rows, plan), indent=2))
        return 0
    print("Reading the Unsplash Lite dataset...", flush=True)
    candidates = load_candidates(dataset_tables(folder), plan, args)
    http = HTTP()
    people_detector = prepare_people_detector(folder, not args.no_people_detector and "people" in categories)
    seen = {x["id"] for x in rows} | set(exclusions)
    creators = Counter(creator_key(x) for x in rows)
    term_counts = Counter((x["category"], x["term"]) for x in rows)
    stop = False

    def add(row):
        """Download one candidate; returns True when it joins the collection."""
        seen.add(row["id"])
        try:
            data = http.get(row["download_url"])
            digest = hashlib.sha256(data).hexdigest()
            if any(x["sha256"] == digest for x in rows):
                return False
            extension, thumb, features = inspect_image(data, args)
            if row["category"] == "people" and people_detector:
                features["person_detection"] = check_people(people_detector, data, extension, folder)
            if any(hamming(x["dhash"], features["dhash"]) <= 5 for x in rows):
                return False
            row.update(features)
            row.update({"sha256": digest, "bytes": len(data), "downloaded_at": utc_now(), "review_status": "pending"})
            row["file"] = f"images/{row['category']}/{row['id']}{extension}"
            row["thumbnail"] = f"thumbnails/{row['id']}.jpg"
            destination = folder / row["file"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(extension + ".part")
            temporary.write_bytes(data)
            temporary.replace(destination)
            thumb.save(folder / row["thumbnail"], quality=85)
        except RateLimited:
            raise
        except Exception as exc:
            with (folder / "errors.jsonl").open("a") as log:
                log.write(json.dumps({"time": utc_now(), "id": row["id"], "url": row["download_url"], "error": str(exc)}) + "\n")
            return False
        rows.append(row)
        creators[creator_key(row)] += 1
        counts[row["category"]] += 1
        term_counts[row["category"], row["term"]] += 1
        save_json(manifest, {"version": 2, "updated_at": utc_now(), "images": rows})
        print(f"  {len(rows):3} | {row['category']} {counts[row['category']]}/{plan[row['category']]['count']} | "
              f"{row['term']} | {row['title'][:70]}", flush=True)
        return True

    try:
        for category in categories:
            config = plan[category]
            if stop or counts[category] >= config["count"]:
                continue
            # Popularity is the quality signal; shuffling the top of the ranking keeps variety.
            ranked = sorted(candidates[category], key=lambda x: x["downloads"], reverse=True)
            pool = ranked[:config["count"] * args.pool_factor]
            random.Random(f"{args.seed}:{category}").shuffle(pool)
            queues = defaultdict(list)
            for row in pool:
                queues[row["term"]].append(row)
            print(f"[{category}] {counts[category]}/{config['count']}; {len(pool)} of {len(ranked)} candidates "
                  f"across {len(queues)} terms", flush=True)
            term_cap = max(3, math.ceil(config["count"] / len(config["terms"])) * 2)
            # Round-robin across terms; relax the per-term cap only if strict spreading cannot fill the quota.
            for relaxed in (False, True):
                progressed = True
                while progressed and counts[category] < config["count"] and not stop:
                    progressed = False
                    for term, queue in queues.items():
                        if counts[category] >= config["count"]:
                            break
                        if args.limit and len(rows) >= args.limit:
                            stop = True
                            break
                        if not relaxed and term_counts[category, term] >= term_cap:
                            continue
                        # Prefer the orientations this category has least of; the sort is stable.
                        aspects = Counter(x["orientation"] for x in rows if x["category"] == category)
                        queue.sort(key=lambda x: aspects[orientation(x["original_width"], x["original_height"])])
                        while queue:
                            row = queue.pop(0)
                            if row["id"] in seen or creators[creator_key(row)] >= args.max_per_creator:
                                continue
                            if add(row):
                                progressed = True
                                break
    except (KeyboardInterrupt, RateLimited) as exc:
        print(f"\nPaused: {exc or 'interrupted'}. Saved progress; rerun the same command to resume.", flush=True)
    finally:
        summary = write_outputs(folder, rows, plan)
        print(f"\nSaved {len(rows)} photos ({summary['bytes'] / 1024 ** 2:.1f} MB). Gallery: {folder / 'index.html'}", flush=True)
    if args.limit and len(rows) >= args.limit:
        return 0
    missing = {key: plan[key]["count"] - counts[key] for key in categories if counts[key] < plan[key]["count"]}
    if missing:
        print(f"Unfilled quotas: {missing}. Add terms, raise --pool-factor, or loosen the size limits and rerun.", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
