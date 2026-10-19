import test from "node:test";
import assert from "node:assert/strict";
import worker from "../backend/worker.js";

const origin = "https://classxiic2627.github.io";
const env = {
  ALLOWED_ORIGIN: origin,
  DB: {
    prepare() {
      return { first: async () => ({ ok: 1 }) };
    }
  },
  MEDIA: {
    head: async () => null
  }
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
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
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

const adminSession = {
  ...memberSession,
  id: 8,
  username: "archive-admin",
  role: "admin",
  display_name: "Archive Admin"
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

test("rejects null login payloads as client errors", async () => {
  const loginEnv = {
    ...env,
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM auth_attempts/);
        return {
          bind() {
            return { first: async () => ({ n: 0 }) };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/member/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.44",
      "Content-Type": "application/json"
    },
    body: "null"
  }), loginEnv);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid request body." });
});

test("throttles repeated initial-setup attempts", async () => {
  const setupEnv = {
    ...env,
    SETUP_SECRET: "a-long-random-setup-secret-for-testing",
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
  const response = await worker.fetch(new Request("https://api.example.test/api/setup", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.45",
      "Content-Type": "application/json",
      "X-Setup-Secret": "wrong-secret-value-long-enough"
    },
    body: "{}"
  }), setupEnv);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: "Too many attempts. Please try again in 15 minutes."
  });
});

test("rejects disallowed upload MIME types before writing to media storage", async () => {
  let mediaWrites = 0;
  const uploadEnv = {
    ...authenticatedEnv(memberSession),
    MEDIA: {
      async put() { mediaWrites++; }
    }
  };
  const form = new FormData();
  form.set("type", "image");
  form.set("title", "Test upload");
  form.set("caption", "");
  form.set("media", new File(["not an image"], "payload.html", { type: "text/html" }));
  const response = await worker.fetch(new Request("https://api.example.test/api/content", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "c".repeat(64)
    },
    body: form
  }), uploadEnv);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "File type does not match an allowed image/video type."
  });
  assert.equal(mediaWrites, 0);
});

test("rejects null setup payloads without creating accounts", async () => {
  const statements = [];
  const setupEnv = {
    ...env,
    SETUP_SECRET: "a-long-random-setup-secret-for-testing",
    DB: {
      prepare(sql) {
        const first = async () => {
          if (sql.includes("FROM auth_attempts")) return { n: 0 };
          if (sql.includes("COUNT(*) AS n FROM users")) return { n: 0 };
          return null;
        };
        return {
          first,
          bind(...values) {
            return {
              first,
              run: async () => {
                statements.push({ sql, values });
                return { success: true };
              }
            };
          }
        };
      },
      async batch() {
        throw new Error("Account batch must not run for invalid input");
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/setup", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.46",
      "Content-Type": "application/json",
      "X-Setup-Secret": "a-long-random-setup-secret-for-testing"
    },
    body: "null"
  }), setupEnv);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid request body." });
  assert.equal(statements.some(({ sql }) => sql.includes("INSERT INTO users")), false);
});

test("health endpoint reports a dependency failure when D1 is unreachable", async () => {
  const brokenEnv = {
    ALLOWED_ORIGIN: origin,
    DB: {
      prepare() {
        return { first: async () => { throw new Error("simulated D1 outage"); } };
      }
    },
    MEDIA: { head: async () => null }
  };
  const response = await worker.fetch(request("/api/health", {
    headers: { Origin: origin }
  }), brokenEnv);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Internal server error." });
});

test("throttles password-change verification attempts per authenticated account", async () => {
  const protectedEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              first: async () => {
                if (sql.includes("FROM sessions")) return adminSession;
                if (sql.includes("FROM auth_attempts")) return { n: 10 };
                return null;
              }
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/account/password", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.48",
      Authorization: "Bearer " + "d".repeat(64),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ currentPassword: "not-used", newPassword: "also-not-used" })
  }), protectedEnv);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: "Too many attempts. Please try again in 15 minutes."
  });
});

test("rejects null password-change payloads as client errors", async () => {
  const protectedEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              first: async () => {
                if (sql.includes("FROM sessions")) return adminSession;
                if (sql.includes("FROM auth_attempts")) return { n: 0 };
                return null;
              }
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/account/password", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.49",
      Authorization: "Bearer " + "e".repeat(64),
      "Content-Type": "application/json"
    },
    body: "null"
  }), protectedEnv);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid request body." });
});

test("rejects and removes expired sessions", async () => {
  const statements = [];
  const expiredSession = { ...memberSession, expires_at: 1 };
  const expiredEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => expiredSession,
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
  const response = await worker.fetch(request("/api/admin/content", {
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "f".repeat(64)
    }
  }), expiredEnv);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Session expired. Please sign in again." });
  assert.ok(statements.some(({ sql }) => sql.includes("DELETE FROM sessions")));
});

test("records failed current-password checks for throttling", async () => {
  const statements = [];
  const passwordEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => {
                if (sql.includes("FROM sessions")) return adminSession;
                if (sql.includes("FROM auth_attempts")) return { n: 0 };
                if (sql.includes("SELECT password_hash FROM users")) {
                  return {
                    password_hash: "AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
                  };
                }
                return null;
              },
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
  const response = await worker.fetch(new Request("https://api.example.test/api/account/password", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.50",
      Authorization: "Bearer " + "g".repeat(64),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      currentPassword: "incorrect-current-password",
      newPassword: "a-long-enough-test-value"
    })
  }), passwordEnv);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Current password is incorrect." });
  assert.ok(statements.some(({ sql }) => sql.includes("INSERT INTO auth_attempts")));
});

test("one-time setup refuses to overwrite existing accounts", async () => {
  const setupSecret = "setup-secret-used-only-in-this-test";
  let batches = 0;
  const setupEnv = {
    ...env,
    SETUP_SECRET: setupSecret,
    DB: {
      prepare(sql) {
        const first = async () => {
          if (sql.includes("FROM auth_attempts")) return { n: 0 };
          if (sql.includes("COUNT(*) AS n FROM users")) return { n: 2 };
          return null;
        };
        return {
          first,
          bind() { return { first, run: async () => ({ success: true }) }; }
        };
      },
      async batch() { batches++; }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/setup", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.51",
      "Content-Type": "application/json",
      "X-Setup-Secret": setupSecret
    },
    body: "{}"
  }), setupEnv);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Setup has already been completed. Rotate the setup secret and remove it when finished."
  });
  assert.equal(batches, 0);
});

test("shared class members cannot change the shared password themselves", async () => {
  const response = await worker.fetch(request("/api/account/password", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "h".repeat(64),
      "Content-Type": "application/json"
    }
  }), authenticatedEnv(memberSession));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "The shared class upload password is managed by the administrator."
  });
});

test("shared class members cannot use the admin password-rotation route", async () => {
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/member-password", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "i".repeat(64),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ newPassword: "a-long-test-password-value" })
  }), authenticatedEnv(memberSession));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "You do not have permission to do that."
  });
});

test("admin member-password rotation enforces minimum password length", async () => {
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/member-password", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "j".repeat(64),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ newPassword: "short" })
  }), authenticatedEnv(adminSession));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "The new class upload password must be at least 12 characters and cannot be blank."
  });
});

test("admin rotation hashes the shared password and revokes member sessions atomically", async () => {
  const batches = [];
  const rotationEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql,
              values,
              first: async () => {
                if (sql.includes("SELECT id FROM users")) return { id: memberSession.id };
                return adminSession;
              }
            };
          }
        };
      },
      async batch(statements) {
        batches.push(statements);
        return statements.map(() => ({ success: true }));
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/member-password", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "k".repeat(64),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ newPassword: "x".repeat(12) })
  }), rotationEnv);
  assert.equal(response.status, 200);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  assert.ok(batches[0].some(statement => statement.sql.includes("UPDATE users SET password_hash")));
  assert.ok(batches[0].some(statement => statement.sql.includes("DELETE FROM sessions")));
  const data = await response.json();
  assert.equal(data.ok, true);
});

test("health endpoint reports an R2 dependency failure", async () => {
  const brokenEnv = {
    ALLOWED_ORIGIN: origin,
    DB: {
      prepare() { return { first: async () => ({ ok: 1 }) }; }
    },
    MEDIA: {
      head: async () => { throw new Error("simulated R2 outage"); }
    }
  };
  const response = await worker.fetch(request("/api/health", {
    headers: { Origin: origin }
  }), brokenEnv);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Internal server error." });
});

test("rejects oversized setup secrets and records the failed attempt", async () => {
  const statements = [];
  const setupEnv = {
    ...env,
    SETUP_SECRET: "a-valid-test-secret-for-initialization",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => ({ n: 0 }),
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
  const response = await worker.fetch(new Request("https://api.example.test/api/setup", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.52",
      "Content-Type": "application/json",
      "X-Setup-Secret": "x".repeat(257)
    },
    body: "{}"
  }), setupEnv);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Not authorized." });
  assert.ok(statements.some(({ sql }) => sql.includes("INSERT INTO auth_attempts")));
});

test("unknown usernames receive the same login error and count toward throttling", async () => {
  const statements = [];
  const loginEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => {
                if (sql.includes("FROM auth_attempts")) return { n: 0 };
                if (sql.includes("FROM users")) return null;
                return null;
              },
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
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.53",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ username: "unknown-admin", password: "some-guess" })
  }), loginEnv);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid username or password." });
  assert.ok(statements.some(({ sql }) => sql.includes("INSERT INTO auth_attempts")));
});

test("fails closed for browser origins when ALLOWED_ORIGIN is missing", async () => {
  const unconfiguredEnv = {
    DB: env.DB,
    MEDIA: env.MEDIA
  };
  const preflight = await worker.fetch(request("/api/content", {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.example" }
  }), unconfiguredEnv);
  assert.equal(preflight.status, 403);

  const response = await worker.fetch(request("/api/health", {
    headers: { Origin: "https://untrusted.example" }
  }), unconfiguredEnv);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Origin not allowed." });
});

test("rejects passwords made entirely of whitespace", async () => {
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/member-password", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "l".repeat(64),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ newPassword: " ".repeat(16) })
  }), authenticatedEnv(adminSession));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "The new class upload password must be at least 12 characters and cannot be blank."
  });
});

test("rejects null announcement payloads as client errors", async () => {
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/announcements", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "m".repeat(64),
      "Content-Type": "application/json"
    },
    body: "null"
  }), authenticatedEnv(adminSession));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid request body." });
});

test("rejects malformed multipart upload bodies as client errors", async () => {
  const response = await worker.fetch(new Request("https://api.example.test/api/content", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "n".repeat(64),
      "Content-Type": "multipart/form-data"
    },
    body: "not a valid multipart body"
  }), authenticatedEnv(memberSession));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid upload form." });
});
