import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { isPushConfigured, sendWebPush } from "../backend/web-push.js";

const b64url = bytes => Buffer.from(bytes).toString("base64url");
const fromB64url = value => Buffer.from(value,"base64url");
const encoder = new TextEncoder();
const concat = (...parts) => {
  const result = new Uint8Array(parts.reduce((total,part)=>total+part.length,0));
  let offset=0;
  for (const part of parts) { result.set(part,offset); offset+=part.length; }
  return result;
};
async function hmac(keyBytes,data) {
  const key=await webcrypto.subtle.importKey("raw",keyBytes,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return new Uint8Array(await webcrypto.subtle.sign("HMAC",key,data));
}
async function hkdfExpand(prk,info,length) {
  const blocks=[];
  let previous=new Uint8Array(),total=0;
  for(let counter=1;total<length;counter++) {
    previous=await hmac(prk,concat(previous,info,Uint8Array.of(counter)));
    blocks.push(previous); total+=previous.length;
  }
  return concat(...blocks).slice(0,length);
}

async function keys() {
  const vapid = await webcrypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw",vapid.publicKey));
  const privateJwk = await webcrypto.subtle.exportKey("jwk",vapid.privateKey);
  const client = await webcrypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
  const clientRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw",client.publicKey));
  return {
    env:{VAPID_PUBLIC_KEY:b64url(publicRaw),VAPID_PRIVATE_KEY:privateJwk.d,VAPID_SUBJECT:"mailto:admin@classxiic.example"},
    subscription:{endpoint:"https://fcm.googleapis.com/fcm/send/test-endpoint",p256dh:b64url(clientRaw),auth:b64url(webcrypto.getRandomValues(new Uint8Array(16)))},
    clientPrivateKey:client.privateKey
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
  assert.equal(request.init.redirect,"manual","provider redirects must not bypass the endpoint host allowlist");
  assert.ok(request.init.signal instanceof AbortSignal,"provider requests must have a bounded timeout");
  assert.match(request.init.headers.Authorization,/^vapid t=[A-Za-z0-9_.-]+, k=/);
  const vapidToken = request.init.headers.Authorization.slice("vapid t=".length).split(", k=")[0];
  const [jwtHeader,jwtClaims,jwtSignature] = vapidToken.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(jwtHeader))),{typ:"JWT",alg:"ES256"});
  const vapidPublicKey = await webcrypto.subtle.importKey("raw",fromB64url(pair.env.VAPID_PUBLIC_KEY),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  assert.equal(await webcrypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},vapidPublicKey,fromB64url(jwtSignature),encoder.encode(jwtHeader+"."+jwtClaims)),true);
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(jwtClaims)));
  assert.equal(claims.aud,new URL(pair.subscription.endpoint).origin);
  assert.equal(claims.sub,pair.env.VAPID_SUBJECT);
  assert.ok(claims.exp > Math.floor(Date.now()/1000));
  assert.equal(request.init.headers["Content-Encoding"],"aes128gcm");
  assert.equal(request.init.headers["Content-Type"],"application/octet-stream");
  assert.ok(request.init.body instanceof Uint8Array);
  assert.ok(request.init.body.length > 100);

  // Decrypt the captured aes128gcm record as a browser push client would. This
  // catches key-derivation/header/layout mistakes that a length-only test misses.
  const record = request.init.body;
  const salt = record.slice(0,16);
  const keyIdLength = record[20];
  const serverPublic = record.slice(21,21+keyIdLength);
  const ciphertext = record.slice(21+keyIdLength);
  assert.equal(keyIdLength,65);
  const serverKey = await webcrypto.subtle.importKey("raw",serverPublic,{name:"ECDH",namedCurve:"P-256"},false,[]);
  const sharedSecret = new Uint8Array(await webcrypto.subtle.deriveBits({name:"ECDH",public:serverKey},pair.clientPrivateKey,256));
  const authSecret = fromB64url(pair.subscription.auth);
  const authPrk = await hmac(authSecret,sharedSecret);
  const clientPublic = fromB64url(pair.subscription.p256dh);
  const keyInfo = concat(encoder.encode("WebPush: info\0"),clientPublic,serverPublic);
  const inputKeyMaterial = await hkdfExpand(authPrk,keyInfo,32);
  const prk = await hmac(salt,inputKeyMaterial);
  const cek = await hkdfExpand(prk,encoder.encode("Content-Encoding: aes128gcm\0"),16);
  const nonce = await hkdfExpand(prk,encoder.encode("Content-Encoding: nonce\0"),12);
  const aesKey = await webcrypto.subtle.importKey("raw",cek,{name:"AES-GCM"},false,["decrypt"]);
  const plaintext = new Uint8Array(await webcrypto.subtle.decrypt({name:"AES-GCM",iv:nonce,tagLength:128},aesKey,ciphertext));
  assert.equal(plaintext[plaintext.length-1],2);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext.slice(0,-1))),{
    title:"Class update",body:"New announcement",url:"/community.html"
  });
});

test("Web Push aborts a provider request that never resolves", async () => {
  const pair=await keys();
  let signal;
  // Node's AbortSignal.timeout timer is unref'ed; keep the test event loop alive
  // long enough for the timeout to fire while the fake provider remains pending.
  const keepAlive=setTimeout(()=>{},100);
  try {
    await assert.rejects(
      sendWebPush(pair.subscription,{title:"Timeout test"},pair.env,async (_url,init)=>{
        signal=init.signal;
        return await new Promise((resolve,reject)=>{
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
        });
      },20),
      error=>error?.name==="TimeoutError"
    );
    assert.ok(signal?.aborted);
  } finally {
    clearTimeout(keepAlive);
  }
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

test("Web Push rejects arbitrary HTTPS hosts to prevent server-side request forgery", async () => {
  const pair = await keys();
  await assert.rejects(
    sendWebPush({...pair.subscription,endpoint:"https://attacker.example/collect"}, {}, pair.env, async () => {
      throw new Error("network must not be called");
    }),
    /provider is not supported/
  );
});
