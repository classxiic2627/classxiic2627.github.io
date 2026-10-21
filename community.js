/* Community Hub frontend. Set API_BASE to the deployed Worker origin before launch. */
(() => {
  "use strict";
  const configuredApiBase = (document.querySelector('meta[name="community-api-base"]')?.content || "").trim().replace(/\/+$/, "");
  const localHosts = new Set(["127.0.0.1"]);
  // Development-only default: the published site host never matches this list,
  // so the public frontend stays disconnected until an approved Worker origin is configured.
  const API_BASE = configuredApiBase || (
    window.location.protocol === "http:" && localHosts.has(window.location.hostname)
      ? "http://127.0.0.1:8787"
      : ""
  );
  const $ = (id) => document.getElementById(id);
  let memberToken = "";
  let adminToken = "";
  let memberMustChangePassword = false;
  let adminMustChangePassword = false;
  const uploadToken = () => {
    if (memberToken && !memberMustChangePassword) return memberToken;
    if (adminToken && !adminMustChangePassword) return adminToken;
    return "";
  };
  const uploadStatusId = () => "memberStatus";
  const syncUploadForm = () => { $("uploadForm").hidden = !uploadToken(); };

  async function api(path, options = {}, token = "") {
    if (!API_BASE) throw new Error("Community API is not configured. Set the community-api-base meta value to the approved Worker URL after staging verification.");
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", "Bearer " + token);
    if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(API_BASE + path, {...options, headers});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ").");
    return data;
  }
  const status = (id, message) => { $(id).textContent = message; };
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  async function loadPublicContent() {
    try {
      const [content, announcements] = await Promise.all([
        api("/api/content"),
        api("/api/announcements")
      ]);
      const grid = $("publicItems");
      grid.replaceChildren();
      for (const item of content.items || []) {
        const card = node("article", undefined, "community-card");
        const mediaUrl = API_BASE + item.mediaUrl;
        const media = node(item.type === "video" ? "video" : "img");
        media.src = mediaUrl;
        if (item.type === "video") { media.controls = true; media.preload = "metadata"; media.playsInline = true; }
        else { media.alt = item.title; media.loading = "lazy"; }
        const body = node("div", undefined, "community-card-body");
        body.append(node("h3", item.title), node("p", item.caption || "A class memory."));
        card.append(media, body);
        grid.append(card);
      }
      if (!grid.children.length) grid.append(node("p", "No community posts yet. Be the first to share a memory."));
      const list = $("announcementList");
      list.replaceChildren();
      for (const item of announcements.items || []) {
        const article = node("article", undefined, "announcement");
        article.append(node("h3", item.title), node("p", item.body), node("small", new Date(item.createdAt).toLocaleString()));
        list.append(article);
      }
      if (!list.children.length) list.append(node("p", "No announcements yet."));
    } catch (error) {
      status("publicStatus", error.message);
    }
  }

  $("memberLogin").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await api("/api/member/login", {method:"POST", body:JSON.stringify({username:$("memberUsername").value.trim(), password:$("memberPassword").value})});
      memberToken = data.token;
      memberMustChangePassword = !!data.mustChangePassword;
      $("memberSessionActions").hidden = false;
      $("memberLogin").hidden = true;
      $("memberUsername").value = "";
      $("memberPassword").value = "";
      syncUploadForm();
      $("memberPasswordChange").hidden = !memberMustChangePassword;
      $("showMemberPasswordChange").hidden = memberMustChangePassword;
      $("cancelMemberPasswordChange").hidden = memberMustChangePassword;
      status("memberStatus", memberMustChangePassword
        ? "Change your temporary password before uploading."
        : "Signed in. Posts are visible to visitors of the class archive.");
    } catch (error) { status("memberStatus", error.message); }
  });
  $("memberLogout").addEventListener("click", async () => {
    try { if (memberToken) await api("/api/logout", {method:"POST"}, memberToken); } catch (_) {}
    memberToken = "";
    memberMustChangePassword = false;
    $("memberSessionActions").hidden = true;
    $("memberPasswordChange").hidden = true;
    $("memberPasswordChange").reset();
    $("showMemberPasswordChange").hidden = false;
    $("cancelMemberPasswordChange").hidden = false;
    syncUploadForm();
    $("memberLogin").hidden = false;
    $("uploadForm").reset();
    status("memberStatus", "Signed out.");
  });
  $("showMemberPasswordChange").addEventListener("click", () => {
    $("memberPasswordChange").hidden = false;
    $("cancelMemberPasswordChange").hidden = false;
  });
  $("cancelMemberPasswordChange").addEventListener("click", () => {
    if (memberMustChangePassword) return;
    $("memberPasswordChange").reset();
    $("memberPasswordChange").hidden = true;
  });
  $("memberPasswordChange").addEventListener("submit", async (event) => {
    event.preventDefault();
    const currentPassword = $("memberCurrentPassword").value;
    const newPassword = $("memberNewPassword").value;
    if (newPassword !== $("memberConfirmPassword").value) {
      status("memberStatus", "The new password and confirmation do not match.");
      return;
    }
    if (newPassword.length < 12) {
      status("memberStatus", "Choose a password with at least 12 characters.");
      return;
    }
    try {
      await api("/api/account/password", {
        method:"POST", body:JSON.stringify({currentPassword,newPassword})
      }, memberToken);
      memberToken = "";
      memberMustChangePassword = false;
      $("memberSessionActions").hidden = true;
      $("memberPasswordChange").reset();
      $("memberPasswordChange").hidden = true;
      syncUploadForm();
      $("memberLogin").hidden = false;
      status("memberStatus", "Password changed and all sessions revoked. Please sign in again.");
    } catch (error) { status("memberStatus", error.message); }
  });
  $("uploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = uploadToken();
    const targetStatus = uploadStatusId();
    if (!token) { status(targetStatus, "Sign in and change your temporary password before uploading."); return; }
    const file = $("uploadMedia").files[0];
    if (!file) { status(targetStatus, "Choose a photo or video first."); return; }
    if (file.size > 50 * 1024 * 1024) { status(targetStatus, "Media must be 50 MiB or smaller."); return; }
    const form = new FormData();
    form.set("type", $("uploadType").value);
    form.set("title", $("uploadTitle").value.trim());
    form.set("caption", $("uploadCaption").value.trim());
    form.set("media", file);
    try {
      await api("/api/content", {method:"POST", body:form}, token);
      $("uploadForm").reset();
      status(targetStatus, "Published. Push notifications are not active yet.");
      await loadPublicContent();
    } catch (error) { status(targetStatus, error.message); }
  });

  $("adminLogin").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await api("/api/admin/login", {method:"POST", body:JSON.stringify({
        username:$("adminUsername").value.trim(),
        password:$("adminPassword").value
      })});
      adminToken = data.token;
      adminMustChangePassword = !!data.mustChangePassword;
      syncUploadForm();
      $("adminSessionActions").hidden = false;
      $("adminLogin").hidden = true;
      $("adminPassword").value = "";
      $("adminPasswordChange").hidden = !adminMustChangePassword;
      $("cancelAdminPasswordChange").hidden = adminMustChangePassword;
      $("adminArea").hidden = adminMustChangePassword;
      if (adminMustChangePassword) {
        status("adminStatus", "For account safety, change the temporary password before using the admin desk.");
      } else {
        await refreshAdmin();
        await refreshAccounts();
        status("adminStatus", "Signed in as administrator.");
      }
    } catch (error) { status("adminStatus", error.message); }
  });
  async function refreshAdmin() {
    const data = await api("/api/admin/content", {}, adminToken);
    const list = $("adminItems");
    list.replaceChildren();
    for (const item of data.items || []) {
      const row = node("div", undefined, "admin-item");
      const info = node("div");
      info.append(node("strong", item.title || "(untitled)"), node("p", item.type + " · " + new Date(item.createdAt).toLocaleString()));
      const del = node("button", "Delete", "button button-danger");
      del.type = "button";
      del.addEventListener("click", async () => {
        if (!confirm("Permanently delete this post and its uploaded media?")) return;
        try {
          await api("/api/admin/content/" + encodeURIComponent(item.id), {method:"DELETE"}, adminToken);
          await refreshAdmin();
          await loadPublicContent();
          status("adminStatus", "Post deleted.");
        } catch (error) {
          status("adminStatus", "Delete did not complete. The item remains in the admin list so you can retry cleanup. " + error.message);
        }
      });
      row.append(info, del);
      list.append(row);
    }
    if (!list.children.length) list.append(node("p", "No published posts yet."));
  }
  $("showAdminPasswordChange").addEventListener("click", () => {
    $("adminPasswordChange").hidden = false;
    $("cancelAdminPasswordChange").hidden = false;
  });
  $("cancelAdminPasswordChange").addEventListener("click", () => {
    if (adminMustChangePassword) return;
    $("adminPasswordChange").reset();
    $("adminPasswordChange").hidden = true;
  });
  $("adminPasswordChange").addEventListener("submit", async (event) => {
    event.preventDefault();
    const currentPassword = $("adminCurrentPassword").value;
    const newPassword = $("adminNewPassword").value;
    if (newPassword !== $("adminConfirmPassword").value) {
      status("adminStatus", "The new password and confirmation do not match.");
      return;
    }
    if (newPassword.length < 12) {
      status("adminStatus", "Choose a password with at least 12 characters.");
      return;
    }
    try {
      await api("/api/account/password", {
        method:"POST",
        body:JSON.stringify({currentPassword, newPassword})
      }, adminToken);
      adminToken = "";
      adminMustChangePassword = false;
      syncUploadForm();
      $("adminSessionActions").hidden = true;
      $("adminPasswordChange").reset();
      $("adminPasswordChange").hidden = true;
      $("adminArea").hidden = true;
      $("adminLogin").hidden = false;
      status("adminStatus", "Password changed. Please sign in again with your new password.");
    } catch (error) { status("adminStatus", error.message); }
  });
  function resetAccountEditor() {
    $("accountForm").reset();
    $("accountId").value = "";
    $("accountTempPasswordLabel").hidden = false;
    $("accountTempPassword").required = true;
    $("accountSaveButton").textContent = "Create student account";
    $("accountCancelEdit").hidden = true;
  }
  async function refreshAccounts() {
    const data = await api("/api/admin/users", {}, adminToken);
    const list = $("accountList");
    list.replaceChildren();
    for (const account of data.items || []) {
      const row = node("div", undefined, "admin-item");
      const info = node("div");
      const state = account.disabled ? "Disabled" : account.mustChangePassword ? "Needs password change" : "Active";
      info.append(node("strong", account.displayName + " (@" + account.username + ")"),
        node("p", account.email + " · " + state));
      const actions = node("div", undefined, "community-actions");
      const edit = node("button", "Edit details", "button button-ghost");
      edit.type = "button";
      edit.addEventListener("click", () => {
        $("accountId").value = String(account.id);
        $("accountUsername").value = account.username;
        $("accountEmail").value = account.email;
        $("accountDisplayName").value = account.displayName;
        $("accountTempPassword").value = "";
        $("accountTempPassword").required = false;
        $("accountTempPasswordLabel").hidden = true;
        $("accountSaveButton").textContent = "Save account details";
        $("accountCancelEdit").hidden = false;
      });
      const toggle = node("button", account.disabled ? "Enable" : "Disable", "button button-ghost");
      toggle.type = "button";
      toggle.addEventListener("click", async () => {
        if (!confirm((account.disabled ? "Re-enable " : "Disable ") + account.username + "?")) return;
        try {
          await api("/api/admin/users/" + account.id + "/status", {
            method:"POST", body:JSON.stringify({disabled:!account.disabled})
          }, adminToken);
          await refreshAccounts();
          status("adminStatus", account.disabled ? "Account enabled." : "Account disabled and sessions revoked.");
        } catch (error) { status("adminStatus", error.message); }
      });
      const reset = node("button", "Reset password", "button button-ghost");
      reset.type = "button";
      reset.addEventListener("click", () => {
        $("accountResetId").value = String(account.id);
        $("accountResetLabel").textContent = "Set a new temporary password for @" + account.username + ". All existing sessions will be revoked.";
        $("accountResetPassword").value = "";
        $("accountResetForm").hidden = false;
      });
      const revoke = node("button", "Sign out everywhere", "button button-ghost");
      revoke.type = "button";
      revoke.addEventListener("click", async () => {
        if (!confirm("Revoke every active session for " + account.username + "?")) return;
        try {
          await api("/api/admin/users/" + account.id + "/revoke-sessions", {method:"POST", body:"{}"}, adminToken);
          status("adminStatus", "All sessions revoked for @" + account.username + ".");
        } catch (error) { status("adminStatus", error.message); }
      });
      actions.append(edit, toggle, reset, revoke);
      row.append(info, actions);
      list.append(row);
    }
    if (!list.children.length) list.append(node("p", "No student accounts have been created yet."));
  }
  $("accountForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const accountId = $("accountId").value;
    const body = {
      username:$("accountUsername").value.trim(),
      email:$("accountEmail").value.trim(),
      displayName:$("accountDisplayName").value.trim()
    };
    const temporaryPassword = $("accountTempPassword").value;
    if (!accountId && temporaryPassword.length < 12) {
      status("adminStatus", "Choose a temporary password with at least 12 characters.");
      return;
    }
    if (!accountId) body.temporaryPassword = temporaryPassword;
    try {
      await api(accountId ? "/api/admin/users/" + accountId + "/update" : "/api/admin/users", {
        method:"POST", body:JSON.stringify(body)
      }, adminToken);
      resetAccountEditor();
      await refreshAccounts();
      status("adminStatus", accountId ? "Student account details updated." : "Student account created. Share its temporary password privately.");
    } catch (error) { status("adminStatus", error.message); }
  });
  $("accountCancelEdit").addEventListener("click", resetAccountEditor);
  $("accountResetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const accountId = $("accountResetId").value;
    try {
      const data = await api("/api/admin/users/" + accountId + "/reset-password", {
        method:"POST", body:JSON.stringify({temporaryPassword:$("accountResetPassword").value})
      }, adminToken);
      $("accountResetForm").reset();
      $("accountResetForm").hidden = true;
      await refreshAccounts();
      status("adminStatus", data.message || "Temporary password reset.");
    } catch (error) { status("adminStatus", error.message); }
  });
  $("accountCancelReset").addEventListener("click", () => {
    $("accountResetForm").reset();
    $("accountResetForm").hidden = true;
  });
  $("announcementForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const published = await api("/api/admin/announcements", {method:"POST", body:JSON.stringify({
        title:$("announcementTitle").value.trim(), body:$("announcementBody").value.trim()
      })}, adminToken);
      $("announcementForm").reset();
      const delivery = published.notifications;
      let message = "Announcement published.";
      if (!delivery || !delivery.configured) message += " Push delivery is not configured on the server.";
      else if (delivery.sent === 0 && delivery.failed === 0) message += " No registered push subscriptions yet.";
      else message += " Push notifications sent: " + delivery.sent + "; failed: " + delivery.failed + ".";
      status("adminStatus", message);
      await loadPublicContent();
    } catch (error) { status("adminStatus", error.message); }
  });
  $("adminLogout").addEventListener("click", async () => {
    try { if (adminToken) await api("/api/logout", {method:"POST"}, adminToken); } catch (_) {}
    adminToken = "";
    adminMustChangePassword = false;
    syncUploadForm();
    $("adminSessionActions").hidden = true;
    $("adminPasswordChange").hidden = true;
    $("adminPasswordChange").reset();
    $("adminArea").hidden = true;
    $("adminLogin").hidden = false;
    status("adminStatus", "Signed out.");
  });

  function decodeApplicationServerKey(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }
  $("subscribeButton").addEventListener("click", async () => {
    const token = uploadToken();
    if (!token) {
      status("pushStatus", "Sign in with your member or administrator account and finish any required password change first.");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      status("pushStatus", "This browser does not support web push notifications.");
      return;
    }
    try {
      const keyData = await api("/api/push/public-key");
      if (!keyData.publicKey) throw new Error("Push notifications are not configured on the server yet.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      const registration = await navigator.serviceWorker.register("/sw.js");
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:decodeApplicationServerKey(keyData.publicKey)
      });
      await api("/api/push/subscribe", {
        method:"POST",
        body:JSON.stringify(subscription.toJSON())
      }, token);
      status("pushStatus", "Notifications enabled on this device for class announcements.");
      $("subscribeButton").textContent = "Notifications enabled";
    } catch (error) {
      status("pushStatus", error.message);
    }
  });
  loadPublicContent();
})();
