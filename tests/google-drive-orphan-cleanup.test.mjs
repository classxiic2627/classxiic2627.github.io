import test from "node:test";
import assert from "node:assert/strict";
import worker from "../backend/worker.js";

const origin = "https://classxiic2627.github.io";

test("D1 insert and Drive cleanup failure emit a sanitized orphan-reconciliation signal", async () => {
  let contentId = null;
  const logs = [];
  const env = {
    ALLOWED_ORIGIN: origin,
    GOOGLE_CLIENT_ID: "orphan-test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fake-client-secret",
    GOOGLE_REFRESH_TOKEN: "fake-refresh-token",
    GOOGLE_DRIVE_FOLDER_ID: "folder_test-123",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => sql.includes("FROM sessions s JOIN users")
                ? {
                    id: 7, username: "student", display_name: "Student", role: "member",
                    disabled: 0, must_change_password: 0,
                    expires_at: Math.floor(Date.now() / 1000) + 3600
                  }
                : null,
              run: async () => {
                if (sql.includes("INSERT INTO content")) {
                  contentId = values[0];
                  throw new Error("simulated D1 insert failure");
                }
                return { meta: { changes: 1, last_row_id: 1 } };
              },
              all: async () => ({ results: [] })
            };
          },
          first: async () => null,
          run: async () => ({ meta: { changes: 1, last_row_id: 1 } }),
          all: async () => ({ results: [] })
        };
      }
    },
    __googleFetch: async (input, options = {}) => {
      const target = String(input);
      if (target === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({
          access_token: "fake-test-access-token",
          expires_in: 3600
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      assert.equal(options.headers.Authorization, "Bearer fake-test-access-token");

      if (target.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=")
          && options.method === "POST") {
        return new Response(null, {
          status: 200,
          headers: {
            Location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=orphan-test-session"
          }
        });
      }

      if (target === "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=orphan-test-session") {
        assert.equal(options.method, "PUT");
        const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
        assert.equal(bytes.length, 8);
        return new Response(JSON.stringify({
          id: "drive-orphan-test-123",
          name: "community-test",
          mimeType: "image/png",
          size: 8
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (target === "https://www.googleapis.com/drive/v3/files/drive-orphan-test-123") {
        assert.equal(options.method, "DELETE");
        return new Response(JSON.stringify({
          error: "sensitive provider detail fake-refresh-token"
        }), { status: 503, headers: { "Content-Type": "application/json" } });
      }

      throw new Error("Unexpected provider request: " + target);
    }
  };

  const form = new FormData();
  form.set("type", "image");
  form.set("title", "Orphan cleanup test");
  form.set("caption", "Failure injection");
  form.set("media", new File([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ], "tiny.png", { type: "image/png" }));

  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  let response;
  try {
    response = await worker.fetch(new Request("https://api.example.test/api/content", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-session-token",
        Origin: origin
      },
      body: form
    }), env);
  } finally {
    console.error = originalError;
  }

  assert.equal(response.status, 500);
  assert.equal(await response.text(), JSON.stringify({ error: "Internal server error." }));
  assert.ok(contentId, "the attempted D1 content ID should be captured");
  const signal = logs.find(args => args[0] === "Community media orphan cleanup required");
  assert.ok(signal, "cleanup failure should emit a reconciliation signal");
  assert.deepEqual(signal[1], {
    event: "drive_orphan_cleanup_failed",
    itemId: contentId,
    driveFileId: "drive-orphan-test-123"
  });
  assert.doesNotMatch(JSON.stringify(signal), /sensitive provider detail|fake-refresh-token|fake-client-secret|fake-test-access-token/);
});
