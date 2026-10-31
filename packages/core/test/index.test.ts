import { describe, expect, it } from 'vitest'
import * as core from '../src/index'

describe('@app/core public surface', () => {
  it('exports the main building blocks', () => {
    for (const name of [
      'PLATFORMS',
      'PLANS',
      'entitlements',
      'validateVariant',
      'DraftInputSchema',
      'ScheduleInputSchema',
      'checkSourceUrl',
      'hasLink',
      'encrypt',
      'createLogger',
      'contentHash',
      'AppError',
      'loadConfig',
      'usagePeriod',
      'systemClock',
    ]) {
      expect(core, name).toHaveProperty(name)
    }
  })
})
