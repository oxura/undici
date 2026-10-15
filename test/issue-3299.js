'use strict'

const { test } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { gzipSync } = require('node:zlib')
const { Agent, Client, Pool, fetch, interceptors } = require('..')

// https://github.com/nodejs/undici/issues/3299
for (const Dispatcher of [Client, Pool]) {
  test(`${Dispatcher.name} errors include the serialized query-aware URL`, { timeout: 10000 }, async (t) => {
    let target
    const server = createServer((req) => {
      target = req.url
      req.socket.destroy()
    })
    t.after(() => { server.closeAllConnections(); server.close() })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    const dispatcher = new Dispatcher(origin)
    t.after(() => dispatcher.destroy())
    await t.assert.rejects(dispatcher.request({ path: '/items', method: 'GET', query: { search: 'two words', tag: ['a', 'b'] } }), (error) => {
      t.assert.strictEqual(error.code, 'UND_ERR_SOCKET')
      t.assert.deepStrictEqual(error.requestUrls, [origin + target])
      return true
    })
  })
}

test('fetch exposes the actual failed URL on its original cause', { timeout: 10000 }, async (t) => {
  const server = createServer((req) => req.socket.destroy())
  t.after(() => { server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/broken?value=a%2Fb`
  const agent = new Agent()
  t.after(() => agent.destroy())
  await t.assert.rejects(fetch(url, { dispatcher: agent }), (error) => {
    t.assert.ok(error instanceof TypeError)
    t.assert.strictEqual(error.cause.code, 'UND_ERR_SOCKET')
    t.assert.deepStrictEqual(error.cause.requestUrls, [url])
    return true
  })
})

test('an HTTP error after a redirect identifies the final request', { timeout: 10000 }, async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/final?token=encoded%20value' })
      res.end()
    } else {
      res.writeHead(422, { 'content-type': 'application/json' })
      res.end('{"error":"invalid"}')
    }
  })
  t.after(() => { server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const agent = new Agent().compose(interceptors.responseError(), interceptors.redirect({ maxRedirections: 2 }))
  t.after(() => agent.destroy())
  await t.assert.rejects(agent.request({ origin, path: '/start', method: 'GET' }), (error) => {
    t.assert.strictEqual(error.code, 'UND_ERR_RESPONSE')
    t.assert.strictEqual(error.statusCode, 422)
    t.assert.deepStrictEqual(error.body, { error: 'invalid' })
    t.assert.deepStrictEqual(error.requestUrls, [origin + '/final?token=encoded%20value'])
    return true
  })
})

for (const valid of [false, true]) {
  test(`decompression ${valid ? 'preserves HTTP error' : 'failure records request'} URL context`, { timeout: 10000 }, async (t) => {
    const server = createServer((req, res) => {
      res.writeHead(422, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(valid ? gzipSync('{"error":"invalid"}') : 'not gzip')
    })
    t.after(() => { server.closeAllConnections(); server.close() })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    const agent = new Agent().compose(interceptors.decompress({ skipErrorResponses: false }), interceptors.responseError())
    t.after(() => agent.destroy())
    await t.assert.rejects(agent.request({ origin, path: '/compressed?q=kept', method: 'GET' }), (error) => {
      t.assert.strictEqual(error.code, valid ? 'UND_ERR_RESPONSE' : 'Z_DATA_ERROR')
      t.assert.deepStrictEqual(error.requestUrls, [origin + '/compressed?q=kept'])
      if (valid) t.assert.deepStrictEqual(error.body, { error: 'invalid' })
      return true
    })
  })
}

for (const frozen of [false, true]) {
  test(`shared cancellation keeps its identity and ${frozen ? 'immutable reason' : 'all request URLs'}`, { timeout: 10000 }, async (t) => {
    let notify
    const arrived = new Promise(resolve => { notify = resolve })
    let count = 0
    const server = createServer(() => { if (++count === 2) notify() })
    t.after(() => { server.closeAllConnections(); server.close() })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    const client = new Client(origin, { pipelining: 2 })
    t.after(() => client.destroy())
    const cause = new Error('original cause')
    const reason = new Error('cancelled together', { cause })
    if (frozen) Object.freeze(reason)
    const promises = ['/first?x=1', '/second?x=2'].map(path => client.request({ path, method: 'GET', blocking: false }).catch(error => error))
    await arrived
    await client.destroy(reason)
    const errors = await Promise.all(promises)
    t.assert.strictEqual(errors[0], reason)
    t.assert.strictEqual(errors[1], reason)
    t.assert.strictEqual(reason.cause, cause)
    if (frozen) {
      t.assert.strictEqual(reason.requestUrls, undefined)
    } else {
      t.assert.deepStrictEqual([...reason.requestUrls].sort(), [origin + '/first?x=1', origin + '/second?x=2'])
    }
  })
}

test('error URLs preserve the actual request target and redact authority credentials', { timeout: 10000 }, async (t) => {
  const targets = []
  const server = createServer((req) => { targets.push(req.url); req.socket.destroy() })
  t.after(() => { server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const client = new Client(origin)
  t.after(() => client.destroy())
  for (const path of ['/a/../b?value=a%2Fb', `http://user:secret@127.0.0.1:${server.address().port}/a/../b?q=kept`]) {
    await t.assert.rejects(client.request({ path, method: 'GET' }), (error) => {
      const actualTarget = targets[targets.length - 1]
      const expected = actualTarget.startsWith('/') ? origin + actualTarget : actualTarget.replace('user:secret@', '')
      t.assert.deepStrictEqual(error.requestUrls, [expected])
      t.assert.ok(!error.requestUrls[0].includes('secret'))
      return true
    })
  }
})
