import slack from '@slack/bolt';
import dotenv from 'dotenv';

dotenv.config();

const { App, ExpressReceiver } = slack;

export const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  endpoints: '/slack/events',
});

// Initialize Slack App
const slackApp = new App({
  receiver,
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

slackApp.command('/reload', async ({ command, ack, say }) => {
  await ack();
  say;
});

slackApp.command('/clean', async ({ command, ack, say }) => {
  await ack();
  console.log(command);
});

// Helper function to send Slack notification
export async function sendSlackNotification(message: string) {
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
