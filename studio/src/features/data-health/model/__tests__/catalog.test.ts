/** @jest-environment node */
import { runPostgres } from '@/features/journey-analytics/model/testing/pg'
import {
  mustSendNote,
  CATALOG_PAGE_SIZE,
  catalogAttributesQuery,
  catalogCountQuery,
  catalogHref,
  catalogPageQuery,
  DEFAULT_CATALOG_QUERY,
  pageCountOf,
  parseCatalogCount,
  parseCatalogEvents,
  parseCatalogQuery,
  type CatalogQuery,
} from '../catalog'

type EventFixture = {
  id: string
  name: string
  label?: string | null
  kind?: 'person' | 'business'
  status?: 'active' | 'inactive' | null
  gate?: boolean
  fields?: { path: string; type?: string; required?: boolean; example?: string }[]
}

function literal(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

function catalogSql(events: readonly EventFixture[]): string {
  return events
    .flatMap((event) => {
      const kind = event.kind ?? 'person'
      const row = `INSERT INTO user_events (id, event_name, display_name, kind, item_key, status, enforce_schema, created_at)
VALUES (${literal(event.id)}, ${literal(event.name)}, ${literal(event.label === undefined ? event.name : event.label)}, '${kind}',
${kind === 'business' ? "'product.id'" : 'NULL'}, ${literal(event.status === undefined ? 'active' : event.status)}, ${event.gate === true}, '2026-11-01T08:00:00Z');`
      const fields = (event.fields ?? []).map(
        (field) => `INSERT INTO user_event_fields (user_event_id, field_path, data_type, required, example_value)
VALUES (${literal(event.id)}, ${literal(field.path)}, ${literal(field.type ?? 'string')}, ${field.required === true}, ${literal(field.example ?? null)});`,
      )
      return [row, ...fields]
    })
    .join('\n')
}

/** The rows the server would read for a query: the count, then the page, then the page's attributes. */
function loadPage(events: readonly EventFixture[], query: CatalogQuery) {
  const [countRows, eventRows] = runPostgres(catalogSql(events), [catalogCountQuery(query), catalogPageQuery(query, query.page)])
  const ids = eventRows.map((row) => String(row.id))
  const [attributeRows] = ids.length === 0 ? [[]] : runPostgres(catalogSql(events), [catalogAttributesQuery(ids)])
  return { ...parseCatalogCount(countRows), events: parseCatalogEvents(eventRows, attributeRows) }
}

const query = (change: Partial<CatalogQuery>): CatalogQuery => ({ ...DEFAULT_CATALOG_QUERY, ...change })

// 60 events. Six hold "cart" in the system name or the display name, in either case.
const SIXTY: EventFixture[] = [
  { id: 'e-add', name: 'add_to_cart', label: 'Add to cart' },
  { id: 'e-remove', name: 'remove_from_cart', label: 'Remove from cart' },
  { id: 'e-view', name: 'view_cart', label: 'Basket viewed' },
  { id: 'e-abandon', name: 'checkout_abandoned', label: 'Cart abandoned' },
  { id: 'e-upper', name: 'promo_seen', label: 'CART banner seen' },
  { id: 'e-vendor', name: 'vn.example/cart_cleared', label: null },
  ...Array.from({ length: 54 }, (_, index) => ({ id: `e-${index}`, name: `page_view_${String(index).padStart(2, '0')}`, label: `Page view ${String(index).padStart(2, '0')}` })),
]

describe('event catalog view (DHL-FR-01)', () => {
  it('shows only the events whose system or display name contains "cart", ignoring case, at most 50 per page', () => {
    const page = loadPage(SIXTY, query({ search: 'cart' }))

    expect(page.catalogSize).toBe(60)
    expect(page.matching).toBe(6)
    expect(page.events.map((event) => event.name).sort()).toEqual(
      ['add_to_cart', 'checkout_abandoned', 'promo_seen', 'remove_from_cart', 'view_cart', 'vn.example/cart_cleared'].sort(),
    )
  })

  it('shows 50 rows on the first page and the other 10 on the second, sorted by display name', () => {
    const first = loadPage(SIXTY, query({}))
    const second = loadPage(SIXTY, query({ page: 2 }))

    expect(first.events).toHaveLength(CATALOG_PAGE_SIZE)
    expect(second.events).toHaveLength(10)
    expect(pageCountOf(first.matching)).toBe(2)
    const labels = [...first.events, ...second.events].map((event) => event.label.toLowerCase())
    expect(labels).toEqual([...labels].sort())
    expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(60)
  })

  it('shows add_to_cart with the gate on and 2 of 3 attributes required as Schema gate On and "3, 2 required"', () => {
    const page = loadPage(
      [
        {
          id: 'e-add',
          name: 'add_to_cart',
          label: 'Add to cart',
          gate: true,
          fields: [
            { path: 'product.id', required: true, example: 'SKU-1' },
            { path: 'product.price', type: 'number', required: true, example: '500000' },
            { path: 'quantity', type: 'number' },
          ],
        },
      ],
      query({}),
    )

    const [event] = page.events
    expect(event.gate).toBe(true)
    expect(mustSendNote(event)).toBe('2 must be sent')
    expect(event.attributes).toEqual([
      { path: 'product.id', type: 'string', required: true, example: 'SKU-1' },
      { path: 'product.price', type: 'number', required: true, example: '500000' },
      { path: 'quantity', type: 'number', required: false, example: null },
    ])
  })

  it('narrows by kind, status, and schema gate together', () => {
    const events: EventFixture[] = [
      { id: 'a', name: 'price_drop', kind: 'business', gate: true },
      { id: 'b', name: 'stock_low', kind: 'business', gate: false },
      { id: 'c', name: 'signup', kind: 'person', gate: true },
      { id: 'd', name: 'old_promo', kind: 'business', gate: true, status: 'inactive' },
      { id: 'e', name: 'legacy', kind: 'person', status: null },
    ]

    expect(loadPage(events, query({ kind: 'business', status: 'active', gate: 'on' })).events.map((event) => event.id)).toEqual(['a'])
    expect(loadPage(events, query({ status: 'inactive' })).events.map((event) => event.id)).toEqual(['d'])
    expect(loadPage(events, query({ status: 'active', kind: 'person', gate: 'off' })).events.map((event) => event.id)).toEqual(['e'])
  })

  it('treats % and _ in the search as plain characters', () => {
    const events: EventFixture[] = [
      { id: 'a', name: 'add_to_cart' },
      { id: 'b', name: 'addxtoxcart' },
      { id: 'c', name: 'discount', label: '10% off' },
    ]

    expect(loadPage(events, query({ search: 'add_to' })).events.map((event) => event.id)).toEqual(['a'])
    expect(loadPage(events, query({ search: '%' })).events.map((event) => event.id)).toEqual(['c'])
  })

  it('counts an empty catalog as 0 events, with one page', () => {
    const page = loadPage([], query({}))

    expect(page).toEqual({ catalogSize: 0, matching: 0, counts: { strict: 0, hidden: 0, item: 0 }, events: [] })
    expect(pageCountOf(0)).toBe(1)
  })
})

describe('the address of a catalog view', () => {
  it('reads the search, the filters, and the page, and turns unknown values into no filter', () => {
    expect(parseCatalogQuery({ q: '  cart ', kind: 'business', status: 'inactive', gate: 'on', page: '3' })).toEqual({
      search: 'cart',
      kind: 'business',
      status: 'inactive',
      gate: 'on',
      page: 3,
    })
    expect(parseCatalogQuery({ kind: 'robot', status: ['active', 'inactive'], gate: '', page: '-1' })).toEqual({
      ...DEFAULT_CATALOG_QUERY,
      status: 'active',
    })
    expect(parseCatalogQuery({ page: '1.5' }).page).toBe(1)
  })

  it('writes back what it reads, and leaves defaults out', () => {
    const shared = query({ search: 'add to', kind: 'person', gate: 'off', page: 2 })

    expect(catalogHref(DEFAULT_CATALOG_QUERY)).toBe('/v2/data/events')
    expect(parseCatalogQuery(Object.fromEntries(new URL(catalogHref(shared), 'https://studio.test').searchParams))).toEqual(shared)
  })
})

describe('parseCatalogEvents', () => {
  it('leaves out a row whose kind breaks the CHECK, and keeps the others', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const events = parseCatalogEvents(
      [
        { id: 'a', event_name: 'ok', label: 'OK', kind: 'person', status: 'active', enforce_schema: false, attribute_count: 0, required_count: 0, created_at: null },
        { id: 'b', event_name: 'broken', label: 'Broken', kind: 'robot', status: 'active', enforce_schema: false, attribute_count: 0, required_count: 0, created_at: null },
      ],
      [],
    )

    expect(events.map((event) => event.id)).toEqual(['a'])
    expect(mustSendNote(events[0])).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
