# PixelStretch

A local photo editor for selecting subjects, extracting layers, and stretching pixels along editable paths. The web application uses React, TypeScript, Vite, and Transformers.js. The separate native iOS implementation is in `Sources/`.

## Run the web app

Use Node.js 24+ and Chrome (also used by the browser tests):

```sh
npm ci
npm run dev
```

Open the printed localhost URL and choose a JPEG, PNG, WebP, or HEIC photo. The photo stays on your device. Models download from Hugging Face when you first use a selection tool and are cached by the browser.

- **Auto:** selects the main foreground subject using [BiRefNet Lite 512](https://huggingface.co/studioludens/birefnet-lite-512). On the supplied Pisa example this includes the tower and cathedral, matching `piza_selected.png`.
- **Tap:** click to include an object; Alt-click to exclude a region. Uses [SlimSAM](https://huggingface.co/Xenova/slimsam-77-uniform).
- **Brush:** paint approximately over an object to provide a bounding-box prompt to SlimSAM. Hold Alt to erase brush strokes.
- **Copy / Cut to new layer:** extracts the selection. Hide the Background layer before exporting a transparent cutout.
- **Stretch:** draw a sample path, shape and lock it, then drag to pull out a band.

Automatically lifted subjects use a narrow inward feather to blend their edges
into the stretch while retaining sharp interior detail. Preview and PNG export
share this blending, including for reopened projects. The original layer pixels
remain in the project, so saving and reopening never compounds the feather.

Click an active selection tool again to restart or retry it. Escape clears the selection and returns to Move. Undo/redo supports Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z.

## Selection implementation

Model loading, preprocessing, and inference run in a dedicated worker. Requests are serialized to keep SAM image embeddings and prompts together; request IDs discard stale results after a tool/layer change or deselection. Model failures appear in the editor and can be retried.

The analysis image is bounded to 1536 pixels on its longest side before reading pixels into JavaScript. Masks retain their own resolution and are mapped onto the original layer for preview/extraction. Original image and PNG export dimensions are preserved.

Auto uses the 512×512 BiRefNet export with ImageNet preprocessing and sigmoid output probabilities. Both models use fp32, try WebGPU first, and fall back to WASM when initialization fails. Auto also retries inference on WASM if GPU execution fails. Its weights are approximately 183 MB on first use. First-run downloads and CPU inference can take time; model loading no longer blocks photo import.

SlimSAM box prompts use corner labels 2 and 3 in its ONNX decoder's point input; point-only prompts include SAM's padding label. Brush masks accept a single half-opacity stroke. Mask resizing uses pixel-center bilinear interpolation.

## Validation

```sh
npm test            # mask geometry and brush regression tests
npm run test:e2e    # real Chrome + supplied piza.HEIC; downloads models
npm run build
npm run lint
```

The browser suite checks HEIC orientation/resolution, lazy model loading, Auto selection, transparent full-resolution PNG export, undo/redo, Tap, Brush, and stale-result handling. It writes a cutout and screenshot into `artifacts/segmentation/`.

The production smoke test runs with WebGPU disabled (start `npm run preview -- --host 127.0.0.1 --port 4173` first):

```sh
node scripts/check-production.mjs
```

To reproduce the old/new model comparison on macOS:

```sh
sips -s format jpeg piza.HEIC --out /tmp/pixelstretch-piza.jpg
npm run compare:models
python3 -m venv /tmp/pixelstretch-eval-venv
/tmp/pixelstretch-eval-venv/bin/pip install opencv-python-headless
/tmp/pixelstretch-eval-venv/bin/python scripts/evaluate-pisa.py
```

On other platforms, provide an oriented JPEG as the first argument to `scripts/compare-models.mjs` and `scripts/evaluate-pisa.py`. The comparison runs fp32 models locally through the Node runtime. It writes masks, transparent cutouts, white-background previews, and `metrics.json`. OpenCV aligns the separately cropped/scaled white-background reference with SIFT/RANSAC before computing overlap.

Measured approximate foreground IoU on the supplied photo: **RMBG-1.4 42.9%; BiRefNet 95.8%; actual browser export 95.8%.** The reference has feathering and a white background, so these are approximate single-image comparisons, not general model accuracy. Thin railings and fine edges can still differ; use prompted selection when Auto chooses the wrong subject.

The compatible dependency audit fixes have been applied. Four reported high-severity dependency entries remain in the upstream Transformers.js Node dependency chain (`sharp`, `adm-zip`, and parents); npm currently offers no compatible automatic fix. These Node packages are used by the local comparison tooling, not the browser bundle.
