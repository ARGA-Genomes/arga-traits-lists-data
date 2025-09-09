import { Webhooks } from '@octokit/webhooks';
import dotenv from 'dotenv';
import express from 'express';

import {
  DataResourceMap,
  formatDrMapChanges,
  getFileContent,
  getParentFolderName,
  isImportedGoogleSheetsFile,
  loadDrMap,
} from './github.js';
import { reloadList } from './lists.js';
import { receiver, sendSlackNotification } from './slack.js';

// Load environment variables
dotenv.config();

// Initialize drMap variable
let drMap: DataResourceMap = {
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
      drMap = await loadDrMap(owner, repo, commitSha);

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
            `✅ *List Reload Completed*\n\n• File: \`${fileName}\`\n• Folder: <https://github.com/${pushEvent.repository.full_name}/tree/main/imported_GoogleSheets/${parentFolderName}|${parentFolderName}>`
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
      // First, verify the webhook signature to ensure it's legitimate
      const signature = req.headers['x-hub-signature-256'] as string;
      const payload = req.body.toString();

      // Verify signature using the webhooks instance
      const isValid = webhooks.verify(payload, signature);

      if (!isValid) {
        console.error('Invalid webhook signature');
        res.status(401).send('Unauthorized');
        return;
      }

      // Signature is valid, immediately respond with 200 OK to prevent timeouts
      res.status(200).send('OK');

      // Parse the payload as JSON for the receive method
      const parsedPayload = JSON.parse(payload);

      // Process webhook asynchronously after responding
      setImmediate(async () => {
        try {
          await webhooks.receive({
            id: req.headers['x-github-delivery'] as string,
            name: req.headers['x-github-event'] as any,
            payload: parsedPayload,
          });
        } catch (error) {
          console.error('Webhook processing error:', error);
          // Error handling will be logged and reported via Slack notifications
        }
      });
    } catch (error) {
      console.error('Webhook verification error:', error);
      res.status(400).send('Bad Request');
    }
  }
);

// Slack events middleware
app.use('/slack/events', receiver.router);

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

    drMap = await loadDrMap(owner, repo);
  } catch (error) {
    console.error('Failed to load initial drs.json:', error);
    console.error('Server cannot start without drs.json configuration');
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`🚀 ARGA Lists Sync server running on port ${port}`);
    console.log(`📡 Webhook endpoint: http://localhost:${port}/webhook`);
    console.log(
      `💬 Slack events endpoint: http://localhost:${port}/slack/events`
    );
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
