/**
 * Class XII C Community Archive API — Cloudflare Worker.
 *
 * Required bindings:
 *   DB: Cloudflare D1 database
 *   MEDIA: Cloudflare R2 bucket
 * Required secrets/vars:
 *   SETUP_SECRET (secret; long random value, used once to initialize accounts)
 *   ALLOWED_ORIGIN (exact HTTPS origin of the Pages site, e.g. https://example.pages.dev)
 *   SESSION_TTL_SECONDS (optional; defaults to 12 hours)
 *
 * This API never ships credentials to the browser. Passwords are salted and
 * hashed with PBKDF2-SHA-256; bearer tokens are stored only as SHA-256 hashes.
 */
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const SESSION_DEFAULT_SECONDS = 12 * 60 * 60;
const PBKDF2_ITERATIONS = 210000;
const AUTH_WINDOW_SECONDS = 15 * 60;
const AUTH_MAX_ATTEMPTS = 10;
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
  return typeof password === "string" && password.length >= 12 && password.length <= 256;
}
function cleanText(value, max, field, required = false) {
  if (typeof value !== "string") { if (!required && (value == null || value === "")) return ""; fail(field + " must be text."); }
  const text = value.trim();
  if (required && !text) fail(field + " is required.");
  if (text.length > max) fail(field + " is too long (max " + max + " characters).");
  return text;
}
function id() { return crypto.randomUUID(); }
async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 1024 * 1024) fail("Request body is too large.", 413);
  try { return await request.json(); } catch { fail("Invalid JSON."); }
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
async function rateLimitKey(request, env, scope) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const keyHash = await digest(scope + ":" + ip);
  const cutoff = Math.floor(Date.now() / 1000) - AUTH_WINDOW_SECONDS;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM auth_attempts WHERE key_hash=? AND attempted_at>?"
  ).bind(keyHash, cutoff).first();
  if (Number(row?.n || 0) >= AUTH_MAX_ATTEMPTS) {
    fail("Too many attempts. Please try again in 15 minutes.", 429);
  }
  return keyHash;
}
async function recordFailedAttempt(env, keyHash) {
  await env.DB.prepare("INSERT INTO auth_attempts(key_hash,attempted_at) VALUES(?,?)")
    .bind(keyHash, Math.floor(Date.now() / 1000)).run();
}
async function clearFailedAttempts(env, keyHash) {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE key_hash=?").bind(keyHash).run();
}
async function login(request, env, role) {
  const attemptKey = await rateLimitKey(request, env, "login:" + role);
  const body = await readJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
  const username = role === "admin" ? cleanText(body.username, 64, "Username", true) : "class-members";
  const password = body.password;
  if (typeof password !== "string" || password.length > 256) fail("Invalid username or password.", 401);
  const user = await env.DB.prepare(
    "SELECT id, username, display_name, role, password_hash, disabled, must_change_password FROM users WHERE username=? AND role=?"
  ).bind(username, role).first();
  let okay = false;
  if (user && !user.disabled) {
    const [salt, hash] = user.password_hash.split("$");
    if (salt && hash) okay = await verifyPassword(password, salt, hash);
  }
  if (!okay) {
    await recordFailedAttempt(env, attemptKey);
    fail("Invalid username or password.", 401);
  }
  await clearFailedAttempts(env, attemptKey);
  return json({...await issueSession(user, env), mustChangePassword:!!user.must_change_password}, 200, env.ALLOWED_ORIGIN);
}
async function requireChangedPassword(user) {
  if (user.must_change_password) fail("Change your temporary password before continuing.", 403);
}
async function handle(request, env) {
  if (!env.DB || !env.MEDIA) fail("Server storage is not configured.", 503);
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/health") {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      await env.MEDIA.head("__community_health_check__");
    } catch {
      fail("Storage health check failed.", 503);
    }
    return json({ok:true, service:"class-archive-api", time:new Date().toISOString()}, 200, env.ALLOWED_ORIGIN);
  }

  if (request.method === "POST" && path === "/api/setup") {
    const attemptKey = await rateLimitKey(request, env, "setup");
    if (!env.SETUP_SECRET) fail("Initial setup is disabled until SETUP_SECRET is configured.", 503);
    const supplied = request.headers.get("X-Setup-Secret") || "";
    if (supplied.length < 16 || supplied.length > 256 || !constantTimeEqual(await digest(supplied), await digest(env.SETUP_SECRET))) {
      await recordFailedAttempt(env, attemptKey);
      fail("Not authorized.", 401);
    }
    await clearFailedAttempts(env, attemptKey);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    if (count.n > 0) fail("Setup has already been completed. Rotate the setup secret and remove it when finished.", 409);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
    const adminUsername = cleanText(body.adminUsername, 64, "Admin username", true);
    const adminPassword = body.adminPassword;
    const memberPassword = body.memberPassword;
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(adminUsername)) fail("Admin username must be 3–64 letters, numbers, dots, underscores or hyphens.");
    if (adminUsername.toLowerCase() === "class-members") fail("Choose a different admin username; that username is reserved for the class member account.");
    if (!validPassword(adminPassword) || !validPassword(memberPassword)) fail("Both passwords must be at least 12 characters.");
    if (adminPassword === memberPassword) fail("Admin and member passwords must be different.");
    const adminHash = await passwordHash(adminPassword);
    const memberHash = await passwordHash(memberPassword);
    // D1 batch executes atomically, preventing a partial setup if one insert fails.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(username,display_name,role,password_hash,must_change_password) VALUES(?,?,?,?,0)")
        .bind(adminUsername, "Class Archive Admin", "admin", adminHash.salt + "$" + adminHash.hash),
      env.DB.prepare("INSERT INTO users(username,display_name,role,password_hash,must_change_password) VALUES(?,?,?,?,0)")
        .bind("class-members", "Class Members", "member", memberHash.salt + "$" + memberHash.hash)
    ]);
    return json({ok:true, message:"Accounts initialized. Store both passwords safely and rotate/remove SETUP_SECRET."}, 201, env.ALLOWED_ORIGIN);
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
    if (user.role !== "admin") fail("The shared class upload password is managed by the administrator.", 403);
    const attemptKey = await rateLimitKey(request, env, "password-change:" + user.id);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
    if (typeof body.currentPassword !== "string" || body.currentPassword.length > 256 || !validPassword(body.newPassword)) fail("Current password must be valid and the new password must be at least 12 characters.");
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id=?").bind(user.id).first();
    const [salt, hash] = row.password_hash.split("$");
    if (!(await verifyPassword(body.currentPassword, salt, hash))) {
      await recordFailedAttempt(env, attemptKey);
      fail("Current password is incorrect.", 401);
    }
    await clearFailedAttempts(env, attemptKey);
    const h = await passwordHash(body.newPassword);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash=?,must_change_password=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .bind(h.salt + "$" + h.hash, user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id)
    ]);
    return json({ok:true, message:"Password changed. Please sign in again."}, 200, env.ALLOWED_ORIGIN);
  }

  if (request.method === "POST" && path === "/api/admin/member-password") {
    const admin = await auth(request, env, "admin");
    await requireChangedPassword(admin);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body.");
    if (!validPassword(body.newPassword)) fail("The new class upload password must be at least 12 characters.");
    const member = await env.DB.prepare(
      "SELECT id FROM users WHERE username=? AND role='member'"
    ).bind("class-members").first();
    if (!member) fail("Class member account not found.", 404);
    const h = await passwordHash(body.newPassword);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash=?,must_change_password=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .bind(h.salt + "$" + h.hash, member.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(member.id)
    ]);
    return json({ok:true, message:"Class upload password rotated. Share it with members through a trusted class channel."}, 200, env.ALLOWED_ORIGIN);
  }

  if (request.method === "GET" && path === "/api/content") {
    const rows = await env.DB.prepare("SELECT id,type,title,caption,created_at AS createdAt FROM content ORDER BY created_at DESC LIMIT 200").all();
    return json({items:(rows.results || []).map(x=>({...x, mediaUrl:"/api/media/"+encodeURIComponent(x.id)}))}, 200, env.ALLOWED_ORIGIN);
  }
  if (request.method === "POST" && path === "/api/content") {
    const user = await auth(request, env, "member");
    await requireChangedPassword(user);
    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_MEDIA_BYTES + 1024 * 1024) fail("Upload exceeds 15 MB.", 413);
    const form = await request.formData();
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
    const itemId = id();
    const key = "uploads/" + itemId;
    await env.MEDIA.put(key, file.stream(), {httpMetadata:{contentType:mime, cacheControl:"private, no-store"}});
    try {
      await env.DB.prepare("INSERT INTO content(id,user_id,type,title,caption,media_key,media_mime,media_size) VALUES(?,?,?,?,?,?,?,?)")
        .bind(itemId, user.id, type, title, caption, key, mime, file.size).run();
    } catch (error) { await env.MEDIA.delete(key); throw error; }
    return json({ok:true, id:itemId}, 201, env.ALLOWED_ORIGIN);
  }
  if (request.method === "GET" && path.startsWith("/api/media/")) {
    const itemId = decodeURIComponent(path.slice("/api/media/".length));
    const row = await env.DB.prepare("SELECT media_key,media_mime,media_size FROM content WHERE id=?").bind(itemId).first();
    if (!row) fail("Media not found.", 404);
    const object = await env.MEDIA.get(row.media_key);
    if (!object) fail("Media not found.", 404);
    const headers = new Headers({"Content-Type":row.media_mime,"X-Content-Type-Options":"nosniff","Cache-Control":"private, max-age=60","Content-Length":String(row.media_size)});
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
    const itemId = decodeURIComponent(path.slice("/api/admin/content/".length));
    const row = await env.DB.prepare("SELECT media_key FROM content WHERE id=?").bind(itemId).first();
    if (!row) fail("Content not found.", 404);
    await env.DB.prepare("DELETE FROM content WHERE id=?").bind(itemId).run();
    await env.MEDIA.delete(row.media_key);
    return json({ok:true}, 200, env.ALLOWED_ORIGIN);
  }
  if (request.method === "POST" && path === "/api/admin/announcements") {
    const user = await auth(request, env, "admin"); await requireChangedPassword(user);
    const body = await readJson(request);
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
      if (origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) return new Response(null,{status:403});
      return new Response(null,{status:204,headers:corsHeaders(env.ALLOWED_ORIGIN || origin || "*")});
    }
    if (origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) return json({error:"Origin not allowed."},403);
    try { return await handle(request,env); }
    catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error("Community API error", error);
      return json({error:status >= 500 ? "Internal server error." : error.message},status,env.ALLOWED_ORIGIN);
    }
  }
};
