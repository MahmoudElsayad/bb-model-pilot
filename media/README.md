# README video assets

The overview is a silent, caption-driven video with six scenes.
Its example task and helper illustrate the workflow.
It contains no measured savings or task performance claims.

- `model-pilot-overview.mp4` is the 32-second, 1280 × 720 H.264 video at 24 frames per second, with `yuv420p` pixels and fast-start metadata.
- `model-pilot-preview.gif` is the complete looping preview at 960 × 540 and eight frames per second.
- `model-pilot-poster.png` is the static opening frame.
- `model-pilot-transcript.md` is the accessible text equivalent.
- `model-pilot-connection.png` is the existing product screenshot used in the closing scene.

The Connection screenshot contains no personal thread titles, local file paths, or API keys.
The renderer uses local fonts, Pillow, and ffmpeg with `libx264`.
It needs no network access.

From the repository root, run:

```sh
python3 scripts/render-model-pilot-video.py
```

Set `PILOT_FONT_REGULAR` and `PILOT_FONT_BOLD` to local font files if Arial on macOS or DejaVu Sans on Linux is unavailable.
An optional `--contact-sheet /absolute/path/to/contact-sheet.jpg` extracts six keyframes from the encoded video for review.
Use `--stills-dir /absolute/path/to/stills` to render individual scene previews without encoding a video.

The README links the GIF preview to the MP4.
GitHub can display the GIF inline without relying on a video HTML tag.
The adjacent video, static poster, and transcript links provide alternatives.
