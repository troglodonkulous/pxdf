# Distinctive Dance Floor — Design System

> **Vendored verbatim 2026-08-11** from the Claude design session that authored
> it. Everything below is authoritative *for visual design* — palette,
> typography, chrome metrics, voice, motion, iconography.
>
> **Two claims in it are out of date and are not corrected inline**, so this
> file stays a faithful copy of its source:
>
> - "a macOS (**SwiftUI**) app" and "GUI is step 5 of the repo plan" — the stack
>   decision was superseded on 2026-08-11. The app is Electron + TypeScript +
>   React driving `mapper/` as a sidecar. See `docs/APP-PLAN.md`.
> - Every path it references — `uploads/`, `assets/`, `guidelines/`,
>   `components/`, `ui_kits/`, `templates/`, `SKILL.md` — belongs to the design
>   tool, not this repo, including the ones in the Index at the bottom. What was
>   actually exported lives in `../` — see `design/README.md`.

Design system for **Distinctive Dance Floor (DDF)**, a macOS (SwiftUI) app by Distinctive Event Solutions that controls a TOP Dance TP-878 pixel-LED dance floor over its native UDP protocol. The vendor software (Ledset/LPlayer) was reverse-engineered and replaced with a verified Python backend (`mapper/`); this system defines the UI that wraps it.

**Sources**
- GitHub: https://github.com/symphonia-ai/ddf — protocol spec, mapper, domain vocabulary (no UI code exists yet; GUI is step 5 of the repo plan). Explore `README.md`, `CLAUDE.md`, `mapper/README.md`, `docs/PROTOCOL.md` for grounding.
- `uploads/DDF Pairings.dc.html` — the approved "1a Signal" color/type pairing; the visual ground truth this system codifies.
- `uploads/ddf-ff-p*.png` — the user's MVP page sketches (Mapping, Play, Edit), copied to `assets/sketches/`.
- `assets/des-logo.png` — Distinctive Event Solutions logo (white lockup + core green bar on black).

**The three MVP surfaces** (from the sketches)
1. **Mapping** — controller/port wiring diagram over the tile grid; inspector with floor Type/Width/Height; show-file Open/Save As; Calibrate; "Open Player" hand-off.
2. **Play** — cue stack (left), live/preview floor render (center), cue controls: speed 0–200%, loop N/∞, brightness (right), transport bar with timecode + Master fader.
3. **Edit** — media browser + quick preview (left), floor canvas (center), layer/clip controls + transform + FX (right), multi-layer clip timeline (bottom).

## Content fundamentals

- **Voice: laconic operator-speak.** Labels are nouns or noun phrases: "Cue Stack", "Output", "Frame rate", "Master". Verbs only on buttons: "Open…", "Save As…", "Calibrate…". macOS ellipsis convention when a dialog follows.
- **Domain vocabulary is the repo's, verbatim:** cue, clip, floor type (`8x8_4P`), tiles, cols × rows, controller, port, packet, frame, fps, latency, Master, orientation, gapless, dry-run. Never invent synonyms ("panel" ≠ tile; "device" ≠ controller).
- **Numbers are data, never prose.** `60.0 fps`, `4.2 ms`, `01:34 / 04:36`, `12 × 8`, `82%` — always mono, unit in a dimmer/smaller style.
- **Status words are single uppercase tokens:** LINKED, LIVE, PREVIEW, DROPPED. Section labels are uppercase micro-labels with wide tracking.
- **Sentence case** for everything else. No emoji, no exclamation points, no marketing adjectives. The tone is a mixing console, not a consumer app.
- Cue names are the user's own event language: "Doors / Warm", "Grand Entrance", "First Dance", "Open Floor", "Last Call".

## Visual foundations

- **One hot green on a cold near-black.** Everything is a green-tinted (hue 152) neutral ramp from `--n-0` (0.075 L) to `--n-11` (0.97 L); the only chromatic elements are the accent green `oklch(0.80 0.20 148)` and the floor render itself. "Zero personality by design — the floor is the only thing on screen with color."
- **Brand green** `#057B1F` (`oklch(0.47 0.16 145)`) comes from the logo; it appears as deep fills (`--ddf-green-deep`) and palette anchors. The *screen* accent is the hotter `--ddf-green-hot` for legibility on dark chrome.
- **Backgrounds:** flat fills only. No gradients, no imagery, no textures, no illustration. Depth comes from the neutral ramp (window `n-2`, chrome `n-3`, raised `n-4`, wells `n-1`) plus 1px hairlines (`n-5`).
- **Borders:** 1px hairlines everywhere; panel seams are borders, not shadows. Wells (floor stage, previews) are inset: darker fill + hairline.
- **Shadows:** one big soft window shadow (`0 24px 60px rgba(0,0,0,.6)`); popovers slightly tighter. No card shadows inside the window.
- **Glow is a status channel:** live/linked dots and active meters get a small green glow (`--glow-accent`). Nothing decorative glows.
- **Corner radii:** small and tight — 3px floor cells, 7–8px controls/rows, 10px wells/panels, 12px window. Pills only for status capsules.
- **Type:** SF Pro Text 13/14 for UI, SF Pro Display for the rare heading, **SF Mono for every number, ID, and timecode** — no exceptions. Uppercase 11px/0.14em micro-labels head every panel section.
- **Selection = solid hot green fill** with near-black text (`--text-on-accent`), like the active cue row. Hover = one neutral step lighter (`n-4`); press = scale 0.97 + `--dur-fast`.
- **Motion:** utilitarian. 80–180ms ease-out fades and fills; no bounces, no springs. The floor preview may animate continuously; chrome never does.
- **Transparency/blur** only for popovers/menus (`--blur-popover`), matching macOS materials.
- **Layout is fixed chrome:** 46px title bar, 236px left sidebar, 214px right inspector, 82px transport bar; center panel flexes. Panel padding 22/26px; list rows 38px with 2px stack gaps.
- **Timeline layer colors** (`--layer-1..4`) are stage-gel lanes — cyan, amber, magenta, violet at matched oklch lightness/chroma — the only place secondary hues appear.
- **LED-segment motif:** faders and the transport progress meter render as strips of lit cells (`--led-cell-off` when unlit), echoing the floor itself; inset wells carry a faint dot-matrix texture.
- **Live things breathe:** the LINKED dot pulses (2.4s), the playing cue shows a 3-bar EQ meter, the progress strip’s head cell glows. Chrome that isn’t live stays still.

## Iconography

- **Native app: SF Symbols** (the macOS system set). SF Symbols cannot be redistributed here, so **web artifacts use Lucide from CDN** — closest match in stroke weight/1.5px style; flagged as a substitution. Load: `https://unpkg.com/lucide@0.462.0/dist/umd/lucide.js` and call `lucide.createIcons()`, or use the `Icon` component.
- Transport glyphs in the reference use text glyphs (◀◀ ❚❚ ▶▶); components render Lucide `rewind`/`pause`/`play`/`fast-forward` at 15px.
- No icon font, no emoji, no PNG icons. The repo contains no UI icon assets (its PNGs are wiring diagrams, kept in `assets/sketches/` + repo).
- Icons are always monochrome: `--text-secondary` at rest, `--text-primary` on hover, `--text-on-accent` on green fills. 15–16px inside 34px hit targets.
- **Logo:** `assets/des-logo.png` (white lockup on black; the ONLY brand mark — never redraw it). On dark chrome it can sit directly; never place on light.

## Index

- `styles.css` → `tokens/` (colors, typography, spacing, radius, elevation, motion, fonts, base).
- `assets/` — `des-logo.png`, `sketches/` (MVP page sketches).
- `guidelines/` — foundation specimen cards (Design System tab).
- `components/core/` — Button, IconButton, Badge, StatusPill, Panel, SectionLabel.
- `components/controls/` — Select, TextField, Slider, Segmented, Switch, Stepper.
- `components/data/` — StatReadout, ListRow, KeyValue, Timecode.
- `components/floor/` — FloorPreview, ControllerChip, TransportBar.
- `ui_kits/ddf-mac/` — the macOS app: Mapping, Play, Edit screens + interactive `index.html`.
- `templates/` — (reserved for deck/doc templates; none yet).
- `SKILL.md` — agent skill entry point.

**Intentional additions:** the repo defines no UI components (GUI not yet built), so the component inventory was authored from the Signal reference + sketches — every component is traceable to an element in one of those two sources.

**Caveat — fonts:** SF Pro / SF Mono are Apple system fonts and are not shipped as files; the CSS stack falls back gracefully off-macOS. If pixel parity on non-Apple platforms matters, supply licensed font files.
