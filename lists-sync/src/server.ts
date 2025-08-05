import { Octokit } from '@octokit/rest';
import { Webhooks } from '@octokit/webhooks';
import slack from '@slack/bolt';
import dotenv from 'dotenv';
import express from 'express';
import fsp from 'fs/promises';

const { App: SlackApp } = slack;

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Validate required environment variables
const requiredEnvVars = [
  'GITHUB_WEBHOOK_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CHANNEL_ID',
  'LISTS_API_ENDPOINT',
  'LISTS_TOKEN',
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
      // Decode base64 content
      const content = Buffer.from(response.data.content, 'base64').toString(
        'utf8'
      );
      return content;
    }
    return null;
  } catch (error) {
    console.error(`Failed to fetch content for ${path}:`, error);
    return null;
  }
}

// Helper function to format file changes for Slack
function formatFileChanges(files: string[], changeType: string): string {
  if (files.length === 0) return '';

  const importedFiles = files.filter(isImportedFile);
  if (importedFiles.length === 0) return '';

  const emoji =
    changeType === 'added' ? '🆕' : changeType === 'modified' ? '📝' : '🗑️';
  return `${emoji} *${changeType.toUpperCase()}:*\n${importedFiles
    .map((file) => `• \`${file}\``)
    .join('\n')}\n`;
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

  // Collect all changed files from all commits
  const allAdded: string[] = [];
  const allModified: string[] = [];
  const allRemoved: string[] = [];

  pushEvent.commits.forEach((commit) => {
    allAdded.push(...(commit.added || []));
    allModified.push(...(commit.modified || []));
    allRemoved.push(...(commit.removed || []));
  });

  // Filter for imported_ files
  const importedAdded = allAdded.filter(isImportedFile);
  const importedModified = allModified.filter(isImportedFile);
  const importedRemoved = allRemoved.filter(isImportedFile);

  // Get content of the first added file if any
  let firstAddedFileContent: string | null = null;
  if (importedAdded.length > 0) {
    const firstAddedFile = importedAdded[0];
    console.log(`Fetching content for first added file: ${firstAddedFile}`);

    // Extract owner and repo from the repository full_name
    const [owner, repo] = pushEvent.repository.full_name.split('/');

    // Get the commit SHA to fetch the file at that specific version
    const commitSha = pushEvent.head_commit?.id || pushEvent.after;

    firstAddedFileContent = await getFileContent(
      owner,
      repo,
      firstAddedFile,
      commitSha
    );

    if (firstAddedFileContent) {
      console.log(
        `Successfully fetched content for ${firstAddedFile} (${firstAddedFileContent.length} characters)`
      );
      // Log first 200 characters as preview
      const preview = firstAddedFileContent.substring(0, 200);
      console.log(
        `Content preview: ${preview}${
          firstAddedFileContent.length > 200 ? '...' : ''
        }`
      );
    } else {
      console.log(`Failed to fetch content for ${firstAddedFile}`);
    }
  }

  // Log changes
  if (
    importedAdded.length > 0 ||
    importedModified.length > 0 ||
    importedRemoved.length > 0
  ) {
    console.log('Changes detected in imported_ folders:');
    if (importedAdded.length > 0) {
      console.log('Added files:', importedAdded);
    }
    if (importedModified.length > 0) {
      console.log('Modified files:', importedModified);
    }
    if (importedRemoved.length > 0) {
      console.log('Removed files:', importedRemoved);
    }

    // Create Slack message
    const branch = pushEvent.ref.replace('refs/heads/', '');
    const commitCount = pushEvent.commits.length;
    const totalChangedFiles =
      importedAdded.length + importedModified.length + importedRemoved.length;

    let slackMessage = `🚀 *ARGA Traits Data Update*\n\n`;
    slackMessage += `📂 Repository: <${pushEvent.repository.html_url}|${pushEvent.repository.full_name}>\n`;
    slackMessage += `🌿 Branch: \`${branch}\`\n`;
    slackMessage += `👤 Author: ${pushEvent.head_commit?.author.name}\n`;
    slackMessage += `📊 ${totalChangedFiles} file(s) changed in imported_ folders across ${commitCount} commit(s)\n\n`;

    // Add file changes
    const addedText = formatFileChanges(importedAdded, 'added');
    const modifiedText = formatFileChanges(importedModified, 'modified');
    const removedText = formatFileChanges(importedRemoved, 'removed');

    if (addedText) slackMessage += addedText;
    if (modifiedText) slackMessage += modifiedText;
    if (removedText) slackMessage += removedText;

    // Add latest commit info
    slackMessage += `\n💬 *Latest commit:* ${pushEvent.head_commit?.message}\n`;
    slackMessage += `🔗 <${pushEvent.compare}|View changes>\n`;
    slackMessage += `🔗 <${pushEvent.head_commit?.url}|View commit>`;

    console.log(slackMessage);
    // await sendSlackNotification(slackMessage);
  } else {
    console.log('No changes detected in imported_ folders');
  }

  await fsp.writeFile(
    `./payload-${Date.now()}.json`,
    JSON.stringify(payload, null, 2),
    'utf8'
  );
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
app.listen(port, () => {
  console.log(`🚀 ARGA Lists Sync server running on port ${port}`);
  console.log(`📡 Webhook endpoint: http://localhost:${port}/webhook`);
  console.log(`🏥 Health check: http://localhost:${port}/health`);
  console.log(`🔍 Monitoring files in 'imported_*' folders`);
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
