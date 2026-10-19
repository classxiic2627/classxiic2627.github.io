/* Community Hub frontend. Set API_BASE to the deployed Worker origin before launch. */
(() => {
  "use strict";
  const API_BASE = ""; // Example: https://class-archive-api.example.workers.dev
  const $ = (id) => document.getElementById(id);
  let memberToken = "";
  let adminToken = "";
  let memberMustChangePassword = false;
  let adminMustChangePassword = false;

  async function api(path, options = {}, token = "") {
    if (!API_BASE) throw new Error("The community API is not connected yet. Deployment setup is still required.");
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
      $("uploadForm").hidden = memberMustChangePassword;
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
    $("uploadForm").hidden = true;
    $("memberLogin").hidden = false;
    $("uploadForm").reset();
    status("memberStatus", "Signed out.");
  });
  $("uploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = $("uploadMedia").files[0];
    if (!file) { status("memberStatus", "Choose a photo or video first."); return; }
    if (file.size > 15 * 1024 * 1024) { status("memberStatus", "Media must be 15 MB or smaller."); return; }
    const form = new FormData();
    form.set("type", $("uploadType").value);
    form.set("title", $("uploadTitle").value.trim());
    form.set("caption", $("uploadCaption").value.trim());
    form.set("media", file);
    try {
      await api("/api/content", {method:"POST", body:form}, memberToken);
      $("uploadForm").reset();
      status("memberStatus", "Published. Push notifications are not active yet.");
      await loadPublicContent();
    } catch (error) { status("memberStatus", error.message); }
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
      $("adminSessionActions").hidden = false;
      $("showAdminMemberPasswordChange").hidden = adminMustChangePassword;
      $("adminMemberPasswordChange").hidden = true;
      $("adminLogin").hidden = true;
      $("adminPassword").value = "";
      $("adminPasswordChange").hidden = !adminMustChangePassword;
      $("cancelAdminPasswordChange").hidden = adminMustChangePassword;
      $("adminArea").hidden = adminMustChangePassword;
      if (adminMustChangePassword) {
        status("adminStatus", "For account safety, change the temporary password before using the admin desk.");
      } else {
        await refreshAdmin();
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
        } catch (error) { status("adminStatus", error.message); }
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
      $("adminSessionActions").hidden = true;
      $("adminMemberPasswordChange").hidden = true;
      $("adminMemberPasswordChange").reset();
      $("adminPasswordChange").reset();
      $("adminPasswordChange").hidden = true;
      $("adminArea").hidden = true;
      $("adminLogin").hidden = false;
      status("adminStatus", "Password changed. Please sign in again with your new password.");
    } catch (error) { status("adminStatus", error.message); }
  });
  $("showAdminMemberPasswordChange").addEventListener("click", () => {
    $("adminMemberPasswordChange").hidden = false;
  });
  $("cancelAdminMemberPasswordChange").addEventListener("click", () => {
    $("adminMemberPasswordChange").reset();
    $("adminMemberPasswordChange").hidden = true;
  });
  $("adminMemberPasswordChange").addEventListener("submit", async (event) => {
    event.preventDefault();
    const newPassword = $("adminNewMemberPassword").value;
    if (newPassword !== $("adminConfirmMemberPassword").value) {
      status("adminStatus", "The new class upload password and confirmation do not match.");
      return;
    }
    if (newPassword.length < 12) {
      status("adminStatus", "Choose a class upload password with at least 12 characters.");
      return;
    }
    try {
      const data = await api("/api/admin/member-password", {
        method:"POST",
        body:JSON.stringify({newPassword})
      }, adminToken);
      $("adminMemberPasswordChange").reset();
      $("adminMemberPasswordChange").hidden = true;
      status("adminStatus", data.message || "Class upload password rotated.");
    } catch (error) { status("adminStatus", error.message); }
  });
  $("announcementForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/admin/announcements", {method:"POST", body:JSON.stringify({
        title:$("announcementTitle").value.trim(), body:$("announcementBody").value.trim()
      })}, adminToken);
      $("announcementForm").reset();
      status("adminStatus", "Announcement published. Push notifications are not active yet.");
      await loadPublicContent();
    } catch (error) { status("adminStatus", error.message); }
  });
  $("adminLogout").addEventListener("click", async () => {
    try { if (adminToken) await api("/api/logout", {method:"POST"}, adminToken); } catch (_) {}
    adminToken = "";
    adminMustChangePassword = false;
    $("adminSessionActions").hidden = true;
    $("adminPasswordChange").hidden = true;
    $("adminPasswordChange").reset();
    $("adminMemberPasswordChange").hidden = true;
    $("adminMemberPasswordChange").reset();
    $("adminArea").hidden = true;
    $("adminLogin").hidden = false;
    status("adminStatus", "Signed out.");
  });

  $("subscribeButton").addEventListener("click", () => {
    status("pushStatus", "Push notifications are not implemented yet, so this button will not request browser permissions.");
  });
  loadPublicContent();
})();
