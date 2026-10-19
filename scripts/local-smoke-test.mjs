import { randomUUID } from "node:crypto";

const base = process.env.LOCAL_API_URL || "http://127.0.0.1:8787";
const setupSecret = process.env.LOCAL_SETUP_SECRET;
const adminUsername = process.env.LOCAL_ADMIN_USERNAME;
const adminEmail = process.env.LOCAL_ADMIN_EMAIL;
const adminPassword = process.env.LOCAL_ADMIN_PASSWORD;

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
  assert(created.response.status === 201 && Number.isSafeInteger(Number(created.data.id)),
    "Admin could not create a student account (HTTP " + created.response.status + ").");
  const memberId = Number(created.data.id);
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

  const disabled = await api("/api/admin/users/" + memberId + "/status", {
    method: "POST",
    token: adminToken,
    body: { disabled: true }
  });
  assert(disabled.response.status === 200, "Could not disable the smoke-test account for cleanup.");
  console.log("PASS: old temporary password rejected; smoke-test account disabled.");
  console.log("LOCAL D1 ACCOUNT FLOW VERIFIED. This script does not verify real Google Drive upload/read/delete.");
}

main().catch(error => {
  console.error("LOCAL SMOKE TEST FAILED:", error.message);
  process.exitCode = 1;
});
