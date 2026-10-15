'use strict'

const { test } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Agent } = require('..')

// https://github.com/nodejs/undici/issues/2331
for (const entry of ['../index', '../index-fetch']) {
  const { fetch } = require(entry)
  test(`${entry} retains the fetch caller when a server disconnects`, { timeout: 10000 }, async (t) => {
    const server = createServer((req) => req.socket.destroy())
    t.after(() => { server.closeAllConnections(); server.close() })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const agent = new Agent()
    t.after(() => agent.destroy())
    async function fetchCaller () {
      await fetch(`http://127.0.0.1:${server.address().port}/`, { dispatcher: agent })
    }
    await t.assert.rejects(fetchCaller(), (error) => {
      t.assert.ok(error instanceof TypeError)
      t.assert.strictEqual(error.cause.code, 'UND_ERR_SOCKET')
      t.assert.match(error.stack, /fetchCaller/)
      t.assert.match(error.stack, /lib[/\\]web[/\\]fetch[/\\]index\.js/)
      return true
    })
  })

  test(`${entry} retains the JSON consumer and original parse failure`, { timeout: 10000 }, async (t) => {
    const server = createServer((req, res) => {
      res.writeHead(503, { 'content-type': 'text/html' })
      res.end('<Service Unavailable>')
    })
    t.after(() => { server.closeAllConnections(); server.close() })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const agent = new Agent()
    t.after(() => agent.destroy())
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { dispatcher: agent })
    async function jsonCaller () {
      return await response.json()
    }
    await t.assert.rejects(jsonCaller(), (error) => {
      t.assert.ok(error instanceof SyntaxError)
      t.assert.match(error.stack, /jsonCaller/)
      t.assert.match(error.stack, /JSON\.parse/)
      return true
    })
  })
}

for (const method of ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']) {
  test(`${method} retains the consumer when the response body is interrupted`, { timeout: 10000 }, async (t) => {
    let peer
    const server = createServer((req, res) => {
      peer = req.socket
      res.writeHead(200, { 'content-length': '100', 'content-type': 'application/json' })
      res.flushHeaders()
    })
    t.after(() => { server.closeAllConnections(); server.close() })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const agent = new Agent()
    t.after(() => agent.destroy())
    const response = await require('..').fetch(`http://127.0.0.1:${server.address().port}/`, { dispatcher: agent })
    async function bodyCaller () {
      return await response[method]()
    }
    const pending = bodyCaller()
    const rejected = t.assert.rejects(pending, (error) => {
      t.assert.ok(error instanceof TypeError)
      t.assert.strictEqual(error.cause.code, 'UND_ERR_SOCKET')
      t.assert.match(error.stack, /bodyCaller/)
      return true
    })
    peer.destroy()
    await rejected
  })
}
