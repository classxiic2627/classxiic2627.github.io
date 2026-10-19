import test from "node:test";
import assert from "node:assert/strict";
import worker from "../backend/worker.js";

const origin = "https://classxiic2627.github.io";
const env = {
  ALLOWED_ORIGIN: origin,
  DB: {},
  MEDIA: {}
};

function request(path, { method = "GET", headers = {} } = {}) {
  return new Request("https://api.example.test" + path, {
    method,
    headers: new Headers(headers)
  });
}

test("health endpoint returns a non-cacheable success response", async () => {
  const response = await worker.fetch(request("/api/health", {
    headers: { Origin: origin }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.deepEqual(await response.json().then(({ ok, service }) => ({ ok, service })), {
    ok: true,
    service: "class-archive-api"
  });
});

test("rejects requests from an unapproved browser origin", async () => {
  const response = await worker.fetch(request("/api/health", {
    headers: { Origin: "https://untrusted.example" }
  }), env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await response.json(), { error: "Origin not allowed." });
});

test("preflight allows only the configured origin", async () => {
  const allowed = await worker.fetch(request("/api/content", {
    method: "OPTIONS",
    headers: { Origin: origin }
  }), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), origin);
  assert.match(allowed.headers.get("access-control-allow-methods"), /DELETE/);

  const denied = await worker.fetch(request("/api/content", {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.example" }
  }), env);
  assert.equal(denied.status, 403);
});

test("unknown API paths return JSON 404 without caching", async () => {
  const response = await worker.fetch(request("/api/does-not-exist", {
    headers: { Origin: origin }
  }), env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.deepEqual(await response.json(), { error: "Not found." });
});

test("reports unavailable storage instead of claiming the API is healthy", async () => {
  const response = await worker.fetch(request("/api/health"), {
    ALLOWED_ORIGIN: origin
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Internal server error." });
});

function authenticatedEnv(user) {
  return {
    ...env,
    DB: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => user,
              run: async () => ({ success: true })
            };
          }
        };
      }
    }
  };
}

const memberSession = {
  id: 7,
  username: "class-members",
  display_name: "Class Members",
  role: "member",
  disabled: 0,
  must_change_password: 0,
  expires_at: 4_000_000_000
};

test("protected upload route rejects missing authentication", async () => {
  const response = await worker.fetch(request("/api/content", {
    method: "POST",
    headers: { Origin: origin }
  }), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Please sign in." });
});

test("member session cannot access administrator-only content", async () => {
  const response = await worker.fetch(request("/api/admin/content", {
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "a".repeat(64)
    }
  }), authenticatedEnv(memberSession));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "You do not have permission to do that." });
});

test("temporary-password accounts cannot upload before changing their password", async () => {
  const response = await worker.fetch(request("/api/content", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "b".repeat(64)
    }
  }), authenticatedEnv({ ...memberSession, must_change_password: 1 }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Change your temporary password before continuing."
  });
});

test("throttles login attempts after the configured failure threshold", async () => {
  const rateLimitedEnv = {
    ...env,
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM auth_attempts/);
        return {
          bind() {
            return { first: async () => ({ n: 10 }) };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/member/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.42",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password: "incorrect-password" })
  }), rateLimitedEnv);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: "Too many attempts. Please try again in 15 minutes."
  });
});

test("scheduled cleanup prunes old auth attempts and expired sessions", async () => {
  const statements = [];
  const promises = [];
  const cleanupEnv = {
    DB: {
      prepare(sql) {
        statements.push(sql);
        return {
          bind() {
            return { run: async () => ({ success: true }) };
          }
        };
      }
    }
  };
  await worker.scheduled({}, cleanupEnv, { waitUntil(promise) { promises.push(promise); } });
  await Promise.all(promises);
  assert.equal(statements.length, 2);
  assert.ok(statements.some(sql => sql.includes("DELETE FROM auth_attempts")));
  assert.ok(statements.some(sql => sql.includes("DELETE FROM sessions")));
});

test("records failed credential checks for login throttling", async () => {
  const statements = [];
  const user = {
    id: 9,
    username: "class-members",
    display_name: "Class Members",
    role: "member",
    password_hash: "AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    disabled: 0,
    must_change_password: 0
  };
  const loginEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => sql.includes("COUNT(*)")
                ? { n: 0 }
                : sql.includes("FROM users")
                  ? user
                  : null,
              run: async () => {
                statements.push({ sql, values });
                return { success: true };
              }
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/member/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.43",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password: "definitely-not-the-password" })
  }), loginEnv);
  assert.equal(response.status, 401);
  assert.ok(statements.some(({ sql }) => sql.includes("INSERT INTO auth_attempts")));
});
