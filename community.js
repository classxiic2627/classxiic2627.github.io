/*
 * Community Hub frontend.
 * Set API_BASE to the deployed Cloudflare Worker URL after backend setup.
 * No passwords or privileged credentials belong in this file.
 */
(() => {
  "use strict";
  const API_BASE = ""; // Example: https://class-archive-api.YOUR-SUBDOMAIN.workers.dev
  const $ = (id) => document.getElementById(id);
  let memberToken = "";
  let adminToken = "";
  let vapidPublicKey = "";

  async function api(path, options = {}, token = "") {
    if (!API_BASE) throw new Error("Backend not configured yet. Deploy backend/ and set API_BASE in community.js.");
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", "Bearer " + token);
    if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(API_BASE + path, {...options, headers});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ").");
    return data;
  }
  function status(id, message) { $(id).textContent = message; }
  function b64urlToBytes(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  }

  $("memberLogin").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const data = await api("/api/member/login", {method:"POST", body:JSON.stringify({password:$("memberPassword").value})});
      memberToken = data.token;
      $("uploadForm").hidden = false;
      $("memberLogin").hidden = true;
      $("memberPassword").value = "";
      status("memberStatus", "Unlocked. Your post will publish immediately.");
    } catch (err) { status("memberStatus", err.message); }
  });
  $("memberLogout").addEventListener("click", () => {
    memberToken = ""; $("uploadForm").hidden = true; $("memberLogin").hidden = false;
    $("uploadForm").reset(); status("memberStatus", "Upload form locked.");
  });
  $("uploadForm").addEventListener("submit", async e => {
    e.preventDefault();
    const file = $("uploadMedia").files[0];
    if (file && file.size > 15 * 1024 * 1024) { status("memberStatus", "Media must be 15 MB or smaller."); return; }
    const form = new FormData();
    form.set("type", $("uploadType").value); form.set("title", $("uploadTitle").value.trim());
    form.set("caption", $("uploadCaption").value.trim()); if (file) form.set("media", file);
    try {
      await api("/api/content", {method:"POST", body:form}, memberToken);
      $("uploadForm").reset(); status("memberStatus", "Published successfully. Subscribers will be notified if push is configured.");
    } catch (err) { status("memberStatus", err.message); }
  });
  $("adminLogin").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const data = await api("/api/admin/login", {method:"POST", body:JSON.stringify({password:$("adminPassword").value})});
      adminToken = data.token; $("adminArea").hidden = false; $("adminLogin").hidden = true; $("adminPassword").value = "";
      await refreshAdmin(); status("adminStatus", "Signed in as admin.");
    } catch (err) { status("adminStatus", err.message); }
  });
  async function refreshAdmin() {
    const data = await api("/api/admin/content", {}, adminToken);
    $("adminItems").replaceChildren();
    for (const item of data.items || []) {
      const row = document.createElement("div"); row.className = "status";
      const title = document.createElement("strong"); title.textContent = item.title || "(untitled)";
      const meta = document.createElement("p"); meta.textContent = item.type + " · " + new Date(item.createdAt).toLocaleString();
      const del = document.createElement("button"); del.textContent = "Delete"; del.className = "secondary";
      del.addEventListener("click", async () => {
        if (!confirm("Permanently delete this item?")) return;
        try { await api("/api/admin/content/" + encodeURIComponent(item.id), {method:"DELETE"}, adminToken); await refreshAdmin(); }
        catch (err) { status("adminStatus", err.message); }
      });
      row.append(title, meta, del); $("adminItems").append(row);
    }
    if (!(data.items || []).length) $("adminItems").textContent = "No published items yet.";
  }
  $("announcementForm").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      await api("/api/admin/announcements", {method:"POST", body:JSON.stringify({title:$("announcementTitle").value.trim(), body:$("announcementBody").value.trim()})}, adminToken);
      $("announcementForm").reset(); status("adminStatus", "Announcement published. Push delivery depends on configured subscriptions.");
    } catch (err) { status("adminStatus", err.message); }
  });
  $("adminLogout").addEventListener("click", () => {
    adminToken = ""; $("adminArea").hidden = true; $("adminLogin").hidden = false;
    status("adminStatus", "Signed out.");
  });
  $("subscribeButton").addEventListener("click", async () => {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser does not support web push.");
      const config = await api("/api/push/public-key");
      vapidPublicKey = config.publicKey;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      const registration = await navigator.serviceWorker.register("sw.js");
      const subscription = await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:b64urlToBytes(vapidPublicKey)});
      await api("/api/push/subscribe", {method:"POST", body:JSON.stringify(subscription.toJSON())});
      status("pushStatus", "This device is subscribed to class notifications.");
    } catch (err) { status("pushStatus", err.message); }
  });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();