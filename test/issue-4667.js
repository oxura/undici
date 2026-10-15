'use strict'

const { test } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Client, interceptors } = require('..')

// https://github.com/nodejs/undici/issues/4667
const mimeTypes = {
  'application/vnd.contentful.management.v1+json': 'json',
  'text/javascript': 'json',
  'text/xml': 'text'
}
for (const scenario of [
  { type: 'application/vnd.contentful.management.v1+json; charset=utf-8', body: '{"message":"invalid"}', expected: { message: 'invalid' } },
  { type: 'Text/JavaScript; charset="utf-8"', body: '{"message":"invalid"}', expected: { message: 'invalid' } },
  { type: 'text/xml', body: '<error>invalid</error>', expected: '<error>invalid</error>' },
  { type: 'text/xml', body: 'café', expected: 'café' },
  { type: 'text/javascript', body: 'invalid JSON', expected: 'invalid JSON' },
  { type: 'application/json', body: '{"message":"default"}', expected: { message: 'default' } },
  { type: 'text/plain', body: 'default', expected: 'default' },
  { type: 'text/plain', body: '{"override":true}', expected: { override: true }, parsers: { 'Text/Plain': 'json' } },
  { type: 'application/json', body: '{"override":true}', expected: '{"override":true}', parsers: { 'application/json': 'text' } },
  { type: 'application/octet-stream', body: 'not text', expected: '' },
  { type: 'application/json-seq', body: '{"message":"not json"}', expected: '' }
]) {
  test(`responseError parses ${scenario.type}: ${scenario.body}`, { timeout: 10000 }, async (t) => {
    const bytes = Buffer.from(scenario.body)
    const server = createServer((req, res) => {
      res.writeHead(422, { 'content-type': scenario.type })
      res.write(bytes.subarray(0, bytes.length - 1))
      setImmediate(() => res.end(bytes.subarray(bytes.length - 1)))
    })
    t.after(() => { server.closeAllConnections(); server.close() })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const client = new Client(`http://127.0.0.1:${server.address().port}`)
      .compose(interceptors.responseError({ mimeTypes: { ...mimeTypes, ...scenario.parsers } }))
    t.after(() => client.destroy())
    await t.assert.rejects(client.request({ path: '/', method: 'GET' }), (error) => {
      t.assert.strictEqual(error.code, 'UND_ERR_RESPONSE')
      t.assert.strictEqual(error.statusCode, 422)
      t.assert.deepStrictEqual(error.body, scenario.expected)
      t.assert.strictEqual(error.bodyTruncated, false)
      return true
    })
  })
}

test('custom JSON obeys the byte limit and preserves connection reuse', { timeout: 10000 }, async (t) => {
  const peers = new Set()
  const server = createServer((req, res) => {
    peers.add(req.socket)
    if (req.url === '/ok') {
      res.end('ok')
    } else {
      res.writeHead(400, { 'content-type': 'text/javascript' })
      res.end('{"message":"invalid"}')
    }
  })
  t.after(() => { server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = new Client(`http://127.0.0.1:${server.address().port}`)
    .compose(interceptors.responseError({ mimeTypes, maxSize: 10 }))
  t.after(() => client.destroy())
  await t.assert.rejects(client.request({ path: '/', method: 'GET' }), (error) => {
    t.assert.strictEqual(error.body, '{"message"')
    t.assert.strictEqual(error.bodyTruncated, true)
    return true
  })
  const response = await client.request({ path: '/ok', method: 'GET' })
  t.assert.strictEqual(await response.body.text(), 'ok')
  t.assert.strictEqual(peers.size, 1)
})

for (const mimeTypes of [null, [], 'text/xml', { 'text/xml': 'xml' }, { invalid: 'text' }, { 'text/xml; charset=utf-8': 'text' }]) {
  test(`rejects invalid MIME parser configuration ${JSON.stringify(mimeTypes)}`, (t) => {
    t.assert.throws(() => interceptors.responseError({ mimeTypes }), { code: 'UND_ERR_INVALID_ARG' })
  })
}
