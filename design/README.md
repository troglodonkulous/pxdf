# `design/` — the visual spec

Exported 2026-08-11 from the Claude design session that produced the DDF
mockups. Vendored because the source lives behind a signed URL that will expire,
and because the app is built directly from these files rather than from
screenshots of them.

**These are a superset of what ships.** Direction (Fwd / Rev / Bounce), Custom
layout and `Calibrate…` all appear in the mockups and are all shelved or
scrapped. `docs/REQUIREMENTS-v1.pdf` wins where the two disagree, and
`docs/APP-PLAN.md` records what is cut and why.

| Path | What it is |
|---|---|
| `mockups.html` | **The visual spec.** All three MVP surfaces plus the re-fit sheet, across three design turns. Screens are inline `text/x-dc` blocks. |
| `support.js` | The design-tool runtime `mockups.html` needs to render. Generated — never edit. |
| `wireframe-mapping.html` | The earlier Mapping wireframe the hi-fi set came from. Provenance. |
| `design-system/readme.md` | The design-system spec: voice, colour rationale, chrome metrics, motion, iconography. Carries a provenance header — two of its claims are out of date. |
| `design-system/tokens/*.css` | The token set. **Build input** — import these, do not retype the values. |
| `design-system/styles.css` | `@import`s the tokens in order. |
| `design-system/components.js` | Twenty components as readable `React.createElement` source: Button, IconButton, Badge, StatusPill, Panel, SectionLabel, Select, TextField, Slider, Segmented, Switch, Stepper, StatReadout, ListRow, KeyValue, Timecode, ControllerChip, **FloorPreview**, **TransportBar**, Icon. |

## Opening `mockups.html`

Open it from disk; it needs `support.js` beside it, which is why that file is
tracked. Icons come from a CDN (`unpkg.com/lucide`), so offline the layout is
correct and the glyphs are missing. Nothing else is fetched.

## What was deliberately not vendored

`_ds_manifest.json` and `_adherence.oxlintrc.json` — design-tool index and lint
metadata, duplicating the tokens and the readme.

The three screen sources (`ui_kits/ddf-mac/{mapping,play,edit}.jsx`) appear in
`components.js`'s bundle header under `sourceHashes` but were **not** in the
export. The rendered screens in `mockups.html` are what we have.
