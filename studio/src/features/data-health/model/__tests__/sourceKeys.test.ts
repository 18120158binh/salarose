/** @jest-environment node */
import { runPostgres } from '@/features/journey-analytics/model/testing/pg'
import { parsePipelineDashboards } from '../dashboards'
import { parseSourceKeyRows, SOURCE_KEYS_QUERY } from '../sourceKeys'

const HASH = 'a3f1c2d4e5b6a7980f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978'

const SETUP = `
INSERT INTO system_users (id, email, role, oidc_issuer, oidc_subject) VALUES ('u-minh', 'minh@example.com', 'admin', 'https://idp.test', 'minh');
INSERT INTO ingestion_source_keys (id, app_id, key_hash, key_hint, created_by, created_at, revoked_at) VALUES
  ('k-old', 'inventory', '${HASH}', 'cdp_sk_Ab12', 'u-minh', '2026-10-01T08:00:00Z', '2026-10-20T09:30:00Z'),
  ('k-new', 'inventory', 'b'::text || repeat('0', 63), 'cdp_sk_Cd34', 'u-minh', '2026-10-20T09:31:00Z', NULL),
  ('k-crm', 'crm', 'c'::text || repeat('0', 63), 'cdp_sk_Ef56', NULL, '2026-11-02T10:00:00Z', NULL);
`

describe('source keys view (DHL-FR-04)', () => {
  const [rows] = runPostgres(SETUP, [SOURCE_KEYS_QUERY])
  const keys = parseSourceKeyRows(rows)

  it('lists active keys first, then by app id, with the creator email', () => {
    expect(keys.map((key) => [key.id, key.appId, key.createdBy, key.status.kind])).toEqual([
      ['k-crm', 'crm', null, 'active'],
      ['k-new', 'inventory', 'minh@example.com', 'active'],
      ['k-old', 'inventory', 'minh@example.com', 'revoked'],
    ])
  })

  it('shows a revoked key as Revoked with the time', () => {
    expect(keys[2].status).toEqual({ kind: 'revoked', at: Date.parse('2026-10-20T09:30:00Z') })
  })

  it('never reads a key hash', () => {
    expect(SOURCE_KEYS_QUERY.text).not.toMatch(/key_hash|\*/)
    expect(JSON.stringify(rows)).not.toContain(HASH)
    expect(JSON.stringify(keys)).not.toContain(HASH)
  })
})

describe('parsePipelineDashboards (DHL-FR-03)', () => {
  it('reads each dashboard by name and address', () => {
    expect(parsePipelineDashboards('[{"name":"Flink jobs","url":"https://grafana.example.com/d/flink"}]')).toEqual([
      { name: 'Flink jobs', url: 'https://grafana.example.com/d/flink' },
    ])
  })

  it('declares none when the value is missing or is not a JSON array, and skips an invalid entry', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parsePipelineDashboards(undefined)).toEqual([])
    expect(parsePipelineDashboards('  ')).toEqual([])
    expect(parsePipelineDashboards('{"name":"x"}')).toEqual([])
    expect(
      parsePipelineDashboards('[{"name":"Bad","url":"javascript:alert(1)"},{"name":"","url":"https://g.test"},{"name":"Lag","url":"https://g.test/d/lag"}]'),
    ).toEqual([{ name: 'Lag', url: 'https://g.test/d/lag' }])
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })
})
