import test from "node:test";
import assert from "node:assert/strict";
import worker from "../backend/worker.js";

const origin = "https://classxiic2627.github.io";
const retryKey = "upload-retry-key-123456";
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function request(form) {
  return new Request("https://api.example.test/api/content", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-session-token",
      Origin: origin,
      "Idempotency-Key": retryKey
    },
    body: form
  });
}
function form(bytes = png) {
  const body = new FormData();
  body.set("type", "image");
  body.set("title", "Retry test");
  body.set("caption", "same payload");
  body.set("media", new File([bytes], "tiny.png", {type:"image/png"}));
  return body;
}
function oauthResponse() {
  return new Response(JSON.stringify({access_token:"unit-test-access-token",expires_in:3600}), {
    status:200, headers:{"Content-Type":"application/json"}
  });
}

test("retry reconciles a Drive commit whose final response was lost without uploading twice", async () => {
  const reservation = {user_id:7,payload_hash:"",item_id:"",state:"",drive_file_id:null};
  const contentRows = [];
  let reservationExists = false;
  let uploadStarts = 0;
  let uploadPuts = 0;
  let driveFile = null;
  const env = {
    ALLOWED_ORIGIN: origin,
    GOOGLE_CLIENT_ID: "idempotency-test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fake-client-secret",
    GOOGLE_REFRESH_TOKEN: "fake-refresh-token",
    GOOGLE_DRIVE_FOLDER_ID: "folder_test-123",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => {
                if (sql.includes("FROM sessions s JOIN users")) return {
                  id:7,username:"student",display_name:"Student",role:"member",
                  disabled:0,must_change_password:0,expires_at:Math.floor(Date.now()/1000)+3600
                };
                if (sql.includes("FROM upload_reservations")) return reservationExists ? {...reservation} : null;
                return null;
              },
              run: async () => {
                if (sql.includes("INSERT INTO upload_reservations")) {
                  if (reservationExists) return {meta:{changes:0}};
                  reservationExists = true;
                  reservation.user_id = values[0];
                  reservation.payload_hash = values[2];
                  reservation.item_id = values[3];
                  reservation.state = "processing";
                  return {meta:{changes:1}};
                }
                if (sql.includes("INSERT INTO content")) {
                  contentRows.push(values);
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='completed'")) {
                  reservation.state = "completed";
                  reservation.drive_file_id = values[0];
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='retryable'")) {
                  reservation.state = "retryable";
                  return {meta:{changes:1}};
                }
                return {meta:{changes:1}};
              },
              all: async () => ({results:[]})
            };
          },
          first: async () => null,
          run: async () => ({meta:{changes:1}}),
          all: async () => ({results:[]})
        };
      }
    },
    __googleFetch: async (input, options = {}) => {
      const target = String(input);
      if (target === "https://oauth2.googleapis.com/token") return oauthResponse();
      assert.equal(options.headers.Authorization, "Bearer unit-test-access-token");
      if (target.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=") && options.method === "POST") {
        uploadStarts += 1;
        const metadata = JSON.parse(String(options.body));
        driveFile = {
          id:"drive-idempotency-123",
          name:metadata.name,
          mimeType:metadata.mimeType,
          size:png.length,
          parents:metadata.parents,
          appProperties:metadata.appProperties
        };
        return new Response(null,{status:200,headers:{Location:"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=idempotency-session"}});
      }
      if (target === "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=idempotency-session" && options.method === "PUT") {
        uploadPuts += 1;
        // Model Drive committing the object while the response is lost in transit.
        throw new Error("simulated lost final response");
      }
      if (target.startsWith("https://www.googleapis.com/drive/v3/files?")) {
        assert.match(decodeURIComponent(target), /appProperties has/);
        return new Response(JSON.stringify({files:driveFile ? [driveFile] : []}),{
          status:200,headers:{"Content-Type":"application/json"}
        });
      }
      throw new Error("Unexpected Google API URL: "+target);
    }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = env.__googleFetch;
  let first;
  let second;
  let third;
  let changedPayload;
  let changedBytesPayload;
  try {
    first = await worker.fetch(request(form()),env);
    second = await worker.fetch(request(form()),env);
    third = await worker.fetch(request(form()),env);
    const changed = form();
    changed.set("title", "Different title");
    changedPayload = await worker.fetch(request(changed),env);
    const alteredBytes = Uint8Array.from([...png.slice(0, 8), 0x01]);
    changedBytesPayload = await worker.fetch(request(form(alteredBytes)),env);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(first.status,503);
  assert.equal(second.status,200);
  assert.equal(third.status,200, "a completed retry returns the same item without another upload");
  assert.equal(changedPayload.status,409, "reusing a key for a changed payload is rejected");
  assert.equal(changedBytesPayload.status,409, "different file bytes with identical metadata are rejected");
  const result = await second.json();
  assert.equal(result.id,reservation.item_id);
  assert.equal(reservation.state,"completed");
  assert.equal(contentRows.length,1);
  assert.equal(contentRows[0][0],reservation.item_id);
  assert.equal(contentRows[0][5],"drive-idempotency-123");
  assert.equal(uploadStarts,1);
  assert.equal(uploadPuts,1);
});
