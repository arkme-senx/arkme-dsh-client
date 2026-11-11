const transient = new Set(['ConnectionTimeoutError', 'ResponseTimeoutError', 'RequestTimeoutError', 'TimeoutError', 'RequestTimeout', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'SecurityTokenExpired']);

// A lost PUT response may mean the immutable object already exists. The caller
// must still verify its complete CDN bytes before proceeding to publication.
export async function putImmutableObject({credentials, createClient, bytes, filename = "artifact", log = event => console.log(JSON.stringify(event)), now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const started = now();
  const multipart = bytes.length >= 8 * 1024 * 1024;
  let checkpoint;
  let objectKey;
  const emit = (event, fields = {}) => log({event, file: filename, size_bytes: bytes.length, elapsed_ms: now() - started, ...fields});
  emit('oss_upload_start', {mode: multipart ? 'multipart' : 'put'});
  for (let attempt = 0; attempt < 3; attempt++) {
    const grant = await credentials();
    if (attempt && grant.object_key !== objectKey) throw new Error('Upload credential object changed');
    objectKey = grant.object_key;
    const client = createClient(grant, {timeout: 300000});
    try {
      const options = {headers: {'x-oss-forbid-overwrite': 'true', 'Cache-Control': 'public, max-age=31536000, immutable'}};
      if (multipart) {
        await client.multipartUpload(grant.object_key, bytes, {...options, partSize: 8 * 1024 * 1024, parallel: 2, checkpoint,
          progress: async (fraction, saved) => {
            if (saved) checkpoint = saved;
            emit('oss_upload_progress', {attempt: attempt + 1, progress_percent: Math.floor(fraction * 100)});
          }});
      } else {
        await client.put(grant.object_key, bytes, options);
      }
      emit('oss_upload_complete', {attempt: attempt + 1});
      return grant;
    } catch (error) {
      if (error.code === 'FileAlreadyExists') { emit('oss_upload_existing', {attempt: attempt + 1}); return grant; }
      // Complete may have succeeded before its response was lost. A fresh
      // initiation will either report FileAlreadyExists or start safely again.
      const missingUpload = multipart && checkpoint && error.code === 'NoSuchUpload';
      if (missingUpload) checkpoint = undefined;
      const retryable = missingUpload || transient.has(error.code) || transient.has(error.name) || [408, 429, 500, 502, 503, 504].includes(error.status);
      const safeCode = [error.code, error.name].find(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) ?? 'Unknown';
      emit(retryable && attempt < 2 ? 'oss_upload_retry' : 'oss_upload_failed', {attempt: attempt + 1, code: safeCode, status: Number.isInteger(error.status) ? error.status : 0});
      if (!retryable || attempt === 2) {
        // Never print SDK messages, requests, endpoints or STS credentials.
        const code = safeCode;
        throw new Error(`OSS upload failed (${code}; status=${Number.isInteger(error.status) ? error.status : 0}; attempts=${attempt + 1})`);
      }
      await wait(1000 * 2 ** attempt);
    }
  }
}
