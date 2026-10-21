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
  let driveSearchFails = false;
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
                if (sql.includes("SET state='reconciliation_required'")) {
                  reservation.state = "reconciliation_required";
                  if (sql.includes("drive_file_id=?")) reservation.drive_file_id = values[0];
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='processing'")) {
                  const expectedState = sql.includes("state='reconciliation_required'") ? "reconciliation_required" : "retryable";
                  if (reservation.state !== expectedState) return {meta:{changes:0}};
                  reservation.state = "processing";
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='retryable'")) {
                  reservation.state = "retryable";
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='reconciliation_required'")) {
                  reservation.state = "reconciliation_required";
                  if (sql.includes("drive_file_id=?")) reservation.drive_file_id = values[0];
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='processing'")) {
                  if (reservation.state !== "reconciliation_required" && reservation.state !== "retryable") return {meta:{changes:0}};
                  reservation.state = "processing";
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
        if (driveSearchFails) throw new Error("simulated Drive lookup timeout");
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
  let lookupTimeoutRetry;
  let noMatchRetry;
  let wrongParentRetry;
  let badPropertyRetry;
  let second;
  let third;
  let changedPayload;
  let changedBytesPayload;
  try {
    first = await worker.fetch(request(form()),env);
    driveSearchFails = true;
    lookupTimeoutRetry = await worker.fetch(request(form()),env);
    driveSearchFails = false;
    // Drive listing can lag behind a successful upload. A no-match result must
    // remain fail-closed; it must never trigger a second Drive upload.
    const committedFile = driveFile;
    driveFile = null;
    noMatchRetry = await worker.fetch(request(form()),env);
    driveFile = committedFile;
    const originalParents = driveFile.parents;
    driveFile.parents = ["another-folder"];
    wrongParentRetry = await worker.fetch(request(form()),env);
    driveFile.parents = originalParents;
    const originalUploadId = driveFile.appProperties.archiveUploadId;
    driveFile.appProperties.archiveUploadId = "different-upload-id";
    badPropertyRetry = await worker.fetch(request(form()),env);
    driveFile.appProperties.archiveUploadId = originalUploadId;
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
  assert.equal(lookupTimeoutRetry.status,503, "a Drive lookup timeout must not trigger a second upload");
  assert.equal(noMatchRetry.status,503, "a temporarily invisible Drive object must not be uploaded again");
  assert.equal(wrongParentRetry.status,503, "a Drive match from the wrong parent folder must fail closed");
  assert.equal(badPropertyRetry.status,503, "a Drive match with mismatched upload metadata must fail closed");
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


test("failed Drive cleanup after D1 insert failure enters reconciliation-required and recovers safely", async () => {
  const reservation = {user_id:7,payload_hash:"",item_id:"",state:"",drive_file_id:null};
  const contentRows = [];
  let contentInsertAttempts = 0;
  let driveDeleteAttempts = 0;
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
                  contentInsertAttempts++;
                  if (contentInsertAttempts === 1) throw new Error("simulated D1 insert failure");
                  contentRows.push(values);
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='completed'")) {
                  reservation.state = "completed";
                  reservation.drive_file_id = values[0];
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='reconciliation_required'")) {
                  reservation.state = "reconciliation_required";
                  if (sql.includes("drive_file_id=?")) reservation.drive_file_id = values[0];
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='processing'")) {
                  const expectedState = sql.includes("state='reconciliation_required'") ? "reconciliation_required" : "retryable";
                  if (reservation.state !== expectedState) return {meta:{changes:0}};
                  reservation.state = "processing";
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='retryable'")) {
                  reservation.state = "retryable";
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='reconciliation_required'")) {
                  reservation.state = "reconciliation_required";
                  if (sql.includes("drive_file_id=?")) reservation.drive_file_id = values[0];
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='processing'")) {
                  if (reservation.state !== "reconciliation_required" && reservation.state !== "retryable") return {meta:{changes:0}};
                  reservation.state = "processing";
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
        return new Response(JSON.stringify(driveFile),{status:200,headers:{"Content-Type":"application/json"}});
      }
      if (target.includes("/drive/v3/files/drive-idempotency-123") && options.method === "DELETE") {
        driveDeleteAttempts++;
        throw new Error("simulated Drive delete failure");
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
  try {
    first = await worker.fetch(request(form()),env);
    assert.equal(reservation.state,"reconciliation_required");
    assert.equal(reservation.drive_file_id,"drive-idempotency-123");
    assert.equal(driveDeleteAttempts,1);
    second = await worker.fetch(request(form()),env);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(first.status,500);
  assert.equal(second.status,200);
  const result = await second.json();
  assert.equal(result.id,reservation.item_id);
  assert.equal(reservation.state,"completed");
  assert.equal(contentRows.length,1);
  assert.equal(contentRows[0][0],reservation.item_id);
  assert.equal(contentRows[0][5],"drive-idempotency-123");
  assert.equal(contentInsertAttempts,2);
  assert.equal(uploadStarts,1);
  assert.equal(uploadPuts,1);
});


test("concurrent same-key retry cannot publish then delete the original request's Drive file", async () => {
  const reservation = {user_id:7,payload_hash:"",item_id:"",state:"",drive_file_id:null};
  let reservationExists = false;
  let contentRow = null;
  let contentInsertCount = 0;
  let uploadStarts = 0;
  let uploadPuts = 0;
  let driveDeleteCount = 0;
  let driveSearchCount = 0;
  let driveFile = null;
  let releasePut;
  let markPutStarted;
  const putStarted = new Promise(resolve => { markPutStarted = resolve; });
  const putRelease = new Promise(resolve => { releasePut = resolve; });
  const user = {
    id:7,username:"student",display_name:"Student",role:"member",
    disabled:0,must_change_password:0,expires_at:Math.floor(Date.now()/1000)+3600
  };
  const env = {
    ALLOWED_ORIGIN:origin,
    GOOGLE_CLIENT_ID:"concurrent-idempotency-test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET:"fake-client-secret",
    GOOGLE_REFRESH_TOKEN:"fake-refresh-token",
    GOOGLE_DRIVE_FOLDER_ID:"folder_test-123",
    DB:{
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first:async()=>{
                if (sql.includes("FROM sessions s JOIN users")) return user;
                if (sql.includes("FROM upload_reservations")) return reservationExists ? {...reservation} : null;
                if (sql.includes("FROM content WHERE id=? AND user_id=?")) {
                  return contentRow && contentRow.id===values[0] && contentRow.user_id===values[1]
                    ? {media_key:contentRow.media_key,media_mime:contentRow.media_mime,media_size:contentRow.media_size}
                    : null;
                }
                return null;
              },
              run:async()=>{
                if (sql.includes("INSERT INTO upload_reservations")) {
                  if (reservationExists) return {meta:{changes:0}};
                  reservationExists=true;
                  reservation.user_id=values[0];
                  reservation.payload_hash=values[2];
                  reservation.item_id=values[3];
                  reservation.state="processing";
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='processing'")) {
                  if (!["retryable","reconciliation_required"].includes(reservation.state)) return {meta:{changes:0}};
                  reservation.state="processing";
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='reconciliation_required'")) {
                  if (reservation.state!=="processing") return {meta:{changes:0}};
                  reservation.state="reconciliation_required";
                  return {meta:{changes:1}};
                }
                if (sql.includes("INSERT INTO content")) {
                  if (contentRow) throw new Error("UNIQUE constraint failed: content.id");
                  contentInsertCount++;
                  contentRow={
                    id:values[0],user_id:values[1],type:values[2],title:values[3],caption:values[4],
                    media_key:values[5],media_mime:values[6],media_size:values[7]
                  };
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='completed'")) {
                  reservation.state="completed";
                  reservation.drive_file_id=values[0];
                  return {meta:{changes:1}};
                }
                if (sql.includes("SET state='retryable'")) {
                  reservation.state="retryable";
                  return {meta:{changes:1}};
                }
                return {meta:{changes:1}};
              },
              all:async()=>({results:[]})
            };
          },
          first:async()=>null,
          run:async()=>({meta:{changes:1}}),
          all:async()=>({results:[]})
        };
      }
    },
    __googleFetch:async(input,options={})=>{
      const url=new URL(typeof input==="string"?input:input.url);
      if (url.href==="https://oauth2.googleapis.com/token") return oauthResponse();
      assert.equal(options.headers.Authorization,"Bearer unit-test-access-token");
      if (url.pathname==="/upload/drive/v3/files" && options.method==="POST" && url.searchParams.get("uploadType")==="resumable") {
        uploadStarts++;
        const metadata=JSON.parse(String(options.body));
        return new Response(null,{status:200,headers:{Location:"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=concurrent-session"}});
      }
      if (url.pathname==="/upload/drive/v3/files" && options.method==="PUT" && url.searchParams.get("upload_id")==="concurrent-session") {
        uploadPuts++;
        const bytes=await new Response(options.body).arrayBuffer();
        driveFile={
          id:"drive-concurrent-file",name:"uploads/"+reservation.item_id,mimeType:"image/png",
          size:bytes.byteLength,parents:["folder_test-123"],appProperties:{archiveUploadId:reservation.item_id}
        };
        markPutStarted();
        await putRelease;
        return Response.json({id:driveFile.id,name:driveFile.name,mimeType:driveFile.mimeType,size:driveFile.size,parents:driveFile.parents,appProperties:driveFile.appProperties});
      }
      if (url.pathname==="/drive/v3/files" && options.method!=="DELETE") {
        driveSearchCount++;
        return Response.json({files:driveFile?[driveFile]:[]});
      }
      if (url.pathname.startsWith("/drive/v3/files/") && options.method==="DELETE") {
        driveDeleteCount++;
        driveFile=null;
        return new Response(null,{status:204});
      }
      throw new Error("Unexpected Google API URL: "+url.href);
    }
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=env.__googleFetch;
  let firstPromise;
  let first;
  let concurrent;
  let finalRetry;
  try {
    firstPromise=worker.fetch(request(form()),env);
    await putStarted;
    concurrent=await worker.fetch(request(form()),env);
    assert.equal(concurrent.status,503,"a second request must not reconcile while the original upload is active");
    assert.equal(driveSearchCount,0,"active processing reservations must not trigger Drive reconciliation");
    assert.equal(contentRow,null,"the concurrent request must not publish a content row");
    assert.equal(driveDeleteCount,0,"the concurrent request must not delete the in-flight Drive object");
    releasePut();
    first=await firstPromise;
    assert.equal(first.status,201);
    finalRetry=await worker.fetch(request(form()),env);
  } finally {
    releasePut();
    globalThis.fetch=originalFetch;
  }
  assert.equal(finalRetry.status,200);
  assert.equal((await finalRetry.json()).id,reservation.item_id);
  assert.equal(reservation.state,"completed");
  assert.equal(contentInsertCount,1);
  assert.equal(contentRow.media_key,"drive-concurrent-file");
  assert.equal(driveFile.id,"drive-concurrent-file");
  assert.equal(driveDeleteCount,0);
  assert.equal(driveSearchCount,0);
  assert.equal(uploadStarts,1);
  assert.equal(uploadPuts,1);
});
