import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { isPushConfigured, sendWebPush } from "../backend/web-push.js";

const encoder = new TextEncoder();
const b64url = bytes => Buffer.from(bytes).toString("base64url");

async function keys() {
  const vapid = await webcrypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw",vapid.publicKey));
  const privateJwk = await webcrypto.subtle.exportKey("jwk",vapid.privateKey);
  const client = await webcrypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
  const clientRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw",client.publicKey));
  return {
    env:{VAPID_PUBLIC_KEY:b64url(publicRaw),VAPID_PRIVATE_KEY:privateJwk.d,VAPID_SUBJECT:"mailto:admin@classxiic.example"},
    subscription:{endpoint:"https://fcm.googleapis.com/fcm/send/test-endpoint",p256dh:b64url(clientRaw),auth:b64url(webcrypto.getRandomValues(new Uint8Array(16)))}
  };
}

test("push configuration is false unless all VAPID values are valid", async () => {
  assert.equal(isPushConfigured({}),false);
  assert.equal(isPushConfigured({VAPID_PUBLIC_KEY:"bad",VAPID_PRIVATE_KEY:"bad",VAPID_SUBJECT:"https://example.test"}),false);
  const pair = await keys();
  assert.equal(isPushConfigured(pair.env),true);
});

test("Web Push sends encrypted payload with VAPID authorization", async () => {
  const pair = await keys();
  let request;
  const result = await sendWebPush(pair.subscription,{title:"Class update",body:"New announcement",url:"/community.html"},pair.env,async (url,init) => {
    request = {url,init};
    return new Response(null,{status:201});
  });
  assert.equal(result.status,201);
  assert.equal(request.url,pair.subscription.endpoint);
  assert.equal(request.init.method,"POST");
  assert.match(request.init.headers.Authorization,/^vapid t=[A-Za-z0-9_.-]+, k=/);
  assert.equal(request.init.headers["Content-Encoding"],"aes128gcm");
  assert.equal(request.init.headers["Content-Type"],"application/octet-stream");
  assert.ok(request.init.body instanceof Uint8Array);
  assert.ok(request.init.body.length > 100);
});

test("Web Push rejects non-HTTPS endpoints before network requests", async () => {
  const pair = await keys();
  await assert.rejects(
    sendWebPush({...pair.subscription,endpoint:"http://fcm.googleapis.com/fcm/send/test"}, {}, pair.env, async () => {
      throw new Error("network must not be called");
    }),
    /HTTPS/
  );
});
