import { Octokit } from '@octokit/rest';
import { Webhooks } from '@octokit/webhooks';
import slack from '@slack/bolt';
import dotenv from 'dotenv';
import express from 'express';

import { reloadList } from './lists.js';

const { App: SlackApp } = slack;

// Load environment variables
dotenv.config();

// Initialize drMap variable
let drMap: { prod: Record<string, string>; test: Record<string, string> } = {
  prod: {},
  test: {},
};

const app = express();
const port = process.env.PORT || 3000;

// Validate required environment variables
const requiredEnvVars = [
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_REPO',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CHANNEL_ID',
  'LISTS_API_ENDPOINT',
  'LISTS_AUTH_CLIENT_ID',
  'LISTS_AUTH_CLIENT_SECRET',
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Initialize GitHub Webhooks
const webhooks = new Webhooks({
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
});

// Initialize GitHub API client (optional token for higher rate limits)
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN, // Optional: add GITHUB_TOKEN to .env for higher rate limits
});

// Initialize Slack App
const slackApp = new SlackApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

// Helper function to check if a file is in an imported_ folder
function isImportedFile(filename: string): boolean {
  const pathSegments = filename.split('/');
  return pathSegments.some((segment) => segment.startsWith('imported_'));
}

// Helper function to check if a file is in imported_GoogleSheets subfolder
function isImportedGoogleSheetsFile(filename: string): boolean {
  return (
    filename.startsWith('imported_GoogleSheets/') && filename.includes('/')
  );
}

// Helper function to extract parent folder name from imported_GoogleSheets file path
function getParentFolderName(filename: string): string | null {
  if (!isImportedGoogleSheetsFile(filename)) return null;
  const parts = filename.split('/');
  if (parts.length >= 3 && parts[0] === 'imported_GoogleSheets') {
    return parts[1]; // Return the subfolder name (e.g., "Edible_species_list")
  }
  return null;
}

// Helper function to load drs.json from GitHub
async function loadDrMapFromGitHub(
  owner: string,
  repo: string,
  ref?: string
): Promise<void> {
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
    drMap = newDrMap;
    console.log('Successfully loaded drs.json from GitHub:', drMap);
  } catch (error) {
    throw new Error(`Failed to load drs.json from GitHub: ${error}`);
  }
}

// Helper function to compare drMaps and format changes for Slack
function formatDrMapChanges(oldDrMap: any, newDrMap: any): string {
  let message = '🔄 *DRS Configuration Updated*\n\n';

  // Production changes
  message += '🏭 *Production*\n';
  const prodChanges = compareDrMapSection(
    oldDrMap.prod || {},
    newDrMap.prod || {}
  );
  if (prodChanges.length === 0) {
    message += '• No changes\n';
  } else {
    message += prodChanges.join('\n') + '\n';
  }

  message += '\n🧪 *Testing*\n';
  const testChanges = compareDrMapSection(
    oldDrMap.test || {},
    newDrMap.test || {}
  );
  if (testChanges.length === 0) {
    message += '• No changes\n';
  } else {
    message += testChanges.join('\n') + '\n';
  }

  return message;
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
      changes.push(`• Added: \`${key}\` → \`${value}\``);
    } else if (oldSection[key] !== value) {
      changes.push(
        `• Changed: \`${key}\` → \`${oldSection[key]}\` to \`${value}\``
      );
    }
  }

  // Check for removals
  for (const [key, value] of Object.entries(oldSection)) {
    if (!(key in newSection)) {
      changes.push(`• Removed: \`${key}\` (was \`${value}\`)`);
    }
  }

  return changes;
}

// Helper function to fetch file content from GitHub
async function getFileContent(
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
      // Check if content is available directly (small files)
      if (response.data.content && response.data.content.trim() !== '') {
        // Decode base64 content
        const content = Buffer.from(response.data.content, 'base64').toString(
          'utf8'
        );
        return content;
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
        const content = await downloadResponse.text();
        return content;
      }
    }
    return null;
  } catch (error) {
    console.error(`Failed to fetch content for ${path}:`, error);
    return null;
  }
}

// Helper function to send Slack notification
async function sendSlackNotification(message: string) {
  try {
    await slackApp.client.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID!,
      text: message,
      mrkdwn: true,
    });
    console.log('Slack notification sent successfully');
  } catch (error) {
    console.error('Error sending Slack notification:', error);
  }
}

// Handle push events (commits)
webhooks.on('push', async ({ payload }) => {
  const pushEvent = payload;

  console.log(`Received push event for ${pushEvent.repository.full_name}`);

  // Only process pushes to the main branch
  const branch = pushEvent.ref.replace('refs/heads/', '');
  if (branch !== 'main') {
    console.log(
      `Ignoring push to branch '${branch}' - only processing 'main' branch`
    );
    return;
  }

  console.log(`Processing push to main branch`);

  // Extract owner and repo from the repository full_name
  const [owner, repo] = pushEvent.repository.full_name.split('/');
  const commitSha = pushEvent.head_commit?.id || pushEvent.after;

  // Collect all changed files from all commits
  const allAdded: string[] = [];
  const allModified: string[] = [];
  const allRemoved: string[] = [];

  pushEvent.commits.forEach((commit) => {
    allAdded.push(...(commit.added || []));
    allModified.push(...(commit.modified || []));
    allRemoved.push(...(commit.removed || []));
  });

  // Check if drs.json was modified
  const drJsonModified =
    allModified.includes('drs.json') || allAdded.includes('drs.json');
  if (drJsonModified) {
    console.log('drs.json was modified, updating drMap...');
    try {
      const oldDrMap = JSON.parse(JSON.stringify(drMap)); // Deep copy
      await loadDrMapFromGitHub(owner, repo, commitSha);

      // Send Slack notification about drMap changes
      const changeMessage = formatDrMapChanges(oldDrMap, drMap);
      await sendSlackNotification(changeMessage);
    } catch (error) {
      console.error('Failed to update drMap after drs.json change:', error);
      await sendSlackNotification(
        `❌ *Error updating DRS configuration*\n\nFailed to load updated drs.json: ${error}`
      );
    }
  }

  // Handle imported_GoogleSheets file additions
  const importedGoogleSheetsAdded = allAdded
    .filter(isImportedGoogleSheetsFile)
    .slice(0, 1);

  for (const addedFile of importedGoogleSheetsAdded) {
    const parentFolderName = getParentFolderName(addedFile);
    if (parentFolderName) {
      console.log(`Processing new file in imported_GoogleSheets: ${addedFile}`);
      const fileName = addedFile.split('/').pop();

      try {
        const fileContent = await getFileContent(
          owner,
          repo,
          addedFile,
          commitSha
        );

        if (fileContent) {
          console.log(`Calling reloadList for folder: ${parentFolderName}`);
          await reloadList(parentFolderName, fileContent, drMap);
          await sendSlackNotification(
            `✅ *List Reload Completed*\n\n- File: \`${fileName}\`\n- Folder: <https://github.com/${pushEvent.repository.full_name}/tree/main/${parentFolderName}|${parentFolderName}>`
          );
        } else {
          console.error(`Failed to fetch content for ${addedFile}`);
          await sendSlackNotification(
            `❌ *List Reload Failed*\n\nFailed to fetch content for: \`${fileName}\``
          );
        }
      } catch (error) {
        console.error(`Failed to reload list for ${addedFile}:`, error);
        await sendSlackNotification(
          `❌ *List Reload Failed*\n\nError processing \`${fileName}\`: ${error}`
        );
      }
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'arga-lists-sync',
  });
});

// Webhook endpoint
app.use(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      await webhooks.verifyAndReceive({
        id: req.headers['x-github-delivery'] as string,
        name: req.headers['x-github-event'] as any,
        signature: req.headers['x-hub-signature-256'] as string,
        payload: req.body.toString(),
      });
      res.status(200).send('OK');
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(400).send('Bad Request');
    }
  }
);

// Error handling middleware
app.use(
  (
    error: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
);

// Start the server
async function startServer() {
  // Load drs.json from repository before starting server
  console.log('Loading drs.json from repository...');
  try {
    const defaultRepo = process.env.GITHUB_REPO!;
    const [owner, repo] = defaultRepo.split('/');

    await loadDrMapFromGitHub(owner, repo);
  } catch (error) {
    console.error('Failed to load initial drs.json:', error);
    console.error('Server cannot start without drs.json configuration');
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`🚀 ARGA Lists Sync server running on port ${port}`);
    console.log(`📡 Webhook endpoint: http://localhost:${port}/webhook`);
    console.log(`🏥 Health check: http://localhost:${port}/health`);
    console.log(`🔍 Monitoring files in 'imported_*' folders`);
    console.log(
      `📋 Loaded DRS configuration with ${
        Object.keys(drMap.test).length
      } test environments and ${
        Object.keys(drMap.prod).length
      } production environments`
    );
  });
}

// Start the server
startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});
