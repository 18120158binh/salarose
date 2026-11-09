/** @jest-environment node */

// The customer lookup loaders check the session before they touch the database, so a page that
// forgets its own check still reads nothing for a visitor who is not signed in.
const mockRequireViewer = jest.fn()
const mockReadOnly = jest.fn()

// A relative path, because the jest moduleNameMapper sends `@/widgets/...` to the studio root.
jest.mock('../../../../widgets/v2-shell/model/viewer', () => ({ requireViewer: () => mockRequireViewer() }))
jest.mock('@/lib/db', () => ({ readOnly: (...args: unknown[]) => mockReadOnly(...args) }))

import { loadEntries, loadIdentities, loadMessages, loadMetrics, loadPerson, searchCustomers } from '../server'

const loaders: [string, () => Promise<unknown>][] = [
  ['searchCustomers', () => searchCustomers('usr_1001')],
  ['loadPerson', () => loadPerson('P1')],
  ['loadIdentities', () => loadIdentities('P1')],
  ['loadEntries', () => loadEntries('P1')],
  ['loadMetrics', () => loadMetrics('P1')],
  ['loadMessages', () => loadMessages('P1')],
]

beforeEach(() => {
  mockRequireViewer.mockReset()
  mockReadOnly.mockReset()
})

describe.each(loaders)('%s', (_name, load) => {
  it('rejects with the sign-in redirect and reads nothing without a session', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' })
    mockRequireViewer.mockRejectedValue(redirect)

    await expect(load()).rejects.toBe(redirect)
    expect(mockReadOnly).not.toHaveBeenCalled()
  })

  it('reads through the read-only helper with the statement timeout for any staff user (CUS-FR-09)', async () => {
    mockRequireViewer.mockResolvedValue({ userId: 'user_lan', email: 'lan@example.com', role: 'editor' })
    mockReadOnly.mockResolvedValue('rows from readOnly')

    await expect(load()).resolves.toBe('rows from readOnly')
    expect(mockReadOnly).toHaveBeenCalledWith(5000, expect.any(Function))
  })
})

it('searches nothing for a blank text', async () => {
  mockRequireViewer.mockResolvedValue({ userId: 'user_lan', email: 'lan@example.com', role: 'editor' })
  await expect(searchCustomers('   ')).resolves.toEqual([])
  expect(mockReadOnly).not.toHaveBeenCalled()
})
