/**
 * Google Drive media adapter for Cloudflare Workers.
 *
 * Required Worker secrets/vars:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL (var)
 *   GOOGLE_PRIVATE_KEY (secret; PEM PKCS#8 private key from service-account JSON)
 *   GOOGLE_DRIVE_FOLDER_ID (var; private folder shared with the service account)
 *
 * Files remain private in Drive. The Worker proxies media reads; do not enable
 * public sharing or send service-account credentials/tokens to the browser.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let tokenPromise = null;

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodePemPrivateKey(pem) {
  const normalized = String(pem || "").replace(/\\n/g, "\n").trim();
  const match = normalized.match(/^-----BEGIN PRIVATE KEY-----([\s\S]+)-----END PRIVATE KEY-----$/);
  if (!match) throw new Error("GOOGLE_PRIVATE_KEY must be a PKCS#8 PRIVATE KEY PEM.");
  const binary = atob(match[1].replace(/\s/g, ""));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function signServiceAssertion(email, privateKey, nowSeconds) {
  const header = base64url(encoder.encode(JSON.stringify({alg:"RS256",typ:"JWT"})));
  const claims = base64url(encoder.encode(JSON.stringify({
    iss: email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  })));
  const unsigned = header + "." + claims;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    decodePemPrivateKey(privateKey),
    {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  return unsigned + "." + base64url(new Uint8Array(signature));
}

async function accessToken(env, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExpiresAt > now + 60) return cachedToken;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const email = String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
    const privateKey = env.GOOGLE_PRIVATE_KEY;
    if (!email || !privateKey) throw new Error("Google Drive service-account credentials are not configured.");
    const assertion = await signServiceAssertion(email, privateKey, now);
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {"Content-Type":"application/x-www-form-urlencoded"},
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      })
    });
    if (!response.ok) throw new Error("Google OAuth token exchange failed (" + response.status + ").");
    const result = await response.json();
    if (typeof result.access_token !== "string" || !Number.isFinite(result.expires_in)) {
      throw new Error("Google OAuth returned an invalid token response.");
    }
    cachedToken = result.access_token;
    cachedTokenExpiresAt = now + result.expires_in;
    return cachedToken;
  })();
  try { return await tokenPromise; }
  finally { tokenPromise = null; }
}

async function driveRequest(env, url, options = {}, fetchImpl = fetch) {
  const token = await accessToken(env, fetchImpl);
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: "Bearer " + token
    }
  });
  if (!response.ok) {
    // Do not include response bodies, which could contain sensitive provider details.
    throw new Error("Google Drive request failed (" + response.status + ").");
  }
  return response;
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

export function createGoogleDriveMedia(env, fetchImpl = fetch) {
  if (!env.GOOGLE_DRIVE_FOLDER_ID) throw new Error("GOOGLE_DRIVE_FOLDER_ID is not configured.");

  return {
    async put(name, body, options = {}) {
      const mimeType = options.httpMetadata?.contentType;
      if (typeof mimeType !== "string" || !mimeType) throw new Error("A media content type is required.");
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
        JSON.stringify({name: String(name).split("/").pop(), mimeType, parents:[env.GOOGLE_DRIVE_FOLDER_ID]}) +
        "\r\n--" + boundary + "\r\n" +
        "Content-Type: " + mimeType + "\r\n\r\n"
      );
      const closing = encoder.encode("\r\n--" + boundary + "--");
      const payload = concatBytes([metadata, fileBytes, closing]);
      const response = await driveRequest(
        env,
        DRIVE_UPLOAD + "?uploadType=multipart&fields=id,name,mimeType,size",
        {method:"POST",headers:{"Content-Type":"multipart/related; boundary=" + boundary},body:payload},
        fetchImpl
      );
      const result = await response.json();
      if (typeof result.id !== "string" || !result.id) throw new Error("Google Drive upload returned no file ID.");
      return {key:result.id, id:result.id, size:Number(result.size) || fileBytes.byteLength, httpMetadata:{contentType:result.mimeType || mimeType}};
    },

    async get(fileId) {
      if (typeof fileId !== "string" || !fileId) return null;
      const response = await driveRequest(env, DRIVE_API + "/" + encodeURIComponent(fileId) + "?alt=media", {}, fetchImpl);
      return {
        body: response.body,
        httpMetadata: {"content-type":response.headers.get("Content-Type") || "application/octet-stream"},
        size: Number(response.headers.get("Content-Length")) || undefined
      };
    },

    async delete(fileId) {
      if (typeof fileId !== "string" || !fileId) return;
      const token = await accessToken(env, fetchImpl);
      const response = await fetchImpl(DRIVE_API + "/" + encodeURIComponent(fileId), {
        method:"DELETE",
        headers:{Authorization:"Bearer " + token}
      });
      // A prior successful deletion is already the desired state.
      if (!response.ok && response.status !== 404) {
        throw new Error("Google Drive deletion failed (" + response.status + ").");
      }
    },

    async health() {
      const folder = encodeURIComponent(env.GOOGLE_DRIVE_FOLDER_ID);
      const response = await driveRequest(
        env,
        DRIVE_API + "/" + folder + "?fields=id,mimeType",
        {},
        fetchImpl
      );
      const result = await response.json();
      if (result.mimeType !== "application/vnd.google-apps.folder") {
        throw new Error("Configured Google Drive parent is not a folder.");
      }
      return true;
    }
  };
}
