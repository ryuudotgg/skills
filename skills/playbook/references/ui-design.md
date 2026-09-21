# UI design

Read this when the work ships a browser-rendered surface: a new page, a component, a redesign, or a prototype that settles a visual decision. The Feature playbook (`../playbooks/feature.md`) points here from steps 1 and 5, the Prototype playbook (`../playbooks/prototype.md`) from steps 2 and 4. A visual-direction skill, if one is installed (Anthropic's `frontend-design` is the usual one), owns palette, type, and the signature element. This file owns what to establish before designing and what to check after building, and it stands on its own without any other skill.

## Before designing

- Name the surface's mode from what the visitor succeeds at there, never from the product. **Persuade** (landing, pricing) means the visitor decides and acts. **Operate** (app UI, dashboards, settings) means the visitor completes a task, so scanability and native expectations outrank expression. **Read** (docs, articles, changelogs) means structure for comprehension. **Experience** (portfolios, galleries) means the artifact leads and the interface recedes. A tool's landing page is still Persuade. A fashion house's docs are still Read.
- Inspect the incumbent before inventing. Tokens, shared components, neighboring screens, fonts, assets. A missing `DESIGN.md` does not make the project greenfield. Refinement keeps the incumbent identity, behavior and copy. Redesign replaces the look and keeps content, function and constraints. Never split the difference into polish on a discarded look.
- On a redesign, list what survives unless the brief puts it in scope: routes and anchors, navigation labels, copy voice, form and analytics contracts, accessibility behavior.
- Real content or labeled examples. Invented numbers, testimonials and claims are not placeholders. Label an illustrative value in the UI itself. An HTML comment discloses nothing to a user.

## Building

- One accent. One elevation system per component, border or shadow, never both on the same card. One icon family at one stroke weight, drawn from a library or authored SVG, never emoji or unicode glyphs.
- Cards are the lazy container. Same-size icon-plus-heading-plus-text cards as page structure, nested cards, and the big-number-small-label hero metric are category defaults, not choices. A kicker or eyebrow above a heading never earns its place.
- Gradient text, zero-offset colored glow shadows, glass as decoration, and a colored left border thicker than 1px are the detector's most common hits. Emphasis comes from weight or size.
- Light or dark comes from the use scene (who, where, under what light), not from the category.

## Motion

If Emil Kowalski's `animate` and `review-animations` skills are installed, run the first for motion you add and the second for motion you inherit. Without them, the gate below is the whole rule:

- Name the purpose in one word before writing motion: feedback, spatial consistency, state indication, preventing a jarring change, explanation, delight. No word, no animation.
- Match frequency. Something seen 100 or more times a day (keyboard shortcuts, command palette, tab switches) gets no animation. Tens a day gets near-imperceptible motion or nothing. Occasional (modals, toasts, drawers) gets standard motion. Delight lives only at rare or first-time moments.
- Extend the codebase's easing and duration tokens. A parallel system is a defect. Entrances ease out. Nothing appears from `scale(0)`. Animate `transform` and `opacity`, and reach for blur, clip-path or mask only when they stay smooth.
- Reduced motion and hover gating ship with the animation, not after.

## Prototype variants

- Each variant diverges on a named axis (layout, density, personality, interaction model, motion). Two variants that differ only in accent or copy are one variant. Replace one. Name variants by direction (Quiet, Editorial, Dense), never A/B/C.
- Render one variant at a time, full size, inside realistic surrounding context. A toast needs a page behind it, a card needs siblings. Thumbnails distort spacing and scale. The switch between variants is instant. It fires too often to animate.

## Verify

Batch the inspection. Build fully, inspect once at desktop and mobile together, fix everything that round shows in one batch, confirm with at most one more round, and stop. Open-ended self-QA burns money without raising the bar.

Each item is a check on the rendered result through the live browser MCP, not an intention:

- Contrast. Body and placeholder text at 4.5:1 or better, large text at 3:1. On colored surfaces, tint secondary text from the surface hue or the foreground, never gray.
- Type. Body measure 65 to 75 characters, obvious scale and weight steps, tracking no tighter than -0.04em, headings balanced. Run the real copy at every breakpoint and fix what overflows.
- Spacing. Tight inside a group, generous between groups, more space above a heading than below it. Read computed values.
- States. Hover, focus, disabled, loading, error, empty, success, and permission-denied where roles exist. Long content, keyboard-only navigation, 200% zoom.
- Browser surfaces. Text selection, caret, scrollbars, focus rings, underline offset, tabular numerals. These ship with defaults from no design system. Theme them from the palette.
- Copy. Controls name their action ("Save changes", not "Submit"), and the same action keeps its name through the whole flow. Errors name the problem and the recovery.
- Coverage. Every brief requirement present and findable within seconds.
- Detector. Where `npx` is available, run `npx impeccable detect --no-config <files>` over the markup and style files you touched, then clear or justify each hit. It needs no model and no key. Without it, the Building section above is the checklist. A clean scan is supporting evidence, not a pass.

A full-page screenshot can look right while its small text is misread, so a check that turns on dense labels, small type or a subtle defect gets its own element screenshot at device pixel scale and is judged on that image, not inside the full page. That is not the 200% zoom check above, which tests reflow. Where the MCP in use offers no element screenshot, establish a way to crop and enlarge before trusting a full-page image on those checks.

Record the tested route, viewports, states, and any unresolved finding in the handback. "Inconclusive" is not a pass.
