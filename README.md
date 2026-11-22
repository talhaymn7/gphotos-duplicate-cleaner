# gphotos-duplicate-cleaner

A Chrome extension that finds duplicate photos and videos in your **Google Photos** library — right
in the browser, without downloading anything — and moves the ones you pick to Google Photos' trash.

- No Google Takeout, no API keys, no server: it runs entirely inside your logged-in photos.google.com tab.
- Detects re-compressed, resized and re-shared copies (e.g. WhatsApp), not just byte-identical files.
- Measures each copy's real resolution and suggests the best one to keep.
- Never deletes on its own: only items you select are moved to trash (recoverable for 60 days).

> **Note:** The extension UI is currently in Turkish.

## Install

The extension isn't on the Chrome Web Store; load it unpacked (works in Chrome, Edge, Brave and other
Chromium browsers):

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder (the one containing `manifest.json`).
4. Open or reload **photos.google.com** — a *Kopya Bulucu* panel appears in the bottom-right corner.

After updating the code, click the ↻ reload button on the extension card **and refresh any open
Google Photos tabs**; otherwise the old script on the page loses its connection to the extension.

## Usage

1. **Scan** — on the main Photos page, click **Kopyaları tara** (*Scan for duplicates*). The page
   scrolls through your whole library by itself and records every item (~10–15 min for 20k items).
   Keep the tab visible while it runs: Chrome throttles hidden tabs and Google Photos doesn't load
   off-screen thumbnails. You can work in another window as long as this one isn't minimized or fully covered.
2. **Review** — click **Sonuçlar** (*Results*) or the extension's toolbar icon. The results page
   fingerprints each thumbnail (a few minutes the first time; cached afterwards) and shows duplicate groups.
   - The highest-resolution copy in each group is marked **tutulacak** (*keep*).
   - 🔍 opens a large preview so you can compare sharpness.
   - **Hassasiyet** (*sensitivity*) slider: lower = only near-identical images, higher = looser matches.
   - Group labels, based on the capture time Google Photos shows:

     | Label | Meaning |
     |---|---|
     | *Aynı anda çekilmiş* — same second | Almost certainly copies of the same photo |
     | *Seri çekim* — 1–60 s apart | Burst shots; frames may differ, check before deleting |
     | *Farklı zamanlarda* — further apart | Possibly a re-shared or re-downloaded copy |

3. **Select** — click thumbnails to mark them for deletion, or use **En iyisi hariç seç**
   (*select all but the best*) per group or for every group at once. Selecting every item of a
   group is blocked, so at least one copy always stays.
4. **Trash** — click **Çöp kutusuna taşı** (*Move to trash*). A small Google Photos window opens and
   does the work; don't close or use it until it finishes. Two modes:
   - **Hızlı (toplu)** — *fast*: ticks the selected items in the library grid and trashes them in one go.
     Every click must raise Google's "N selected" counter by exactly one, and the total must match
     before anything is deleted; otherwise the selection is cleared and nothing is removed.
   - **Tek tek** — *one by one*: opens each item and trashes it. Slower (a few seconds per item);
     offered automatically if the fast mode stops.

   Trashed items stay in Google Photos' **Trash** for 60 days and can be restored from there.

Progress is saved: a stopped scan, unfinished fingerprinting or your selection all survive closing the page.

## How it works

| File | Role |
|---|---|
| `extension/content.js` | Runs on photos.google.com: the panel, auto-scrolling scan, and trashing (grid bulk-select or per item) |
| `extension/results.html`, `results.js` | Results page: downloads thumbnails, computes fingerprints, measures resolution, groups and manages selection |
| `extension/hash.js` | Perceptual hash (pHash, 64-bit DCT — bit-identical to Python's `imagehash.phash`) and BK-tree grouping by Hamming distance |
| `extension/background.js` | Opens the results page |

- **Finding duplicates:** each thumbnail is reduced to a 64-bit perceptual hash that survives resizing
  and re-compression. Items whose hashes differ by at most *sensitivity* bits (and whose aspect ratios
  match) are grouped. Photos and videos are compared separately; videos by their cover frame.
- **Resolution:** the extension starts downloading the full-size image and stops as soon as the
  JPEG/PNG header with the dimensions arrives — usually after a few KB.
- **Storage:** everything (item list, hashes, sizes, selection) lives in `chrome.storage.local` on
  your machine. Nothing is sent anywhere except the requests to Google Photos your browser already makes.

### Permissions

| Permission | Why |
|---|---|
| `photos.google.com` | Inject the panel, scan the library, trash items |
| `*.googleusercontent.com`, `*.usercontent.google.com` | Download thumbnails with your session (Google returns 403 otherwise) |
| `storage`, `unlimitedStorage` | Cache scan results for large libraries |

## Limitations

- Google offers no public API for this (since 2025 the Photos Library API only exposes items an app
  uploaded itself), so the extension reads the Google Photos web page. If Google changes its markup,
  parts may break. The panel's **Tanılama** (*Diagnostics*) button copies the page details needed to fix it.
- Original file size isn't visible from the web UI; "best copy" uses resolution, then the size of
  the image Google serves.
- Video durations aren't read, so similar-looking videos are grouped by cover frame only.

## License

[Apache 2.0](LICENSE)
