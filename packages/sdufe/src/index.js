/**
 * linke-sdufe：山财强智教务适配器共享包。
 * linke-cli（Node）与 Linke App（uni-app，经 uni.request 垫片）同源引用。
 */
export { createSdufeAdapter, COURSE_TYPE_MAP } from './adapter.js'
export { nodeEnv, validateEnv } from './env.js'
export { computeEncoded } from './encoding.js'
export * as parsers from './parsers.js'
export { stripSpaces, isJwLoginExpired, extractCookieHeader } from './util.js'
export { LinkeError, EXIT, networkError, credentialInvalid, loginRetryExhausted, parseError } from './errors.js'
export { getAdapter, registerAdapter, listAdapters, initSdufe } from './registry.js'
