import slack from '@slack/bolt';
import dotenv from 'dotenv';
import express from 'express';

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
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Initialize Slack App
const slackApp = new SlackApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

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

// Helper function to send Slack notification
async function deleteSlackMessage() {
  try {
    await slackApp.client.chat.delete({
      channel: process.env.SLACK_CHANNEL_ID!,
      ts: '1754350479.609999',
    });
    console.log('Slack message deleted successfully');
  } catch (error) {
    console.error('Error deleting message:', error);
  }
}

deleteSlackMessage();
// sendSlackNotification('Testing notification');
