export function generateScaffoldSecret(byteLength = 32) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Secure random generation unavailable for scaffold secret.');
  }
  const bytes = new Uint8Array(byteLength);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
