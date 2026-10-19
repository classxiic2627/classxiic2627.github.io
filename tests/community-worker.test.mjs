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
  assert.deepEqual(await response.json(), { error: "Server storage is not configured." });
});
