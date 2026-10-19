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
      const fileBytes = body instanceof ReadableStream
        ? new Uint8Array(await new Response(body).arrayBuffer())
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : ArrayBuffer.isView(body)
            ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
            : new Uint8Array(await new Response(body).arrayBuffer());
      const boundary = "drive_upload_" + crypto.randomUUID().replace(/-/g, "");
      const metadata = encoder.encode(
        "--" + boundary + "\r\n" +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify({ name: String(name).split("/").pop(), mimeType, parents: [folderId] }) +
        "\r\n--" + boundary + "\r\n" +
        "Content-Type: " + mimeType + "\r\n\r\n"
      );
      const closing = encoder.encode("\r\n--" + boundary + "--");
      const payload = concatBytes([metadata, fileBytes, closing]);
      const response = await driveRequest(
        env,
        DRIVE_UPLOAD + "?uploadType=multipart&fields=id,name,mimeType,size",
        { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: payload },
        fetchImpl
      );
      const result = await response.json().catch(() => null);
      if (!result || !validDriveId(result.id) || (result.mimeType && result.mimeType !== mimeType)) {
        providerError("Google Drive returned an invalid upload response.");
      }
      return {
        key: result.id,
        id: result.id,
        size: Number(result.size) || fileBytes.byteLength,
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
