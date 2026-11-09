import { searchText } from '../search'

describe('searchText (CUS-FR-01, CUS-FR-11)', () => {
  it('searches nothing for blank text', () => {
    expect(searchText('   ')).toBeNull()
  })

  it('keeps an id exact and trimmed, with no other form', () => {
    expect(searchText('  usr_1001 ')).toEqual({ exact: 'usr_1001', userIds: ['usr_1001'] })
    expect(searchText('1001')).toEqual({ exact: '1001', userIds: ['1001'] })
  })

  it('also matches an email in lower case', () => {
    expect(searchText(' Lan@Example.com')).toEqual({ exact: 'Lan@Example.com', userIds: ['Lan@Example.com', 'lan@example.com'] })
    expect(searchText('lan@example.com')?.userIds).toEqual(['lan@example.com'])
  })

  it.each([
    ['0912 345 678', ['0912 345 678', '+84912345678', '0912345678']],
    ['0912345678', ['0912345678', '+84912345678']],
    ['+84912345678', ['+84912345678', '0912345678']],
    ['+84 (912) 345-678', ['+84 (912) 345-678', '+84912345678', '0912345678']],
    ['84912345678', ['84912345678', '+84912345678', '0912345678']],
    ['912.345.678', ['912.345.678', '+84912345678', '0912345678']],
    ['+1 415 555 0100', ['+1 415 555 0100', '+14155550100']],
  ])('matches the phone %s as +84 and with the leading 0', (typed, userIds) => {
    expect(searchText(typed)?.userIds).toEqual(userIds)
  })

  it('reads text with too few or too many digits, or with letters, as an id', () => {
    expect(searchText('12345678')?.userIds).toEqual(['12345678'])
    expect(searchText('0912345678901')?.userIds).toEqual(['0912345678901'])
    expect(searchText('0912-345-ABC')?.userIds).toEqual(['0912-345-ABC'])
  })
})
