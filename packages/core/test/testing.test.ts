import { describe, expect, it } from 'vitest'
import { decryptString, encrypt, parseKeyRing } from '../src/crypto'
import { TEST_TOKEN_ENCRYPTION_KEYS, fixedClock, memoryLogger, testConfig, testKeyRing } from '../src/testing'

describe('testing helpers', () => {
  it('test key ring matches the test env value', () => {
    const sealed = encrypt(testKeyRing(), 'x')
    expect(decryptString(parseKeyRing(TEST_TOKEN_ENCRYPTION_KEYS), sealed)).toBe('x')
  })

  it('testConfig uses fakes and accepts overrides', () => {
    const c = testConfig({ LOG_LEVEL: 'debug' })
    expect(c).toMatchObject({ APP_ENV: 'test', DEV_AUTH: true, STORAGE_DRIVER: 'memory', LOG_LEVEL: 'debug' })
  })

  it('memoryLogger captures lines and fixedClock is re-exported', () => {
    const log = memoryLogger()
    log.info('hi', { a: 1 })
    expect(log.lines[0]).toMatchObject({ msg: 'hi', a: 1 })
    expect(fixedClock(0).now().getTime()).toBe(0)
  })
})
