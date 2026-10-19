// Creates a dedicated app-owned Drive folder using an OAuth grant with drive.file scope.
// Run locally with GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN set.
// The script never prints tokens; it prints only the newly created folder ID.
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

for (const [name, value] of Object.entries({
  GOOGLE_CLIENT_ID: clientId,
  GOOGLE_CLIENT_SECRET: clientSecret,
  GOOGLE_REFRESH_TOKEN: refreshToken
})) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Missing required environment variable: " + name);
  }
}

async function main() {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  if (!tokenResponse.ok) {
    throw new Error("Google OAuth refresh failed (HTTP " + tokenResponse.status + "). Check the local credentials and consented scopes.");
  }
  const tokenData = await tokenResponse.json();
  if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new Error("Google OAuth did not return an access token.");
  }

  const folderResponse = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + tokenData.access_token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: "Class XII C Archive Media",
      mimeType: "application/vnd.google-apps.folder"
    })
  });
  if (!folderResponse.ok) {
    throw new Error("Google Drive folder creation failed (HTTP " + folderResponse.status + "). Check that the refresh token was granted the drive.file scope.");
  }
  const folder = await folderResponse.json();
  if (typeof folder.id !== "string" || folder.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error("Google Drive returned an invalid folder record.");
  }
  console.log("Created private Drive folder. Set GOOGLE_DRIVE_FOLDER_ID to:");
  console.log(folder.id);
}

main().catch(error => {
  console.error("Drive folder setup failed:", error.message);
  process.exitCode = 1;
});
