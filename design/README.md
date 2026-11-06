# `design/` — the visual spec

Exported 2026-08-11 from the Claude design session that produced the DDF
mockups. Vendored because the source lives behind a signed URL that will expire,
and because the app is built directly from these files rather than from
screenshots of them.

**These are a superset of what ships.** Direction (Fwd / Rev / Bounce), Custom
layout and `Calibrate…` all appear in the mockups and are all shelved or
scrapped. The operator's requirements (`docs/REQUIREMENTS-v1.pdf`, not published) win where the two disagree, and
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

Open it from disk. It loads eleven local files — `support.js`, the eight token
stylesheets, `design-system/styles.css`, and `design-system/components.js` — all
of which are tracked here. The only remote fetch is the Lucide icon CDN
(`unpkg.com/lucide`), so offline the layout is correct and the glyphs are
missing.

**One deliberate modification.** The export referenced its design system as
`_ds/ddf-design-system-fee2c806-87cc-485d-b1c8-5cde8d2c6639/…` and its bundle as
`_ds_bundle.js`. Those ten references were rewritten to `design-system/…` and
`components.js` to match this layout; an HTML comment at the top of the file
says the same thing. Nothing else in it is changed. Verified rendering after the
rewrite — full styling, all fourteen design-system components resolved.

Without that fix the file was inert: `components.js` holds the sole definition
of `window.DistinctiveDanceFloorDesignSystem_fee2c8`, which `mockups.html`
references 230 times and `support.js` does not provide.

## What was deliberately not vendored

`_ds_manifest.json` and `_adherence.oxlintrc.json` — design-tool index and lint
metadata, duplicating the tokens and the readme.

The three screen sources (`ui_kits/ddf-mac/{mapping,play,edit}.jsx`) appear in
`components.js`'s bundle header under `sourceHashes` but were **not** in the
export. The rendered screens in `mockups.html` are what we have.
