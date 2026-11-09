import { CHANNELS, type Channel, type LimitUnit } from 'shared/types/campaigns'
import type { JourneyNode, Limit, NodeSetting, SetupTrigger } from './nodes'

/** Display names from the catalog. A name it does not know falls back to the saved name. */
export type NameLookup = {
  eventDisplayName(name: string): string | undefined
  segmentName(id: string): string | undefined
}

const CHANNEL_NAMES: Record<Channel, string> = {
  push: 'Push',
  'web-push': 'Web push',
  sms: 'SMS',
  email: 'Email',
  facebook: 'Facebook',
  zalo: 'Zalo',
  whatsapp: 'WhatsApp',
  webhook: 'Webhook',
}

const UNIT_NAMES: Record<LimitUnit, string> = { SECONDS: 'second', MINUTES: 'minute', HOURS: 'hour', DAYS: 'day' }

function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value)
}

/** A channel's display name. An unknown channel shows as saved, and none reads "Engagement". */
export function channelName(channel: string | null): string {
  if (channel === null) return 'Engagement'
  return isChannel(channel) ? CHANNEL_NAMES[channel] : channel
}

function limitLabel({ value, unit }: Limit): string {
  return `${value} ${UNIT_NAMES[unit]}${value === 1 ? '' : 's'}`
}

function setupLabel(trigger: SetupTrigger | null, names: NameLookup): string {
  if (trigger === null) return 'Start'
  switch (trigger.kind) {
    case 'event':
    case 'business_event':
      return `Start: ${names.eventDisplayName(trigger.event) ?? trigger.event}`
    case 'segment_entry':
      return `Start: enters ${names.segmentName(trigger.segmentId) ?? trigger.segmentId}`
  }
}

/** JBD-FR-22: a node's type and main setting, never its id. */
export function nodeLabel(setting: NodeSetting, names: NameLookup): string {
  const event = (name: string | null) => (name === null ? 'an event' : (names.eventDisplayName(name) ?? name))
  switch (setting.type) {
    case 'setup':
      return setupLabel(setting.trigger, names)
    case 'check':
      return `Check: ${event(setting.event)}`
    case 'watch': {
      const limit = setting.limit === null ? null : limitLabel(setting.limit)
      if (setting.delay) return limit === null ? 'Wait' : `Wait ${limit}`
      const waitFor = `Wait for ${event(setting.event)}`
      return limit === null ? waitFor : `${waitFor}, ${limit}`
    }
    case 'segment':
      return 'Condition split'
    case 'engagement': {
      const channel = channelName(setting.channel)
      return setting.headline === null ? channel : `${channel} "${setting.headline}"`
    }
    case 'end':
      return 'End'
    default: {
      const exhaustive: never = setting
      return exhaustive
    }
  }
}

const FIXED_BRANCHES: Readonly<Record<string, string>> = { next: 'Next', yes: 'Yes', no: 'No', success: 'Success', timeout: 'Timeout' }

/** A branch in a split. The fixed names of the branch table read as words, a multi-branch key as saved. */
export function branchLabel(branch: string): string {
  return Object.hasOwn(FIXED_BRANCHES, branch) ? FIXED_BRANCHES[branch] : branch
}

export function removedStepLabel(nodeType: string): string {
  return `Removed step (${nodeType})`
}

function savedEvent(setting: NodeSetting): string | null {
  switch (setting.type) {
    case 'setup':
      return setting.trigger !== null && setting.trigger.kind !== 'segment_entry' ? setting.trigger.event : null
    case 'check':
    case 'watch':
      return setting.event
    default:
      return null
  }
}

/** The event names and segment ids whose display names the nodes' labels need. */
export function referencedNames(nodes: readonly JourneyNode[]): { events: string[]; segments: string[] } {
  const events = new Set<string>()
  const segments = new Set<string>()
  for (const { setting } of nodes) {
    const event = savedEvent(setting)
    if (event !== null) events.add(event)
    if (setting.type === 'setup' && setting.trigger?.kind === 'segment_entry') segments.add(setting.trigger.segmentId)
  }
  return { events: [...events].sort(), segments: [...segments].sort() }
}
