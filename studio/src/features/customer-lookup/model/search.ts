/**
 * CUS-FR-01, CUS-FR-11: what one typed text searches for. Device ids and person ids match the
 * trimmed text exactly. User ids also match the text's contact forms, because a deployment may fill
 * the user id with an email or a phone: an email in lower case, and a Vietnamese phone both as
 * +84 and with the leading 0.
 */
export type SearchText = {
  readonly exact: string
  /** The exact text first, then each other form, without repeats. */
  readonly userIds: readonly [string, ...string[]]
}

const PHONE = /^\+?[\d\s.()-]+$/
const MIN_PHONE_DIGITS = 9
const MAX_PHONE_DIGITS = 12

function phoneForms(text: string): string[] {
  if (!PHONE.test(text)) return []
  const digits = text.replace(/\D/g, '')
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return []
  if (text.startsWith('+')) {
    // A number outside Vietnam has no leading-0 form here.
    return digits.startsWith('84') ? [`+${digits}`, `0${digits.slice(2)}`] : [`+${digits}`]
  }
  const national = digits.startsWith('0') ? digits.slice(1) : digits.startsWith('84') && digits.length >= 11 ? digits.slice(2) : digits
  return [`+84${national}`, `0${national}`]
}

function contactForms(text: string): string[] {
  return text.includes('@') ? [text.toLowerCase()] : phoneForms(text)
}

/** Null for a text that is empty once trimmed: it searches nothing. */
export function searchText(typed: string): SearchText | null {
  const exact = typed.trim()
  if (exact === '') return null
  const others = contactForms(exact).filter((form) => form !== exact)
  return { exact, userIds: [exact, ...new Set(others)] }
}
