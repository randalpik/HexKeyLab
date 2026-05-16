# Finale 25 + Wine + RGP Lua spike

Goal: verify the three load-bearing assumptions of Path A (HKL as MIDI proxy +
color/spelling side-channel into Finale 25 via RGP Lua) before committing to
the full build-out.

Total time budget: ~60 minutes. No HKL code changes required.

## Setup

1. Download RGP Lua from <https://robertgpatterson.com/-fininfo/-rgplua/rgplua.html>.
   The zip contains a Windows DLL and sample scripts.
2. Install into the Finale 25 plug-ins folder under your Wine prefix. The
   conventional path is:
   `~/.wine/drive_c/ProgramData/MakeMusic/Finale 25/Plug-ins/`
   (substitute your prefix path; check where your existing Finale 25 install
   keeps its plug-ins.)
3. Launch Finale 25 under Wine.

## S1 — `spike-1-hello.lua`

Verify the plugin loads and can execute scripts.

- In Finale, open `Plug-ins → RGP Lua → Edit Script`.
- Paste the contents of `spike-1-hello.lua` and run.
- **Success**: an alert dialog shows the Lua version and Finale environment info.
- **Failure**: no RGP Lua menu, or the script errors.

## S2 — `spike-2-color.lua`

Verify per-notehead color works.

- Open any document in Finale, enter a few notes in any layer.
- Select one note (Speedy or Simple entry, cursor on the note).
- Run `spike-2-color.lua` via `Plug-ins → RGP Lua → Run Script…`.
- **Success**: the selected notehead renders in magenta. Multi-note chord:
  every notehead colored.
- **Failure**: notes unchanged, or an error about a missing setter method.
  If it errors on the setter line, edit the script to try the alternates
  documented inside.

## S3 — `spike-3-poll.lua`

Verify modeless dialog + LuaSocket polling under Wine.

- Run `spike-3-poll.lua`. A small dialog titled "HKL bridge spike" opens
  with the text "waiting…".
- From a Linux terminal:
  ```
  echo "hello" | nc 127.0.0.1 12345
  ```
- **Success**: the dialog updates to `got: hello`.
- **Failure modes**:
  - `module 'socket' not found` → LuaSocket isn't bundled with RGP Lua's
    Lua. Look for alternate networking modules in the RGP Lua docs.
  - Dialog opens but doesn't update → timer/event loop issue under Wine.
  - Dialog blocks Finale → `ExecuteModal` is wrong, try `ShowModeless`.

## Decision matrix

After running the three spikes, fill in:

| Spike | Result | Notes |
|---|---|---|
| S1 | ✓ / ✗ | |
| S2 | ✓ / ✗ | (which setter worked) |
| S3 | ✓ / ✗ | |

| S1 | S2 | S3 | Decision |
|---|---|---|---|
| ✓ | ✓ | ✓ | Commit to Path A — build the HKL proxy + bridge + plugin. |
| ✓ | ✓ | ✗ | Path A viable with a different IPC (file polling / named pipe). |
| ✓ | ✗ | – | Path A loses its color story. Fall back to Path C2 (MusicXML). |
| ✗ | – | – | Plugin doesn't load. Fall back to Path C2 or MuseScore 4. |

## Spike result (recorded 2026-05-16)

| Spike | Result | Notes |
|---|---|---|
| S1 | ✓ | RGP Lua loads and runs scripts under Wine + Finale 25. |
| S2 | ✗ | All four candidate color APIs are `nil`. Further research confirms the **PDK Framework exposes no per-notehead color setter anywhere** — `FCNoteheadMod`, `FCEntryAlterMod`, `FCNote`, `FCNoteEntry` all have no color members. The only `Set*Color*` methods in the entire framework are `FCGridsGuidesPrefs`. Per-note color in Finale 25 is achievable in the UI but not scriptable via PDK/RGP Lua. |
| S3 | ✗ | LuaSocket not bundled. RGP Lua ships `luaosutils.internet`, which is HTTPS-outbound-only (no TCP server in Finale). Workable by flipping direction (HKL hosts HTTP, Finale polls), but moot given S2. |

**Conclusion: Path A is dead.** The headline value of bridging HKL into Finale was per-(q,r) notehead color; without that, the side-channel adds nothing the user doesn't already have from existing Finale Speedy Entry. Workarounds (4-layer routing, colored notehead-character glyphs) are far too limited for HKL's color palette.

The remaining live paths are documented in the main planning file at
`/home/max/.claude/plans/now-that-we-have-idempotent-pudding.md` and summarized:

- **Path B (MuseScore 4 + QML plugin)** — MuseScore's plugin API *does* expose `note.color`. Same architectural shape (HKL MIDI proxy + side-channel) but on native Linux with no Wine. One known chord-color bug to verify.
- **Path C-Full** — HKL becomes a score editor with bidirectional `.hkl ↔ .musicxml`. Most code, fully captured value in HKL.
