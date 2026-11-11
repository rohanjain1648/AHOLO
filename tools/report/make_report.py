#!/usr/bin/env python3
"""Builds docs/report/NOVA-SWARM-Aholo-Project-Report.pdf from the screenshots in docs/report/.

    python tools/report/make_report.py

16:9 landscape pages, one topic each, so a judge can skim it like slides. Plain Helvetica only
(the built-in fonts have no arrows or emoji), so arrows are drawn as shapes.
"""
import io
import os
from reportlab.lib.colors import Color, HexColor
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
IMG = os.path.join(ROOT, "docs", "report")
OUT = os.path.join(IMG, "NOVA-SWARM-Aholo-Project-Report.pdf")

W, H = 1280, 720
M = 56  # page margin
BG = HexColor("#070912")
PANEL = HexColor("#101727")
LINE = HexColor("#26324f")
TEXT = HexColor("#e6f0ff")
DIM = HexColor("#9fb0cf")
CYAN = HexColor("#3fe9ff")
AMBER = HexColor("#ffb44d")
VIOLET = HexColor("#9d7bff")
GREEN = HexColor("#6bff9d")
RED = HexColor("#ff6a6a")

TOTAL = 12
_cache = {}


def image(name, max_w=1500, crop=None):
    """A downscaled copy of a report image as an ImageReader, with its (w, h). crop = (left, top, right, bottom) in pixels."""
    key = (name, crop)
    if key in _cache:
        return _cache[key]
    im = Image.open(os.path.join(IMG, name)).convert("RGB")
    if crop:
        im = im.crop(crop)
        im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)  # small source: enlarge before placing
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=84)
    buf.seek(0)
    _cache[key] = (ImageReader(buf), im.width, im.height)
    return _cache[key]


def page_bg(c):
    c.setFillColor(BG)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    # a faint grid, echoing the game's floor
    c.setStrokeColor(Color(0.25, 0.45, 0.8, alpha=0.06))
    c.setLineWidth(0.6)
    for x in range(0, W, 64):
        c.line(x, 0, x, H)
    for y in range(0, H, 64):
        c.line(0, y, W, y)


def footer(c, n):
    c.setFont("Helvetica", 9)
    c.setFillColor(DIM)
    c.drawString(M, 24, "NOVA SWARM: The Generated Swarm  |  Manycore Aholo Global 3D AI Hackathon  |  aholo.vercel.app")
    c.drawRightString(W - M, 24, f"{n} / {TOTAL}")


def title(c, text, kicker=None, color=CYAN):
    if kicker:
        c.setFont("Helvetica-Bold", 12)
        c.setFillColor(color)
        c.drawString(M, H - 50, kicker.upper())
    c.setFont("Helvetica-Bold", 34)
    c.setFillColor(TEXT)
    c.drawString(M, H - 92, text)


def para(c, text, x, y_top, w, size=15, color=TEXT, leading=None, bold=False):
    """Draw wrapped rich text (reportlab mini-markup) with its top at y_top. Returns the height used."""
    style = ParagraphStyle(
        "p", fontName="Helvetica-Bold" if bold else "Helvetica", fontSize=size,
        leading=leading or size * 1.38, textColor=color,
    )
    p = Paragraph(text, style)
    _, h = p.wrap(w, 10000)
    p.drawOn(c, x, y_top - h)
    return h


def bullets(c, items, x, y_top, w, size=15, gap=9, color=TEXT, dot=CYAN):
    y = y_top
    for it in items:
        c.setFillColor(dot)
        c.circle(x + 4, y - size * 0.62, 2.6, stroke=0, fill=1)
        h = para(c, it, x + 18, y, w - 18, size=size, color=color)
        y -= h + gap
    return y_top - y


def panel(c, x, y, w, h, stroke=LINE, fill=PANEL, r=14):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(1.2)
    c.roundRect(x, y, w, h, r, stroke=1, fill=1)


def shot(c, name, x, y, w, h, caption=None, border=CYAN, crop=None):
    """Draw an image fitted into the (x, y, w, h) box (y = bottom), rounded, with an optional caption below it."""
    reader, iw, ih = image(name, crop=crop)
    cap_h = 24 if caption else 0
    box_h = h - cap_h
    s = min(w / iw, box_h / ih)
    dw, dh = iw * s, ih * s
    dx = x + (w - dw) / 2
    dy = y + cap_h  # sit directly above the caption
    c.saveState()
    p = c.beginPath()
    p.roundRect(dx, dy, dw, dh, 10)
    c.clipPath(p, stroke=0)
    c.drawImage(reader, dx, dy, dw, dh)
    c.restoreState()
    c.setStrokeColor(border)
    c.setLineWidth(1.4)
    c.roundRect(dx, dy, dw, dh, 10, stroke=1, fill=0)
    if caption:
        c.setFont("Helvetica", 11)
        c.setFillColor(DIM)
        c.drawCentredString(x + w / 2, y + 6, caption)


def stat(c, x, y, w, big, small, color=CYAN):
    panel(c, x, y, w, 86)
    c.setFont("Helvetica-Bold", 34)
    c.setFillColor(color)
    c.drawString(x + 18, y + 38, big)
    c.setFont("Helvetica", 12)
    c.setFillColor(DIM)
    c.drawString(x + 18, y + 16, small)


def arrow(c, x1, y, x2, color=DIM):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(2)
    c.line(x1, y, x2 - 8, y)
    p = c.beginPath()
    p.moveTo(x2, y)
    p.lineTo(x2 - 10, y + 5.5)
    p.lineTo(x2 - 10, y - 5.5)
    p.close()
    c.drawPath(p, stroke=0, fill=1)


def node(c, x, y, w, h, head, sub, color=CYAN):
    panel(c, x, y, w, h, stroke=color)
    c.setFont("Helvetica-Bold", 13)
    c.setFillColor(color)
    c.drawCentredString(x + w / 2, y + h - 22, head)
    para(c, sub, x + 8, y + h - 32, w - 16, size=10.5, color=DIM, leading=13)


def table(c, x, y_top, col_w, rows, head_color=CYAN, size=12.5, row_h=28):
    """rows[0] is the header. Returns the bottom y."""
    y = y_top
    for i, row in enumerate(rows):
        if i == 0:
            c.setFillColor(Color(0.25, 0.9, 1, alpha=0.12))
            c.roundRect(x - 8, y - row_h + 6, sum(col_w) + 16, row_h, 6, stroke=0, fill=1)
        elif i % 2 == 0:
            c.setFillColor(Color(1, 1, 1, alpha=0.035))
            c.roundRect(x - 8, y - row_h + 6, sum(col_w) + 16, row_h, 6, stroke=0, fill=1)
        cx = x
        for j, cell in enumerate(row):
            c.setFont("Helvetica-Bold" if i == 0 else "Helvetica", size)
            c.setFillColor(head_color if i == 0 else TEXT)
            c.drawString(cx, y - row_h + 14, cell)
            cx += col_w[j]
        y -= row_h
    return y


# --------------------------------------------------------------------------------------------
def p1_cover(c):
    page_bg(c)
    c.setFont("Helvetica-Bold", 13)
    c.setFillColor(AMBER)
    c.drawString(M, H - 62, "MANYCORE AHOLO GLOBAL 3D AI HACKATHON   |   PROJECT REPORT")
    c.setFont("Helvetica-Bold", 78)
    c.setFillColor(CYAN)
    c.drawString(M, H - 190, "NOVA SWARM")
    c.setFont("Helvetica-Bold", 38)
    c.setFillColor(TEXT)
    c.drawString(M, H - 244, "The Generated Swarm")
    para(c, "A browser 3D roguelite where <b>every character, ship and boss is generated by Aholo Lux3D</b>, "
            "and the next boss is whatever <b>you</b> type.", M, H - 282, 540, size=19, color=TEXT, leading=27)
    y = H - 410
    for label, val, col in [("PLAY", "aholo.vercel.app", CYAN), ("SOURCE", "github.com/rohanjain1648/AHOLO", VIOLET),
                            ("BUILT BY", "Rohan Jain (solo), with Claude Code as pair-engineer", AMBER)]:
        c.setFont("Helvetica-Bold", 11)
        c.setFillColor(col)
        c.drawString(M, y, label)
        c.setFont("Helvetica", 16)
        c.setFillColor(TEXT)
        c.drawString(M + 92, y, val)
        y -= 34
    c.setFont("Helvetica", 12)
    c.setFillColor(DIM)
    c.drawString(M, 62, "Open the live link, press HANGAR, then FORGE, then PLAY SOLO. That is the whole tour.")
    shot(c, "forge-crystal-golem-boss.jpg", 650, 150, 580, 420, None)
    c.setFont("Helvetica", 11)
    c.setFillColor(DIM)
    c.drawCentredString(940, 128, "A boss typed into the Forge, generated by Lux3D, arriving in a live run")


def p2_idea(c):
    page_bg(c)
    title(c, "Generated 3D usually ends up in a gallery.", "The idea")
    c.setFont("Helvetica-Bold", 34)
    c.setFillColor(CYAN)
    c.drawString(M, H - 132, "I wanted it inside a game.")
    bullets(c, [
        "<b>A game is the harshest test of generated assets.</b> They must be rigged, light enough for a phone, readable from a "
        "top-down camera, and fun to look at for minutes at a time.",
        "<b>A roguelite swarm is hungry for variety.</b> It needs many distinct, animated characters and bosses, "
        "which is exactly what a text-to-3D model can supply.",
        "<b>The twist: the player authors content.</b> Forge turns one typed sentence into the next boss, live, while the run is on. "
        "The prompt becomes a mechanic.",
    ], M, H - 190, 640, size=17, gap=16)
    # right column: stats
    sx, sw = 760, 224
    stat(c, sx, 470, sw, "19", "Lux3D models in the game", CYAN)
    stat(c, sx + sw + 16, 470, sw, "5", "Lux3D capabilities used", AMBER)
    stat(c, sx, 364, sw, "2", "game halves: surface + orbit", VIOLET)
    stat(c, sx + sw + 16, 364, sw, "200", "automated tests passing", GREEN)
    panel(c, sx, 180, sw * 2 + 16, 166)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(AMBER)
    c.drawString(sx + 18, 322, "THE FIVE LUX3D CAPABILITIES")
    bullets(c, ["Text-to-3D, G1 (the hand-prompted cast)", "Text-to-3D, G1-Turbo (Forge + gallery bosses)",
                "Humanoid auto-rig", "Animation retargeting", "Part split (the two-stage capital ship)"],
            sx + 18, 306, sw * 2 - 20, size=13, gap=3, dot=AMBER)
    panel(c, M, 112, 660, 206)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(AMBER)
    c.drawString(M + 18, 294, "WHERE EACH JUDGING CRITERION IS ANSWERED")
    rows = [("Use of Manycore tools", "Every model, five Lux3D capabilities, and Forge at runtime"),
            ("Fun and engagement", "Orbit dogfight, boss intros, dash, new weapons, shatter deaths"),
            ("Innovation", "The prompt is a mechanic: the player authors the boss"),
            ("Completeness", "Live link, 200 tests, fallbacks, co-op, a Hangar of every asset")]
    yy = 266
    for a, b in rows:
        c.setFont("Helvetica-Bold", 12.5)
        c.setFillColor(CYAN)
        c.drawString(M + 18, yy, a)
        c.setFont("Helvetica", 12.5)
        c.setFillColor(TEXT)
        c.drawString(M + 196, yy, b)
        yy -= 40
    footer(c, 2)


def p3_play(c):
    page_bg(c)
    title(c, "What you play", "The game")
    # loop diagram
    y, h, w = 520, 74, 214
    xs = [M, M + w + 62, M + 2 * (w + 62), M + 3 * (w + 62)]
    node(c, xs[0], y, w, h, "SURFACE", "Waves, XP, upgrades. The Warden arrives at 2:00.", CYAN)
    node(c, xs[1], y, w, h, "LAUNCH", "Field clears, ground falls away, camera swoops up.", AMBER)
    node(c, xs[2], y, w, h, "ORBIT", "Drift flight, a generated fleet, then the capital ship.", VIOLET)
    node(c, xs[3], y, w, h, "RE-ENTRY", "Back down. The swarm is 35% tougher each loop.", GREEN)
    for i in range(3):
        arrow(c, xs[i] + w + 6, y + h / 2, xs[i + 1] - 6)
    c.setFont("Helvetica", 10.5)
    c.setFillColor(DIM)
    c.drawString(xs[0], y - 16, "Kill the Warden to launch.")
    c.drawString(xs[2], y - 16, "Destroy the capital ship to descend.")
    shot(c, "boss-intro-warden.jpg", M, 92, 560, 380, "Surface: the Warden's arrival (boss intro)")
    shot(c, "capital-stage1-bridge.jpg", M + 590, 92, 576, 380, "Orbit: Lux3D fighter, asteroid and capital ship", VIOLET)
    footer(c, 3)


def p4_pipeline(c):
    page_bg(c)
    title(c, "How Lux3D is used: the asset pipeline", "The process")
    y, h = 500, 92
    stages = [("PROMPT", "tools/lux3d/cast.mjs: prompt, style, rig, budget", DIM),
              ("TEXT-TO-3D", "G1, about 5 min each. Upright T-pose for humanoids", CYAN),
              ("AUTO-RIG", "Lux3D rigs the humanoids: 50 to 150 s", AMBER),
              ("RETARGET", "Idle, Walk, Sprint, Death clips: about 10 s", AMBER),
              ("SHRINK", "gltf-transform + meshopt: triangles, WebP textures", VIOLET),
              ("MANIFEST", "manifest.json maps role to file, clips, pose", GREEN)]
    w = 170
    gap = (W - 2 * M - len(stages) * w) / (len(stages) - 1)
    for i, (hd, sub, col) in enumerate(stages):
        x = M + i * (w + gap)
        node(c, x, y, w, h, hd, sub, col)
        if i:
            arrow(c, x - gap + 4, y + h / 2, x - 4)
    para(c, "<b>Resumable and frugal.</b> Every task id and result URL is saved after each step, so a crash or dropped download never "
            "pays for the same task twice. It is a dry run unless you pass <b>--yes</b>. Each model writes a log (prompt, task ids, timings, "
            "triangle counts, clips) that this report draws on.", M, 440, 560, size=14, leading=20)
    table(c, M, 340, [190, 360], [
        ["Lux3D API", "Used for"],
        ["text-to-3d, G1", "13 hand-prompted cast models"],
        ["text-to-3d, G1-Turbo", "Forge bosses, 6 gallery bosses"],
        ["animations/rig", "Hero, grunt, fast, tank, Warden"],
        ["animations/retarget", "Their Lux3D animation clips"],
        ["part-split", "Capital ship: bridge breaks off"],
    ], size=12.5)
    c.setFont("Helvetica-Oblique", 11)
    c.setFillColor(DIM)
    c.drawString(M, 158, "Not used: image-to-3D, material transfer, articulation, World/SpatialGen, RenderCloud, LuxReal.")
    # numbers panel
    px, pw = 690, W - M - 690
    panel(c, px, 150, pw, 260)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(AMBER)
    c.drawString(px + 20, 384, "ONE MODEL, START TO FINISH: THE GRUNT")
    c.setFont("Helvetica-Bold", 40)
    c.setFillColor(CYAN)
    c.drawString(px + 20, 330, "22 MB  >  367 KB")
    c.setFont("Helvetica-Bold", 28)
    c.setFillColor(TEXT)
    c.drawString(px + 20, 288, "12.7k  >  5.5k triangles")
    bullets(c, ["Generated in 4 min 44 s, rigged in 56 s, retargeted in 11 s.",
                "All 13 cast models together weigh about 3.5 MB.",
                "Every model keeps a log of how it was made."], px + 20, 252, pw - 40, size=13.5, gap=7)
    footer(c, 4)


def p5_rig(c):
    page_bg(c)
    title(c, "Iteration 1: the rig that was rejected", "Process")
    panel(c, M, 368, 540, 226, stroke=RED)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(RED)
    c.drawString(M + 20, 568, "ATTEMPT 1")
    para(c, "Prompt: <i>\"a rusty scrap-metal robot soldier ... <b>hunched posture</b> ...\"</i>", M + 20, 554, 500, size=13.5, color=TEXT)
    para(c, "Generation succeeded. The auto-rig did not:", M + 20, 516, 500, size=13.5, color=TEXT)
    para(c, "<b>MODEL_NOT_RIGGABLE</b>: a humanoid robot, but its pose is not a valid base stance. The body is not upright and the "
            "knees are bent.", M + 20, 492, 500, size=14.5, color=RED, leading=20)
    para(c, "A rejected rig did not appear to cost credits, so the lesson was cheap.", M + 20, 424, 500, size=12, color=DIM)
    panel(c, M, 118, 540, 232, stroke=GREEN)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(GREEN)
    c.drawString(M + 20, 324, "ATTEMPT 2: THE FIX")
    para(c, "Every humanoid prompt now asks for <b>\"standing perfectly upright with straight legs, in a T-pose\"</b>, with a comment in "
            "cast.mjs explaining why. The pipeline also surfaces Lux3D's real error text instead of a bare status code.",
         M + 20, 310, 500, size=13.5, leading=19)
    para(c, "Result: rigged in 56 s, four Lux3D clips in 11 s (Idle, Zombie Walk, Sprint, Death). The other four humanoids rigged first try.",
         M + 20, 232, 500, size=13.5, leading=19, color=TEXT)
    shot(c, "grunt-ingame-v1.jpg", 630, 340, 594, 254, "The grunt in the arena, walking on a Lux3D animation")
    shot(c, "hangar-grunt.jpg", 630, 62, 594, 266, "The same model in the Hangar, with its prompt and clips", GREEN)
    footer(c, 5)


def p6_orient(c):
    page_bg(c)
    title(c, "Iteration 2: making generated assets behave", "Process")
    hw = 580
    shot(c, "cast-topdown-before-orientation.jpg", M, 332, hw, 262, "Before: ships built nose-up, the capital ship sideways", RED)
    shot(c, "space-cast-topdown.png", M + hw + 28, 332, hw, 262, "After: every nose follows the orange game-forward arrow", GREEN)
    shot(c, "gallery-dragon-before-selflit.jpg", M, 50, hw, 262, "Before: G1-Turbo output is dark; the Warden's gold tint made it brown", RED)
    shot(c, "gallery-dragon-selflit.jpg", M + hw + 28, 50, hw, 262, "After: lit by its own texture, so it reads", GREEN)
    footer(c, 6)


def p7_placeholder(c):
    page_bg(c)
    title(c, "Iteration 3: from stand-in shapes to Lux3D ships", "Process")
    shot(c, "orbit-placeholder-ships.jpg", M, 250, 570, 340, "First playable orbit: low-poly placeholders I wrote in code", RED)
    shot(c, "capital-stage1-bridge.jpg", M + 598, 250, 570, 340, "Same moment with the Lux3D fighter, asteroid and capital ship", GREEN)
    bullets(c, [
        "I built the whole surface-to-orbit loop first with placeholder shapes, so the game design could be judged before spending credits.",
        "Then six Lux3D prompts replaced them in one batch (about 5 min each, three at a time). The game picks them up from the manifest, no code change.",
        "A built-in preview tool draws every model from the game camera's angle, which is how the orientation problems on the previous page were found.",
    ], M, 218, W - 2 * M, size=14.5, gap=8)
    footer(c, 7)


def p8_forge(c):
    page_bg(c)
    title(c, "Forge: you author the boss", "The feature", AMBER)
    shot(c, "forge-prompt.jpg", M, 300, 360, 294, "1. Type a boss", AMBER, crop=(340, 0, 600, 135))
    shot(c, "forge-crystal-golem-boss.jpg", M + 380, 300, 520, 294, "2. About 2 to 4 minutes later it arrives as the boss", AMBER)
    panel(c, M, 168, 900, 108, stroke=AMBER)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(AMBER)
    c.drawString(M + 18, 252, "3. IF LIVE GENERATION CANNOT RUN")
    para(c, "The game says so, plainly, and summons the closest pre-forged Lux3D boss to what you typed:", M + 18, 238, 860, size=13, color=DIM)
    para(c, "<i>\"Live Forge is offline. Pre-forged boss: 'a colossal cyber dragon with neon blue circuit scales'\"</i>", M + 18, 212, 860, size=15, color=TEXT)
    px = M + 960
    panel(c, px, 330, W - M - px, 264, stroke=AMBER)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(AMBER)
    c.drawString(px + 16, 570, "HOW IT STAYS SAFE")
    bullets(c, ["The Lux3D key lives <b>only on the relay server</b>.", "Prompts are cleaned and length-limited.",
                "<b>3 forges per hour per address</b>, 40 per day.", "6 pre-forged bosses as fallback: relay offline, cap hit, failed job, or credits gone.",
                "In co-op the host shares its boss so everyone fights the same creature."],
            px + 16, 548, W - M - px - 30, size=12.5, gap=8, dot=AMBER)
    para(c, "<b>Why it matters:</b> credits expire before judging ends, so Forge degrades to the gallery instead of breaking, and says so.",
         M, 140, 900, size=13.5, color=TEXT, leading=19)
    footer(c, 8)


def p9_split(c):
    page_bg(c)
    title(c, "Part split: a two-stage capital ship", "The feature", VIOLET)
    shot(c, "capital-stage1-bridge.jpg", M, 250, 570, 340, "Stage 1: the command bridge stands on the hull", VIOLET)
    shot(c, "capital-stage2-bridge-gone.jpg", M + 598, 250, 570, 340, "Stage 2: the bridge tore off, leaving a scorched gap", RED)
    bullets(c, [
        "<b>Lux3D part split</b> (94 s) separated the generated capital ship into hull and bridge. It found two parts, not a row of turrets, so the "
        "design follows what it actually gave.",
        "At <b>half health</b> the bridge is flung away and tumbles, BRIDGE DESTROYED appears with a screen shake, and the ship fires about <b>50% faster</b>.",
        "The stage rides in the network snapshot, so co-op players see the same moment. A helper script names the parts and installs the model.",
    ], M, 218, W - 2 * M, size=14.5, gap=8, dot=VIOLET)
    footer(c, 9)


def p10_feel(c):
    page_bg(c)
    title(c, "Game feel, built on the generated models", "The feature")
    w = 372
    shot(c, "shatter-death.png", M, 290, w, 310, "Shatter death", CYAN)
    shot(c, "weapon-rail-lance.jpg", M + w + 24, 290, w, 310, "Rail Lance: a piercing beam", AMBER)
    shot(c, "hangar-forge-guardian.jpg", M + 2 * (w + 24), 290, w, 310, "Hangar: the prompt behind every model", VIOLET)
    bullets(c, [
        "<b>Shatter deaths:</b> a dying enemy's own Lux3D mesh and textures are cut into chunks that fly out, spin and shrink. It works for every model, including a boss you forged.",
        "<b>Boss intro:</b> letterbox bars, a camera swoop and the boss's name on screen. Players are invulnerable for 2.6 s, so the cinematic never costs a hit.",
        "<b>Dash, Chain Lightning and Rail Lance:</b> a dodge with a cooldown, lightning that arcs between enemies, and a beam through a line of them.",
        "<b>Hangar:</b> a turntable of all 19 models with the exact prompt, triangle count, rigging and clips for each.",
    ], M, 262, W - 2 * M, size=15, gap=11)
    footer(c, 10)


def p11_quality(c):
    page_bg(c)
    title(c, "Quality: a bot that plays the game", "Engineering", GREEN)
    para(c, "A bot plays the real simulation (kites, focuses the boss, dashes, picks random upgrades). It is a crude stand-in for a player, so its numbers "
            "compare settings against each other rather than claim absolute truth.", M, H - 118, 780, size=13.5, color=DIM, leading=19)
    table(c, M, 536, [330, 160, 150, 150], [
        ["Tuning", "Median survival", "Beat Warden", "Beat capital"],
        ["First tuning (16 runs)", "2:50", "1 of 16", "0 of 16"],
        ["After balancing (60 runs)", "8:45", "42 of 60", "20 of 60"],
    ], head_color=GREEN, size=13)
    table(c, M, 420, [330, 160, 150, 150], [
        ["Does each feature earn its place? (60 runs each)", "Median survival", "Beat Warden", "Beat capital"],
        ["Everything on", "8:26", "39 of 60", "10 of 60"],
        ["Without the two new weapons", "7:31", "42 of 60", "12 of 60"],
        ["Without dash", "5:54", "33 of 60", "12 of 60"],
    ], head_color=GREEN, size=13)
    c.setFont("Helvetica-Oblique", 10.5)
    c.setFillColor(DIM)
    c.drawString(M, 296, "Second table measured mid-tuning. Dash is worth about 2.5 minutes of survival; the new weapons about 1 minute and 35% more kills.")
    px = 880
    panel(c, px, 290, W - M - px, 322, stroke=GREEN)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(GREEN)
    c.drawString(px + 16, 588, "WHAT THE BOT FOUND")
    bullets(c, [
        "<b>A crash from the original game:</b> a dying splitter's child could take its own freed slot and wipe its split setting, so the second child threw. Fixed, with a regression test.",
        "<b>83% of damage</b> was the Warden's five-bullet fan. Now three bullets, slower; same for the capital ship.",
        "Boss HP was scaled twice (about 2,800 at 2:00). Now gentle.",
        "Orbit followed total run time, so late launches met a late-game fleet. It now follows time in orbit.",
    ], px + 16, 566, W - M - px - 30, size=12.2, gap=8, dot=GREEN)
    para(c, "<b>200 tests</b> cover the simulation, network snapshots, host/client sessions, Forge and the relay. A headless two-browser smoke test runs real co-op through a real relay.",
         M, 262, 780, size=13.5, leading=19)
    para(c, "One \"flaky\" test turned out to be a real bug in the test itself: it searched a log for the text \"f1\", which random channel ids contain about one run in ten. "
            "I found the cause instead of retrying, and every commit is now gated on the real test result.", M, 196, 780, size=13.5, color=DIM, leading=19)
    footer(c, 11)


def p12_close(c):
    page_bg(c)
    title(c, "Honest scope, and what's next", "Wrap-up", AMBER)
    cw = (W - 2 * M - 48) / 3
    cols = [
        ("EXISTED BEFORE", CYAN, ["The simulation, rendering and audio engine", "One CC0 robot used for every character", "3 weapons, 15 upgrades, 5 enemies, a boss",
                                  "Co-op relay and snapshots; Nexconn chat code"]),
        ("BUILT FOR THIS HACKATHON", GREEN, ["The Lux3D pipeline and all 19 models", "Surface, launch, orbit, descent loop", "Forge, gallery fallback, co-op sync",
                                              "Part split, shatter, boss intro, Hangar", "Dash and two new weapons; the balance bot"]),
        ("LIMITS, STATED PLAINLY", AMBER, ["Live Forge needs credits; the gallery covers judging", "Dash has no touch button yet", "The free relay sleeps after idle (about 1 min to wake)",
                                           "Balance numbers come from a bot, not playtesters", "Rooms are web-only until the Android app is updated"]),
    ]
    for i, (hd, col, items) in enumerate(cols):
        x = M + i * (cw + 24)
        panel(c, x, 398, cw, 198, stroke=col)
        c.setFont("Helvetica-Bold", 12)
        c.setFillColor(col)
        c.drawString(x + 18, 572, hd)
        bullets(c, items, x + 18, 550, cw - 34, size=13, gap=6, dot=col)
    para(c, "<b>Next:</b> mobile releases (and a touch dash button), image-to-3D companions from a photo, material transfer to re-skin enemies per sector, "
            "and more sectors with generated props.", M, 380, W - 2 * M, size=14, leading=20)
    panel(c, M, 196, W - 2 * M, 150, stroke=CYAN)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(CYAN)
    c.drawString(M + 20, 322, "TRY IT IN 60 SECONDS:  aholo.vercel.app")
    steps = [("1  HANGAR", "See all 19 Lux3D models with the prompts that made them."),
             ("2  FORGE", "Type a boss. Live it takes a few minutes; if busy, a pre-forged one steps in."),
             ("3  PLAY SOLO", "Hold the mouse to fire, Shift or E to dash, press 1 / 2 / 3 on level-up."),
             ("4  LAUNCH", "Beat the Warden (it arrives at 2:00) to fly into orbit and meet the capital ship.")]
    yy = 296
    for a, b in steps:
        c.setFont("Helvetica-Bold", 12.5)
        c.setFillColor(AMBER)
        c.drawString(M + 20, yy, a)
        c.setFont("Helvetica", 12.5)
        c.setFillColor(TEXT)
        c.drawString(M + 160, yy, b)
        yy -= 29
    c.setFont("Helvetica-Bold", 13)
    c.setFillColor(CYAN)
    c.drawString(M, 160, "Play:  aholo.vercel.app")
    c.setFillColor(VIOLET)
    c.drawString(M + 300, 160, "Source:  github.com/rohanjain1648/AHOLO")
    c.setFont("Helvetica", 10.5)
    c.setFillColor(DIM)
    c.drawString(M, 104, "Models generated with Aholo Lux3D. Fallback robot: RobotExpressive.glb by Tomas Laulhe, CC0, used only if a Lux3D model fails to load. Code: MIT.")
    c.drawString(M, 88, "Built with Claude Code as a pair-engineer. Libraries: three, ws, gltf-transform, meshoptimizer, sharp, vite, vitest, playwright.")
    footer(c, 12)


def main():
    c = canvas.Canvas(OUT, pagesize=(W, H))
    c.setTitle("NOVA SWARM: The Generated Swarm - Aholo Hackathon Project Report")
    c.setAuthor("Rohan Jain")
    c.setSubject("Manycore Aholo Global 3D AI Hackathon")
    for fn in (p1_cover, p2_idea, p3_play, p4_pipeline, p5_rig, p6_orient, p7_placeholder, p8_forge, p9_split, p10_feel, p11_quality, p12_close):
        fn(c)
        c.showPage()
    c.save()
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB, {TOTAL} pages)")


if __name__ == "__main__":
    main()
