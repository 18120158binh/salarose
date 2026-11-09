---
version: 2
name: Salarose
description: The visual language of the studio. Light, flat surfaces with hairline borders, a dark sidebar, teal for every action a person takes, violet only for AI, and Space Grotesk numbers. Decision 0045 adopts it.
---

# Salarose design system

This page is the studio's visual language. The studio is branded **Salarose**. [Decision 0045](docs/internal/architecture/decisions/0045-adopt-the-salarose-design-system-and-approve-a-visual-draft-before-ui-code.md) adopts it and sets the rule that an owner approves a visual draft of a screen before anyone writes its UI code.

The tokens on this page come from the Salarose design system (`tokens.json`, version 1). Use the token names in code and in reviews. Never inline a hex value.

## Rules

1. **Teal is an action you take.** `accent` marks primary buttons, the active navigation entry, links, selected chips, and toggles that are on.
2. **Violet is AI only.** `ai` marks AI features and nothing else: AI journey generation, AI insights, and generated suggestions. Never use violet for decoration or for an action that is not AI. Never swap teal and violet.
3. **Status is an icon and a word.** Every status (`success`, `warning`, `danger`, `info`) shows an icon and a word, such as a check and "Healthy". Color never carries meaning alone.
4. **Numbers are set in Space Grotesk.** Labels next to them stay small and quiet.
5. **Depth comes from a hairline first.** Use the `border` hairline before a shadow.
6. **Light theme only, for now.** The studio has one theme, Light. Do not build dark variants, a theme switch, or `.dark` token values until the owner adds a dark theme to the design system. The owner instructed this on 2026-11-08. The Account board's theme choice and "Switch to dark theme" button are board leftovers, and this rule overrides them.

## Color

### Surfaces and text

| Token | Value | Use |
|---|---|---|
| `surface-100` | `#F3F3EF` | Page background |
| `surface-200` | `#FDFDFC` | Cards, panels, and the top bar |
| `surface-ink` | `#15171C` | The sidebar and code blocks |
| `ink` | `#16181C` | Primary text |
| `ink-secondary` | `#5A5E66` | Secondary text and labels |
| `ink-muted` | `#676C75` | Captions and axis labels. Never use a lighter gray for text. |
| `ink-inverse` | `#E8E9EB` | Primary text on `surface-ink` |
| `ink-inverse-muted` | `#B9BDC6` | Navigation entries and secondary text on `surface-ink` |
| `border` | `rgba(22,24,28,0.08)` | Card borders and row dividers |
| `border-strong` | `rgba(22,24,28,0.14)` | Input and secondary-button outlines |

### Action and AI

| Token | Value | Use |
|---|---|---|
| `accent` | `#0E6F6A` | Primary actions, active navigation, links, focus ring |
| `accent-strong` | `#0A5350` | Link hover and a pressed primary button |
| `accent-tint` | `rgba(14,111,106,0.10)` | Selected chips, icon tiles, highlighted cards |
| `accent-border` | `rgba(14,111,106,0.30)` | Border of an `accent-tint` surface |
| `ai` | `#6250D6` | AI features only |
| `ai-ink` | `#352A77` | Headings on `ai-tint` |
| `ai-body` | `#3A3655` | Body text on `ai-tint` |
| `ai-tint` | `rgba(98,80,214,0.08)` | Background of AI cards, banners, and badges |
| `ai-border` | `rgba(98,80,214,0.30)` | Border of an `ai-tint` surface |

A tint is a translucent wash with its matching `-border`. Never use a solid pastel fill.

### Status

| Token | Value | Use |
|---|---|---|
| `success-text` | `#006300` | Positive changes and "Healthy", beside an icon |
| `success-fill` | `#0ca30c` | Live dots and success icon fills |
| `warning-text` | `#8A5A00` | Warning text, beside an icon |
| `warning-fill` | `#fab219` | Warning dot fills |
| `danger` | `#B3261E` | Destructive actions and negative changes |
| `info` | `#184f95` | Running and in-progress states |

### Charts

| Token | Value | Use |
|---|---|---|
| `chart-1` | `#2a78d6` | Series 1, and every single-series bar |
| `chart-2` | `#eb6834` | Series 2 |
| `chart-3` | `#1baf7a` | Series 3. Under 3:1 on white, so it always needs direct value labels. |
| `chart-track` | `#F0F0EB` | Track behind a bar, and the neutral chip fill |
| `chart-grid` | `#E3E2DC` | Gridlines |

### Brand only

`sky` (`#B7D6EA`), `blush` (`#EBDFD8`), `salt` (`#F8F7F2`), and `rose-sun` (`#F8A868`) draw the horizon on the sign-in page and the mark. They never carry text. `rose-sun` fails text contrast.

## Typography

| Family | Token | Stack | Use |
|---|---|---|---|
| Space Grotesk | `display` | `'Space Grotesk', sans-serif` | Page titles, card titles, and every number |
| IBM Plex Sans | `sans` | `'IBM Plex Sans', system-ui, sans-serif` | All other UI text |
| Mono | `mono` | `ui-monospace, SFMono-Regular, Menlo, monospace` | Event names, field names, and ids, such as `com.acme/add_to_cart` |

| Style | Family | Size / line height | Weight | Use |
|---|---|---|---|---|
| `page-title` | display | 19px / 1.3 | 600 | One per screen |
| `card-title` | display | 15px / 1.4 | 600 | Card and panel titles |
| `stat-number` | display | 26px / 1.2 | 600 | KPI values |
| `body` | sans | 13.5px / 1.5 | 400 | Default UI text |
| `body-strong` | sans | 13.5px / 1.5 | 600 | Emphasis and button labels |
| `body-sm` | sans | 12.5px / 1.5 | 400 | Table cells and secondary rows |
| `caption` | sans | 11.5px / 1.45 | 400 | Timestamps and footnotes, in `ink-secondary` or darker |
| `overline` | sans | 11px / 1.3, letter spacing 1.4px, uppercase | 600 | Eyebrows and sidebar group labels |
| `code` | mono | 12px / 1.6 | 400 | Snippets on `surface-ink` |
| `data-chip` | mono | 11.5px / 1.4 | 400 | Event names, field names, ids |

The `hero`, `display-stat`, `h1`, and `h2` styles of the design system are for marketing pages. The studio does not use them.

Use `font-variant-numeric: tabular-nums` in tables and on axis ticks.

## Spacing, radius, and shadow

| Token | Value | Use |
|---|---|---|
| `space-1` | 4px | Icon-to-label gaps |
| `space-2` | 8px | Chip gaps and tight stacks |
| `space-3` | 12px | Control padding and dense grids |
| `space-4` | 16px | Card grid gaps |
| `space-5` | 20px | Sections inside a page |
| `space-6` | 28px | Page gutters |
| `space-7` | 44px | Marketing and sign-in only: spacing inside a section |
| `space-8` | 84px | Marketing and sign-in only: spacing between sections |

| Token | Value | Use |
|---|---|---|
| `radius-control` | 8px | Buttons, inputs, selects |
| `radius-tile` | 10px | KPI tiles, nested cards, icon tiles |
| `radius-card` | 12px | Cards and panels |
| `radius-pill` | 999px | Badges, chips, toggles, avatars |
| `radius-hero` | 16px | Marketing and sign-in only: the card on the horizon |

| Token | Value | Use |
|---|---|---|
| `shadow-card` | `0 1px 2px rgba(22,24,28,0.08)` | Active tab pill |
| `shadow-pop` | `0 2px 8px rgba(14,111,106,0.12)` | Selected cards and journey nodes |
| `shadow-hero` | `0 24px 60px rgba(26,43,51,0.14)` | Marketing and sign-in only: the card on the horizon |

The studio pages inside the shell never use `space-7`, `space-8`, `radius-hero`, or `shadow-hero`.

## Icons

Icons come from one set, lucide: stroke icons with 2px round joins in `currentColor`, 17px in the sidebar and controls and 20px in empty states. AI features use the four-point spark. No emoji and no hand-drawn inline SVG, except the Salarose mark.

The mark is a rose-sun half disc on a white horizon line, with its reflection below, on a teal tile with `radius-card` corners. Do not recolor it or separate the sun from the horizon.

## App patterns

Build each pattern from the coss components in `shared/components/ui`. Add a variant there instead of changing a component that another page uses.

### App shell

- **Sidebar.** 240px wide, `surface-ink` background. Entries are `body` in `ink-inverse-muted` with a 17px icon and `radius-control` corners. The current entry has a white wash at 10% and white `body-strong` text. Group labels, such as DATA and ADMIN, are `overline`. A Preview badge is a pill at the end of the entry. The sidebar collapses to a 64px rail of icons, where a small mint dot marks a Preview page. Below 768px it opens as a sheet from the left.
- **Top bar.** `surface-200` with a `border` bottom line. Left: a breadcrumb of the workspace name, then the page. Center or right: the search button, "Search or jump to…", with its shortcut in a `kbd`. Right: the account menu behind an avatar with the viewer's initials.
- **Content.** `surface-100` background with `space-6` gutters. Tables use the full width. Forms and profile text cap at 720px.

Studio pages have no footer. The [studio shell](docs/internal/features/studio-shell.md) contract owns what the sidebar and the top bar contain.

### Page header

One per page. The title is `page-title`. A one-line description in `body`, `ink-secondary`, sits below it. At most one primary button sits on the right, with secondary actions as outline buttons or in a menu. A Preview badge sits next to the title of a page at stage `preview`.

### Buttons

- Primary: `accent` background, white `body-strong` text, `radius-control`. Pressed: `accent-strong`.
- Secondary: `surface-200` background, `border-strong` outline, `ink` text.
- Destructive: `danger`.
- AI: `ai` background or an `ai-tint` card, only for an AI action.

### Data table

- The table sits in a card: `surface-200`, `border`, `radius-card`.
- Header row in `caption`, `ink-muted`. Rows in `body-sm`, separated by `border`. The whole row is the click target when it opens something. Row actions sit in a trailing menu.
- Numbers are right-aligned with tabular figures. Ids and event names use `data-chip` as secondary text, never as the main label.
- Status is a pill with an icon and a word.
- Search, filters, and sort sit in a toolbar above the table. Paging sits below it.

### KPI card

A card with `radius-tile` and 16px padding. From top to bottom: the label in `caption`, `ink-secondary`, with an info icon whose tooltip defines the number; the value in `stat-number`; the change against the previous period in `caption`, an arrow and the sign, in `success-text` when it moves the good way, `danger` when it moves the bad way, `ink-muted` at 0. A card that cannot compute its value says "Not available" with the reason, never 0.

### Charts

- Series take `chart-1`, `chart-2`, `chart-3` in that order, never cycled. With more than three series, fold the rest into "Other" or split the chart.
- Magnitude across categories is single-hue `chart-1` bars on `chart-track`, with a 4px rounded end and right-aligned value labels.
- Gridlines are `chart-grid` hairlines. Axis text is `ink-muted`, 11px. Never two axes. Never a label on every point.
- Every chart has a tooltip with exact values, and a table or text with the same numbers for screen readers.
- Good and bad use the status tokens, not the chart tokens.

### Page states

- **Loading.** A skeleton with the layout of the loaded region. No motion when the viewer asks for reduced motion.
- **Empty.** One sentence that says what is missing and what to do next, a 20px icon in `ink-muted` above it, and one secondary button when the viewer may act. No illustration, no emoji.
- **Error.** One fixed sentence that names what failed, and **Try again**.
- **Not available.** A dash and "Not available:" with the reason.

### Toasts, sheets, and dialogs

- A toast reports the outcome of an action, bottom right, on `surface-200` with a `border` and `radius-card`. It closes after 5 seconds, or stays until closed when it carries an error or **Undo**. Never use a browser alert or confirm.
- A side sheet shows a row's detail or an edit form from the right, 480px wide, 640px for a form with a preview. Escape and a click outside close it. A sheet with unsaved changes asks before it closes.
- A dialog asks one question: a title, one or two sentences that say what will happen, the action on the right named by its verb, and **Cancel**. A destructive action uses the destructive button.

### Focus

Every control shows a 2px `accent` focus ring, offset 2px, on `:focus-visible`.

## Motion

Keep motion calm and short. Put every animation inside `@media (prefers-reduced-motion: no-preference)`. The horizon on the sign-in page may drift slowly. App pages do not animate beyond hover, focus, and opening a sheet or dialog.

## Copy

Write labels the way a marketer talks: "Entries", "Waiting", "Dropped data", "Hidden from builder". No engineering terms, no raw ids as main labels, no stack traces. Say what the data shows, and name the mechanism only when asked.

## Responsive behavior

| Width | Layout |
|---|---|
| 1024px and up | Full layout, sidebar open |
| 768px to 1023px | Sidebar starts collapsed to its rail |
| Below 768px | Sidebar opens as a sheet from a menu button |

Touch targets are at least 40 by 40px. Inputs are 40px tall.
