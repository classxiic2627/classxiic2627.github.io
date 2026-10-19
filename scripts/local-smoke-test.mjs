import { randomUUID } from "node:crypto";

const base = process.env.LOCAL_API_URL || "http://127.0.0.1:8787";
const setupSecret = process.env.LOCAL_SETUP_SECRET;
const adminUsername = process.env.LOCAL_ADMIN_USERNAME;
const adminEmail = process.env.LOCAL_ADMIN_EMAIL;
const adminPassword = process.env.LOCAL_ADMIN_PASSWORD;
let cleanupAdminToken = null;
let cleanupMemberId = null;

const parsedBase = new URL(base);
if (parsedBase.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsedBase.hostname) ||
    parsedBase.port !== "8787" ||
    parsedBase.username || parsedBase.password) {
  throw new Error("Safety stop: LOCAL_API_URL must point to http://127.0.0.1:8787 (the isolated local Worker).");
}
for (const [name, value] of Object.entries({
  LOCAL_SETUP_SECRET: setupSecret,
  LOCAL_ADMIN_USERNAME: adminUsername,
  LOCAL_ADMIN_EMAIL: adminEmail,
  LOCAL_ADMIN_PASSWORD: adminPassword
})) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing required environment variable: " + name);
}
if (setupSecret.length < 16) throw new Error("LOCAL_SETUP_SECRET must be at least 16 characters.");
if (adminPassword.length < 12) throw new Error("LOCAL_ADMIN_PASSWORD must be at least 12 characters.");

async function api(path, { method = "GET", token, body, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Origin", "http://127.0.0.1:8000");
  if (token) requestHeaders.set("Authorization", "Bearer " + token);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  const response = await fetch(new URL(path, base), {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const setup = await api("/api/setup", {
    method: "POST",
    headers: { "X-Setup-Secret": setupSecret },
    body: {
      adminUsername,
      adminEmail,
      adminDisplayName: "Local Smoke Test Admin",
      adminPassword
    }
  });
  if (setup.response.status === 201) {
    console.log("PASS: first-admin setup created the local admin.");
  } else if (setup.response.status === 409) {
    console.log("INFO: local setup was already completed; checking the existing admin login.");
  } else {
    throw new Error("Admin setup failed (HTTP " + setup.response.status + "): " + (setup.data.error || "unknown error"));
  }

  const adminLogin = await api("/api/admin/login", {
    method: "POST",
    body: { username: adminUsername, password: adminPassword }
  });
  assert(adminLogin.response.status === 200 && typeof adminLogin.data.token === "string",
    "Admin login failed (HTTP " + adminLogin.response.status + ").");
  const adminToken = adminLogin.data.token;
  cleanupAdminToken = adminToken;
  console.log("PASS: admin login.");

  const suffix = Date.now().toString(36) + "-" + randomUUID().slice(0, 8);
  const temporaryPassword = "LocalTemp-" + randomUUID() + "!";
  const permanentPassword = "LocalPermanent-" + randomUUID() + "!";
  const username = "local.student." + suffix;
  const email = "local.student." + suffix + "@example.test";
  const created = await api("/api/admin/users", {
    method: "POST",
    token: adminToken,
    body: { username, email, displayName: "Local Smoke Student", temporaryPassword }
  });
  assert(created.response.status === 201 && Number.isSafeInteger(Number(created.data.id)) && Number(created.data.id) > 0,
    "Admin could not create a student account (HTTP " + created.response.status + ").");
  const memberId = Number(created.data.id);
  cleanupMemberId = memberId;
  console.log("PASS: admin created a student account.");

  const memberLogin = await api("/api/member/login", {
    method: "POST",
    body: { username, password: temporaryPassword }
  });
  assert(memberLogin.response.status === 200 && memberLogin.data.mustChangePassword === true,
    "Temporary-password member login failed or did not enforce the password-change gate.");
  console.log("PASS: student login requires a password change.");

  const changed = await api("/api/account/password", {
    method: "POST",
    token: memberLogin.data.token,
    body: { currentPassword: temporaryPassword, newPassword: permanentPassword }
  });
  assert(changed.response.status === 200, "Student password change failed (HTTP " + changed.response.status + ").");
  console.log("PASS: student changed the temporary password.");

  const relogin = await api("/api/member/login", {
    method: "POST",
    body: { username, password: permanentPassword }
  });
  assert(relogin.response.status === 200 && relogin.data.mustChangePassword === false,
    "Student could not sign in with the new password.");
  console.log("PASS: student can sign in with the new password.");

  const oldPassword = await api("/api/member/login", {
    method: "POST",
    body: { username, password: temporaryPassword }
  });
  assert(oldPassword.response.status === 401, "The old temporary password was not rejected.");

  if (process.env.LOCAL_VERIFY_DRIVE === "1") {
    let uploadedItemId = null;
    let driveCleanupFailure = "";
    try {
      const form = new FormData();
      form.set("type", "image");
      form.set("title", "Temporary local Drive smoke test");
      form.set("caption", "This item should be deleted by the smoke test.");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=", "base64");
      form.set("media", new Blob([png], { type: "image/png" }), "local-smoke-test.png");
      const uploadResponse = await fetch(new URL("/api/content", base), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + relogin.data.token,
          Origin: "http://127.0.0.1:8000"
        },
        body: form
      });
      const upload = await uploadResponse.json().catch(() => ({}));
      assert(uploadResponse.status === 201 && typeof upload.id === "string",
        "Real Google Drive upload failed (HTTP " + uploadResponse.status + "): " + (upload.error || "unknown error"));
      uploadedItemId = upload.id;
      console.log("PASS: real Google Drive upload.");

      const listed = await api("/api/content");
      assert(listed.response.status === 200 && listed.data.items?.some(item => item.id === uploadedItemId),
        "Uploaded Drive item was not returned by the content listing.");
      const mediaResponse = await fetch(new URL("/api/media/" + encodeURIComponent(uploadedItemId), base), {
        headers: { Origin: "http://127.0.0.1:8000" }
      });
      const mediaBytes = new Uint8Array(await mediaResponse.arrayBuffer());
      assert(mediaResponse.status === 200 && mediaResponse.headers.get("content-type") === "image/png" &&
        mediaBytes.length === png.length && mediaBytes.every((byte, index) => byte === png[index]),
        "Real Google Drive read-back did not match the uploaded PNG.");
      console.log("PASS: real Google Drive read-back matches uploaded bytes.");
    } finally {
      // Always attempt cleanup, even when upload verification or read-back fails.
      if (uploadedItemId) {
        try {
          const deletedMedia = await api("/api/admin/content/" + encodeURIComponent(uploadedItemId), {
            method: "DELETE", token: adminToken
          });
          if (deletedMedia.response.status === 200) {
            console.log("PASS: real Google Drive deletion.");
          } else {
            driveCleanupFailure = "Could not clean up Drive smoke-test item " + uploadedItemId +
              " (HTTP " + deletedMedia.response.status + "). Remove it manually from the dedicated test folder.";
            console.error("WARNING: " + driveCleanupFailure);
          }
        } catch (cleanupError) {
          driveCleanupFailure = "Drive smoke-test cleanup failed for item " + uploadedItemId +
            "; remove it manually from the dedicated test folder. " + String(cleanupError);
          console.error("WARNING: " + driveCleanupFailure);
        }
      }
    }
    if (driveCleanupFailure) throw new Error(driveCleanupFailure);
  } else {
    console.log("INFO: skipped real Drive test; set LOCAL_VERIFY_DRIVE=1 to opt in.");
  }

  const disabled = await api("/api/admin/users/" + memberId + "/status", {
    method: "POST",
    token: adminToken,
    body: { disabled: true }
  });
  assert(disabled.response.status === 200, "Could not disable the smoke-test account for cleanup.");
  cleanupMemberId = null;
  console.log("PASS: old temporary password rejected; smoke-test account disabled.");
  console.log("LOCAL ACCOUNT FLOW VERIFIED.");
}

main().catch(async error => {
  console.error("LOCAL SMOKE TEST FAILED:", error.message);
  // Do not leave a generated member enabled if an assertion fails mid-flow.
  if (cleanupAdminToken && cleanupMemberId) {
    try {
      const cleanup = await api("/api/admin/users/" + cleanupMemberId + "/status", {
        method: "POST",
        token: cleanupAdminToken,
        body: { disabled: true }
      });
      if (cleanup.response.status === 200) {
        console.log("CLEANUP: disabled the generated smoke-test account after failure.");
      } else {
        console.error("CLEANUP WARNING: could not disable generated account (HTTP " + cleanup.response.status + ").");
      }
    } catch (cleanupError) {
      console.error("CLEANUP WARNING: generated account may remain enabled:", cleanupError.message);
    }
  }
  process.exitCode = 1;
});
