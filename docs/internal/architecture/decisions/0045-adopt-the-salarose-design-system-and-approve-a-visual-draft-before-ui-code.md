---
title: Adopt the Salarose design system, and approve a visual draft before UI code
id: 0045
status: accepted
date: 2026-11-08
tags: [studio, ui, design]
supersedes: ["0034"]
superseded_by: []
---

# 0045. Adopt the Salarose design system, and approve a visual draft before UI code

## Context

Until 2026-11-08, DESIGN.md was an analysis of a marketing site, Cal.com: black primary buttons, Cal Sans headings, a dark footer, and an "App patterns" section that adapted it to studio v2. It asked for every page in both a light and a dark theme. Studio v2 was built from contracts and that page, with no picture of a screen before the code. The owner then found the live v2 Data pages confusing: the code met its contracts, but the owner saw the result only after it shipped.

The owner then had the whole studio redrawn as clickable boards in their own design system, Salarose, and approved the boards on 2026-11-08. The boards keep every control the live pages have and change their layout, names, and look.

## Decision

The studio uses the Salarose design system. DESIGN.md holds its tokens and the app patterns built from them: teal for an action a person takes, violet for AI only, status as an icon and a word, Space Grotesk for headings and numbers, IBM Plex Sans for UI text, and mono for ids. The studio has a light theme only until the owner adds a dark theme to the design system, as the owner instructed on 2026-11-08 in the brief for studio v3: "Light theme only for now." The brand is Salarose.

A new screen, or a change to the layout of an existing screen, starts as a visual draft that the owner approves. The feature contract changes to match the approved draft, and only then is UI code written. A change that keeps the layout, such as a fixed label or a bug fix, needs no draft.

## Why

- The boards are what the owner approved. A contract written from them, and code written from the contract, ship what the owner expects. The v2 Data pages show the cost of the other order.
- A draft is cheap to change and code is not. The owner answered the open questions on the boards in one review, before any code moved.
- One design system for every screen removes the rules DESIGN.md had for a marketing site that the studio never had: the dark footer, the black buttons, and the hover ban.
- The owner instructed light only on 2026-11-08. Light only halves the work of each screen while real marketers start, and the design system defines one theme.
- The Account board shows a Light and Dark choice under Preferences, and its top bar has a "Switch to dark theme" button. Both are board leftovers from the v2 shell. The owner's instruction overrides them, and the contracts leave them out.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the Cal.com-based DESIGN.md and restyle it | The owner approved Salarose. Two visual languages would conflict on button color, fonts, and the role of violet. |
| Keep light and dark themes | The design system has no dark tokens. A dark theme invented in code would be a design no one approved. |
| Write UI code from contracts only, and review the shipped page | This is how the v2 Data pages reached the owner, and the owner found them confusing. |

## Consequences

- DESIGN.md is rewritten to Salarose. Code must use its tokens by name, never an inline hex value, and must not use violet outside AI features.
- The studio shell drops the theme switch and the requirement that every page render in both themes. The `theme` cookie that the classic studio reads is no longer written by v2.
- The sign-in page shows the Salarose brand and a horizon background. That is a change of look only: its links, order, and messages stay as the admin authentication contract states them.
- Every UI lane starts from an approved board. A lane that needs a screen with no board stops and asks for a draft.
- The rule that v2 pages render in both themes, stated in DESIGN.md's former "Dark mode" section and in the studio shell contract, is retired. This record supersedes [decision 0034](0034-build-studio-v2-side-by-side-under-v2.md) in one part only: 0034 says the classic and v2 pages share the `theme` cookie. From this record, v2 reads no theme and writes no `theme` cookie, and the classic pages keep reading the cookie until classic removal. The rest of 0034 and [decision 0037](0037-one-studio-retire-the-classic-studio.md) stand.

## Related

- [DESIGN.md](../../../../DESIGN.md)
- [Studio shell](../../features/studio-shell.md)
- [Admin authentication](../../features/admin-authentication.md)
- [0034. Build studio v2 side by side under `/v2`](0034-build-studio-v2-side-by-side-under-v2.md)
- [0037. One studio: retire the classic studio](0037-one-studio-retire-the-classic-studio.md)
