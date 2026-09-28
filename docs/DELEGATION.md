# Delegating to Codex

Read this before handing any task to a Codex builder or critic. It covers the
sandbox, what the sandbox can and cannot be told, what must never be delegated,
and the acceptance-command rule that PR 1 was lost to.

## The sandbox, and why prompts cannot reach it

Codex builder/critic pairs run through the `codex` plugin's
`codex-companion.mjs`, which starts every `--write` task in the Codex CLI's
`workspace-write` sandbox. That sandbox's network access is controlled **only**
by `[sandbox_workspace_write]` `network_access` in `.codex/config.toml` — never
by anything in the task prompt, because the sandbox is a process boundary the
Codex CLI enforces, not something Codex is told about.

PR 1's `npm install` silently no-op'd for exactly this reason: the sandbox had
no network, and nothing in the acceptance chain could see the gap. The
acceptance-command rule below is a fix *around* that; this is the mechanism it
was never a fix *of*.

- **`network_access = true` is set in this repo's `.codex/config.toml`, scoped
  to `ddf` only** — not in `~/.codex/config.toml`, which would widen it to
  every trusted project on this machine. Decided 2026-08-12. It lets
  `npm install` run inside the sandbox, but it also means any future `--write`
  Codex run in this repo can reach the network for anything, not just installs.
  An accepted scoped risk, not a non-issue — do not copy the setting into the
  global config without deciding that tradeoff again.
- **Network access does not remove the need to verify.** It fixes "can the
  sandbox reach npm", not "did the install actually finish". After every Codex
  builder run that touches dependencies, check `ls node_modules/<pkg>` (or run
  `npm ls`) yourself before trusting its acceptance report, and if the
  deliverable is a process, launch it. A green report is not proof.
- **Forbid `@ts-ignore` / `@ts-expect-error` on an import that will not
  resolve**, explicitly, in every builder prompt. That is the specific move
  that blinded `tsc` in PR 1, and it reads as a reasonable local workaround
  every time it happens.

## The acceptance command needs a leg that fails when a dependency is absent

PR 1's was `typecheck && test && build`, run in a sandbox without network where
`npm install` silently no-op'd. The gate reported green over the whole half of
the PR it existed to check.

**No single leg was buggy.** Externalising `electron` is correct for the
bundler; `@ts-ignore` on an unresolvable import is a normal local workaround;
unit tests that spawn no process are ordinary. The defect lived only in the
conjunction — which is why reading any one file would not have shown it.

`typecheck` does catch it today, but only because no `@ts-ignore` masks the
import any more. One re-added comment and that is gone, so do not rely on it.
`npm ls` is a cheap unconditional check and **not sufficient alone**:
`npm install` can report success while a large binary payload never arrives,
and `npm ls` calls that healthy. Hence `npx electron --version` alongside it in
the verification bar.

**Where the deliverable is a process, make something launch it.**

## Split by activity, never by module

**Never delegate tests.** Decided 2026-08-12 after PR 2.

Codex built `videoSource.ts`, the whole Play UI, and 724 lines of CSS. The CSS
had zero raw hex, zero raw oklch, 214 `var(--)` references, and imported the
real design-system stylesheet. **Codex is good at building UI.** It wrote
**4 tests over 1,400 lines**, all on one pure geometry function, and the
readiness bug that shipped is in the file it wrote.

Three mechanisms, all structural, none fixable by prompt:

1. A UI test needs a new dependency, and adding a dependency inside the sandbox
   is exactly what failed in PR 1. There was no `jsdom` in `package.json` —
   either it was never tried or it failed silently, and nobody checked.
2. The UI spec lives in `mockups.html`, the requirements PDF, and the
   operator's head. **A sandboxed subagent cannot ask the user a question.**
3. A builder that writes its own tests writes tests its code passes.

PR 1's rule "do the gate-critical code yourself" was right and got applied to
the wrong axis — *which module*, when it should have been *which activity*.
**Tests are gate-critical whoever's module they cover.**

- **The orchestrator writes the tests first and hands them to the builder as
  the spec.** Then green means something structurally: the builder cannot route
  around a leg it did not author.
- **The orchestrator installs and verifies any new dependency before the
  builder starts**, outside the sandbox.
- **UI is graded by extending `app/test/e2e/wire.mjs`, not by jsdom.** See
  `APP-PLAN.md`, "Two harnesses, and no third", for the measurement this comes
  from.

## Reviewers land before the bar

Do not run the app half of the verification bar until every commissioned
reviewer (a second model, a Codex critic) has returned findings and those
findings are resolved. Any accepted finding changes app code, which invalidates
every app leg already run — typecheck, the unit suite, and the wire gate.
Running them early looks like progress and produces a green result that has to
be thrown away. Flagged by the owner on 2026-08-13, with the bar running and two
reviewers still in flight.

Legs over code the branch does not touch are safe to run early: if `mapper/`
and `tools/` are byte-identical to `main`, the mapper and oracle suites,
`mapper matrix` and the cutover digests stay valid. Say plainly which legs still
count and which were invalidated, rather than reporting the bar as passed.

## A builder's claim that its UI works is not evidence

An agent delegated a coding task writes the code; it is not asked to test the
UI, and its own report that the UI works does not count. The orchestrating
session verifies it, with **two** techniques, because each has caught a real bug
the other missed:

- **Scripted, CDP-driven checks** for precise claims — does X move, swap or
  resize by the right amount. A pixel-level check (freeze playback, sample the
  canvas corners through the page's own 2D context, rotate, require diagonal
  corners to swap) proved a rotation was real where a screenshot comparison was
  nearly fooled by ordinary playback motion.
- **A pass over the real, visible window** (computer-use screenshots) for
  whole-window sanity. A CDP script measured the preview canvas's own box and
  found the zoom math correct; only a screenshot showed the canvas drawing
  *over* sibling panels, because a `position: fixed` element escaped an
  ancestor's `overflow: hidden` that was never its containing block.

Settled 2026-08-13 at the owner's instruction ("it's not their job to test the
ui. that's your job").

## Merging

No subagent merges anything, ever. See `CLAUDE.md` § Git — the rule applies to
agents and subagents alike.

## The stop-time review gate

Enabled via `codex:setup --enable-review-gate`, toggled 2026-08-12. It reviews
the **orchestrator's** own turn at Stop, not the Codex sandboxed run — it
exists to catch the orchestrator accepting a Codex report too readily, not to
catch Codex itself. `--disable-review-gate` turns it back off. The state is
local to this machine's checkout path, not part of the repo.
