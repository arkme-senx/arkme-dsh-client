const transient = new Set(['ConnectionTimeoutError', 'ResponseTimeoutError', 'RequestTimeoutError', 'TimeoutError', 'RequestTimeout', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);

// A lost PUT response may mean the immutable object already exists. The caller
// must still verify its complete CDN bytes before proceeding to publication.
export async function putImmutableObject({credentials, createClient, bytes, wait = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const grant = await credentials();
    const client = createClient(grant, {timeout: 300000});
    try {
      await client.put(grant.object_key, bytes, {headers: {'x-oss-forbid-overwrite': 'true', 'Cache-Control': 'public, max-age=31536000, immutable'}});
      return grant;
    } catch (error) {
      if (error.code === 'FileAlreadyExists' || error.status === 409) return grant;
      const retryable = transient.has(error.code) || transient.has(error.name) || [408, 429, 500, 502, 503, 504].includes(error.status);
      if (!retryable || attempt === 2) {
        // Never print SDK messages, requests, endpoints or STS credentials.
        const code = [error.code, error.name].find(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) ?? 'Unknown';
        throw new Error(`OSS upload failed (${code}; status=${Number.isInteger(error.status) ? error.status : 0}; attempts=${attempt + 1})`);
      }
      await wait(1000 * 2 ** attempt);
    }
  }
}
