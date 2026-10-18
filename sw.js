self.addEventListener("push", event => {
  let data = {title:"The Archive", body:"There's something new in the class archive.", url:"/"}; 
  try { if (event.data) data = {...data, ...event.data.json()}; } catch (_) {}
  event.waitUntil(self.registration.showNotification(data.title || "The Archive", {
    body: data.body || "There's something new in the class archive.",
    icon: "images/icon-192.png",
    badge: "images/icon-192.png",
    data: {url: data.url || "/"},
    tag: data.tag || "class-archive-update"
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(clients.matchAll({type:"window", includeUncontrolled:true}).then(list => {
    const existing = list.find(client => client.url.startsWith(self.location.origin));
    if (existing) { existing.navigate(target); return existing.focus(); }
    return clients.openWindow(target);
  }));
});