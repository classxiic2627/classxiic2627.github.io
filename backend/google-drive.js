/**
 * Google Drive media adapter for Cloudflare Workers.
 *
 * Configuration:
 *   GOOGLE_CLIENT_ID (var)
 *   GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN (Worker secrets)
 *   GOOGLE_DRIVE_FOLDER_ID (var; dedicated private folder in the authorized account)
 *
 * Files remain private in Drive. The Worker proxies media reads; never enable
 * public sharing or send OAuth credentials/access tokens to the browser.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const encoder = new TextEncoder();
const tokenCache = new Map();

function providerError(message, status = 503) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function validDriveId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}
async function fingerprint(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function accessToken(env, fetchImpl = fetch) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || typeof clientSecret !== "string" || !clientSecret.trim() ||
      typeof refreshToken !== "string" || !refreshToken.trim()) {
    providerError("Google Drive OAuth credentials are not configured.");
  }
  const key = await fingerprint(clientId + ":" + clientSecret + ":" + refreshToken);
  const now = Math.floor(Date.now() / 1000);
  let entry = tokenCache.get(key);
  if (entry?.token && entry.expiresAt > now + 60) return entry.token;
  if (entry?.promise) return entry.promise;
  entry = entry || { token: "", expiresAt: 0, promise: null };
  entry.promise = (async () => {
    let response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token"
        })
      });
    } catch {
      providerError("Google OAuth token request failed.");
    }
    if (!response.ok) providerError("Google OAuth rejected the refresh credentials (" + response.status + ").");
    const data = await response.json().catch(() => null);
    if (!data || typeof data.access_token !== "string" || !data.access_token ||
        !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) {
      providerError("Google OAuth returned an invalid token response.");
    }
    entry.token = data.access_token;
    entry.expiresAt = now + Number(data.expires_in);
    return entry.token;
  })();
  tokenCache.set(key, entry);
  try {
    return await entry.promise;
  } finally {
    entry.promise = null;
    tokenCache.set(key, entry);
    while (tokenCache.size > 8) {
      const oldestKey = tokenCache.keys().next().value;
      if (oldestKey === key) break;
      tokenCache.delete(oldestKey);
    }
  }
}

async function driveRequest(env, url, options = {}, fetchImpl = fetch, allowStatuses = []) {
  const token = await accessToken(env, fetchImpl);
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: "Bearer " + token }
    });
  } catch {
    providerError("Google Drive request failed.");
  }
  if (!response.ok && !allowStatuses.includes(response.status)) {
    // Never include provider response bodies, OAuth tokens, or credentials in errors.
    providerError("Google Drive request failed (" + response.status + ").");
  }
  return response;
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function createGoogleDriveMedia(env, fetchImpl = fetch) {
  const folderId = String(env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
  if (!validDriveId(folderId)) providerError("GOOGLE_DRIVE_FOLDER_ID is missing or invalid.");

  return {
    async put(name, body, options = {}) {
      const mimeType = options.httpMetadata?.contentType;
      if (typeof mimeType !== "string" || !mimeType) providerError("A media content type is required.", 400);
      let uploadBody = body;
      let uploadSize = Number(options.size);
      // Keep a known-size stream streaming through the Worker fetch API. This
      // avoids another full-file copy for videos near the 50 MiB request limit.
      if (!(body instanceof ReadableStream) || !Number.isSafeInteger(uploadSize) || uploadSize < 1) {
        const fileBytes = body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : ArrayBuffer.isView(body)
            ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
            : new Uint8Array(await new Response(body).arrayBuffer());
        uploadBody = fileBytes;
        uploadSize = fileBytes.byteLength;
      }
      if (!uploadSize) providerError("Media upload cannot be empty.", 400);

      // Drive documents multipart uploads for files up to 5 MB; larger uploads
      // must use the resumable protocol. Use it for every size so the 50 MiB
      // class-video limit follows one consistent, supported path.
      const metadata = {
        name: String(name).split("/").pop(),
        mimeType,
        parents: [folderId]
      };
      const startResponse = await driveRequest(
        env,
        DRIVE_UPLOAD + "?uploadType=resumable&fields=id,name,mimeType,size",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": mimeType,
            "X-Upload-Content-Length": String(uploadSize)
          },
          body: JSON.stringify(metadata)
        },
        fetchImpl
      );
      const location = startResponse.headers.get("Location");
      let sessionUrl;
      try { sessionUrl = new URL(location); }
      catch { providerError("Google Drive did not return a valid upload session."); }
      // Never forward the OAuth bearer token to an untrusted Location URL.
      if (sessionUrl.protocol !== "https:" ||
          sessionUrl.origin !== new URL(DRIVE_UPLOAD).origin ||
          sessionUrl.pathname !== "/upload/drive/v3/files") {
        providerError("Google Drive returned an invalid upload session URL.");
      }

      // Cloudflare ignores a manually supplied Content-Length for a generic
      // ReadableStream and sends chunked encoding. Drive's single-request
      // resumable upload expects a known length, so wrap streams in the runtime's
      // FixedLengthStream when available. Node-based mocked tests keep the stream
      // fallback; deployed Workers get the fixed-length transport.
      let requestBody = uploadBody;
      let streamCompletion = null;
      let streamFailure = null;
      if (requestBody instanceof ReadableStream && typeof FixedLengthStream === "function") {
        const fixedLength = new FixedLengthStream(uploadSize);
        streamCompletion = requestBody.pipeTo(fixedLength.writable).catch(error => {
          streamFailure = error;
        });
        requestBody = fixedLength.readable;
      }

      let uploadResponse;
      try {
        uploadResponse = await driveRequest(
          env,
          sessionUrl.href,
          {
            method: "PUT",
            headers: {
              "Content-Type": mimeType,
              "Content-Length": String(uploadSize),
              "Content-Range": "bytes 0-" + (uploadSize - 1) + "/" + uploadSize
            },
            body: requestBody
          },
          fetchImpl,
          [308]
        );
      } finally {
        if (streamCompletion) await streamCompletion;
      }
      if (streamFailure) providerError("Google Drive upload stream failed.");
      if (uploadResponse.status === 308) {
        // A partial/incomplete session has no final file ID to commit to D1.
        // Fail closed rather than claiming the upload succeeded; the user can retry.
        providerError("Google Drive upload did not complete. Please retry.", 503);
      }
      const result = await uploadResponse.json().catch(() => null);
      if (!result || !validDriveId(result.id) || (result.mimeType && result.mimeType !== mimeType)) {
        providerError("Google Drive returned an invalid upload response.");
      }
      return {
        key: result.id,
        id: result.id,
        size: Number(result.size) || uploadSize,
        httpMetadata: { contentType: result.mimeType || mimeType }
      };
    },
    async get(fileId) {
      if (!validDriveId(fileId)) return null;
      const response = await driveRequest(
        env, DRIVE_API + "/" + encodeURIComponent(fileId) + "?alt=media", {}, fetchImpl, [404]
      );
      if (response.status === 404) return null;
      return {
        body: response.body,
        httpMetadata: { "content-type": response.headers.get("Content-Type") || "application/octet-stream" },
        size: Number(response.headers.get("Content-Length")) || undefined
      };
    },

    async delete(fileId) {
      if (!validDriveId(fileId)) providerError("Google Drive file reference is invalid.");
      const response = await driveRequest(
        env, DRIVE_API + "/" + encodeURIComponent(fileId), { method: "DELETE" }, fetchImpl, [404]
      );
      // A prior successful deletion is already the desired state.
      if (!response.ok && response.status !== 404) providerError("Google Drive deletion failed.");
    },

    async health() {
      const response = await driveRequest(
        env, DRIVE_API + "/" + encodeURIComponent(folderId) + "?fields=id,name,mimeType", {}, fetchImpl
      );
      const folder = await response.json().catch(() => null);
      if (!folder || folder.id !== folderId || folder.mimeType !== FOLDER_MIME) {
        providerError("Configured Google Drive target is not an accessible folder.");
      }
      return true;
    }
  };
}
