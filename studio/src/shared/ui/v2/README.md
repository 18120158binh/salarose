# Page kit

The parts every studio v2 page is built from, in the Salarose design. Use these before you write a new card, header, table, or state. If a page needs something the kit lacks, add it here with a test instead of building it inside a feature.

## Theme

The v2 shell marks its root with `data-salarose`. While it is on the page, `studio/app/globals.css` swaps the coss tokens to Salarose values on the whole document, menus and dialogs included, and the v2 layout loads Space Grotesk and IBM Plex Sans. The classic studio never renders that attribute, so it keeps its look. v2 is light only (SHL-FR-14). The `dark` variant and the dark tokens are off while a v2 shell is on the page, even when the classic theme cookie puts `dark` on `<html>`, so never write a `dark:` class for v2.

Use the coss components in `shared/components/ui` and the Tailwind token classes. Never hardcode a hex value.

| Role | Class |
|---|---|
| Page ground, card, popover | `bg-background`, `bg-card`, `bg-popover` |
| Text, secondary text | `text-foreground`, `text-muted-foreground` |
| Captions, axis labels, empty-state icons (`ink-muted`) | `text-ink-muted` |
| An action: primary button, link, active control | `primary` (teal) |
| AI features only | `text-ai`, `bg-ai-tint`, `border-ai-border` |
| Status | `text-success`, `text-warning`, `text-destructive`, `text-info`, always with an icon |
| Headings and every number | `font-heading` (Space Grotesk), with `tabular-nums` in tables |
| Ids and event names | `font-mono` |
| Spacing (`space-1` to `space-8`, 4px to 84px) | `p-space-6`, `gap-space-4`, and the like. Page gutters are `space-6`. `space-7` and `space-8` are for sign-in only. |
| Radii | `rounded-control` (8px) for controls, `rounded-tile` (10px) for KPI tiles, `rounded-card` (12px) for cards |

## Parts

| Part | File | Use it for |
|---|---|---|
| `PageHeader` | `PageHeader.tsx` | The one header per page: title, description, actions on the right, controls below. `preview` adds the Preview badge. |
| `SectionCard` | `SectionCard.tsx` | A titled card with optional actions. `flush` lets a table or list run to its edges. |
| `KpiCard`, `KpiRow` | `KpiCard.tsx` | A number with its definition, change, and sparkline. A value the page cannot compute shows "Not available" with the reason. |
| `StatusBadge` | `StatusBadge.tsx` | A status as an icon and a word: `success`, `warning`, `error`, `info`, `neutral`. |
| `PreviewBadge` | `PreviewBadge.tsx` | A page, sidebar entry, or control at stage preview. `on="primary"` inside a primary button. |
| `DataTable`, `CellLabel`, `TablePager` | `DataTable.tsx` | A table in a card, with row links, row menus, a toolbar, and paging. |
| `DataRegion` | `DataRegion.tsx` | A part of a page that loads on its own, with its own loading and error state. |
| `RegionEmpty`, `RegionError`, `RegionSkeleton`, `TableSkeleton`, `NotAvailable` | `states.tsx` | The empty, error, loading, and not-available states of a region. |
| `Forbidden`, `PageNotFound` | `states.tsx` | A whole page the viewer may not open, or one that does not exist for them. |
| `RangePicker` | `RangePicker.tsx` | Today, Last 7 days, Last 30 days, with the time zone. |
| `SideSheet` | `SideSheet.tsx` | Row detail or an edit form beside a list. |
| `toast` | `toast.ts` | The outcome of an action. Never a browser alert. |

## A page

```tsx
<PageHeader actions={<Button>Add event</Button>} description="The actions your sites send to Studio." title="Events" />
<KpiRow>
  <KpiCard change={null} definition="Events received in the range." label="Events" value={reading} />
</KpiRow>
<DataTable columns={columns} empty={<RegionEmpty icon={InboxIcon} message="No event yet." />} label="Events" rowKey={(row) => row.id} rows={rows} />
```
