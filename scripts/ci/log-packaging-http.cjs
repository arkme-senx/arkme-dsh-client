// got errors can omit the request URL. Exclude query strings, signed paths and credentials.
const { channel } = require('node:diagnostics_channel')
channel('http.client.response.finish').subscribe(({ request, response }) => {
  if (response.statusCode < 500) return
  const host = request.host
  const path = request.path.split('?')[0]
  const asset = host === 'github.com' && /^\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.-]+\/[\w.-]+$/.test(path) ? path : ''
  console.error(`Packaging HTTP ${response.statusCode} from ${host}${asset}`)
})
