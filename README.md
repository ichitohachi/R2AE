# R2AE

**[日本語 README](README.ja.md)**

A bridge script that sends clips from a DaVinci Resolve timeline to After Effects, reproducing their placement, scale, position, rotation, anchor point, speed, and audio.

This is not a persistent link like Adobe Dynamic Link. Each time you run it, the script writes out the current timeline state as JSON and After Effects rebuilds it as a new composition — a one-shot transfer. After the transfer, there is no ongoing dependency between Resolve and After Effects; editing either one has no effect on the other.

**This is a convenience script, not a data interchange format.** Unlike EDL, AAF, or XML, it makes no accuracy guarantees. The transform math (scale, position, anchor point, etc.) was derived empirically by comparing Resolve's inspector values against After Effects' rendered output, not from official specifications. It's built to save time on a repetitive manual task, not to be a certified, lossless bridge between the two applications. Always check the result against the original timeline before relying on it.

## What it does

- Sends all clips overlapping the timeline's IN/OUT range in one go (clips crossing the range boundary are trimmed at the edge)
- Supports multiple tracks (video and audio). Respects track-level and clip-level enable/disable
- Matches the composition resolution to the timeline settings
- Converts each clip's Zoom, Pan/Tilt, Rotation, Anchor Point, Flip, and Opacity into AE's Scale / Position / Rotation / Anchor Point / Opacity
- Reproduces constant-speed retiming via AE's Time Remap, with a check to avoid misreading frame-rate conforms as speed changes
- Merges duplicate audio when stereo is split across L/R tracks
- Prevents double playback of audio linked to a video clip
- Reuses already-imported footage (sending the same file multiple times won't create duplicates in the Project panel)

## What it doesn't do

- Real-time sync (this is not a persistent link like Dynamic Link)
- Transitions, keyframed animation, speed ramps (variable speed)
- Color grading, Resolve-side effects, cropping, compound clips, Fusion clips, titles
- Pitch / Yaw (3D tilt) — not supported due to differences in projection models between the two applications

## Requirements

- DaVinci Resolve (free or Studio; Lua scripting must be enabled)
- Adobe After Effects (2024 or later recommended)
- macOS or Windows

Testing has been done on macOS with DaVinci Resolve and After Effects 2026.

**The delivery mechanism to After Effects differs by OS.**

- **macOS**: Uses AppleScript to tell After Effects to run the script directly. No setup beyond installing the two files is needed — running `r2ae` is enough.
- **Windows**: Detects the running After Effects process and calls `AfterFX.exe -r` to run the script directly against it. **After Effects needs to already be running** — if it isn't, R2AE doesn't launch it automatically; the Resolve console says so, and the JSON is left written for you to pick up once you've opened After Effects and run `r2ae` again. If multiple AE versions are installed, the clips go to whichever version is currently running.

## Installation

### 1. Place r2ae_receive.jsx

```
macOS   : ~/Documents/ae_bridge/r2ae_receive.jsx
Windows : %USERPROFILE%\Documents\ae_bridge\r2ae_receive.jsx
```

Create the `ae_bridge` folder if it doesn't exist.

### 2. Place r2ae.lua

```
macOS   : ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/r2ae.lua
Windows : %APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\r2ae.lua
```

After placing it, **fully restart DaVinci Resolve**. The scripts folder is only scanned once, at startup.

### 3. After Effects settings

In Preferences > Scripting & Expressions, enable "Allow Scripts to Write Files and Access Network". If left off, loading the JSON will fail with an error.

### 4. (Optional) r2ae_debug.lua

A diagnostic script for inspecting the raw values Resolve returns. Place it in the same Utility folder to add it to the menu. Not required for normal operation.

## Usage

**On Windows, open After Effects first.** If it isn't already running, R2AE can't launch it automatically (details below).

1. In the Resolve timeline, mark the range you want to send using `I` / `O` (In/Out points)
2. Run Workspace > Scripts > Utility > `r2ae`

**macOS**: After Effects launches (or comes to the foreground) and a new composition is built automatically.

**Windows**: After the JSON is written, R2AE detects the running After Effects process and sends the script to it directly via `AfterFX.exe -r`. **After Effects needs to be open first** — if it isn't, the Console says so and the JSON stays written for later. If direct execution doesn't work in your environment, open `r2ae_receive.jsx` manually via File > Scripts > Run Script File.

All clips on any track that overlap the IN/OUT range are included. Clips crossing the range boundary are trimmed at the edge, and the composition's duration matches the marked range exactly. If no IN/OUT range is set, nothing is sent.

## Configuration

Behavior can be changed via variables at the top of `r2ae.lua`.

| Variable | Description |
|---|---|
| `AUDIO_MODE` | `"auto"` (default) / `"video_only"` / `"separate"` — how linked audio is handled |
| `INPUT_SCALING` | `"fit"` (default) / `"fill"` / `"stretch"` / `"none"` — should match Resolve's project setting for "Input Sizing Preset" |
| `ROTATION_SIGN` | `1` / `-1` (default) — corrects rotation direction |
| `ENABLE_SPEED` | `true` (default) — whether speed changes are reflected as Time Remap |
| `RESPECT_TRACK_ENABLE` | `true` (default) — exclude disabled tracks |
| `RESPECT_CLIP_ENABLE` | `true` (default) — exclude disabled clips (the `D` key state) |

## How it works

1. `r2ae.lua` reads the timeline via the Resolve Scripting API and writes each target clip's file path, trim points, transform values, and speed to a JSON file
2. **macOS**: `osascript` tells After Effects to run `r2ae_receive.jsx` directly
3. **Windows**: finds the running `AfterFX.exe` process via `Get-Process` and calls `AfterFX.exe -r` to run `r2ae_receive.jsx` directly (After Effects must already be running; if this doesn't work in your environment, manual execution can pick up the JSON instead)
4. `r2ae_receive.jsx` reads the JSON, imports the footage, and builds the composition

After that, there is no remaining connection between the two applications.

## About the transform conversion

Resolve's inspector values (Zoom / Pan / Tilt / Anchor Point / Rotation) live in a coordinate system shaped by the timeline resolution, the source resolution, and the project's input scaling setting. In particular, Anchor Point in Resolve behaves as a pivot rather than a simple offset — moving it also moves the clip's on-screen position. This tool derives the conversion formulas from measured, real-world values (see the comments in `r2ae.lua` for details).

## Known limitations

- The Resolve Scripting API has no way to query which clips are currently selected on the timeline. Because of this, range selection is done via IN/OUT marks. If you need to send only specific clips, combine this with track/clip enable-disable
- The check that distinguishes a frame-rate conform from an actual speed change is heuristic. If you notice a misclassification, please file an issue with the measured values (from the Resolve Console log)
- Pitch / Yaw are not supported, since Resolve and After Effects use different projection models and cannot be reconciled accurately
- Windows automatic execution requires After Effects to already be running. If it isn't, R2AE doesn't launch it automatically — the Console will say so, and the JSON stays written so you can pick it up later (open After Effects, then run the script manually)

## License

MIT License. See `LICENSE`.

## Disclaimer

This tool only uses the officially documented scripting APIs of DaVinci Resolve and After Effects. It does not rely on either application's internal implementation or any undocumented API, but future versions of either application may change API behavior in ways that break this tool. Provided with no warranty. Please verify behavior in a test environment before relying on this for important projects.
