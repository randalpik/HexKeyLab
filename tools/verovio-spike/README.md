# Verovio + BroadcastChannel spike (HKL Composer Phase 0)

Verifies the five load-bearing assumptions of the HKL Composer architecture
before committing to Phase 1. Single self-contained HTML file; no build step
required.

## How to run

The Verovio toolkit loads from the official CDN (`verovio.org`). Since the
spike runs against `file://`, **most browsers require launching it via a
local web server**:

```
cd /home/max/HexKeyLab
python3 -m http.server 8765
# then open http://localhost:8765/tools/verovio-spike/
```

Or use the existing Vite dev server (`npm run dev`) and navigate to
`/tools/verovio-spike/index.html`.

For V5 cross-tab testing, open the same URL in **two browser tabs** of the
same browser instance (BroadcastChannel is same-origin only).

## What each test verifies

| ID | Verifies | Pass criteria |
|---|---|---|
| V1 | Verovio renders MEI with per-notehead `@color` | Score appears in pane; noteheads are colored individually (each chord-note in a different hue). |
| V2 | Click-to-locate via `xml:id` → SVG `id` mapping | Clicking any notehead logs its id and `getElementAttr(id)` JSON. |
| V3 | In-memory MEI mutation + re-render | Pressing V3 appends a new chord to the layer; score re-renders without page reload. |
| V4 | Playback cursor follow via `getElementsAtTime(ms)` | Cursor highlight steps through the notes over ~6 s; each step logs the active note ids. |
| V5 | BroadcastChannel cross-tab messaging | "Send ping" from one tab updates the log in another tab; round-trip latency is reported. "Broadcast simulated held-keys" verifies the planned HKL→Composer payload shape. |

## Decision matrix

| V1 | V2 | V3 | V4 | V5 | Decision |
|---|---|---|---|---|---|
| ✓ | ✓ | ✓ | ✓ | ✓ | **Commit to Phase 1.** All four Verovio assumptions hold; cross-tab transport works. |
| ✓ | ✓ | ✓ | ✓ | ✗ | BroadcastChannel issue (unlikely; well-supported). Fall back to `postMessage` via `window.opener` or a local WS bridge. |
| ✓ | ✓ | ✓ | ✗ | – | Playback cursor needs different mechanism (parse MIDI manually, or drive cursor directly from Composer's score state). Architecturally minor. |
| ✓ | ✓ | ✗ | – | – | Re-render flow issue (very unlikely). Reconsider mutation strategy. |
| ✓ | ✗ | – | – | – | Click-mapping issue (unlikely; well-documented). Fall back to data attributes. |
| ✗ | – | – | – | – | Verovio doesn't render with `@color`. Should not happen per MEI 5 spec — investigate version. |

## Notes

- The MEI fixture in V1 uses arbitrary colors not derived from HKL's lattice — that's intentional for the spike (verifying the rendering path, not the color values).
- V4 simulates playback cursor follow by polling `getElementsAtTime` over time. It does NOT play audio in the spike — that's HKL's job in the real architecture. The point is to verify Verovio's timing mechanism, not to test audio.
- V5 acts as both sender and receiver in the same page. To test true cross-tab, open the page in two tabs and click "Send ping" in one — the log in the other tab should show the receipt.
