# Third-party material

This inventory covers the exported design material stored in this repository
and its external runtime references, the retained vendor mapper fixture,
and the loop tool's external references.
Dependencies installed from `app/package.json` carry their own licences in
`node_modules` and are not vendored in this repository.

## Vendored design export

| Material | Paths | Licence notice and provenance |
|---|---|---|
| Generated design-tool runtime (`dc-runtime`) | `design/support.js` | **no notice in file**. The header identifies it as generated from `dc-runtime/src/*.ts`. The export contains no bundled licence or upstream licence reference for this runtime; its licence is unspecified here. This is vendored executable JavaScript, loaded locally by the mockups. |
| Exported mockups, wireframe, components and design tokens | `design/mockups.html`, `design/wireframe-mapping.html`, `design/design-system/components.js`, `design/design-system/readme.md`, `design/design-system/styles.css`, `design/design-system/tokens/*.css` | **no notice in file**. These are the project-specific design-session export described in `design/README.md`, retained locally. The component bundle lists source hashes and an empty `inlinedExternals` array; it does not bundle the external libraries below. No separate upstream licence is established by this export. |

## Retained vendor fixture

`fixtures/Test3.mapper.xml` is the vendor mapper configuration used as an
interoperability fixture (64 × 40 pixels, type index 3). It is vendored data,
not executable code. **no notice in file**; no bundled licence establishes a
licence for this configuration. Its provenance and values are documented in
[docs/CAPTURE_RESULTS.md](docs/CAPTURE_RESULTS.md) and
[docs/PROTOCOL.md](docs/PROTOCOL.md), “Mapper file format”.

## CDN references, not vendored libraries

The following paths contain loaders or references, rather than copies of the
libraries. Licence names below come from the linked upstream licence files;
the local referring files have **no notice in file** for these libraries.

| Component | Local reference and remote URL | Upstream licence |
|---|---|---|
| Lucide 0.462.0 icons | `design/mockups.html` loads `https://unpkg.com/lucide@0.462.0/dist/umd/lucide.min.js`; `design/design-system/components.js` uses `window.lucide`. `design/design-system/readme.md` also documents the unminified CDN URL. | [ISC, with MIT-licensed Feather portions](https://github.com/lucide-icons/lucide/blob/0.462.0/LICENSE). Loaded from CDN; no icon library is vendored. |
| React and ReactDOM 18.3.1 | `design/support.js` loads `https://unpkg.com/react@18.3.1/umd/react.production.min.js` and `https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js`. | [MIT](https://github.com/facebook/react/blob/v18.3.1/LICENSE). Loaded from CDN, not included in the local runtime. |
| Babel standalone 7.29.0 | `design/support.js` loads `https://unpkg.com/@babel/standalone@7.29.0/babel.min.js` for JSX compilation. | [MIT](https://github.com/babel/babel/blob/v7.29.0/LICENSE). Loaded from CDN on demand, not vendored. |
| JSZip 3.10.1 | `tools/dancefloor-loops.html` loads `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js` for ZIP output. | [MIT or GPLv3, at the user's choice](https://github.com/Stuk/jszip/blob/v3.10.1/LICENSE.markdown). Loaded from CDN, not vendored. |

## Fonts referenced by URL

Font files are not redistributed. The HTML files request stylesheets and fonts
from Google Fonts; their local references have **no notice in file**.

| Font | Local reference and stylesheet URL | Upstream licence |
|---|---|---|
| Shantell Sans | `design/wireframe-mapping.html`: `https://fonts.googleapis.com/css2?family=Shantell+Sans:wght@400;500;700&display=swap` | [SIL Open Font License 1.1](https://github.com/google/fonts/blob/main/ofl/shantellsans/OFL.txt). |
| Rajdhani and JetBrains Mono | `tools/dancefloor-loops.html`: `https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap` | SIL Open Font License 1.1: [Rajdhani](https://github.com/google/fonts/blob/main/ofl/rajdhani/OFL.txt), [JetBrains Mono](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt). |

`design/design-system/tokens/fonts.css` supplies no `@font-face` rules or font
files; it uses system font fallbacks. The design-system notes describe Lucide
as the web substitute for system symbols; no SF Symbols assets are bundled.
