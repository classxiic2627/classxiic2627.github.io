import { webcrypto } from "node:crypto";

const pair = await webcrypto.subtle.generateKey(
  {name:"ECDSA",namedCurve:"P-256"},
  true,
  ["sign","verify"]
);
const publicKey = Buffer.from(await webcrypto.subtle.exportKey("raw",pair.publicKey)).toString("base64url");
const privateJwk = await webcrypto.subtle.exportKey("jwk",pair.privateKey);

console.log("VAPID_PUBLIC_KEY=" + publicKey);
console.log("VAPID_PRIVATE_KEY=" + privateJwk.d);
console.log("VAPID_SUBJECT=mailto:replace-with-a-monitored-address@example.com");
console.log("");
console.log("Keep VAPID_PRIVATE_KEY secret. Do not commit it or put it in browser code.");
