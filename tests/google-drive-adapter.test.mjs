import test from "node:test";
import assert from "node:assert/strict";
import worker from "../backend/worker.js";

const origin = "https://classxiic2627.github.io";
let sequence = 0;

function envFor({ first, run } = {}) {
  sequence += 1;
  return {
    ALLOWED_ORIGIN: origin,
    GOOGLE_CLIENT_ID: `worker-test-client-${sequence}.apps.googleusercontent.com`,
    GOOGLE_CLIENT_SECRET: `fake-client-secret-${sequence}`,
    GOOGLE_REFRESH_TOKEN: `fake-refresh-token-${sequence}`,
    GOOGLE_DRIVE_FOLDER_ID: "folder_test-123",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => first ? first(sql, values) : null,
              run: async () => run ? run(sql, values) : ({ meta: { changes: 1 } }),
              all: async () => ({ results: [] })
            };
          },
          first: async () => first ? first(sql, []) : null,
          run: async () => run ? run(sql, []) : ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] })
        };
      }
    }
  };
}

function request(path, options = {}) {
  return new Request("https://api.example.test" + path, options);
}

async function withFetch(mockFetch, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function oauthResponse() {
  return new Response(JSON.stringify({ access_token: "unit-test-access-token", expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("health verifies the configured private Drive folder through server-side OAuth", async () => {
  let tokenRequests = 0;
  let folderRequests = 0;
  const env = envFor({
    first: async sql => sql.includes("SELECT 1 AS ok") ? { ok: 1 } : null
  });

  const response = await withFetch(async (url, options = {}) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      tokenRequests += 1;
      assert.equal(options.method, "POST");
      assert.match(String(options.body), /grant_type=refresh_token/);
      assert.match(String(options.body), /client_secret=fake-client-secret-/);
      return oauthResponse();
    }
    folderRequests += 1;
    assert.match(String(url), /\/drive\/v3\/files\/folder_test-123\?fields=/);
    assert.equal(options.headers.Authorization, "Bearer unit-test-access-token");
    return new Response(JSON.stringify({
      id: "folder_test-123",
      name: "Class media",
      mimeType: "application/vnd.google-apps.folder"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }, () => worker.fetch(request("/api/health"), env));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).storage, "google-drive");
  assert.equal(tokenRequests, 1);
  assert.equal(folderRequests, 1);
});

test("member upload sends validated bytes to Drive and stores only the Drive file ID in D1 metadata", async () => {
  let uploadedBody = "";
  let contentInsert = null;
  const env = envFor({
    first: async sql => sql.includes("FROM sessions s JOIN users")
      ? {
          id: 7, username: "student", display_name: "Student", role: "member",
          disabled: 0, must_change_password: 0, expires_at: Math.floor(Date.now() / 1000) + 3600
        }
      : null,
    run: async (sql, values) => {
      if (sql.includes("INSERT INTO content")) contentInsert = values;
      return { meta: { changes: 1 } };
    }
  });
  const form = new FormData();
  form.set("type", "image");
  form.set("title", "Local test");
  form.set("caption", "Mocked Drive integration");
  form.set("media", new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "tiny.png", {
    type: "image/png"
  }));

  const response = await withFetch(async (url, options = {}) => {
    if (String(url) === "https://oauth2.googleapis.com/token") return oauthResponse();
    assert.match(String(url), /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/);
    assert.equal(options.headers.Authorization, "Bearer unit-test-access-token");
    assert.match(options.headers["Content-Type"], /^multipart\/related; boundary=/);
    uploadedBody = new TextDecoder().decode(options.body);
    return new Response(JSON.stringify({
      id: "drive-file-abc123",
      name: "community-test",
      mimeType: "image/png",
      parents: ["folder_test-123"]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }, () => worker.fetch(request("/api/content", {
    method: "POST",
    headers: { Authorization: "Bearer test-session-token", Origin: origin },
    body: form
  }), env));

  assert.equal(response.status, 201);
  assert.match(uploadedBody, /"parents":\["folder_test-123"\]/);
  assert.ok(contentInsert);
  assert.equal(contentInsert[0], (await response.clone().json()).id);
  assert.equal(contentInsert[5], "drive-file-abc123");
  assert.equal(contentInsert[6], "image/png");
});

test("Drive upload is compensated when the D1 metadata insert fails", async () => {
  const calls = [];
  const env = envFor({
    first: async sql => sql.includes("FROM sessions s JOIN users")
      ? {
          id: 7, username: "student", display_name: "Student", role: "member",
          disabled: 0, must_change_password: 0, expires_at: Math.floor(Date.now() / 1000) + 3600
        }
      : null,
    run: async sql => {
      if (sql.includes("INSERT INTO content")) throw new Error("simulated D1 failure");
      return { meta: { changes: 1 } };
    }
  });
  const form = new FormData();
  form.set("type", "image");
  form.set("title", "Cleanup test");
  form.set("caption", "");
  form.set("media", new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "tiny.png", {
    type: "image/png"
  }));

  const response = await withFetch(async (url, options = {}) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") return oauthResponse();
    if (target.startsWith("https://www.googleapis.com/upload/drive/v3/files?")) {
      calls.push("upload");
      return new Response(JSON.stringify({ id: "drive-orphan-1", mimeType: "image/png" }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    if (target === "https://www.googleapis.com/drive/v3/files/drive-orphan-1") {
      calls.push("delete");
      assert.equal(options.method, "DELETE");
      assert.equal(options.headers.Authorization, "Bearer unit-test-access-token");
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected Google API URL: " + target);
  }, () => worker.fetch(request("/api/content", {
    method: "POST",
    headers: { Authorization: "Bearer test-session-token", Origin: origin },
    body: form
  }), env));

  assert.equal(response.status, 500);
  assert.deepEqual(calls, ["upload", "delete"]);
  assert.doesNotMatch(await response.text(), /unit-test-access-token|fake-client-secret|fake-refresh-token/);
});

test("media retrieval proxies Drive bytes and does not expose the Drive API URL", async () => {
  const env = envFor({
    first: async sql => sql.includes("SELECT media_key,media_mime,media_size FROM content")
      ? { media_key: "drive-file-read1", media_mime: "image/png", media_size: 4 }
      : null
  });
  const urls = [];
  const response = await withFetch(async url => {
    const target = String(url);
    urls.push(target);
    if (target === "https://oauth2.googleapis.com/token") return oauthResponse();
    assert.equal(target, "https://www.googleapis.com/drive/v3/files/drive-file-read1?alt=media");
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  }, () => worker.fetch(request("/api/media/public-item"), env));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(urls.some(url => url.includes("drive-file-read1")), true);
  assert.equal(response.headers.get("Location"), null);
});

test("OAuth rejection fails closed without returning credentials or token details", async () => {
  const env = envFor({
    first: async sql => sql.includes("SELECT 1 AS ok") ? { ok: 1 } : null
  });
  const response = await withFetch(async url => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "sensitive provider detail" }), {
        status: 401, headers: { "Content-Type": "application/json" }
      });
    }
    throw new Error("Drive API must not be called after OAuth failure");
  }, () => worker.fetch(request("/api/health"), env));

  assert.equal(response.status, 503);
  const body = await response.text();
  assert.doesNotMatch(body, /invalid_grant|sensitive provider detail|fake-client-secret|fake-refresh-token|unit-test-access-token/);
});
