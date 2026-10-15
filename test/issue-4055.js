'use strict'

const { test } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Client } = require('..')

// https://github.com/nodejs/undici/issues/4055
for (const useMilo of [false, true]) {
  for (const phase of ['headers', 'body']) {
    test(`${phase} timeout below one second (${useMilo ? 'milo' : 'llhttp'})`, { timeout: 10000 }, async (t) => {
      const pending = new Set()
      const server = createServer((req, res) => {
        if (phase === 'body') {
          res.writeHead(200, { 'content-length': '2' })
          res.write('a')
        }
        const timer = setTimeout(() => {
          pending.delete(timer)
          res.end(phase === 'body' ? 'b' : 'ok')
        }, 200)
        pending.add(timer)
      })
      t.after(() => {
        for (const timer of pending) clearTimeout(timer)
        server.closeAllConnections()
        server.close()
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const client = new Client(`http://127.0.0.1:${server.address().port}`, { useMilo })
      t.after(() => client.destroy())
      await t.assert.rejects(async () => {
        const response = await client.request({
          path: '/',
          method: 'GET',
          headersTimeout: phase === 'headers' ? 50 : 0,
          bodyTimeout: phase === 'body' ? 50 : 0
        })
        await response.body.text()
      }, { code: phase === 'headers' ? 'UND_ERR_HEADERS_TIMEOUT' : 'UND_ERR_BODY_TIMEOUT' })
    })
  }

  test(`short body timeouts refresh on progress (${useMilo ? 'milo' : 'llhttp'})`, { timeout: 10000 }, async (t) => {
    const pending = new Set()
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-length': '10' })
      res.write('a')
      let remaining = 9
      const timer = setInterval(() => {
        res.write('b')
        if (--remaining === 0) {
          clearInterval(timer)
          pending.delete(timer)
          res.end()
        }
      }, 20)
      pending.add(timer)
    })
    t.after(() => {
      for (const timer of pending) clearInterval(timer)
      server.closeAllConnections()
      server.close()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const client = new Client(`http://127.0.0.1:${server.address().port}`, { useMilo, headersTimeout: 100, bodyTimeout: 100 })
    t.after(() => client.destroy())
    const response = await client.request({ path: '/', method: 'GET' })
    t.assert.strictEqual(await response.body.text(), 'a' + 'b'.repeat(9))
  })
}
