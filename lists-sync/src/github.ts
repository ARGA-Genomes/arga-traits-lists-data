import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
import { gunzipSync } from 'zlib';

dotenv.config();

// Initialize GitHub API client (optional token for higher rate limits)
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN, // Optional: add GITHUB_TOKEN to .env for higher rate limits
});

// Helper function to fetch file content from GitHub
export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    // Check if it's a file (not a directory)
    if ('content' in response.data && response.data.type === 'file') {
      let content: string;

      // Check if content is available directly (small files)
      if (response.data.content && response.data.content.trim() !== '') {
        // Decode base64 content
        const buffer = Buffer.from(response.data.content, 'base64');

        // Check if file is gzipped based on extension
        if (path.endsWith('.csv.gz')) {
          console.log(`Decompressing gzipped file: ${path}`);
          const decompressed = gunzipSync(buffer);
          content = decompressed.toString('utf8');
        } else {
          content = buffer.toString('utf8');
        }
      }
      // For large files, GitHub provides a download_url instead
      else if (response.data.download_url) {
        console.log(
          `File too large for direct content, downloading from: ${response.data.download_url}`
        );
        const downloadResponse = await fetch(response.data.download_url);
        if (!downloadResponse.ok) {
          throw new Error(
            `Failed to download file: ${downloadResponse.status} ${downloadResponse.statusText}`
          );
        }

        if (path.endsWith('.csv.gz')) {
          console.log(`Decompressing large gzipped file: ${path}`);
          const buffer = Buffer.from(await downloadResponse.arrayBuffer());
          const decompressed = gunzipSync(buffer);
          content = decompressed.toString('utf8');
        } else {
          content = await downloadResponse.text();
        }
      } else {
        return null;
      }

      return content;
    }
    return null;
  } catch (error) {
    console.error(`Failed to fetch content for ${path}:`, error);
    return null;
  }
}

export type DataResourceMap = {
  prod: Record<string, string>;
  test: Record<string, string>;
};

// Helper function to load drs.json from GitHub
export async function loadDrMap(
  owner: string,
  repo: string,
  ref?: string
): Promise<DataResourceMap> {
  try {
    const content = await getFileContent(
      owner,
      repo,
      'drs.json',
      ref || 'HEAD'
    );
    if (!content) {
      throw new Error('Failed to fetch drs.json content from GitHub');
    }
    const newDrMap = JSON.parse(content);

    console.log('Successfully loaded drs.json from GitHub!');
    return newDrMap as DataResourceMap;
  } catch (error) {
    throw new Error(`Failed to load drs.json from GitHub: ${error}`);
  }
}

// Helper function to compare drMaps and format changes for Slack
export function formatDrMapChanges(
  oldDrMap: DataResourceMap,
  newDrMap: DataResourceMap
): string[] {
  // Delta changes
  const prodChanges = compareDrMapSection(
    oldDrMap.prod || {},
    newDrMap.prod || {}
  );
  const testChanges = compareDrMapSection(
    oldDrMap.test || {},
    newDrMap.test || {}
  );

  const messages = [
    '🏭  *Production*',
    ...(prodChanges.length === 0 ? ['No changes'] : prodChanges),
    '',
    '🧪  *Testing*',
    ...(testChanges.length === 0 ? ['No changes'] : testChanges),
  ];

  return messages;
}

// Helper function to check if a file is in imported_GoogleSheets subfolder
export function isImportedGoogleSheetsFile(filename: string): boolean {
  return (
    filename.startsWith('imported_GoogleSheets/') &&
    filename.includes('/') &&
    (filename.endsWith('.csv') || filename.endsWith('.csv.gz'))
  );
}

// Helper function to extract parent folder name from imported_GoogleSheets file path
export function getParentFolderName(filename: string): string | null {
  if (!isImportedGoogleSheetsFile(filename)) return null;
  const parts = filename.split('/');
  if (parts.length >= 3 && parts[0] === 'imported_GoogleSheets') {
    return parts[1]; // Return the subfolder name (e.g., "Edible_species_list")
  }
  return null;
}

// Helper function to find the latest file for a given list name
export async function findLatestFileForList(
  listName: string
): Promise<{ name: string; path: string } | null> {
  try {
    const defaultRepo = process.env.GITHUB_REPO!;
    const [owner, repo] = defaultRepo.split('/');

    // Get contents of the list folder
    const folderPath = `imported_GoogleSheets/${listName}`;
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: folderPath,
    });

    if (!Array.isArray(response.data)) {
      console.error(
        `Expected directory listing for ${folderPath}, got single file`
      );
      return null;
    }

    // Filter for CSV files and sort by name (which should include timestamp)
    const csvFiles = response.data
      .filter(
        (file) =>
          file.type === 'file' &&
          (file.name.endsWith('.csv') || file.name.endsWith('.csv.gz'))
      )
      .sort((a, b) => b.name.localeCompare(a.name)); // Sort descending to get latest first

    if (csvFiles.length === 0) {
      console.log(`No CSV files found in ${folderPath}`);
      return null;
    }

    const latestFile = csvFiles[0];
    console.log(`Found latest file for ${listName}: ${latestFile.name}`);

    return {
      name: latestFile.name,
      path: latestFile.path,
    };
  } catch (error) {
    console.error(`Failed to find latest file for ${listName}:`, error);
    return null;
  }
}

// Helper function to compare a section of drMap
function compareDrMapSection(
  oldSection: Record<string, string>,
  newSection: Record<string, string>
): string[] {
  const changes: string[] = [];

  // Check for additions and modifications
  for (const [key, value] of Object.entries(newSection)) {
    if (!(key in oldSection)) {
      changes.push(`Added: \`${key}\` → \`${value}\``);
    } else if (oldSection[key] !== value) {
      changes.push(
        `Changed: \`${key}\` → \`${oldSection[key]}\` to \`${value}\``
      );
    }
  }

  // Check for removals
  for (const [key, value] of Object.entries(oldSection)) {
    if (!(key in newSection)) {
      changes.push(`Removed: \`${key}\` (was \`${value}\`)`);
    }
  }

  return changes;
}
