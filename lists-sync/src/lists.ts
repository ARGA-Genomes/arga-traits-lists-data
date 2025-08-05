interface DrMap {
  prod: Record<string, string>;
  test: Record<string, string>;
}

interface SpeciesListResponse {
  id: string;
  dataResourceUid: string;
  title: string;
  version: number;
  rowCount: number;
}

interface UploadResponse {
  localFile: string;
  rowCount: number;
  fieldList: string[];
  originalFieldNames: string[];
  validationErrors: string[] | null;
}

interface ProgressResponse {
  id: string;
  speciesListID: string;
  completed: boolean;
  rowCount: number;
  mongoTotal: number;
  elasticTotal: number;
  started: number;
}

interface OAuth2TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface CachedToken {
  access_token: string;
  expires_at: number;
}

// Configuration constants
const PROGRESS_CHECK_INTERVAL = 5000; // 5 seconds
const MAX_PROGRESS_ATTEMPTS = 120; // 10 minutes total
const MAX_WAIT_TIME_SECONDS =
  MAX_PROGRESS_ATTEMPTS * (PROGRESS_CHECK_INTERVAL / 1000);

// Token cache to avoid unnecessary OAuth2 requests
let cachedToken: CachedToken | null = null;

/**
 * Gets a valid access token, either from cache or by fetching a new one
 */
async function getAccessToken(): Promise<string> {
  // Check if we have a cached token that's still valid (with 5 minute buffer)
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000; // 5 minutes buffer

  if (cachedToken && now < cachedToken.expires_at - bufferMs) {
    console.log('Using cached access token');
    return cachedToken.access_token;
  }

  console.log('Fetching new M2M access token...');

  // Fetch a new token using client credentials flow
  const tokenUrl =
    'https://auth-secure.auth.ap-southeast-2.amazoncognito.com/oauth2/token';

  const credentials = `${process.env.LISTS_AUTH_CLIENT_ID}:${process.env.LISTS_AUTH_CLIENT_SECRET}`;
  const base64Credentials = Buffer.from(credentials).toString('base64');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${base64Credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'ala/attrs ala/internal users/read',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch access token: ${response.status} ${response.statusText}. Response: ${errorText}`
    );
  }

  const tokenData: OAuth2TokenResponse =
    (await response.json()) as OAuth2TokenResponse;

  // Cache the token with expiration time
  cachedToken = {
    access_token: tokenData.access_token,
    expires_at: now + tokenData.expires_in * 1000, // Convert to milliseconds
  };

  console.log(
    `✅ New access token acquired, expires in ${tokenData.expires_in} seconds`
  );

  return tokenData.access_token;
}

/**
 * Creates a multipart form data body for HTTP requests
 */
function createMultipartFormData(
  boundary: string,
  fields: Record<string, string>
): string {
  const parts: string[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}`);
    if (name === 'file' && value.includes('\n')) {
      // Handle file content with proper headers
      const filename = `${Date.now()}.csv`;
      parts.push(
        `Content-Disposition: form-data; name="file"; filename="${filename}"`
      );
      parts.push('Content-Type: text/csv');
    } else {
      parts.push(`Content-Disposition: form-data; name="${name}"`);
    }
    parts.push('');
    parts.push(value);
  }

  parts.push(`--${boundary}--`);
  parts.push('');

  return parts.join('\r\n');
}

/**
 * Generates a random boundary string for multipart form data
 */
function generateBoundary(): string {
  return `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
}

/**
 * Fetches the internal species list ID from the ALA Lists API
 */
async function fetchSpeciesListId(dataResourceUid: string): Promise<string> {
  const listUrl = `${process.env.LISTS_API_ENDPOINT}/v2/speciesList/${dataResourceUid}`;

  console.log(
    `Fetching species list info for dataResourceUid: ${dataResourceUid}`
  );

  const accessToken = await getAccessToken();

  const response = await fetch(listUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch species list (${dataResourceUid}): ${response.status} ${response.statusText}`
    );
  }

  const listData: SpeciesListResponse =
    (await response.json()) as SpeciesListResponse;

  console.log(
    `Found species list: "${listData.title}" (ID: ${listData.id}, Version: ${listData.version})`
  );

  return listData.id;
}

/**
 * Uploads file content to the ALA Lists API
 */
async function uploadFileContent(
  parentFolderName: string,
  fileContent: string
): Promise<string> {
  const uploadUrl = `${process.env.LISTS_API_ENDPOINT}/v2/upload`;
  const boundary = generateBoundary();

  console.log(
    `Uploading file content for folder: ${parentFolderName} (${fileContent.length} characters)`
  );

  const formDataBody = createMultipartFormData(boundary, {
    file: fileContent,
  });

  const accessToken = await getAccessToken();

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: formDataBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to upload file: ${response.status} ${response.statusText}. Response: ${errorText}`
    );
  }

  const uploadData: UploadResponse = (await response.json()) as UploadResponse;

  if (uploadData.validationErrors && uploadData.validationErrors.length > 0) {
    throw new Error(
      `Upload validation errors:\n${uploadData.validationErrors
        .map((error, index) => `${index + 1}. ${error}`)
        .join('\n')}`
    );
  }

  console.log(
    `File uploaded successfully: ${uploadData.localFile} (${uploadData.rowCount} rows)`
  );

  return uploadData.localFile;
}

/**
 * Ingests the uploaded file into the species list
 */
async function ingestFile(
  speciesListID: string,
  localFile: string
): Promise<void> {
  const ingestUrl = `${process.env.LISTS_API_ENDPOINT}/v2/ingest/${speciesListID}`;
  const boundary = generateBoundary();

  console.log(
    `Starting ingestion of file: ${localFile} into list: ${speciesListID}`
  );

  const formDataBody = createMultipartFormData(boundary, {
    file: localFile,
  });

  const accessToken = await getAccessToken();

  const response = await fetch(ingestUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: formDataBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to ingest file: ${response.status} ${response.statusText}. Response: ${errorText}`
    );
  }

  console.log('File ingestion started successfully');
}

/**
 * Monitors the progress of file ingestion until completion
 */
async function waitForIngestionCompletion(
  speciesListID: string
): Promise<void> {
  const progressUrl = `${process.env.LISTS_API_ENDPOINT}/v2/ingest/${speciesListID}/progress`;

  console.log(`Monitoring ingestion progress for list: ${speciesListID}`);
  console.log(
    `Will check every ${PROGRESS_CHECK_INTERVAL / 1000}s for up to ${
      MAX_WAIT_TIME_SECONDS / 60
    } minutes`
  );

  let completed = false;
  let attempts = 0;

  while (!completed && attempts < MAX_PROGRESS_ATTEMPTS) {
    await new Promise((resolve) =>
      setTimeout(resolve, PROGRESS_CHECK_INTERVAL)
    );
    attempts++;

    try {
      const accessToken = await getAccessToken();

      const response = await fetch(progressUrl, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        console.warn(
          `Progress check ${attempts} failed: ${response.status} ${response.statusText}`
        );
        continue;
      }

      const progressData: ProgressResponse =
        (await response.json()) as ProgressResponse;
      completed = progressData.completed;

      const elapsed = Math.round((Date.now() - progressData.started) / 1000);
      console.log(
        `Progress check ${attempts}/${MAX_PROGRESS_ATTEMPTS}: completed = ${completed} ` +
          `(${progressData.mongoTotal}/${progressData.rowCount} processed, ${elapsed}s elapsed)`
      );
    } catch (error) {
      console.warn(`Progress check ${attempts} failed with error:`, error);
    }
  }

  if (!completed) {
    throw new Error(
      `File processing did not complete within ${MAX_WAIT_TIME_SECONDS} seconds (${attempts} attempts)`
    );
  }

  console.log(`✅ Ingestion completed successfully after ${attempts} checks`);
}

/**
 * Reloads a species list with new file content
 *
 * @param parentFolderName - The folder name that maps to a dataResourceUid in drMap
 * @param fileContent - The CSV file content to upload
 * @param drMap - The mapping of folder names to dataResourceUids
 */
export async function reloadList(
  parentFolderName: string,
  fileContent: string,
  drMap: DrMap
): Promise<void> {
  const startTime = Date.now();
  console.log(`🚀 Starting reloadList for folder: ${parentFolderName}`);

  try {
    // Step 0: Ensure we have a valid access token
    console.log('🔐 Acquiring access token...');
    await getAccessToken();

    // Step 1: Get the dataResourceUid from drMap
    const isListsTest = process.env.LISTS_API_ENDPOINT!.includes('.test');
    const dataResourceUid =
      drMap[isListsTest ? 'test' : 'prod'][parentFolderName];

    if (!dataResourceUid) {
      throw new Error(
        `No dataResourceUid found for folder: ${parentFolderName}. ` +
          `Available folders: ${Object.keys(drMap.test).join(', ')}`
      );
    }

    // Step 2: Fetch the species list internal ID
    const speciesListID = await fetchSpeciesListId(dataResourceUid);

    // Step 3: Upload the file content
    const localFile = await uploadFileContent(parentFolderName, fileContent);

    // Step 4: Ingest the uploaded file
    await ingestFile(speciesListID, localFile);

    // Step 5: Wait for ingestion to complete
    await waitForIngestionCompletion(speciesListID);

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `✅ Successfully completed reloadList for folder: ${parentFolderName} in ${duration}s`
    );
  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.error(
      `❌ Failed to reload list for folder: ${parentFolderName} after ${duration}s:`,
      error
    );
    throw error;
  }
}
