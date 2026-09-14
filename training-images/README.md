# Auto Stretch source photos

This folder contains a downloader and a local collection of 300 source-photo
candidates for making and rating stretch edits. It does not contain trained
weights or good/bad edit labels.

## Run

From the repository root:

```sh
python3 -m venv training-images/.venv
training-images/.venv/bin/python -m pip install -r training-images/requirements.txt
training-images/.venv/bin/python training-images/download.py
```

No API key is required. Photos come only from the
[Unsplash Lite dataset](https://github.com/unsplash/datasets): 25,000 photos,
almost all from Unsplash's editorial feed. The first run downloads the dataset
archive (about 305 MB) to `cache/`, resuming a partial download on rerun, then
fetches each selected photo from the Unsplash image CDN. Category quotas and
subject terms are in `categories.json`:

| Category | Photos |
| --- | ---: |
| People | 60 |
| Architecture and streets | 60 |
| Animals | 40 |
| Objects, food, vehicles | 40 |
| Plants | 35 |
| Landscapes | 35 |
| Interiors | 30 |

## License

The [Unsplash Dataset terms](https://github.com/unsplash/datasets/blob/master/TERMS.md)
allow downloading and storing Lite dataset photos and using them to train
machine learning models for internal business purposes. They forbid publishing,
disclosing or redistributing the data. Photos, the dataset and generated reports
are ignored by Git; keep them local and do not ship them with the app. A copy of
the terms is extracted to `cache/unsplash-lite/TERMS.md`.

## Files

- `images/<category>/`: downloaded JPEGs, longest edge 2048 px.
- `manifest.json`: one record per image, with Unsplash page and image URLs,
  photographer, caption, keywords, download and view counts, dimensions, SHA-256,
  perceptual hash, matched term and review status.
- `index.html`: gallery with category and text filters. Open directly in a browser.
- `contact-sheets/`: one visual overview per category.
- `summary.json`: category, orientation, creator, country and storage counts.
- `cache/`: dataset archive, extracted tables and the compiled person detector.
- `errors.jsonl`: failed downloads and rejected image records.
- `exclude.json`: reviewed IDs (`unsplash-<photo id>`) to reject, with reasons. On
  resume, matching files move to `excluded/` and their places are refilled; files
  are not deleted.

## Selection

Each photo is assigned to the category of the first subject term in its AI
caption (for example "brown tabby cat lying on white sofa" is an animal photo).
Photos whose caption or confident keywords indicate text, graphics or artwork are
skipped, as are panoramas beyond 2.5:1 and originals under 1600 px.

Within a category, candidates are ranked by Unsplash downloads as a quality
signal. The most downloaded `count × --pool-factor` photos are shuffled and
sampled round-robin across terms, capping each photographer at two images and
favoring less common orientations. The term cap is relaxed only when strict
spreading cannot fill the quota. Exact and near duplicates are removed.

On macOS with the Swift compiler installed, `detect-people.swift` is built in
`cache/` and Apple's built-in Vision face/person detection rejects people photos
with no detected person. It runs locally and downloads no additional model.
`--no-people-detector` disables it. It checks presence only, does not identify
anyone, and can miss people.

Captions and keywords come from third-party AI services, so labels can be wrong
and the dataset leans towards nature and travel photography. These are sampling
aids, not proof of semantic or demographic coverage; review the gallery.

## Resume and customize

Every successful download updates the manifest atomically. Rerun the same command
to resume. Existing files are checked against their SHA-256; missing or altered
files are not counted as complete. Rate limits are honored, including
`Retry-After`; long delays stop the run with progress saved. An unfilled quota
produces a nonzero exit status and an explicit report.

```sh
# Small smoke run (12 total images, starting with people)
training-images/.venv/bin/python training-images/download.py --limit 12

# Fill one category only
training-images/.venv/bin/python training-images/download.py --category interiors

# Sample from a wider, less popularity-filtered pool
training-images/.venv/bin/python training-images/download.py --pool-factor 20

# Rebuild the gallery and reports without network requests
training-images/.venv/bin/python training-images/download.py --refresh-gallery

# Use a separate collection and plan
training-images/.venv/bin/python training-images/download.py --output /tmp/stretch-photos --plan training-images/categories.json
```

`--limit` limits the total collection, including existing images. It does not
request that many additional images or change the category quotas. Increasing
quotas or adding terms appends photos; reducing quotas does not delete files.
A different `--seed` changes which photos are sampled for unfilled places.

## Before training

Use the gallery to check subjects, framing, silhouettes, background complexity,
lighting, color and portrait diversity. Keep an explicit record of removals and
manual category changes. This download is a candidate collection, not a curated
training set. The dataset license does not include model releases for people in
the photos.

Create the final train/validation/test split by original image and photo session
after review, and keep all crops and stretch variants of an original together.
No automatic split is assigned because a downloader cannot reliably identify
sessions, recurring people, or landmarks. Preserve the source ID in each edit's
record along with the exact stretch recipe and your preference label.
