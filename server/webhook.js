/**
 * Home Assistant Webhook Server
 * 使い方: npm run server
 *
 * HA設定例 (configuration.yaml):
 *   rest_command:
 *     earthquake_alert:
 *       url: http://<このPCのIP>:3001/webhook
 *       method: POST
 *       content_type: application/json
 *       payload: '{"type":"earthquake_alert","message":"地震発生"}'
 */
import http from 'node:http'

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',')

/** @type {Set<http.ServerResponse>} */
const sseClients = new Set()

function setCorsHeaders(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  res.setHeader('Access-Control-Allow-Origin', allowed)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function broadcastSSE(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) client.write(payload)
  console.log(`[SSE] Broadcast "${eventName}" to ${sseClients.size} client(s)`)
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const origin = req.headers.origin ?? ''

  if (req.method === 'OPTIONS') {
    setCorsHeaders(res, origin)
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/sse') {
    setCorsHeaders(res, origin)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    sseClients.add(res)
    console.log(`[SSE] Client connected (total: ${sseClients.size})`)
    const ping = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(ping)
      sseClients.delete(res)
      console.log(`[SSE] Client disconnected (total: ${sseClients.size})`)
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/webhook') {
    setCorsHeaders(res, origin)
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let data = { type: 'earthquake_alert', message: null }
      try {
        const parsed = JSON.parse(body)
        if (typeof parsed === 'object' && parsed !== null) data = { ...data, ...parsed }
      } catch { /* use defaults */ }

      console.log('[Webhook] Received:', data)
      if (data.type === 'earthquake_alert') broadcastSSE('earthquake-alert', { message: data.message })
      else if (data.type === 'dismiss') broadcastSSE('dismiss', {})

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, clients: sseClients.size }))
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, clients: sseClients.size, uptime: process.uptime() }))
    return
  }

  res.writeHead(404)
  res.end('Not found')
}).listen(PORT, () => {
  console.log(`\n地震ビューアー Webhook サーバー起動`)
  console.log(`  Webhook: http://localhost:${PORT}/webhook`)
  console.log(`  SSE:     http://localhost:${PORT}/sse`)
  console.log(`  Status:  http://localhost:${PORT}/status`)
  console.log(`  URL起動: http://localhost:5173/?ha_alert=1\n`)
})
