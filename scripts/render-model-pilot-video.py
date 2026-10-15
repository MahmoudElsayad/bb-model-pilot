#!/usr/bin/env python3
"""Render the README overview with Pillow and ffmpeg, without network access."""

import argparse
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "media"
WIDTH, HEIGHT, FPS = 1280, 720, 24
DURATIONS = (4, 5, 6, 6, 6, 5)
DURATION = sum(DURATIONS)
BG = "#282828"
SURFACE = "#31302e"
BORDER = "#45423c"
CREAM = "#ede1bb"
SECONDARY = "#cdc1a2"
ORANGE = "#ec8743"
ACCENT_TEXT = "#f3c8a4"


def resolve_font(variable, candidates):
    override = os.environ.get(variable)
    for candidate in ([override] if override else []) + candidates:
        if Path(candidate).is_file():
            return candidate
    raise SystemExit(f"Set {variable} to a local TrueType font file.")


REGULAR = resolve_font("PILOT_FONT_REGULAR", [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
])
BOLD = resolve_font("PILOT_FONT_BOLD", [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
])
FONTS = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in FONTS:
        FONTS[key] = ImageFont.truetype(BOLD if bold else REGULAR, size)
    return FONTS[key]


def text(draw, xy, value, size=28, color=CREAM, bold=False):
    draw.text(xy, value, font=font(size, bold), fill=color, anchor="lt")


def line(draw, points, color=BORDER, width=2):
    draw.line(points, fill=color, width=width)


def panel(draw, box, accent=False):
    draw.rounded_rectangle(box, radius=6, fill=SURFACE, outline=ORANGE if accent else BORDER, width=2)


def arrow(draw, start, end, color=ORANGE):
    line(draw, (start, end), color, 3)
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    points = [end]
    for offset in (-0.55, 0.55):
        points.append((end[0] - 12 * math.cos(angle + offset), end[1] - 12 * math.sin(angle + offset)))
    draw.polygon(points, fill=color)


def base(index, title=None, eyebrow=None):
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    text(draw, (64, 36), "MODEL PILOT / BB", 19, SECONDARY, True)
    text(draw, (1095, 36), f"0{index + 1} / 06", 19, SECONDARY)
    line(draw, ((64, 78), (1216, 78)))
    if eyebrow:
        text(draw, (64, 116), eyebrow.upper(), 19, ACCENT_TEXT, True)
    if title:
        text(draw, (64, 156), title, 49, CREAM, True)
    return image, draw


def scene_intro():
    image, draw = base(0)
    text(draw, (64, 140), "Model Pilot", 88, CREAM, True)
    text(draw, (64, 270), "Right model.", 65, CREAM, True)
    text(draw, (64, 350), "Right effort.", 65, ORANGE, True)
    text(draw, (64, 478), "Automatic model selection", 29, SECONDARY)
    text(draw, (64, 520), "and focused helpers inside BB.", 29, SECONDARY)
    for y, label, detail in [(157, "Your task", "Describe the work"), (307, "Classifier", "Chooses the route"), (457, "Coding agent", "Does the work")]:
        panel(draw, (832, y, 1216, y + 112), label == "Classifier")
        text(draw, (860, y + 24), label, 30, CREAM, True)
        text(draw, (860, y + 68), detail, 23, SECONDARY)
    arrow(draw, (1024, 273), (1024, 300))
    arrow(draw, (1024, 423), (1024, 450))
    return image


def scene_task():
    image, draw = base(1, "Describe the task.", "Example routing")
    panel(draw, (64, 260, 590, 470))
    text(draw, (96, 292), "YOUR FIRST MESSAGE", 20, SECONDARY, True)
    text(draw, (96, 348), "Add search to this app.", 36, CREAM, True)
    text(draw, (96, 410), "Send it to Model Pilot in BB.", 26, SECONDARY)
    arrow(draw, (614, 365), (686, 365))
    text(draw, (720, 255), "CHOOSE A BB CLASSIFIER", 20, SECONDARY, True)
    for i, label in enumerate(("An available model", "Uses Codex sign-in", "or Claude Code sign-in")):
        y = 300 + i * 80
        panel(draw, (720, y, 1216, y + 64), i == 0)
        text(draw, (748, y + 19), label, 27, CREAM, True)
        if i == 0:
            text(draw, (1086, y + 22), "PICK", 18, ACCENT_TEXT, True)
    text(draw, (64, 596), "The classifier receives task text and routing questions.", 29, SECONDARY)
    return image


def scene_route():
    image, draw = base(2, "The first message sets the route.", "Main agent")
    for x, n, title, detail in [(64, "01", "Main model", "Matches the task"), (456, "02", "Reasoning effort", "Sets reasoning depth"), (848, "03", "Context window", "Sets context capacity")]:
        panel(draw, (x, 274, x + 368, 491))
        text(draw, (x + 28, 303), n, 25, ORANGE, True)
        text(draw, (x + 28, 364), title, 31, CREAM, True)
        text(draw, (x + 28, 425), detail, 25, SECONDARY)
    line(draw, ((64, 544), (1216, 544)))
    text(draw, (64, 578), "Later messages keep the main model", 32, CREAM, True)
    text(draw, (64, 622), "and its conversation history.", 29, SECONDARY)
    return image


def scene_helpers():
    image, draw = base(3, "Give helpers focused work.", "Example routing")
    panel(draw, (64, 274, 460, 503), True)
    text(draw, (96, 309), "MAIN AGENT", 20, ACCENT_TEXT, True)
    text(draw, (96, 368), "Build the feature", 32, CREAM, True)
    text(draw, (96, 427), "Keeps the conversation", 25, SECONDARY)
    arrow(draw, (464, 323), (782, 323))
    text(draw, (505, 279), "Focused task brief", 25, SECONDARY)
    arrow(draw, (782, 462), (464, 462))
    text(draw, (537, 490), "Result returns", 25, SECONDARY)
    panel(draw, (792, 274, 1216, 503))
    text(draw, (824, 309), "HELPER", 20, SECONDARY, True)
    text(draw, (824, 368), "Find search patterns", 31, CREAM, True)
    text(draw, (824, 427), "Starts with its own context", 25, SECONDARY)
    text(draw, (64, 586), "Helpers receive a brief, not the full conversation.", 31, CREAM, True)
    text(draw, (64, 633), "The main agent owns the final result.", 27, SECONDARY)
    return image


def scene_usage():
    image, draw = base(4, "Compare the recorded work.", "Usage")
    panel(draw, (64, 264, 600, 528))
    text(draw, (96, 295), "RECORDED USAGE", 20, SECONDARY, True)
    for y, value in [(353, "Main agent"), (405, "Helpers"), (457, "Classifier overhead")]:
        draw.rectangle((96, y + 7, 104, y + 23), fill=ORANGE)
        text(draw, (125, y), value, 29, CREAM)
    panel(draw, (624, 264, 1216, 528))
    text(draw, (656, 295), "PRICE COMPARISON", 20, SECONDARY, True)
    text(draw, (656, 355), "Same recorded agent tokens", 29, CREAM, True)
    text(draw, (656, 409), "at another model's price.", 29, CREAM)
    text(draw, (656, 476), "A scenario, not a measured saving.", 24, ACCENT_TEXT)
    text(draw, (64, 586), "Inspect tokens, model choices, and estimated costs.", 30, CREAM, True)
    text(draw, (64, 633), "The comparison does not measure task quality.", 27, SECONDARY)
    return image


def scene_connect():
    image, draw = base(5)
    text(draw, (64, 124), "START IN BB", 19, ACCENT_TEXT, True)
    text(draw, (64, 172), "Use your BB models.", 47, CREAM, True)
    text(draw, (64, 232), "Keep your agent sign-ins.", 47, CREAM, True)
    for y, number, title in [(338, "1", "Choose a BB classification model."), (416, "2", "Use your existing agent sign-in."), (494, "3", "Select Model Pilot. Send your task.")]:
        draw.rounded_rectangle((64, y, 103, y + 39), radius=3, fill=ORANGE)
        text(draw, (77, y + 8), number, 23, BG, True)
        text(draw, (123, y + 7), title, 27, CREAM)
    text(draw, (64, 596), "No separate API key for BB models.", 26, SECONDARY)
    text(draw, (64, 638), "Your provider subscription limits still apply.", 24, SECONDARY)
    text(draw, (664, 304), "ACTUAL BB CONNECTION", 19, SECONDARY, True)
    screenshot = Image.open(MEDIA / "model-pilot-connection.png").convert("RGB")
    screenshot = screenshot.crop((720, 235, 1408, 525))
    screenshot.thumbnail((552, 360), Image.Resampling.LANCZOS)
    image.paste(screenshot, (664, 346))
    draw = ImageDraw.Draw(image)
    draw.rectangle((663, 345, 664 + screenshot.width, 346 + screenshot.height), outline=BORDER, width=1)
    return image


def run(command, **kwargs):
    subprocess.run(command, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stills-dir", type=Path)
    parser.add_argument("--contact-sheet", type=Path)
    args = parser.parse_args()
    MEDIA.mkdir(exist_ok=True)
    scenes = [scene_intro(), scene_task(), scene_route(), scene_helpers(), scene_usage(), scene_connect()]
    scenes[0].save(MEDIA / "model-pilot-poster.png")
    if args.stills_dir:
        args.stills_dir.mkdir(parents=True, exist_ok=True)
        for index, scene in enumerate(scenes):
            scene.save(args.stills_dir / f"scene-{index + 1}.png")
        return
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("Install ffmpeg with libx264 to render the overview.")
    video = MEDIA / "model-pilot-overview.mp4"
    encoder = subprocess.Popen([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
        "-vcodec", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}",
        "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264", "-preset", "slow",
        "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video),
    ], stdin=subprocess.PIPE)
    elapsed = 0
    try:
        for index, seconds in enumerate(DURATIONS):
            for frame in range(seconds * FPS):
                local_time = frame / FPS
                image = scenes[index].copy()
                if index and local_time < 0.2:
                    image = Image.blend(scenes[index - 1], image, min(1, local_time / 0.2))
                draw = ImageDraw.Draw(image)
                completed = (elapsed + local_time) / DURATION
                draw.rectangle((0, HEIGHT - 4, round(WIDTH * completed), HEIGHT), fill=ORANGE)
                encoder.stdin.write(image.tobytes())
            elapsed += seconds
    finally:
        encoder.stdin.close()
    if encoder.wait() != 0:
        raise SystemExit("Video encoding failed.")
    with tempfile.TemporaryDirectory(prefix="model-pilot-media-") as temporary:
        palette = str(Path(temporary) / "palette.png")
        run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
             "-vf", "fps=8,scale=960:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=diff", palette])
        run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-i", palette,
             "-lavfi", "fps=8,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3",
             "-loop", "0", str(MEDIA / "model-pilot-preview.gif")])
    if args.contact_sheet:
        args.contact_sheet.parent.mkdir(parents=True, exist_ok=True)
        run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
             "-vf", "select='eq(n,48)+eq(n,144)+eq(n,264)+eq(n,408)+eq(n,552)+eq(n,708)',scale=640:360,tile=2x3",
             "-frames:v", "1", str(args.contact_sheet)])
    print(f"Rendered {DURATION}s at {WIDTH}x{HEIGHT}, {FPS}fps.")
    for artifact in (video, MEDIA / "model-pilot-preview.gif", MEDIA / "model-pilot-poster.png"):
        print(f"{artifact.relative_to(ROOT)}: {artifact.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
