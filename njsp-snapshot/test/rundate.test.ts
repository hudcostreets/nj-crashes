import { describe, expect, it } from 'vitest'

import { isRollback, rundateEpoch } from '../src/rundate'

describe('rundateEpoch / isRollback (refresh_data.rundate_dt / is_rollback)', () => {
  it('parses EDT and EST', () => {
    expect(rundateEpoch('Wed Oct 28 10:00:01 EDT 2026')).toBe(Date.parse('2026-10-28T14:00:01Z'))
    expect(rundateEpoch('Sun Nov 01 10:00:04 EST 2026')).toBe(Date.parse('2026-11-01T15:00:04Z'))
    expect(rundateEpoch('Sun Nov 01 10:00:04 2026')).toBeUndefined()
    expect(rundateEpoch('garbage')).toBeUndefined()
  })

  it('compares instants', () => {
    expect(isRollback('Wed Oct 28 10:00:01 EDT 2026', 'Sat Oct 31 10:00:03 EDT 2026')).toBe(true)
    expect(isRollback('Sun Nov 01 10:00:04 EST 2026', 'Sat Oct 31 10:00:03 EDT 2026')).toBe(false)
    expect(isRollback('Sat Oct 31 10:00:03 EDT 2026', 'Sat Oct 31 09:30:00 EST 2026')).toBe(true)
    expect(isRollback('Sat Oct 31 10:00:03 EDT 2026', 'Sat Oct 31 10:00:03 EDT 2026')).toBe(false)
    expect(isRollback(undefined, 'Sat Oct 31 10:00:03 EDT 2026')).toBe(false)
    expect(isRollback('Wed Oct 28 10:00:01 EDT 2026', undefined)).toBe(false)
  })
})
