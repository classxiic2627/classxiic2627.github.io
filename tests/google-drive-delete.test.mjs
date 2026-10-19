import test from "node:test";
import assert from "node:assert/strict";
import worker from "../backend/worker.js";

const origin = "https://classxiic2627.github.io";
let sequence = 0;

function setup({ driveStatus = 204, role = "admin" } = {}) {
  sequence += 1;
  const order = [];
  let d1DeleteCount = 0;
  const env = {
    ALLOWED_ORIGIN: origin,
    GOOGLE_CLIENT_ID: `delete-test-${sequence}.apps.googleusercontent.com`,
    GOOGLE_CLIENT_SECRET: `fake-secret-${sequence}`,
    GOOGLE_REFRESH_TOKEN: `fake-refresh-${sequence}`,
    GOOGLE_DRIVE_FOLDER_ID: "folder_test-123",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => {
                if (sql.includes("FROM sessions s JOIN users")) {
                  return {
                    id: 1, username: role === "admin" ? "admin" : "member", display_name: role === "admin" ? "Admin" : "Member", role,
                    disabled: 0, must_change_password: 0,
                    expires_at: Math.floor(Date.now() / 1000) + 3600
                  };
                }
                if (sql.includes("SELECT media_key FROM content")) return { media_key: "drive-file-delete1" };
                return null;
              },
              run: async () => {
                if (sql.includes("DELETE FROM content")) {
                  d1DeleteCount += 1;
                  order.push("d1-delete");
                }
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }
    },
    __googleFetch: async (url, options = {}) => {
      const target = String(url);
      if (target === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "fake-delete-access-token", expires_in: 3600 }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }
      assert.equal(target, "https://www.googleapis.com/drive/v3/files/drive-file-delete1");
      assert.equal(options.method, "DELETE");
      assert.equal(options.headers.Authorization, "Bearer fake-delete-access-token");
      order.push("drive-delete");
      return driveStatus === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ error: "sensitive provider detail" }), { status: driveStatus });
    }
  };
  return { env, order, get d1DeleteCount() { return d1DeleteCount; } };
}

function deleteRequest() {
  return new Request("https://api.example.test/api/admin/content/item-delete1", {
    method: "DELETE",
    headers: { Authorization: "Bearer admin-session-token", Origin: origin }
  });
}

test("admin deletion removes the Drive file before deleting its D1 metadata", async () => {
  const state = setup();
  const response = await worker.fetch(deleteRequest(), state.env);
  assert.equal(response.status, 200);
  assert.deepEqual(state.order, ["drive-delete", "d1-delete"]);
  assert.equal(state.d1DeleteCount, 1);
});

test("member cannot delete published media through the admin-only route", async () => {
  const state = setup({ role: "member" });
  const response = await worker.fetch(deleteRequest(), state.env);
  assert.equal(response.status, 403);
  assert.deepEqual(state.order, []);
  assert.equal(state.d1DeleteCount, 0);
});

test("Drive deletion failure preserves D1 metadata so an administrator can retry", async () => {
  const state = setup({ driveStatus: 503 });
  const response = await worker.fetch(deleteRequest(), state.env);
  assert.equal(response.status, 503);
  assert.deepEqual(state.order, ["drive-delete"]);
  assert.equal(state.d1DeleteCount, 0);
  assert.doesNotMatch(await response.text(), /sensitive provider detail|fake-delete-access-token/);
});
