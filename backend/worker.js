import { createGoogleDriveMedia } from "./google-drive.js";

/**
 * Class XII C Community Archive API — Cloudflare Worker.
 *
 * Required bindings/configuration:
 *   DB: Cloudflare D1 database
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL: dedicated Google service account email
 *   GOOGLE_PRIVATE_KEY: service-account PKCS#8 private key (Worker secret)
 *   GOOGLE_DRIVE_FOLDER_ID: private Drive folder shared with the service account
 * Required secrets/vars:
 *   SETUP_SECRET (secret; long random value, used once to initialize accounts)
 *   ALLOWED_ORIGIN (exact site origin)
 *   SESSION_TTL_SECONDS (optional; defaults to 12 hours)
 *
 * This API never ships credentials to the browser. Passwords are salted and
 * hashed with PBKDF2-SHA-256; bearer tokens are stored only as SHA-256 hashes.
 * Uploaded media is private in Google Drive and proxied through this Worker.
 */
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = MAX_MEDIA_BYTES + 1024 * 1024;
const SESSION_DEFAULT_SECONDS = 12 * 60 * 60;
const PBKDF2_ITERATIONS = 210000;
const AUTH_WINDOW_SECONDS = 15 * 60;
const AUTH_MAX_ATTEMPTS = 10;
const DUMMY_PASSWORD_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";
const DUMMY_PASSWORD_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const encoder = new TextEncoder();

function json(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(origin ? corsHeaders(origin) : {})
    }
  });
}
// Deliberately omit X-Setup-Secret: first-admin setup is CLI-only so the
// bootstrap secret never needs to enter browser JavaScript or frontend state.
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin"
  };
}
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function randomBytes(size = 32) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return bytes; }
function toB64(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function fromB64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function digest(value) { return toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }
function constantTimeEqual(left, right) {
  const a = encoder.encode(left), b = encoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}
async function passwordHash(password, salt = randomBytes(16)) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2", hash:"SHA-256", salt, iterations:PBKDF2_ITERATIONS}, key, 256);
  return {salt:toB64(salt), hash:toB64(new Uint8Array(bits))};
}
async function verifyPassword(password, salt, expected) {
  const result = await passwordHash(password, fromB64(salt));
  const a = encoder.encode(result.hash), b = encoder.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function validPassword(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 256 && password.trim().length > 0;
}
function cleanText(value, max, field, required = false) {
  if (typeof value !== "string") { if (!required && (value == null || value === "")) return ""; fail(field + " must be text."); }
  const text = value.trim();
  if (required && !text) fail(field + " is required.");
  if (text.length > max) fail(field + " is too long (max " + max + " characters).");
  return text;
}
function id() { return crypto.randomUUID(); }
function normalizeUsername(value) {
  const username = cleanText(value, 64, "Username", true).toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) fail("Username must be 3–64 letters, numbers, dots, underscores or hyphens.");
  return username;
}
function normalizeEmail(value) {
  const email = cleanText(value, 254, "Email", true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Enter a valid email address.");
  return email;
}
function accountIdFromPath(path, suffix) {
  const match = path.match(new RegExp("^/api/admin/users/([0-9]+)/" + suffix + "$"));
  if (!match) return null;
  const accountId = Number(match[1]);
  return Number.isSafeInteger(accountId) && accountId > 0 ? accountId : null;
}
async function readLimitedBody(request, maxBytes, message) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    fail(message, 413);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        fail(message, 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error && Number.isInteger(error.status)) throw error;
    fail("Unable to read request body.", 400);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
async function readJson(request) {
  const bytes = await readLimitedBody(request, MAX_JSON_BYTES, "Request body is too large.");
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail("Invalid JSON."); }
}
async function matchesMediaSignature(file, mime) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  switch (mime) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG" &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    case "image/gif":
      return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "video/mp4":
      return ascii(4, 8) === "ftyp";
    case "video/webm":
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    case "video/ogg":
      return ascii(0, 4) === "OggS";
    default:
      return false;
  }
}

async function auth(request, env, requiredRole = null) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  if (!match) fail("Please sign in.", 401);
  const tokenHash = await digest(match[1]);
  const row = await env.DB.prepare(
    "SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.must_change_password, s.expires_at " +
    "FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?"
  ).bind(tokenHash).first();
  if (!row || row.disabled || row.expires_at <= Math.floor(Date.now()/1000)) {
    if (row) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
    fail("Session expired. Please sign in again.", 401);
  }
  if (requiredRole && row.role !== requiredRole) fail("You do not have permission to do that.", 403);
  const path = new URL(request.url).pathname;
  if (row.must_change_password && path !== "/api/logout" && path !== "/api/account/password") {
    fail("Change your temporary password before continuing.", 403);
  }
  return row;
}
async function issueSession(user, env) {
  const token = Array.from(randomBytes(32), b => b.toString(16).padStart(2,"0")).join("");
  const ttl = Math.max(900, Math.min(604800, Number(env.SESSION_TTL_SECONDS) || SESSION_DEFAULT_SECONDS));
  const now = Math.floor(Date.now()/1000);
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
    .bind(await digest(token), user.id, now + ttl, now).run();
  return {token, expiresIn:ttl, user:{username:user.username, displayName:user.display_name, role:user.role}};
}
async function reserveAuthAttempt(request, env, scope, maxAttempts = AUTH_MAX_ATTEMPTS, identity = null) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  // Identity values (such as normalized usernames) are hashed with the scope;
  // raw account identifiers are never stored in auth_attempts.
  const keyHash = await digest(scope + ":" + (identity === null ? ip : identity));
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - AUTH_WINDOW_SECONDS;
  // Count and reserve in one SQLite write statement so concurrent requests
  // cannot all pass a separate COUNT check before any failure is recorded.
  const result = await env.DB.prepare(
    "INSERT INTO auth_attempts(key_hash,attempted_at) " +
    "SELECT ?,? WHERE (SELECT COUNT(*) FROM auth_attempts WHERE key_hash=? AND attempted_at>?) < ?"
  ).bind(keyHash, now, keyHash, cutoff, maxAttempts).run();
  if (Number(result.meta?.changes || 0) !== 1) {
    fail("Too many attempts. Please try again in 15 minutes.", 429);
  }
  const attemptId = Number(result.meta?.last_row_id);
  if (!Number.isSafeInteger(attemptId) || attemptId <= 0) {
    fail("Authentication throttling is unavailable.", 503);
  }
  return {id:attemptId, keyHash};
}
async function clearAuthReservation(env, attempt) {
  // Delete only this successful request's reservation; never clear concurrent failures.
  await env.DB.prepare("DELETE FROM auth_attempts WHERE id=? AND key_hash=?")
    .bind(attempt.id, attempt.keyHash).run();
}
async function login(request, env, role) {
  // Reserve the IP-wide slot before parsing so malformed payloads also count
  // toward the generous IP ceiling.
  const ipAttempt = await reserveAuthAttempt(request, env, "login-ip:" + role, 100);
  const body = await readJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
  const username = cleanText(body.username, 64, "Username", true).toLowerCase();
  const password = body.password;
  if (typeof password !== "string" || password.length > 256) fail("Invalid username or password.", 401);

  // Layer a generous IP-wide ceiling over a stricter per-account bucket. A
  // school/NAT IP can serve many students, so a few mistakes by one student
  // must not lock every member out. The account bucket is keyed by a digest of
  // the normalized username and applies across IPs to slow distributed guesses.
  let accountAttempt;
  try {
    accountAttempt = await reserveAuthAttempt(request, env, "login-account:" + role, AUTH_MAX_ATTEMPTS, username);
  } catch (error) {
    try { await clearAuthReservation(env, ipAttempt); } catch {}
    throw error;
  }

  const user = await env.DB.prepare(
    "SELECT id, username, display_name, role, password_hash, disabled, must_change_password FROM users WHERE username=? AND role=?"
  ).bind(username, role).first();
  const [storedSalt, storedHash] = (user?.password_hash || "").split("$");
  const salt = storedSalt && storedHash ? storedSalt : DUMMY_PASSWORD_SALT;
  const hash = storedSalt && storedHash ? storedHash : DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPassword(password, salt, hash);
  const okay = !!user && !user.disabled && passwordMatches;
  if (!okay) {
    fail("Invalid username or password.", 401);
  }
  await clearAuthReservation(env, ipAttempt);
  await clearAuthReservation(env, accountAttempt);
  return json({...await issueSession(user, env), mustChangePassword:!!user.must_change_password}, 200, env.ALLOWED_ORIGIN);
}
async function requireChangedPassword(user) {
  if (user.must_change_password) fail("Change your temporary password before continuing.", 403);
}
function driveStorage(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY || !env.GOOGLE_DRIVE_FOLDER_ID) {
    fail("Google Drive storage is not configured.", 503);
  }
  try { return createGoogleDriveMedia(env, env.__googleFetch || fetch); }
  catch { fail("Google Drive storage configuration is invalid.", 503); }
}
async function handle(request, env) {
  if (!env.DB) fail("Database storage is not configured.", 503);
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/health") {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      await driveStorage(env).health();
    } catch (error) {
      if (Number(error?.status) === 503) throw error;
      fail("Storage health check failed.", 503);
    }
    return json({ok:true, service:"class-archive-api", storage:"google-drive", time:new Date().toISOString()}, 200, env.ALLOWED_ORIGIN);
  }

  if (request.method === "POST" && path === "/api/setup") {
    if (!env.SETUP_SECRET) fail("Initial setup is disabled until SETUP_SECRET is configured.", 503);
    const attempt = await reserveAuthAttempt(request, env, "setup");
    const supplied = request.headers.get("X-Setup-Secret") || "";
    if (supplied.length < 16 || supplied.length > 256 || !constantTimeEqual(await digest(supplied), await digest(env.SETUP_SECRET))) {
      fail("Not authorized.", 401);
    }
    // Avoid repeated expensive password hashing after initialization. Keep this
    // request's reservation on the 409 path so valid-secret retries still count
    // toward the per-IP setup threshold. The conditional INSERT below remains
    // the final race guard if two first-time setup requests overlap.
    const existingAdmin = await env.DB.prepare("SELECT 1 AS present FROM users LIMIT 1").first();
    if (existingAdmin) {
      fail("Setup has already been completed. Rotate the setup secret and remove it when finished.", 409);
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
    const adminUsername = normalizeUsername(body.adminUsername);
    const adminEmail = normalizeEmail(body.adminEmail);
    const adminPassword = body.adminPassword;
    if (!validPassword(adminPassword)) fail("Admin password must be at least 12 non-blank characters.");
    const adminHash = await passwordHash(adminPassword);
    // A single conditional INSERT makes one-time initialization atomic under D1's serialized writes.
    const result = await env.DB.prepare(
      "INSERT INTO users(username,email,display_name,role,password_hash,must_change_password) " +
      "SELECT ?,?,?,?, ?,0 WHERE NOT EXISTS (SELECT 1 FROM users)"
    ).bind(adminUsername, adminEmail, cleanText(body.adminDisplayName || "Class Archive Admin", 100, "Admin display name", true), "admin", adminHash.salt + "$" + adminHash.hash).run();
    if (Number(result.meta?.changes || 0) !== 1) {
      fail("Setup has already been completed. Rotate the setup secret and remove it when finished.", 409);
    }
    await clearAuthReservation(env, attempt);
    return json({ok:true, message:"Administrator initialized. Create student accounts from the admin desk and rotate/remove SETUP_SECRET."}, 201, env.ALLOWED_ORIGIN);
  }
  if (request.method === "POST" && path === "/api/member/login") return login(request, env, "member");
  if (request.method === "POST" && path === "/api/admin/login") return login(request, env, "admin");

  if (request.method === "POST" && path === "/api/logout") {
    const header = request.headers.get("Authorization") || "";
    const match = header.match(/^Bearer ([A-Za-z0-9_-]+)$/);
    if (match) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(match[1])).run();
    return json({ok:true}, 200, env.ALLOWED_ORIGIN);
  }
  if (request.method === "POST" && path === "/api/account/password") {
    const user = await auth(request, env);
    const attempt = await reserveAuthAttempt(request, env, "password-change:" + user.id);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
    if (typeof body.currentPassword !== "string" || body.currentPassword.length > 256 || !validPassword(body.newPassword)) fail("Current password must be valid and the new password must be at least 12 non-blank characters.");
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id=?").bind(user.id).first();
    const [salt, hash] = row.password_hash.split("$");
    if (!(await verifyPassword(body.currentPassword, salt, hash))) {
      fail("Current password is incorrect.", 401);
    }
    await clearAuthReservation(env, attempt);
    const h = await passwordHash(body.newPassword);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash=?,must_change_password=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .bind(h.salt + "$" + h.hash, user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id)
    ]);
    return json({ok:true, message:"Password changed. All sessions were revoked; please sign in again."}, 200, env.ALLOWED_ORIGIN);
  }

  if (request.method === "GET" && path === "/api/admin/users") {
    const admin = await auth(request, env, "admin");
    await requireChangedPassword(admin);
    const rows = await env.DB.prepare(
      "SELECT id,username,email,display_name AS displayName,role,disabled,must_change_password AS mustChangePassword,created_at AS createdAt " +
      "FROM users WHERE role='member' ORDER BY username COLLATE NOCASE LIMIT 500"
    ).all();
    return json({items:(rows.results || []).map(row=>({...row,disabled:!!row.disabled,mustChangePassword:!!row.mustChangePassword}))}, 200, env.ALLOWED_ORIGIN);
  }
  if (request.method === "POST" && path === "/api/admin/users") {
    const admin = await auth(request, env, "admin");
    await requireChangedPassword(admin);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
    const username = normalizeUsername(body.username);
    const email = normalizeEmail(body.email);
    const displayName = cleanText(body.displayName, 100, "Display name", true);
    if (!validPassword(body.temporaryPassword)) fail("Temporary password must be at least 12 non-blank characters.");
    const password = await passwordHash(body.temporaryPassword);
    try {
      const result = await env.DB.prepare(
        "INSERT INTO users(username,email,display_name,role,password_hash,must_change_password,disabled) VALUES(?,?,?,'member',?,1,0)"
      ).bind(username,email,displayName,password.salt+"$"+password.hash).run();
      return json({ok:true,id:result.meta?.last_row_id ?? null,message:"Student account created. Share the temporary password privately; it will not be shown again."},201,env.ALLOWED_ORIGIN);
    } catch (error) {
      if (/unique|constraint/i.test(String(error?.message || error))) fail("That username or email is already in use.",409);
      throw error;
    }
  }
  const updateId = accountIdFromPath(path, "update");
  if (request.method === "POST" && updateId !== null) {
    const admin = await auth(request, env, "admin");
    await requireChangedPassword(admin);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
    const username = normalizeUsername(body.username);
    const email = normalizeEmail(body.email);
    const displayName = cleanText(body.displayName, 100, "Display name", true);
    try {
      const result = await env.DB.prepare(
        "UPDATE users SET username=?,email=?,display_name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND role='member'"
      ).bind(username,email,displayName,updateId).run();
      if (!result.meta?.changes) fail("Student account not found.",404);
      return json({ok:true},200,env.ALLOWED_ORIGIN);
    } catch (error) {
      if (/unique|constraint/i.test(String(error?.message || error))) fail("That username or email is already in use.",409);
      throw error;
    }
  }
  const statusId = accountIdFromPath(path, "status");
  if (request.method === "POST" && statusId !== null) {
    const admin = await auth(request, env, "admin");
    await requireChangedPassword(admin);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.disabled !== "boolean") fail("Provide disabled as true or false.");
    const update = env.DB.prepare(
      "UPDATE users SET disabled=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND role='member'"
    ).bind(body.disabled ? 1 : 0,statusId);
    const statements = [update];
    if (body.disabled) statements.push(env.DB.prepare(
      "DELETE FROM sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND role='member' AND disabled=1)"
    ).bind(statusId,statusId));
    const results = await env.DB.batch(statements);
    if (!Number(results?.[0]?.meta?.changes || 0)) fail("Student account not found.",404);
    return json({ok:true,message:body.disabled?"Account disabled and sessions revoked.":"Account re-enabled."},200,env.ALLOWED_ORIGIN);
  }
  const resetId = accountIdFromPath(path, "reset-password");
  if (request.method === "POST" && resetId !== null) {
    const admin = await auth(request, env, "admin");
    await requireChangedPassword(admin);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || !validPassword(body.temporaryPassword)) fail("Temporary password must be at least 12 non-blank characters.");
    const password = await passwordHash(body.temporaryPassword);
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash=?,must_change_password=1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND role='member'")
        .bind(password.salt+"$"+password.hash,resetId),
      env.DB.prepare(
        "DELETE FROM sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND role='member')"
      ).bind(resetId,resetId)
    ]);
    if (!Number(results?.[0]?.meta?.changes || 0)) fail("Student account not found.",404);
    return json({ok:true,message:"Temporary password reset and all sessions revoked. Share it privately."},200,env.ALLOWED_ORIGIN);
  }
  const revokeId = accountIdFromPath(path, "revoke-sessions");
  if (request.method === "POST" && revokeId !== null) {
    const admin = await auth(request, env, "admin");
    await requireChangedPassword(admin);
    const target = await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='member'").bind(revokeId).first();
    if (!target) fail("Student account not found.",404);
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(revokeId).run();
    return json({ok:true,message:"All sessions revoked."},200,env.ALLOWED_ORIGIN);
  }

  if (request.method === "GET" && path === "/api/content") {
    const rows = await env.DB.prepare("SELECT id,type,title,caption,created_at AS createdAt FROM content ORDER BY created_at DESC LIMIT 200").all();
    return json({items:(rows.results || []).map(x=>({...x, mediaUrl:"/api/media/"+encodeURIComponent(x.id)}))}, 200, env.ALLOWED_ORIGIN);
  }
  if (request.method === "POST" && path === "/api/content") {
    const user = await auth(request, env, "member");
    await requireChangedPassword(user);
    const mediaStore = driveStorage(env);
    // Bound the complete multipart request before parsing it. Content-Length is
    // only an early-rejection hint; the streamed byte count is authoritative.
    const uploadBody = await readLimitedBody(request, MAX_UPLOAD_REQUEST_BYTES, "Upload request exceeds the 15 MB media limit.");
    const boundedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: uploadBody
    });
    let form;
    try { form = await boundedRequest.formData(); }
    catch { fail("Invalid upload form."); }
    const type = form.get("type");
    const title = cleanText(form.get("title"), 120, "Title", true);
    const caption = cleanText(form.get("caption"), 1000, "Caption");
    const file = form.get("media");
    if (!(file instanceof File)) fail("Choose an image or video to upload.");
    if (file.size < 1 || file.size > MAX_MEDIA_BYTES) fail("Media must be between 1 byte and 15 MB.", 413);
    const mime = file.type.toLowerCase();
    const allowed = type === "image" ? ["image/jpeg","image/png","image/webp","image/gif"] :
      type === "video" ? ["video/mp4","video/webm","video/ogg"] : [];
    if (!allowed.includes(mime)) fail("File type does not match an allowed image/video type.");
    if (!(await matchesMediaSignature(file, mime))) fail("File contents do not match the selected media type.", 415);
    const itemId = id();
    let stored;
    try {
      stored = await mediaStore.put("uploads/" + itemId, file.stream(), {
        httpMetadata: {contentType:mime, cacheControl:"private, no-store"}
      });
    } catch {
      fail("Google Drive upload failed.", 503);
    }
    const driveFileId = stored?.key || stored?.id;
    if (typeof driveFileId !== "string" || !driveFileId) {
      fail("Google Drive did not return a valid file ID.", 503);
    }
    try {
      await env.DB.prepare("INSERT INTO content(id,user_id,type,title,caption,media_key,media_mime,media_size) VALUES(?,?,?,?,?,?,?,?)")
        .bind(itemId, user.id, type, title, caption, driveFileId, mime, file.size).run();
    } catch (error) {
      try { await mediaStore.delete(driveFileId); }
      catch (cleanupError) {
        console.error("Failed to clean up unreferenced Google Drive file", {itemId, error:String(cleanupError)});
      }
      throw error;
    }
    return json({ok:true, id:itemId}, 201, env.ALLOWED_ORIGIN);
  }
  if (request.method === "GET" && path.startsWith("/api/media/")) {
    const itemId = decodeURIComponent(path.slice("/api/media/".length));
    const row = await env.DB.prepare("SELECT media_key,media_mime,media_size FROM content WHERE id=?").bind(itemId).first();
    if (!row) fail("Media not found.", 404);
    let object;
    try { object = await driveStorage(env).get(row.media_key); }
    catch { fail("Google Drive media retrieval failed.", 503); }
    if (!object) fail("Media not found.", 404);
    const contentType = object.httpMetadata?.["content-type"] || row.media_mime || "application/octet-stream";
    const headers = new Headers({"Content-Type":contentType,"X-Content-Type-Options":"nosniff","Cache-Control":"private, max-age=60",...(row.media_size ? {"Content-Length":String(row.media_size)} : {})});
    if (env.ALLOWED_ORIGIN) for (const [key, value] of Object.entries(corsHeaders(env.ALLOWED_ORIGIN))) headers.set(key, value);
    return new Response(object.body,{headers});
  }
  if (request.method === "GET" && path === "/api/admin/content") {
    const user = await auth(request, env, "admin");
    await requireChangedPassword(user);
    const rows = await env.DB.prepare("SELECT id,type,title,caption,created_at AS createdAt FROM content ORDER BY created_at DESC LIMIT 500").all();
    return json({items:rows.results || []}, 200, env.ALLOWED_ORIGIN);
  }
  if (request.method === "DELETE" && path.startsWith("/api/admin/content/")) {
    const user = await auth(request, env, "admin"); await requireChangedPassword(user);
    const mediaStore = driveStorage(env);
    const itemId = decodeURIComponent(path.slice("/api/admin/content/".length));
    const row = await env.DB.prepare("SELECT media_key FROM content WHERE id=?").bind(itemId).first();
    if (!row) fail("Content not found.", 404);
    // Google Drive and D1 cannot share a transaction. Delete the file first so a
    // Drive failure leaves the metadata row available for an admin retry. Drive
    // deletion is idempotent here: an already-missing file can still be reconciled.
    try { await mediaStore.delete(row.media_key); }
    catch { fail("Google Drive media deletion failed.", 503); }
    await env.DB.prepare("DELETE FROM content WHERE id=?").bind(itemId).run();
    return json({ok:true}, 200, env.ALLOWED_ORIGIN);
  }
  if (request.method === "POST" && path === "/api/admin/announcements") {
    const user = await auth(request, env, "admin"); await requireChangedPassword(user);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
    const title = cleanText(body.title, 120, "Title", true);
    const announcement = cleanText(body.body, 3000, "Announcement", true);
    const announcementId = id();
    await env.DB.prepare("INSERT INTO announcements(id,user_id,title,body) VALUES(?,?,?,?)").bind(announcementId,user.id,title,announcement).run();
    return json({ok:true,id:announcementId}, 201, env.ALLOWED_ORIGIN);
  }
  if (request.method === "GET" && path === "/api/announcements") {
    const rows = await env.DB.prepare("SELECT id,title,body,created_at AS createdAt FROM announcements ORDER BY created_at DESC LIMIT 50").all();
    return json({items:rows.results || []}, 200, env.ALLOWED_ORIGIN);
  }
  if (request.method === "GET" && path === "/api/push/public-key") return json({publicKey:env.VAPID_PUBLIC_KEY || null}, 200, env.ALLOWED_ORIGIN);
  if (request.method === "POST" && path === "/api/push/subscribe") {
    await auth(request, env, "member");
    return json({error:"Push delivery is not configured yet. Subscription storage and VAPID signing must be completed before enabling this feature."}, 501, env.ALLOWED_ORIGIN);
  }
  return json({error:"Not found."},404,env.ALLOWED_ORIGIN);
}
export default {
  async scheduled(_controller, env, ctx) {
    if (!env.DB) return;
    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil(Promise.all([
      env.DB.prepare("DELETE FROM auth_attempts WHERE attempted_at < ?").bind(now - 86400).run(),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run()
    ]));
  },
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      if (origin && (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN)) return new Response(null,{status:403});
      if (!origin) return new Response(null,{status:204});
      return new Response(null,{status:204,headers:corsHeaders(env.ALLOWED_ORIGIN)});
    }
    if (origin && (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN)) return json({error:"Origin not allowed."},403);
    try { return await handle(request,env); }
    catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error("Community API error", error);
      return json({error:status >= 500 ? "Internal server error." : error.message},status,env.ALLOWED_ORIGIN);
    }
  }
};
