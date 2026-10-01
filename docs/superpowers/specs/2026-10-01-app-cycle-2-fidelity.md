# App cycle 2 — fidelity pass (item A)

`apps/app/scripts/fidelity.mjs <app url> [out dir]` renders the design system's `ChatScreen`
mockup (served with the vendored tokens and bundle) and the app, headless (Playwright MCP),
at 1440×900 and 1180×760, light and dark, and prints the measures that differ. Screenshots and
`measures.json` land in the out dir (gitignored `apps/app/fidelity-out/` by default; never
committed: the app screenshot shows the user's own conversations).

## Before (2026-10-01, 0.2.3)

| measure | mockup | app | cause |
| --- | --- | --- | --- |
| top bar children | h2 · status · spacer · tabs | h2 · status · spacer · (resume form) · (steer form) · model picker · tabs | the picker and forms sat inside the 56 px row; the title shrank to "O…" |
| scrolling element | none (mockup) | `.thread` (760 px column) | the scrollbar sat mid-screen, at the column's edge, in the browser's default style |
| follow on streaming | n/a | none | the view stayed where it was while a reply grew |
| composer model | mono label | mono label (not clickable) | the model was changed from the top bar |

## After (2026-10-01, this branch)

Differences the script still reports, all content-dependent:

| measure | mockup | app | why it is expected |
| --- | --- | --- | --- |
| side.rect.h | 640 | 900 / 760 | the mockup card is 640 px tall; the app fills the window |
| title.rect.w | 95 | 120 | "Trip to Porto" vs the conversation's title (min-width 120) |
| status.rect.w | 69 | 53 | "Working" vs "Online" |
| tabs.rect.w | 211 | 177 | the mockup's Tasks tab carries a count |
| thread.rect.h | 453 | 3770 | the mockup has one turn; the app a long conversation (the column now scrolls as a whole) |
| msgUser.rect.w | 658 | 54 | the request text ("ola") |
| composerModel.rect.w | 95 | 140 | the label is a button with a chevron now (same 24 px height, same type) |
| scrollbars | — | `.scroll`, `.sx-code__pre` | the thread column and clipped code blocks scroll; the bar sits at the window's edge |

Everything else matches: sidebar 248 px with 16/12 padding and `surface-sunken`, brand 22/1
display, nav 34 px rows, "RECENT" overline, the me row, top bar 56 px with 24 px gutters and
12 px gaps, title 600 16/24, thread 24/32 padding with 20 px gaps and 760 px max width, message
body 15/24 at 720 px, compose 0/32/20 at 760 px, composer padding/radius/max-width and the
mono 12 px model label.
