# ARGA traits lists data
This repo contains an archive of traits-based lists about Australian biodiversity species.  The lists are available as CSV documents and are ingested to the ALA Species Lists tool (https://lists.test.ala.org.au/).  The lists are then ingested into the ARGA index via an API from ALA Lists.

## ARGA Tools: Push Google Sheets to GitHub — Setup Checklist
### Checklist
#### 1. Prepare the Google Sheet
Ensure your Google Sheet is ready (first tab should contain the MASTER data file, which is the data you want pushed to GitHub and ultimately ALA Lists).
Save any formatting or edits before proceeding.
#### 2. Add the **Apps Script**
- Go to ```Extensions > Apps Script```.
- In ```Code.gs```, paste the following script:
```
// When the spreadsheet is opened, create a custom menu
function onOpen() {
 const ui = SpreadsheetApp.getUi();
 ui.createMenu('ARGA Tools')
   .addItem('Push current sheet to ARGA GitHub', 'pushCurrentSheet')
   .addToUi();
}


// Triggered from the custom menu
function pushCurrentSheet() {
 const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
 const now = new Date();
 const timestamp = now.toISOString().replace(/[:.]/g, '-');
 const safeSheetName = sheet.getName().replace(/[^\w\d_-]/g, '-');
 const fileName = `imported_GoogleSheets/${safeSheetName}_${timestamp}.csv`;
 const csvContent = convertSheetToCsv(sheet);
 pushCsvToGitHub(fileName, csvContent);
}


// Converts the sheet contents to CSV format
function convertSheetToCsv(sheet) {
 const data = sheet.getDataRange().getValues();
 return data.map(row => row.map(cell => `"${cell}"`).join(",")).join("\n");
}


// Pushes the CSV to GitHub
function pushCsvToGitHub(fileName, content) {
 const GITHUB_TOKEN = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN'); // Use script property
 const REPO_OWNER = 'ARGA-Genomes';
 const REPO_NAME = 'arga-traits-lists-data';
 const BRANCH = 'main';


 const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${fileName}`;
 const headers = {
   "Authorization": `Bearer ${GITHUB_TOKEN}`,
   "Accept": "application/vnd.github.v3+json"
 };


 const encodedContent = Utilities.base64Encode(content);


 // Check if file already exists
 const existingFile = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });


 const payload = {
   message: "ARGA: Update CSV from Google Sheet",
   content: encodedContent,
   branch: BRANCH
 };


 if (existingFile.getResponseCode() === 200) {
   const fileData = JSON.parse(existingFile.getContentText());
   payload.sha = fileData.sha; // Required to update existing files
 }


 const options = {
   method: "put",
   headers: headers,
   contentType: "application/json",
   payload: JSON.stringify(payload),
   muteHttpExceptions: true
 };


 try {
   const response = UrlFetchApp.fetch(url, options);
   const result = JSON.parse(response.getContentText());
   Logger.log("✅ Upload successful: " + result.content.html_url);
   SpreadsheetApp.getUi().alert("✅ CSV pushed successfully:\n" + result.content.html_url);
 } catch (error) {
   Logger.log("❌ Upload failed: " + error.message);
   SpreadsheetApp.getUi().alert("❌ Upload failed:\n" + error.message);
 }
}


// Manual runner
function testPush() {
 pushCurrentSheet();
}
```
- Save the script.
#### 3. Set the **Script Property** for GitHub token
In Apps Script editor:
- Go to ```**Project Settings > Script Properties**```.
- Add a new property:
  - Key: ```GITHUB_TOKEN```
  - Value: (_your GitHub classic token_)
#### 4. Reload your sheet
- Refresh the Sheet (```Cmd+R``` or ```Ctrl+R```).
- The custom menu ```**ARGA Tools > Push current sheet to ARGA GitHub**``` should now appear.
### Deployment tips
| **Tip** | **Why** |
| :---   | :--- |
| Use clear sheet names | Cleaner GitHub filenames |
| Push after major edits | Ensures version control |
| The first time you push, you will need to authenticate your Google account | Authorises your Google account to use this script on this file |
| Check GitHub after push | Confirm your CSV file is live |
## Quick recovery steps
1. Reload your Google Sheet.
2. Check ```**Script Properties**``` for your GitHub token.
3. Check GitHub — if no file appears, simply re-push.
### Notes
- Every push creates a **new versioned file** — no overwrites unless filename is identical.
- You can safely retry if unsure.
- Always keep your GitHub token secure — never paste it into the spreadsheet itself!

