const encoder = new TextEncoder();
const b64url = bytes => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const fromB64url = value => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0));
};
const concat = (...parts) => {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, {name:"HMAC", hash:"SHA-256"}, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}
async function hkdfExpand(prk, info, length) {
  const output = [];
  let previous = new Uint8Array();
  let total = 0;
  for (let counter = 1; total < length; counter++) {
    previous = await hmac(prk, concat(previous, info, Uint8Array.of(counter)));
    output.push(previous);
    total += previous.length;
  }
  return concat(...output).slice(0, length);
}
function requireVapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) throw new Error("VAPID push configuration is incomplete.");
  const publicKey = fromB64url(env.VAPID_PUBLIC_KEY);
  const privateKey = fromB64url(env.VAPID_PRIVATE_KEY);
  if (publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32 ||
      !/^mailto:[^\s@]+@[^\s@]+$/.test(env.VAPID_SUBJECT)) throw new Error("VAPID configuration is invalid.");
  return {publicKey, privateKey};
}
async function createVapidToken(endpoint, env) {
  const {publicKey, privateKey} = requireVapid(env);
  const header = b64url(encoder.encode(JSON.stringify({typ:"JWT",alg:"ES256"})));
  const claims = b64url(encoder.encode(JSON.stringify({aud:new URL(endpoint).origin,exp:Math.floor(Date.now()/1000)+12*60*60,sub:env.VAPID_SUBJECT})));
  const unsigned = header + "." + claims;
  const key = await crypto.subtle.importKey("jwk", {
    kty:"EC",crv:"P-256",x:b64url(publicKey.slice(1,33)),y:b64url(publicKey.slice(33,65)),
    d:b64url(privateKey),ext:true,key_ops:["sign"]
  }, {name:"ECDSA",namedCurve:"P-256"}, false, ["sign"]);
  const signature = await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,encoder.encode(unsigned));
  return unsigned + "." + b64url(new Uint8Array(signature));
}
async function encryptPayload(subscription, payload) {
  const clientPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  if (clientPublic.length !== 65 || clientPublic[0] !== 4 || authSecret.length !== 16) throw new Error("Push subscription keys are invalid.");
  const clientKey = await crypto.subtle.importKey("raw",clientPublic,{name:"ECDH",namedCurve:"P-256"},false,[]);
  const ephemeral = await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw",ephemeral.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH",public:clientKey},ephemeral.privateKey,256));
  const authPrk = await hmac(authSecret,sharedSecret);
  const keyInfo = concat(encoder.encode("WebPush: info\0"),clientPublic,serverPublic);
  const inputKeyMaterial = await hkdfExpand(authPrk,keyInfo,32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt,inputKeyMaterial);
  const cek = await hkdfExpand(prk,encoder.encode("Content-Encoding: aes128gcm\0"),16);
  const nonce = await hkdfExpand(prk,encoder.encode("Content-Encoding: nonce\0"),12);
  const message = encoder.encode(JSON.stringify(payload));
  if (message.length > 3800) throw new Error("Push notification payload is too large.");
  const aesKey = await crypto.subtle.importKey("raw",cek,{name:"AES-GCM"},false,["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce,tagLength:128},aesKey,concat(message,Uint8Array.of(2))));
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0,4096,false);
  header[4] = serverPublic.length;
  return concat(salt,header,serverPublic,ciphertext);
}
export async function sendWebPush(subscription,payload,env,fetchImpl=fetch) {
  const endpoint = new URL(subscription.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("Push endpoint must use HTTPS.");
  const host = endpoint.hostname;
  const allowedHost = host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    host.endsWith(".push.services.mozilla.com") ||
    host === "web.push.apple.com" ||
    host.endsWith(".push.apple.com") ||
    host.endsWith(".notify.windows.com");
  if (!allowedHost || endpoint.username || endpoint.password || endpoint.port) {
    throw new Error("Push endpoint provider is not supported.");
  }
  requireVapid(env);
  const [token,body] = await Promise.all([createVapidToken(endpoint.href,env),encryptPayload(subscription,payload)]);
  const response = await fetchImpl(endpoint.href,{
    method:"POST",
    redirect:"manual",
    signal:AbortSignal.timeout(5000),
    headers:{
      Authorization:"vapid t="+token+", k="+env.VAPID_PUBLIC_KEY,
      "Content-Encoding":"aes128gcm",
      "Content-Type":"application/octet-stream",
      TTL:"86400",
      Urgency:"normal"
    },
    body
  });
  return {status:response.status};
}
export function isPushConfigured(env) {
  try { requireVapid(env); return true; } catch { return false; }
}
