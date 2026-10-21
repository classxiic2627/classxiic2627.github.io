const encoder = new TextEncoder();
const CHUNK_BYTES = 1024 * 1024;
const HASH_BYTES = 32;

function toB64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Fingerprint file bytes in fixed-size chunks without allocating a full-file
 * ArrayBuffer. This is intentionally a versioned SHA-256-of-chunk-digests
 * construction, not SHA-256(file) itself. The total size and chunk size are
 * domain-separated into the final digest; same bytes produce the same value,
 * while changed bytes or chunk boundaries change it.
 */
export async function fingerprintFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0 ||
      typeof file.slice !== "function") {
    throw new TypeError("A file-like object with a safe size and slice() is required.");
  }

  const chunkDigests = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    const chunkBuffer = await file.slice(offset, end).arrayBuffer();
    if (chunkBuffer.byteLength !== end - offset) {
      throw new Error("File chunk length did not match the expected range.");
    }
    chunkDigests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", chunkBuffer)));
  }

  const header = encoder.encode("archive-upload-fingerprint-v1:" + file.size + ":" + CHUNK_BYTES + ":");
  const combined = new Uint8Array(header.length + chunkDigests.length * HASH_BYTES);
  combined.set(header, 0);
  let cursor = header.length;
  for (const chunkDigest of chunkDigests) {
    combined.set(chunkDigest, cursor);
    cursor += HASH_BYTES;
  }
  return toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", combined)));
}
