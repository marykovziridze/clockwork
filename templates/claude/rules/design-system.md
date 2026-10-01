---
# Path-scoped: https://code.claude.com/docs/en/memory#path-specific-rules
paths:
  - "**/*.{css,scss,sass,less}"
  - "**/*.{tsx,jsx,vue,svelte}"
  - "**/*.twig"
  - "**/{templates,parts,patterns,template-parts,blocks}/**/*.{php,html}"
  - "**/theme.json"
  - "**/tailwind.config.*"
---

# Design system: current rules

Project-owned rules the user set or measured. A row with an unfilled `{{…}}` is not a rule yet: verifiers hold the page to the Baseline row that backs it, and list a row no Baseline backs as not measurable (no value, no baseline). Fill it from the design source; "decide per project" = the user's value.

## How to use this file
- **Tokens are the only source of sizes and colours** (`{{token file}}`); a raw hex, px or ms in a component is a finding.
- **Change a rule by rewriting its row**, Source ending `reversed <YYYY-MM-DD> <CD-n>`; history: CLIENT `## Confirmed Decisions`. Grep the old rule; one task lists pages built on it (L83).
- Rows state what shipped (L82). Reuse a ruling on the same shape of choice (L87). This project's rule beats a skill's (DS §Import). No source, no row.
- **Measure**: fresh verifier, live page, `.claude/tools/measure.js`; @W = each RW-1 width, @L = each RW-2 locale. Code is not evidence (L56).
- Sources: DS kit design standards, V Verification, L kit lesson, P1/P2 live projects.

## Baseline (applies until the project sets its own value)
Public floors, not taste: a page under them looks unfinished whatever the design. No layout, component or section order is required (no hero, eyebrow, card or body-then-button pattern); unusual and creative layouts are expected. "backs X" = holds while row X is unfilled; a filled X replaces it. A row that backs nothing always applies. Where sources differ the stricter floor is kept, noted in Source. Phone < 600px, tablet 600–839, desktop ≥ 840 (Material 3 breakpoints). Skills are under `~/.claude/skills/`.

| Rule | Value / token | How to measure | Source |
|---|---|---|---|
| BL-1 No text or control inside the side gutter; full-bleed images and backgrounds exempt | phone 16px · tablet and desktop 24px | baselineScan().edges at 320, 390, 768, 1024, 1440, 2560 | https://m3.material.io/foundations/layout/breakpoints/compact (16dp; /medium, /expanded, /large-extra-large: 24dp); taste/SKILL.md px-4 agrees |
| BL-2 Sections breathe: last text of one section to first text of the next, and a banded section's edge to its text (backs SP-2, SP-3) | 48px at every width | baselineScan().sections @W | wondelai-refactoring-ui/SKILL.md (page sections 48-64px); ui-ux-pro-max-skill/SKILL.md (tiers up to 48); stricter than taste/SKILL.md phone py-8 (32px) |
| BL-3 A button's label never nears its edge (backs CM-5) | 16px left and right | baselineScan().buttons at 390, 1440 | https://m3.material.io/components/buttons/specs (small button padding 24dp in M3, 16dp in M3 Expressive: the smaller is the floor) |
| BL-4 Card content inset from the card's painted edge, every side | 16px | baselineScan().cards at 390, 1440 | https://m3.material.io/components/cards/specs (left/right padding 16dp; top/bottom not given); interface-design-skill/references/critique.md (16px card padding = tight) carries it to top and bottom |
| BL-5 Field text inset and field height | 16px (12px beside an icon) · 44px tall | baselineScan().fields at 390, 1440 | https://m3.material.io/components/text-fields/specs (left/right padding 16dp, 12dp with icons); height: https://developer.apple.com/design/human-interface-guidelines/buttons (hit region ≥ 44x44 pt) and https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html (44 by 44 CSS px, AAA); M3's 56dp container is a default, not a minimum, so CM-3 (44) stands |
| BL-6 Line height of wrapping body text | 1.5–1.7 × font size | baselineScan().lineHeight @W | https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html (≥ 1.5); impeccable/skill/reference/typeset.md (1.5-1.7; ui-ux-pro-max allows 1.75, stricter 1.7 kept) |
| BL-7 A heading sits nearer its own text than the block above it | space above ÷ space below > 1 | baselineScan().headings at 390, 1440 | impeccable/skill/reference/spatial-design.md (more space above); ui-refactor/references/layout-spacing.md (between groups > within) |
| BL-8 Gap between neighbouring targets; links inside running text exempt | 8px | baselineScan().targets at 390 | https://m3.material.io/foundations/designing/structure (8dp); ui-ux-pro-max-skill/SKILL.md touch-spacing 8px |
| BL-9 Body text line length (backs SP-5) | ≤ 75 characters | baselineScan().measure @W | ui-refactor/references/typography.md (45-75); DS §Hard rules (65ch); https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html (≤ 80); https://m3.material.io/foundations/layout/breakpoints/overview says 40-60: stricter, but DS 65ch wins |
| BL-10 Images keep their proportions; cover and contain crops are fine | drawn ratio = file ratio (1px) | baselineScan().images @W | https://developer.mozilla.org/en-US/docs/Web/CSS/object-fit (fill stretches) |
| BL-11 Every padding, vertical margin and gap is on the grid; no one-off values (backs SP-1) | multiples of 4px | baselineScan().scale at 390, 1440 | impeccable/skill/reference/spatial-design.md (4pt); interface-design-skill/references/critique.md (multiple of 4, no exceptions) |

## Spacing and layout
| Rule | Value / token | How to measure | Source |
|---|---|---|---|
| SP-1 Every gap is a scale step, named by use | `{{tight · small · normal · generous · section}}` | styles() gaps @W are steps | P1 §8; L80 |
| SP-2 Section padding is the section's size token, never at the call site | `{{Section size}}` | equal hero padding-top @W | P2 §Inner-page hero spacing |
| SP-3 Gap between sections by meaning: continues above < default < new band | `{{3 steps}}` | gap() between sections | P1 §8 |
| SP-4 Containers prose / wide / full, chosen per block | `{{prose}}` `{{wide}}` 100% | styles() max-width @W | P1 §8 |
| SP-5 Prose 66–75 characters a line | `{{≈65ch}}` | characters per body line @W | DS §Hard rules; L88 |
| SP-6 A bleeding section's text column is a track, not a fraction | `minmax(0,1fr) min({{prose}},100%)` | SP-5 at 1440, 1920, 2560 | L88; P1 §8 |
| SP-7 One token per axis and shared distance | `{{--axis-*}}` | edge x table @W, difference 0 | DS §Two edges; L80 |
| SP-8 Equal-height grids centre their content | - | space above vs below per card @W @L | DS §A value in a design file |
| SP-9 Badly wrapping text needs a wider box, not smaller type | - | width vs a nowrap probe | DS §When the symptom |
| SP-10 Close a distance, never add an element to cross it; after a resize recheck both axes | - | width, height, gap() before, after | DS §Fixing one axis; L89 |
| SP-11 No sideways scroll, no clipped text | 0px | overflowScan() @W @L | P1 §9; V §25 |
| SP-12 Buttons and fields never span a wide container (cap = prose; phones exempt) | `{{prose}}` | styles() width above `{{first breakpoint}}` | DS §Import; P1 §8 |
| SP-13 Few breakpoints, content-driven, each named by what changes | `{{width → change}}` | every served media query listed | DS §Import; P1 §9 |

## Typography
| Rule | Value / token | How to measure | Source |
|---|---|---|---|
| TY-1 Sizes only from the type scale; no hand-written clamp() if the stack makes it | `{{--text-*}}` | styles() font-size per role @W | DS §Import; P1 §9 |
| TY-2 Body ≥16px on phones | 16px | smallest body size at 320, 390 | DS §Hard rules |
| TY-3 Faces and weights per role | `{{role → face, weight}}` | styles() per role | `{{CD-n}}` |
| TY-4 Design-file values belong to its face: remap weights; its line breaks aren't spec | `{{design → build weight}}` | styles() weights; textCut @W @L | DS §A value in a design file; L85 |
| TY-5 Body copy over 4 lines at 1440 gets a subhead, list, pull-out or photo, never rewritten copy | 4 lines | lines per paragraph at 1440 | P1 §8 |

## Colour and contrast
| Rule | Value / token | How to measure | Source |
|---|---|---|---|
| CO-1 Colour only as tokens, no raw literals; colour space: decide per project | `{{space · --color-*}}` | literals vs tokens per folder | L80 (DS OKLCH vs P1 §4 hex) |
| CO-2 60-30-10, at most one accent | `{{60 · 30 · 10}}` | accent pixel share per section, 1440 | DS §Hard rules |
| CO-3 No AI-purple or AI-blue gradients | - | hue of each gradient stop | DS §Hard rules |
| CO-4 Text 4.5:1 (3:1 at ≥24px or ≥18.66px bold); on photos vs the lightest pixel; per state, role | 4.5 / 3 | renderedContrast(); photos: 2 frozen shots, hideInk, worst glyph | L90; L85; P1 §3b |
| CO-5 Disabled stays readable, never reacts to hover | `{{--ink-disabled}}` | contrast; no :hover matches :disabled | DS §Hard rules; P1 §6b |
| CO-6 Tools are light-only | - | dark-scheme emulation | DS §Hard rules |

## Components and states
| Rule | Value / token | How to measure | Source |
|---|---|---|---|
| CM-1 Compose existing primitives, never hand-roll | `{{library}}` | lint ratchet count only falls | DS §Hard rules; L84 |
| CM-2 Loading, empty, error, success states | - | force each, screenshot | DS §Hard rules |
| CM-3 Targets 44×44 (24 = WCAG floor, exemption stated) | 44px | targetSizes({min: 44}) at 390 | DS §Hard rules; P1 §9 |
| CM-4 :focus-visible ring on everything focusable, 3:1 vs surface | 3:1 | real Tab presses, focusState() | DS §Hard rules; L90; P1 §9 |
| CM-5 Labels dead centre (inline-flex); a hover line is as long as the word | `{{padding per size}}` | ink vs box centre ≤1px | DS §A design system for review |
| CM-6 Button labels never wrap | - | 1 line @W @L | L88 |
| CM-7 Paired buttons share one height; buttons auto-width | - | styles() height per pair | P2 §CTA rules |
| CM-8 Clickable at rest; nothing hover-only | - | touch emulation at 1024 | DS §Motion and compositing; L94 |
| CM-9 A repeated interaction is one exported constant | - | grep: one definition | DS §When the symptom; L87 |
| CM-10 N-across rows fit the longest label per locale and their item count | - | label lines, last-row fill @W @L | DS §A component applied |
| CM-11 Auto-moving content has a pause control | WCAG 2.2.2 | pause by keyboard | L90 |

## Motion
| Rule | Value / token | How to measure | Source |
|---|---|---|---|
| MO-1 Durations and easings only from tokens | `{{--duration-*}}` | grep literals | P2 §Motion tokens; L80 |
| MO-2 Hover, focus, press timing: decide per project | `{{ms · easing}}` | transition per state | P1 §6 0.4–0.8s, P2 §Audience card 0.6s vs DS ≤0.3s |
| MO-3 Nothing animates from scale(0) | - | animationStates() | DS §Hard rules |
| MO-4 prefers-reduced-motion fallback on every animation | - | emulate: end state only | P1 §6 |
| MO-5 Clip-path or mask reveals only on bare media; text gets opacity + translate | - | per frame in a real scroll, longest locale | V §15; L57; L92 |
| MO-6 Hover backplates, moving hovers: decide per project, each a CM-9 pattern | `{{where}}` | forced :hover | P2 §Interactive-state, P1 §6 vs DS: subtle bg, no move |

## Responsive widths and locales
| Rule | Value / token | How to measure | Source |
|---|---|---|---|
| RW-1 Test widths; a fix names the widths and locales it covers and misses | 320 360 390 430 768 1024 1280 1440 1536 1710 1920 2560 `{{+ the user's monitor}}` | device emulation; innerWidth | L59; L62 |
| RW-2 Locales, longest first | `{{de, nl, en}}` | every page in each | L59; L97; P1 §9 |
| RW-3 Reveals keyed to (hover: hover), never width | - | touch emulation at 1024 | DS §Import |
| RW-4 One landscape touch check | `{{844×390}}` | nothing hidden vs portrait | P1 §9 |
| RW-5 Every string translated; one-word labels read; label and link share one source | - | per-locale scan; href vs label | L97 |

## Imagery
| Rule | Value / token | How to measure | Source |
|---|---|---|---|
| IM-1 Served image ≥2× its drawn width | 2× | imageResolution() @W | L88; L99; V §25 |
| IM-2 srcset and sizes on every img; sizes = drawn size | - | DOM scan | P1 §9; V §25 |
| IM-3 Check EXIF orientation before judging a crop; a replaced image gets a new path | - | sips -g orientation; new URL | L99 |
| IM-4 Know what each raster in a design frame is | - | open each asset full size | DS §Templates; L86 |
| IM-5 Alt text and captions state only sourced facts; placeholders flagged or absent | - | alt vs sources | L98; DS §Templates |

## Banned patterns
| Rule | Value / token | How to measure | Source |
|---|---|---|---|
| BAN-1 Unless a row allows it: pill buttons, gradient text, glassmorphism, nested cards, centred hero everything, h-screen crutch, Inter/DM Sans in dashboards, emoji as UI, left-border accent stripes, everything in cards, rule of three everywhere | - | screenshot review; grep bg-clip-text, backdrop-blur | DS §Banned patterns; P2 §CTA |
| BAN-2 Controls made of generic parts (bordered tiles, radio rings, ticks) | - | screenshot review | L94 |
| BAN-3 An eyebrow that repeats its heading | - | eyebrow vs heading | P2 §Eyebrows; L94 |
| BAN-4 Decoration on legal pages | - | screenshot review | L94 |
| BAN-5 Copying a reference: take only its mechanism, from its CSS; near its height with less copy = padded | - | height + words, both pages | DS §A reference is translated; L95 |
