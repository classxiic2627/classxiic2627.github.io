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
    body: JSON.stringify({ username: "class-members", password: "definitely-not-the-password" })
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
        const first = async () => sql.includes("FROM auth_attempts") ? { n: 0 } : null;
        return {
          first,
          bind() { return { first, run: async () => ({ success: true, meta: { changes: 0 } }) }; }
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
          bind(...values) {
            return {
              sql, values,
              first:async()=> sql.includes("FROM auth_attempts") ? {n:0} : null,
              run:async()=>{
                statements.push({sql,values});
                return {success:true,meta:{changes:1}};
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
  const insert = statements.find(statement=>statement.sql.includes("INSERT INTO users"));
  assert.ok(insert);
  assert.match(insert.sql,/WHERE NOT EXISTS \(SELECT 1 FROM users\)/);
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

test("successful member login creates a hashed, expiring session", async () => {
  const statements = [];
  const user = {
    id: 7,
    username: "class-members",
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
      "CF-Connecting-IP": "203.0.113.54",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ username: "class-members", password: "class-archive-test-passphrase" })
  }), loginEnv);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.token, /^[0-9a-f]{64}$/);
  assert.equal(data.mustChangePassword, false);
  assert.equal(data.user.role, "member");
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
              run:async()=>{statements.push({sql,values});return {success:true};}
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

test("admin with a temporary password cannot access account management before changing it", async () => {
  const response = await worker.fetch(request("/api/admin/users", {
    headers: {Origin:origin,Authorization:"Bearer " + "o".repeat(64)}
  }), authenticatedEnv({ ...adminSession, must_change_password: 1 }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Change your temporary password before continuing."
  });
});
