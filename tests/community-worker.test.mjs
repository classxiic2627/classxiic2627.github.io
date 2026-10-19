import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import worker from "../backend/worker.js";

const origin = "https://classxiic2627.github.io";
const driveFolderId = "drive-folder-test";
function makeGoogleFetch(overrides = {}) {
  let uploadCount = 0;
  const pendingUploads = new Map();
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    if (url.href === "https://oauth2.googleapis.com/token") {
      if (overrides.onToken) return overrides.onToken({url,init});
      return Response.json({access_token:"test-drive-access-token",expires_in:3600});
    }
    if (url.pathname === "/drive/v3/files/" + driveFolderId && method === "GET") {
      if (overrides.onFolder) return overrides.onFolder({url,init});
      return Response.json({id:driveFolderId,name:"Test uploads",mimeType:"application/vnd.google-apps.folder"});
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "POST" && url.searchParams.get("uploadType") === "resumable") {
      const metadata = JSON.parse(String(init.body));
      uploadCount++;
      const id = overrides.uploadId || ("drive-file-test-" + uploadCount);
      const sessionId = "test-session-" + uploadCount;
      pendingUploads.set(sessionId,{metadata,id});
      if (overrides.onUpload) overrides.onUpload({url,init,metadata,id});
      return new Response(null,{status:200,headers:{Location:"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id="+sessionId}});
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "PUT" && url.searchParams.has("upload_id")) {
      const pending = pendingUploads.get(url.searchParams.get("upload_id"));
      if (!pending) return new Response("Unknown upload session",{status:404});
      const uploaded = await new Response(init.body).arrayBuffer();
      const size = Number(init.headers?.["Content-Length"] || uploaded.byteLength);
      return Response.json({id:pending.id,name:pending.metadata.name,mimeType:pending.metadata.mimeType,size,parents:pending.metadata.parents});
    }
    if (url.pathname.startsWith("/drive/v3/files/") && url.searchParams.get("alt") === "media" && method === "GET") {
      if (overrides.onDownload) return overrides.onDownload({url,init});
      return new Response(new Uint8Array([137,80,78,71,13,10,26,10]), {status:200});
    }
    if (url.pathname.startsWith("/drive/v3/files/") && method === "DELETE") {
      if (overrides.onDelete) return overrides.onDelete({url,init});
      return new Response(null,{status:204});
    }
    if (overrides.fetch) return overrides.fetch({url,init});
    return new Response(JSON.stringify({error:"Unexpected fake Google API request."}),{status:404,headers:{"Content-Type":"application/json"}});
  };
}
const env = {
  ALLOWED_ORIGIN: origin,
  GOOGLE_CLIENT_ID: "test-oauth-client-id",
  GOOGLE_CLIENT_SECRET: "test-oauth-client-secret",
  GOOGLE_REFRESH_TOKEN: "test-refresh-token",
  GOOGLE_DRIVE_FOLDER_ID: driveFolderId,
  __googleFetch: makeGoogleFetch(),
  DB: {
    prepare() {
      return { first: async () => ({ ok: 1 }) };
    }
  }
};

function request(path, { method = "GET", headers = {} } = {}) {
  return new Request("https://api.example.test" + path, {
    method,
    headers: new Headers(headers)
  });
}

test("service-worker notification clicks reject off-origin and malformed URLs", async () => {
  const handlers = new Map();
  const navigated = [];
  const focused = [];
  const archiveOrigin = "https://classxiic2627.github.io";
  const lookalikeClient = {
    url: archiveOrigin + ".attacker.example/community.html",
    navigate: async url => { navigated.push({ client: "lookalike", url }); },
    focus: async () => { focused.push("lookalike"); }
  };
  const client = {
    url: archiveOrigin + "/community.html",
    navigate: async url => { navigated.push({ client: "archive", url }); },
    focus: async () => { focused.push("archive"); }
  };
  const self = {
    location: { origin: archiveOrigin },
    addEventListener: (name, handler) => handlers.set(name, handler)
  };
  const clients = {
    matchAll: async () => [lookalikeClient, client],
    openWindow: async url => { navigated.push({ client: "new-window", url }); }
  };
  runInNewContext(readFileSync(new URL("../sw.js", import.meta.url), "utf8"), { self, clients, URL });
  let closedCount = 0;
  for (const url of ["https://attacker.example/phishing", "http://[invalid"]) {
    let completion;
    handlers.get("notificationclick")({
      notification: { data: { url }, close() { closedCount++; } },
      waitUntil(promise) { completion = promise; }
    });
    await completion;
  }
  assert.equal(closedCount, 2);
  assert.deepEqual(navigated, [
    { client: "archive", url: archiveOrigin + "/" },
    { client: "archive", url: archiveOrigin + "/" }
  ]);
  assert.deepEqual(focused, ["archive", "archive"]);
});

test("admin readiness uses server-side Google OAuth credentials without exposing them", async () => {
  let tokenForm = null;
  const oauthEnv = {
    ...authenticatedEnv(adminSession),
    GOOGLE_CLIENT_ID: "unique-oauth-client-for-token-test",
    GOOGLE_CLIENT_SECRET: "unique-client-secret-test",
    GOOGLE_REFRESH_TOKEN: "unique-refresh-token-test",
    __googleFetch: makeGoogleFetch({onToken:({init})=>{
      tokenForm = new URLSearchParams(init.body);
      return Response.json({access_token:"private-test-access-token",expires_in:3600});
    }})
  };
  const response = await worker.fetch(request("/api/admin/health", {headers:{
    Origin:origin, Authorization:"Bearer " + "a".repeat(64)
  }}),oauthEnv);
  assert.equal(response.status,200);
  assert.equal(tokenForm.get("grant_type"),"refresh_token");
  assert.equal(tokenForm.get("client_id"),oauthEnv.GOOGLE_CLIENT_ID);
  assert.equal(tokenForm.get("client_secret"),oauthEnv.GOOGLE_CLIENT_SECRET);
  assert.equal(tokenForm.get("refresh_token"),oauthEnv.GOOGLE_REFRESH_TOKEN);
  const body = JSON.stringify(await response.json());
  assert.doesNotMatch(body,/unique-client-secret-test|unique-refresh-token-test|private-test-access-token/);
});
test("public liveness is non-cacheable and does not touch D1 or Google Drive", async () => {
  let providerCalls = 0;
  const response = await worker.fetch(request("/api/health", {
    headers: { Origin: origin }
  }), {
    ALLOWED_ORIGIN: origin,
    __googleFetch: async () => { providerCalls++; throw new Error("public liveness must not call providers"); },
    DB: { prepare() { throw new Error("public liveness must not query D1"); } }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.deepEqual(await response.json(), {ok:true,service:"class-archive-api"});
  assert.equal(providerCalls, 0);
});

test("member sessions cannot access detailed admin readiness", async () => {
  const response = await worker.fetch(request("/api/admin/health", {
    headers: {Origin:origin,Authorization:"Bearer " + "m".repeat(64)}
  }), authenticatedEnv(memberSession));
  assert.equal(response.status,403);
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

test("one-time setup secret is intentionally excluded from browser CORS preflight", async () => {
  const response = await worker.fetch(request("/api/setup", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-setup-secret"
    }
  }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  const allowedHeaders = response.headers.get("access-control-allow-headers");
  assert.equal(allowedHeaders, "Authorization, Content-Type");
  assert.doesNotMatch(allowedHeaders, /X-Setup-Secret/i);
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

test("public liveness remains available when dependency bindings are absent", async () => {
  const response = await worker.fetch(request("/api/health"), {ALLOWED_ORIGIN:origin});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,service:"class-archive-api"});
});

function authenticatedEnv(user) {
  return {
    ...env,
    DB: {
      prepare(sql) {
        return {
          first: async () => ({ ok: 1 }),
          bind() {
            return {
              first: async () => user,
              run: async () => {
                if (sql.includes("INSERT INTO auth_attempts")) return { success: true, meta: { changes: 1, last_row_id: 900 } };
                if (sql.includes("DELETE FROM auth_attempts")) return { success: true, meta: { changes: 1, last_row_id: 900 } };
                return { success: true };
              }
            };
          }
        };
      }
    }
  };
}

const memberSession = {
  id: 7,
  username: "alice.student",
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

test("admin account list returns only member records with boolean status flags", async () => {
  const accountEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {sql,values,first:async()=>adminSession};
          },
          all:async()=>({results:[{
            id:42,username:"alice",email:"alice@example.test",displayName:"Alice",role:"member",
            disabled:1,mustChangePassword:1,createdAt:"2026-10-19T00:00:00.000Z"
          }]})
        };
      }
    }
  };
  const response = await worker.fetch(request("/api/admin/users", {
    headers:{Origin:origin,Authorization:"Bearer " + "m".repeat(64)}
  }),accountEnv);
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.items.length,1);
  assert.equal(data.items[0].username,"alice");
  assert.equal(data.items[0].disabled,true);
  assert.equal(data.items[0].mustChangePassword,true);
});

test("invalid member email is rejected before inserting an account", async () => {
  let inserted=false;
  const accountEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first:async()=>adminSession,
              run:async()=>{if(sql.includes("INSERT INTO users"))inserted=true;return {success:true,meta:{changes:1}};}
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/users", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "n".repeat(64),"Content-Type":"application/json"},
    body:JSON.stringify({username:"valid-user",email:"not-an-email",displayName:"Valid User",temporaryPassword:"a-valid-temporary-password"})
  }),accountEnv);
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:"Enter a valid email address."});
  assert.equal(inserted,false);
});

test("admin can create an individual member account with normalized unique identity and temporary password", async () => {
  const calls = [];
  const accountEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql, values,
              first: async () => adminSession,
              run: async () => {
                calls.push({sql, values});
                return {success:true,meta:{last_row_id:42,changes:1}};
              }
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/users", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "u".repeat(64),"Content-Type":"application/json"},
    body:JSON.stringify({
      username:"  Alice.Student ",email:" ALICE@Example.Test ",displayName:"Alice Student",
      temporaryPassword:"a-unique-temporary-password"
    })
  }), accountEnv);
  assert.equal(response.status,201);
  assert.equal((await response.json()).id,42);
  const insert = calls.find(call=>call.sql.includes("INSERT INTO users"));
  assert.ok(insert);
  assert.equal(insert.values[0],"alice.student");
  assert.equal(insert.values[1],"alice@example.test");
  assert.equal(insert.values[2],"Alice Student");
  assert.match(insert.values[3],/^.+\$.+$/);
  assert.notEqual(insert.values[3],"a-unique-temporary-password");
  assert.match(insert.sql,/must_change_password,disabled/);
});

test("duplicate normalized member identity is rejected without exposing a database error", async () => {
  const accountEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql, values,
              first: async () => adminSession,
              run: async () => {
                if (sql.includes("INSERT INTO users")) throw new Error("UNIQUE constraint failed: users.email");
                return {success:true,meta:{changes:1}};
              }
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/users", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "x".repeat(64),"Content-Type":"application/json"},
    body:JSON.stringify({
      username:"ALICE.STUDENT",email:"ALICE@EXAMPLE.TEST",displayName:"Alice",
      temporaryPassword:"another-unique-temporary-password"
    })
  }),accountEnv);
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:"That username or email is already in use."});
});

test("resetting a member password atomically revokes only that member's sessions", async () => {
  let statements = [];
  const accountEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {sql,values,first:async()=>adminSession,run:async()=>({success:true,meta:{changes:1}})};
          }
        };
      },
      async batch(items) {
        statements = items;
        return [{success:true,meta:{changes:1}},{success:true,meta:{changes:1}}];
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/users/42/reset-password", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "y".repeat(64),"Content-Type":"application/json"},
    body:JSON.stringify({temporaryPassword:"reset-to-a-new-temporary-password"})
  }),accountEnv);
  assert.equal(response.status,200);
  assert.equal(statements.length,2);
  assert.match(statements[0].sql,/UPDATE users SET password_hash=.*must_change_password=1/);
  assert.match(statements[1].sql,/DELETE FROM sessions WHERE user_id=.*EXISTS \(SELECT 1 FROM users WHERE id=.*role='member'/);
  assert.deepEqual(statements[1].values,[42,42]);
});

test("member accounts cannot access the admin account-management API", async () => {
  const response = await worker.fetch(request("/api/admin/users", {
    headers:{Origin:origin,Authorization:"Bearer " + "v".repeat(64)}
  }), authenticatedEnv(memberSession));
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:"You do not have permission to do that."});
});

test("admin profile updates normalize username/email and target member accounts only", async () => {
  const statements = [];
  const accountEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql,values,
              first:async()=>adminSession,
              run:async()=>{statements.push({sql,values});return {success:true,meta:{changes:1}};}
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/users/42/update", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "z".repeat(64),"Content-Type":"application/json"},
    body:JSON.stringify({username:"New.Student",email:"NEW@EXAMPLE.TEST",displayName:"New Student"})
  }),accountEnv);
  assert.equal(response.status,200);
  const update=statements.find(item=>item.sql.includes("UPDATE users SET username"));
  assert.ok(update);
  assert.deepEqual(update.values.slice(0,3),["new.student","new@example.test","New Student"]);
  assert.match(update.sql,/WHERE id=\? AND role='member'/);
});

test("session revocation requires a member target and deletes that user's sessions", async () => {
  const statements = [];
  const accountEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql,values,
              first:async()=>sql.includes("FROM sessions") ? adminSession : {id:42},
              run:async()=>{statements.push({sql,values});return {success:true,meta:{changes:1}};}
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/users/42/revoke-sessions", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "q".repeat(64),"Content-Type":"application/json"},
    body:"{}"
  }),accountEnv);
  assert.equal(response.status,200);
  assert.ok(statements.some(item=>item.sql.includes("DELETE FROM sessions WHERE user_id=?") && item.values[0]===42));
});

test("disabling a member and revoking their sessions use one atomic D1 batch", async () => {
  let batchStatements = [];
  const accountEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {sql,values,first:async()=>adminSession,run:async()=>({success:true,meta:{changes:1}})};
          }
        };
      },
      async batch(statements) {
        batchStatements = statements;
        return [{success:true,meta:{changes:1}},{success:true,meta:{changes:1}}];
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/users/42/status", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "w".repeat(64),"Content-Type":"application/json"},
    body:JSON.stringify({disabled:true})
  }),accountEnv);
  assert.equal(response.status,200);
  assert.equal(batchStatements.length,2);
  assert.match(batchStatements[0].sql,/UPDATE users SET disabled/);
  assert.match(batchStatements[1].sql,/DELETE FROM sessions WHERE user_id/);
});

test("account management remains available without Google Drive configuration", async () => {
  const accountEnv = {
    ALLOWED_ORIGIN: origin,
    DB: {
      prepare() {
        return {
          bind() { return { first: async () => adminSession }; },
          all: async () => ({ results: [] })
        };
      }
    }
  };
  const response = await worker.fetch(request("/api/admin/users", {
    headers: { Origin: origin, Authorization: "Bearer " + "m".repeat(64) }
  }), accountEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [] });

  const health = await worker.fetch(request("/api/health"), accountEnv);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {ok:true,service:"class-archive-api"});
});

test("upload fails closed with 503 when Google Drive OAuth is not configured", async () => {
  const mediaMissingEnv = { ...authenticatedEnv(memberSession), GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, GOOGLE_REFRESH_TOKEN: undefined };
  const response = await worker.fetch(request("/api/content", {
    method: "POST",
    headers: { Origin: origin, Authorization: "Bearer " + "u".repeat(64) }
  }), mediaMissingEnv);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Internal server error." });
});

test("public registration is not implemented", async () => {
  const response = await worker.fetch(request("/api/register", {
    method:"POST",
    headers:{Origin:origin,"Content-Type":"application/json"}
  }),env);
  assert.equal(response.status,404);
  assert.deepEqual(await response.json(),{error:"Not found."});
});

test("member disable route cannot delete sessions for an administrator ID", async () => {
  let statements = [];
  const accountEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {sql,values,first:async()=>adminSession,run:async()=>({success:true,meta:{changes:1}})};
          }
        };
      },
      async batch(items) {
        statements=items;
        return [{success:true,meta:{changes:0}},{success:true,meta:{changes:0}}];
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/users/8/status", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "r".repeat(64),"Content-Type":"application/json"},
    body:JSON.stringify({disabled:true})
  }),accountEnv);
  assert.equal(response.status,404);
  assert.match(statements[1].sql,/EXISTS \(SELECT 1 FROM users WHERE id=\? AND role='member' AND disabled=1\)/);
  assert.deepEqual(statements[1].values,[8,8]);
});

test("successful admin deletion removes Google Drive media before D1 metadata", async () => {
  const order = [];
  const deleteEnv = {
    ...env,
    __googleFetch: makeGoogleFetch({onDelete:({url})=>{
      assert.equal(url.pathname,"/drive/v3/files/drive-file-delete-in-order");
      order.push("drive-delete");
      return new Response(null,{status:204});
    }}),
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql,values,
              first:async()=>{
                if (sql.includes("FROM sessions s JOIN users")) return adminSession;
                if (sql.includes("SELECT media_key FROM content")) return {media_key:"drive-file-delete-in-order"};
                return null;
              },
              run:async()=>{order.push("d1-delete");return {success:true,meta:{changes:1}};}
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/content/delete-in-order", {
    method:"DELETE",
    headers:{Origin:origin,Authorization:"Bearer " + "e".repeat(64)}
  }),deleteEnv);
  assert.equal(response.status,200);
  assert.deepEqual(order,["drive-delete","d1-delete"]);
});

test("Google Drive delete failure preserves the D1 content row so an admin can retry", async () => {
  const executed = [];
  const deleteEnv = {
    ...env,
    __googleFetch: makeGoogleFetch({onDelete:({url})=>{
      executed.push({mediaDelete:url.pathname.split("/").pop()});
      return new Response("simulated Drive failure",{status:500});
    }}),
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql,values,
              first:async()=>{
                if (sql.includes("FROM sessions s JOIN users")) return adminSession;
                if (sql.includes("SELECT media_key FROM content")) return {media_key:"drive-file-retryable-item"};
                return null;
              },
              run:async()=>{executed.push({sql,values});return {success:true,meta:{changes:1}};}
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/content/retryable-item", {
    method:"DELETE",
    headers:{Origin:origin,Authorization:"Bearer " + "c".repeat(64)}
  }),deleteEnv);
  assert.equal(response.status,503);
  assert.ok(executed.some(item=>item.mediaDelete==="drive-file-retryable-item"));
  assert.equal(executed.some(item=>item.sql?.includes("DELETE FROM content WHERE id=?")),false);
});

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

test("disabled member sessions are rejected and removed", async () => {
  const statements = [];
  const disabledEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql,values,
              first:async()=>({...memberSession,disabled:1}),
              run:async()=>{statements.push({sql,values});return {success:true};}
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(request("/api/content", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "d".repeat(64)}
  }),disabledEnv);
  assert.equal(response.status,401);
  assert.deepEqual(await response.json(),{error:"Session expired. Please sign in again."});
  assert.ok(statements.some(item=>item.sql.includes("DELETE FROM sessions WHERE token_hash=?")));
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
        assert.match(sql, /INSERT INTO auth_attempts/);
        return {
          bind() {
            return { run: async () => ({ success: true, meta: { changes: 0 } }) };
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

test("atomic login reservations throttle concurrent failures before password verification", async () => {
  const reservations = [];
  let nextId = 0;
  let userLookups = 0;
  const loginEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => {
                if (sql.includes("FROM users")) {
                  userLookups++;
                  return null;
                }
                return null;
              },
              run: async () => {
                if (sql.includes("INSERT INTO auth_attempts")) {
                  const keyHash = values[2];
                  const cutoff = values[3];
                  const limit = values[4];
                  const active = reservations.filter(item => item.keyHash === keyHash && item.attemptedAt > cutoff).length;
                  if (active >= limit) return { success: true, meta: { changes: 0 } };
                  const item = { id: ++nextId, keyHash: values[0], attemptedAt: values[1] };
                  reservations.push(item);
                  return { success: true, meta: { changes: 1, last_row_id: item.id } };
                }
                if (sql.includes("DELETE FROM auth_attempts")) {
                  const [attemptId, keyHash] = values;
                  const index = reservations.findIndex(item => item.id === attemptId && item.keyHash === keyHash);
                  if (index >= 0) reservations.splice(index, 1);
                  return { success: true, meta: { changes: index >= 0 ? 1 : 0 } };
                }
                return { success: true, meta: { changes: 1, last_row_id: ++nextId } };
              }
            };
          }
        };
      }
    }
  };
  const responses = await Promise.all(Array.from({ length: 20 }, () => worker.fetch(
    new Request("https://api.example.test/api/member/login", {
      method: "POST",
      headers: {
        Origin: origin,
        "CF-Connecting-IP": "203.0.113.70",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username: "unknown.student", password: "wrong-password" })
    }),
    loginEnv
  )));
  const statuses = responses.map(response => response.status);
  assert.equal(statuses.filter(status => status === 401).length, 10);
  assert.equal(statuses.filter(status => status === 429).length, 10);
  assert.equal(userLookups, 10);
  assert.equal(reservations.length, 20);
});

test("different member accounts behind one shared IP are not locked out by a small set of failures", async () => {
  const reservations = [];
  let nextId = 0;
  let userLookups = 0;
  const loginEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => {
                if (sql.includes("FROM users")) {
                  userLookups++;
                  return null;
                }
                return null;
              },
              run: async () => {
                if (sql.includes("INSERT INTO auth_attempts")) {
                  const keyHash = values[2];
                  const cutoff = values[3];
                  const limit = values[4];
                  const active = reservations.filter(item => item.keyHash === keyHash && item.attemptedAt > cutoff).length;
                  if (active >= limit) return { success: true, meta: { changes: 0 } };
                  const item = { id: ++nextId, keyHash: values[0], attemptedAt: values[1] };
                  reservations.push(item);
                  return { success: true, meta: { changes: 1, last_row_id: item.id } };
                }
                if (sql.includes("DELETE FROM auth_attempts")) {
                  const [attemptId, keyHash] = values;
                  const index = reservations.findIndex(item => item.id === attemptId && item.keyHash === keyHash);
                  if (index >= 0) reservations.splice(index, 1);
                  return { success: true, meta: { changes: index >= 0 ? 1 : 0 } };
                }
                return { success: true, meta: { changes: 1, last_row_id: ++nextId } };
              }
            };
          }
        };
      }
    }
  };
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => worker.fetch(
    new Request("https://api.example.test/api/member/login", {
      method: "POST",
      headers: {
        Origin: origin,
        "CF-Connecting-IP": "203.0.113.71",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username: "student" + String(index).padStart(2, "0"), password: "wrong-password" })
    }),
    loginEnv
  )));
  const statuses = responses.map(response => response.status);
  assert.equal(statuses.filter(status => status === 401).length, 20);
  assert.equal(statuses.filter(status => status === 429).length, 0);
  assert.equal(userLookups, 20);
  assert.equal(reservations.filter(item => item.keyHash === reservations[0]?.keyHash).length, 20);
});

test("per-account login throttling also applies across different source IPs", async () => {
  const reservations = [];
  let nextId = 0;
  let userLookups = 0;
  const loginEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => {
                if (sql.includes("FROM users")) {
                  userLookups++;
                  return null;
                }
                return null;
              },
              run: async () => {
                if (sql.includes("INSERT INTO auth_attempts")) {
                  const keyHash = values[2];
                  const cutoff = values[3];
                  const limit = values[4];
                  const active = reservations.filter(item => item.keyHash === keyHash && item.attemptedAt > cutoff).length;
                  if (active >= limit) return { success: true, meta: { changes: 0 } };
                  const item = { id: ++nextId, keyHash: values[0], attemptedAt: values[1] };
                  reservations.push(item);
                  return { success: true, meta: { changes: 1, last_row_id: item.id } };
                }
                if (sql.includes("DELETE FROM auth_attempts")) {
                  const [attemptId, keyHash] = values;
                  const index = reservations.findIndex(item => item.id === attemptId && item.keyHash === keyHash);
                  if (index >= 0) reservations.splice(index, 1);
                  return { success: true, meta: { changes: index >= 0 ? 1 : 0 } };
                }
                return { success: true, meta: { changes: 1, last_row_id: ++nextId } };
              }
            };
          }
        };
      }
    }
  };
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => worker.fetch(
    new Request("https://api.example.test/api/member/login", {
      method: "POST",
      headers: {
        Origin: origin,
        "CF-Connecting-IP": "198.51.100." + (index + 1),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username: "same.student", password: "wrong-password" })
    }),
    loginEnv
  )));
  const statuses = responses.map(response => response.status);
  assert.equal(statuses.filter(status => status === 401).length, 10);
  assert.equal(statuses.filter(status => status === 429).length, 10);
  assert.equal(userLookups, 10);
  assert.equal(reservations.length, 20);
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
    username: "alice.student",
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
                return { success: true, meta: { changes: 1, last_row_id: 901 } };
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
    body: JSON.stringify({ username: "alice.student", password: "definitely-not-the-password" })
  }), loginEnv);
  assert.equal(response.status, 401);
  assert.ok(statements.some(({ sql }) => sql.includes("INSERT INTO auth_attempts")));
});

test("rejects null login payloads as client errors", async () => {
  const loginEnv = {
    ...env,
    DB: {
      prepare(sql) {
        assert.match(sql, /INSERT INTO auth_attempts/);
        return {
          bind() {
            return { run: async () => ({ success: true, meta: { changes: 1, last_row_id: 902 } }) };
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
        assert.match(sql, /INSERT INTO auth_attempts/);
        return {
          bind() {
            return { run: async () => ({ success: true, meta: { changes: 0 } }) };
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

test("valid setup-secret retries after initialization remain throttled without rehashing passwords", async () => {
  const reservations = [];
  let nextId = 0;
  let userInsertAttempts = 0;
  const setupSecret = "a-long-random-setup-secret-for-testing";
  const setupEnv = {
    ...env,
    SETUP_SECRET: setupSecret,
    DB: {
      prepare(sql) {
        return {
          first: async () => sql.includes("SELECT 1 AS present FROM users LIMIT 1") ? { present: 1 } : null,
          bind(...values) {
            return {
              first: async () => sql.includes("SELECT 1 AS present FROM users LIMIT 1") ? { present: 1 } : null,
              run: async () => {
                if (sql.includes("INSERT INTO auth_attempts")) {
                  const keyHash = values[2];
                  const cutoff = values[3];
                  const limit = values[4];
                  const active = reservations.filter(item => item.keyHash === keyHash && item.attemptedAt > cutoff).length;
                  if (active >= limit) return { success: true, meta: { changes: 0 } };
                  const item = { id: ++nextId, keyHash: values[0], attemptedAt: values[1] };
                  reservations.push(item);
                  return { success: true, meta: { changes: 1, last_row_id: item.id } };
                }
                if (sql.includes("INSERT INTO users")) userInsertAttempts++;
                return { success: true, meta: { changes: 0, last_row_id: ++nextId } };
              }
            };
          }
        };
      }
    }
  };

  const responses = [];
  for (let i = 0; i < 11; i++) {
    responses.push(await worker.fetch(new Request("https://api.example.test/api/setup", {
      method: "POST",
      headers: {
        Origin: origin,
        "CF-Connecting-IP": "203.0.113.52",
        "Content-Type": "application/json",
        "X-Setup-Secret": setupSecret
      },
      body: JSON.stringify({ adminUsername: "archive-admin", adminEmail: "admin@example.test", adminPassword: "a-long-test-password-for-admin" })
    }), setupEnv));
  }
  assert.equal(responses.slice(0, 10).filter(response => response.status === 409).length, 10);
  assert.equal(responses[10].status, 429);
  assert.equal(reservations.length, 10);
  assert.equal(userInsertAttempts, 0, "completed setup should short-circuit before PBKDF2 and insert");
});

test("rejects disallowed upload MIME types before contacting Google Drive", async () => {
  let driveCalls = 0;
  const uploadEnv = {
    ...authenticatedEnv(memberSession),
    __googleFetch: makeGoogleFetch({fetch:()=>{driveCalls++;return new Response("unexpected",{status:500});}})
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
  assert.equal(driveCalls, 0);
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
                return { success: true, meta: { changes: 1, last_row_id: 903 } };
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

test("admin readiness reports a dependency failure when D1 is unreachable", async () => {
  const brokenEnv = {
    ...authenticatedEnv(adminSession),
    DB: {
      prepare() {
        return {
          first: async () => { throw new Error("simulated D1 outage"); },
          bind() { return { first: async () => adminSession, run: async () => ({meta:{changes:1}}) }; }
        };
      }
    }
  };
  const response = await worker.fetch(request("/api/admin/health", {
    headers: {Origin:origin,Authorization:"Bearer " + "a".repeat(64)}
  }), brokenEnv);
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:"Internal server error."});
});

test("admin readiness maps a D1 session-lookup outage to service unavailable", async () => {
  const brokenEnv = {
    ...env,
    DB: {
      prepare() {
        return {
          bind() { return { first: async () => { const error = new Error("simulated D1 session lookup outage"); error.status = 500; throw error; } }; },
          first: async () => ({ok:1})
        };
      }
    }
  };
  const response = await worker.fetch(request("/api/admin/health", {
    headers: {Origin:origin,Authorization:"Bearer " + "a".repeat(64)}
  }), brokenEnv);
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:"Internal server error."});
});

test("throttles password-change verification attempts per authenticated account", async () => {
  const protectedEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              first: async () => sql.includes("FROM sessions") ? adminSession : null,
              run: async () => ({ success: true, meta: { changes: 0 } })
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
              first: async () => sql.includes("FROM sessions") ? adminSession : null,
              run: async () => ({ success: true, meta: { changes: 1, last_row_id: 904 } })
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
                return { success: true, meta: { changes: 1, last_row_id: 905 } };
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
        const first = async () => sql.includes("FROM auth_attempts") ? { n: 0 } : null;
        return {
          first,
          bind() {
            return {
              first,
              run: async () => sql.includes("INSERT INTO auth_attempts") || sql.includes("DELETE FROM auth_attempts")
                ? { success: true, meta: { changes: 1, last_row_id: 906 } }
                : { success: true, meta: { changes: 0 } }
            };
          }
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
    body: JSON.stringify({adminUsername:"archive-admin",adminEmail:"admin@example.test",adminPassword:"a-long-unique-test-password"})
  }), setupEnv);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Setup has already been completed. Rotate the setup secret and remove it when finished."
  });
  assert.equal(batches, 0);
});

test("first-admin setup uses a single conditional insert and requires an email", async () => {
  const statements = [];
  const setupEnv = {
    ...env,
    SETUP_SECRET:"setup-secret-for-this-test-only",
    DB: {
      prepare(sql) {
        return {
          sql,
          first:async()=> null,
          bind(...values) {
            return {
              sql, values,
              first:async()=> sql.includes("FROM auth_attempts") ? {n:0} : null,
              run:async()=>{
                statements.push({sql,values});
                return {success:true,meta:{changes:1,last_row_id:907}};
              }
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/setup", {
    method:"POST",
    headers:{Origin:origin,"CF-Connecting-IP":"203.0.113.59","Content-Type":"application/json","X-Setup-Secret":"setup-secret-for-this-test-only"},
    body:JSON.stringify({adminUsername:"Archive.Admin",adminEmail:"ADMIN@EXAMPLE.TEST",adminPassword:"a-unique-initial-admin-password"})
  }),setupEnv);
  assert.equal(response.status,201);
  const insertIndex = statements.findIndex(statement=>statement.sql.includes("INSERT INTO users"));
  const insert = statements[insertIndex];
  assert.ok(insert);
  assert.match(insert.sql,/WHERE NOT EXISTS \(SELECT 1 FROM users\)/);
  const reservationDeleteIndex = statements.findIndex(statement=>statement.sql.includes("DELETE FROM auth_attempts WHERE id=? AND key_hash=?"));
  assert.ok(reservationDeleteIndex > insertIndex, "successful setup clears its reservation only after the admin insert succeeds");
  assert.equal(insert.values[0],"archive.admin");
  assert.equal(insert.values[1],"admin@example.test");
  assert.equal(insert.values[3],"admin");
});

test("legacy shared-password rotation endpoint is removed", async () => {
  const response = await worker.fetch(new Request("https://api.example.test/api/admin/member-password", {
    method: "POST",
    headers: {Origin:origin,Authorization:"Bearer " + "j".repeat(64),"Content-Type":"application/json"},
    body: JSON.stringify({newPassword:"a-long-test-password-value"})
  }), authenticatedEnv(adminSession));
  assert.equal(response.status, 404);
});

test("admin readiness reports a Google Drive dependency failure", async () => {
  const brokenEnv = {
    ...authenticatedEnv(adminSession),
    __googleFetch: makeGoogleFetch({onFolder:()=>new Response("simulated Drive outage",{status:500})})
  };
  const response = await worker.fetch(request("/api/admin/health", {
    headers: {Origin:origin,Authorization:"Bearer " + "a".repeat(64)}
  }), brokenEnv);
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:"Internal server error."});
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
                return { success: true, meta: { changes: 1, last_row_id: 908 } };
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
                return { success: true, meta: { changes: 1, last_row_id: 909 } };
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
  const response = await worker.fetch(new Request("https://api.example.test/api/account/password", {
    method: "POST",
    headers: {Origin:origin,Authorization:"Bearer " + "l".repeat(64),"Content-Type":"application/json"},
    body: JSON.stringify({currentPassword:"valid-looking-current-password",newPassword:" ".repeat(16)})
  }), authenticatedEnv(adminSession));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Current password must be valid and the new password must be at least 12 non-blank characters."
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

test("rejects oversized JSON bodies when Content-Length is absent", async () => {
  const body = "x".repeat(1024 * 1024 + 1);
  const req = new Request("https://api.example.test/api/member/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.60",
      "Content-Type": "application/json"
    },
    body
  });
  assert.equal(req.headers.get("content-length"), null);
  const jsonEnv = {
    ...env,
    DB: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => ({ n: 0 }),
              run: async () => ({ success: true, meta: { changes: 1, last_row_id: 912 } })
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(req, jsonEnv);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Request body is too large." });
});

test("rejects oversized numeric Content-Length before reading the request body", async () => {
  const req = new Request("https://api.example.test/api/member/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.61",
      "Content-Type": "application/json",
      "Content-Length": String(1024 * 1024 + 1)
    },
    body: "{}"
  });
  const jsonEnv = {
    ...env,
    DB: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => ({ n: 0 }),
              run: async () => ({ success: true, meta: { changes: 1, last_row_id: 913 } })
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(req, jsonEnv);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Request body is too large." });
});

test("keeps the 50 MiB upload cap aligned across Worker, browser, UI, and docs", () => {
  const workerSource = readFileSync(new URL("../backend/worker.js", import.meta.url), "utf8");
  const clientSource = readFileSync(new URL("../community.js", import.meta.url), "utf8");
  const htmlSource = readFileSync(new URL("../community.html", import.meta.url), "utf8");
  const readmeSource = readFileSync(new URL("../backend/README.md", import.meta.url), "utf8");
  assert.match(workerSource, /const MAX_MEDIA_BYTES = 50 \* 1024 \* 1024;/);
  assert.match(workerSource, /const MAX_UPLOAD_REQUEST_BYTES = MAX_MEDIA_BYTES \+ 1024 \* 1024;/);
  assert.match(workerSource, /Upload request exceeds the 50 MB media limit/);
  assert.match(clientSource, /file\.size > 50 \* 1024 \* 1024/);
  assert.match(htmlSource, /Maximum file size: 50 MB/);
  assert.ok(readmeSource.includes("51 MiB (50 MiB media"));
});

test("rejects multipart uploads over the 50 MB limit from declared length before parsing", async () => {
  const req = new Request("https://api.example.test/api/content", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "q".repeat(64),
      "Content-Type": "multipart/form-data; boundary=community-test",
      "Content-Length": String(51 * 1024 * 1024 + 1)
    },
    body: "not parsed because the declared request size exceeds the cap"
  });
  const response = await worker.fetch(req, authenticatedEnv(memberSession));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Upload request exceeds the 50 MB media limit." });
});

test("rejects oversized streamed multipart bodies when Content-Length is absent", async () => {
  const chunk = new Uint8Array(4 * 1024 * 1024);
  let emitted = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (emitted >= 13) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(chunk);
    }
  });
  const req = new Request("https://api.example.test/api/content", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "r".repeat(64),
      "Content-Type": "multipart/form-data; boundary=community-test"
    },
    body,
    duplex: "half"
  });
  assert.equal(req.headers.get("content-length"), null);
  const response = await worker.fetch(req, authenticatedEnv(memberSession));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Upload request exceeds the 50 MB media limit." });
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

test("rejects uploads whose bytes do not match their declared image/video MIME type", async () => {
  const mediaTypes = [
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "video/mp4", "video/webm", "video/ogg"
  ];
  let driveCalls = 0;
  const mediaEnv = {
    ...authenticatedEnv(memberSession),
    __googleFetch: makeGoogleFetch({fetch:()=>{driveCalls++;return new Response("unexpected",{status:500});}})
  };
  for (const mime of mediaTypes) {
    const form = new FormData();
    form.set("type", mime.startsWith("image/") ? "image" : "video");
    form.set("title", "Signature test");
    form.set("caption", "");
    form.set("media", new Blob(["not a valid media signature"], { type: mime }), "spoofed-upload.bin");
    const response = await worker.fetch(new Request("https://api.example.test/api/content", {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: "Bearer " + "s".repeat(64)
      },
      body: form
    }), mediaEnv);
    assert.equal(response.status, 415, mime);
    assert.deepEqual(await response.json(), {
      error: "File contents do not match the selected media type."
    });
  }
  assert.equal(driveCalls, 0);
});

test("accepts a PNG upload with a matching file signature", async () => {
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4J8AAAAASUVORK5CYII=",
    "base64"
  );
  const form = new FormData();
  form.set("type", "image");
  form.set("title", "Valid PNG signature");
  form.set("caption", "");
  form.set("media", new Blob([pngBytes], { type: "image/png" }), "pixel.png");
  let storedDriveId = null;
  const mediaEnv = {
    ...authenticatedEnv(memberSession),
    __googleFetch: makeGoogleFetch({uploadId:"drive-file-png",onUpload:({metadata,id})=>{
      storedDriveId = id;
      assert.equal(metadata.mimeType,"image/png");
      assert.deepEqual(metadata.parents,[driveFolderId]);
    }})
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/content", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "t".repeat(64)
    },
    body: form
  }), mediaEnv);
  assert.equal(response.status, 201);
  assert.equal(storedDriveId, "drive-file-png");
  assert.ok((await response.json()).id);
});

test("allows an authenticated admin account to upload media", async () => {
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4J8AAAAASUVORK5CYII=",
    "base64"
  );
  const form = new FormData();
  form.set("type", "image");
  form.set("title", "Admin upload");
  form.set("caption", "");
  form.set("media", new Blob([pngBytes], { type: "image/png" }), "admin-pixel.png");
  let storedDriveId = null;
  const adminEnv = {
    ...authenticatedEnv(adminSession),
    __googleFetch: makeGoogleFetch({
      uploadId: "drive-file-admin-png",
      onUpload: ({ metadata, id }) => {
        storedDriveId = id;
        assert.equal(metadata.mimeType, "image/png");
        assert.deepEqual(metadata.parents, [driveFolderId]);
      }
    })
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/content", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "a".repeat(64)
    },
    body: form
  }), adminEnv);
  assert.equal(response.status, 201);
  assert.equal(storedDriveId, "drive-file-admin-png");
  assert.ok((await response.json()).id);
});

test("removes an uploaded Google Drive file when D1 metadata insertion fails", async () => {
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4J8AAAAASUVORK5CYII=",
    "base64"
  );
  const form = new FormData();
  form.set("type", "image");
  form.set("title", "Compensation test");
  form.set("caption", "");
  form.set("media", new Blob([pngBytes], { type: "image/png" }), "pixel.png");
  let storedDriveId = null;
  const deletedIds = [];
  const uploadEnv = {
    ...env,
    __googleFetch: makeGoogleFetch({
      uploadId:"drive-file-cleanup",
      onUpload:({id})=>{storedDriveId=id;},
      onDelete:({url})=>{deletedIds.push(url.pathname.split("/").pop());return new Response(null,{status:204});}
    }),
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql,
              values,
              first: async () => sql.includes("FROM sessions s JOIN users") ? memberSession : null,
              run: async () => {
                if (sql.includes("INSERT INTO content")) throw new Error("simulated D1 insert failure");
                return { success: true };
              }
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/content", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer " + "v".repeat(64)
    },
    body: form
  }), uploadEnv);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal server error." });
  assert.equal(storedDriveId, "drive-file-cleanup");
  assert.deepEqual(deletedIds, ["drive-file-cleanup"]);
});

test("media endpoint streams private Google Drive bytes through the Worker", async () => {
  const pngBytes = Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]);
  let requestedFileId = null;
  const mediaEnv = {
    ...env,
    __googleFetch: makeGoogleFetch({onDownload:({url,init})=>{
      requestedFileId = url.pathname.split("/").pop();
      assert.equal(init.headers.Authorization,"Bearer test-drive-access-token");
      return new Response(pngBytes,{status:200,headers:{"Content-Type":"image/png"}});
    }}),
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {first:async()=>sql.includes("FROM content")?{
              media_key:"drive-file-read-test",media_mime:"image/png",media_size:pngBytes.length
            }:null};
          }
        };
      }
    }
  };
  const response = await worker.fetch(request("/api/media/memory-id",{headers:{Origin:origin}}),mediaEnv);
  assert.equal(response.status,200);
  assert.equal(requestedFileId,"drive-file-read-test");
  assert.equal(response.headers.get("content-type"),"image/png");
  assert.equal(response.headers.get("cache-control"),"private, max-age=60");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),pngBytes);
});
test("successful member login creates a hashed, expiring session", async () => {
  const statements = [];
  const user = {
    id: 7,
    username: "alice.student",
    display_name: "Class Members",
    role: "member",
    password_hash: "AAAAAAAAAAAAAAAAAAAAAA==$DGjF6pAtZCrqHycMaLV0VxSi/IV3kuF9nxysUBNVVvs=",
    disabled: 0,
    must_change_password: 0
  };
  const loginEnv = {
    ...env,
    SESSION_TTL_SECONDS: "3600",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => {
                if (sql.includes("FROM auth_attempts")) return { n: 0 };
                if (sql.includes("FROM users")) return user;
                return null;
              },
              run: async () => {
                statements.push({ sql, values });
                return { success: true, meta: { changes: 1, last_row_id: 910 } };
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
      "CF-Connecting-IP": "203.0.113.54",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ username: "alice.student", password: "class-archive-test-passphrase" })
  }), loginEnv);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.token, /^[0-9a-f]{64}$/);
  assert.equal(data.mustChangePassword, false);
  assert.equal(data.user.role, "member");
  const reservationDelete = statements.find(({ sql }) => sql.includes("DELETE FROM auth_attempts WHERE id=? AND key_hash=?"));
  assert.ok(reservationDelete, "successful login should delete only its own throttle reservation");
  assert.equal(statements.some(({ sql }) => sql === "DELETE FROM auth_attempts WHERE key_hash=?"), false);
  const sessionInsert = statements.find(({ sql }) => sql.includes("INSERT INTO sessions"));
  assert.ok(sessionInsert);
  assert.notEqual(sessionInsert.values[0], data.token);
  assert.ok(sessionInsert.values[2] > sessionInsert.values[3]);
});

test("member can replace a temporary password and atomically revoke all sessions", async () => {
  const currentPassword = "temporary-password-for-member";
  const newPassword = "permanent-password-for-member";
  const salt = new Uint8Array(16).fill(23);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(currentPassword), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations:210000},key,256);
  const passwordHash = Buffer.from(salt).toString("base64") + "$" + Buffer.from(bits).toString("base64");
  const statements = [];
  const user = {...memberSession,must_change_password:1};
  const passwordEnv = {
    ...env,
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql,values,
              first:async()=>{
                if (sql.includes("FROM sessions s JOIN users")) return user;
                if (sql.includes("FROM auth_attempts")) return {n:0};
                if (sql.includes("SELECT password_hash FROM users")) return {password_hash:passwordHash};
                return null;
              },
              run:async()=>{statements.push({sql,values});return {success:true,meta:{changes:1,last_row_id:911}};}
            };
          }
        };
      },
      async batch(items) { statements.push(...items.map(item=>({sql:item.sql,values:item.values}))); return items.map(()=>({success:true})); }
    }
  };
  const response = await worker.fetch(new Request("https://api.example.test/api/account/password", {
    method:"POST",
    headers:{Origin:origin,Authorization:"Bearer " + "p".repeat(64),"Content-Type":"application/json"},
    body:JSON.stringify({currentPassword,newPassword})
  }),passwordEnv);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,message:"Password changed. All sessions were revoked; please sign in again."});
  assert.ok(statements.some(item=>item.sql.includes("UPDATE users SET password_hash=?,must_change_password=0")));
  assert.ok(statements.some(item=>item.sql.includes("DELETE FROM sessions WHERE user_id=?")));
});

test("scheduled cleanup removes expired sessions and old auth-attempt rows", async () => {
  const statements = [];
  let waited = null;
  const scheduledEnv = {
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...values) {
            return {
              sql,
              values,
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
  await worker.scheduled({}, scheduledEnv, {
    waitUntil(promise) { waited = promise; }
  });
  assert.ok(waited instanceof Promise);
  await waited;
  assert.equal(statements.length, 2);
  const attempts = statements.find(item => item.sql.includes("DELETE FROM auth_attempts"));
  const sessions = statements.find(item => item.sql.includes("DELETE FROM sessions"));
  assert.ok(attempts);
  assert.ok(sessions);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(attempts.values[0] <= now - 86400);
  assert.ok(sessions.values[0] <= now);
});

test("admin with a temporary password cannot access account management before changing it", async () => {
  const response = await worker.fetch(request("/api/admin/users", {
    headers: {Origin:origin,Authorization:"Bearer " + "o".repeat(64)}
  }), authenticatedEnv({ ...adminSession, must_change_password: 1 }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Change your temporary password before continuing."
  });
});
