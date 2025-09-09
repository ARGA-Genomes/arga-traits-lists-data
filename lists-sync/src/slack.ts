import slack from '@slack/bolt';
import dotenv from 'dotenv';

import {
  DataResourceMap,
  findLatestFileForList,
  getFileContent,
} from './github.js';
import { reloadList } from './lists.js';

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

// Store drMap reference that will be set from server.ts
let drMap: DataResourceMap = { prod: {}, test: {} };

// Function to set drMap from server.ts
export function setDrMap(newDrMap: DataResourceMap) {
  drMap = newDrMap;
}

type Blocks = (slack.webApi.Block | slack.webApi.KnownBlock)[];

export function createMessageBlocks(
  title: string,
  initialMessages?: string[],
  gitHubLink?: string,
  alaLink?: string
): (message?: string | string[]) => Blocks {
  const messages: string[] = initialMessages || [];

  return (message) => {
    if (Array.isArray(message)) {
      messages.push(...message);
    } else if (message) {
      messages.push(message);
    }

    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: title,
          emoji: true,
        },
      },
      ...(gitHubLink && alaLink
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `View list on <${gitHubLink}|GitHub>, or <${alaLink}|ALA>`,
              },
            } as slack.webApi.KnownBlock,
          ]
        : []),
      {
        type: 'divider',
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: messages.join('\n'),
          },
        ],
      },
    ];
  };
}

async function updateReloadMessage(
  message: slack.webApi.ChatPostMessageResponse,
  blocks: Blocks
) {
  await slackApp.client.chat.update({
    ts: message.ts!,
    channel: message.channel!,
    blocks,
  });
}

slackApp.command('/reload', async ({ command, ack, say }) => {
  // Acknowledge the command immediately
  await ack();

  const listName = command.text.trim();

  if (!listName) {
    await say(
      '❌ *Usage:* `/reload [list_name]`\n\nExample: `/reload Edible_species_list`\n\nTo see available lists, use `/lists`'
    );
    return;
  }

  // Check if list exists in drMap
  const isListsTest = process.env.LISTS_API_ENDPOINT!.includes('.test');
  const environment = isListsTest ? 'test' : 'prod';
  const dataResourceUid = drMap[environment][listName];

  if (!dataResourceUid) {
    await say(
      `❌  List not found in configuration! Check \`drs.json\` for available lists.`
    );
    return;
  }

  const gitHubLink = `https://github.com/${process.env
    .GITHUB_REPO!}/tree/main/imported_GoogleSheets/${listName}`;
  const alaLink = `https://lists${
    environment === 'test' ? '.test' : ''
  }.ala.org.au/list/${dataResourceUid}`;

  // Send initial response
  const updateBlocks = createMessageBlocks(
    `List reload: ${listName}`,
    [],
    gitHubLink,
    alaLink
  );
  const message = await say({
    blocks: updateBlocks(`🔄  Starting reload for list *${listName}*`),
  });

  try {
    // Find the latest file for this list
    const latestFile = await findLatestFileForList(listName);

    if (!latestFile) {
      await updateReloadMessage(
        message,
        updateBlocks(
          `❌  No files found for list *${listName}*, please ensure there are CSV files in the \`imported_GoogleSheets/${listName}/\` folder.`
        )
      );
      return;
    }

    // Generate links
    await updateReloadMessage(
      message,
      updateBlocks(
        `📁  Found latest file \`${latestFile.name}\`, downloading and processing...`
      )
    );

    // Get file content
    const defaultRepo = process.env.GITHUB_REPO!;
    const [owner, repo] = defaultRepo.split('/');
    const fileContent = await getFileContent(
      owner,
      repo,
      latestFile.path,
      'HEAD'
    );

    if (!fileContent) {
      await updateReloadMessage(
        message,
        updateBlocks(`❌  *Failed to download file:* \`${latestFile.name}\``)
      );
      return;
    }

    await updateReloadMessage(
      message,
      updateBlocks(`🚀  Starting list reload process...`)
    );

    // Reload the list
    await reloadList(listName, fileContent, drMap);

    await updateReloadMessage(
      message,
      updateBlocks(`✅  List reload completed successfully!`)
    );
  } catch (error) {
    console.error(`Slash command reload failed for ${listName}:`, error);
    await updateReloadMessage(
      message,
      updateBlocks(
        `❌  List reload failed for: *${listName}*\n\n*Error:* ${error}`
      )
    );
  }
});

slackApp.command('/clean', async ({ command, ack, say }) => {
  await ack();

  const timeStamps = command.text.trim().split(',');

  if (timeStamps.length < 1) {
    console.log('❌ No timestamps supplied');
    return;
  }

  try {
    await Promise.all(
      timeStamps.map((ts) =>
        slackApp.client.chat.delete({
          channel: process.env.SLACK_CHANNEL_ID!,
          ts,
        })
      )
    );
  } catch (error) {
    console.error('Clean command failed:', error);
  }
});

// Helper function to send Slack notification
export async function sendSlackNotification(data: string | Blocks) {
  try {
    await slackApp.client.chat.postMessage(
      typeof data === 'string'
        ? {
            channel: process.env.SLACK_CHANNEL_ID!,
            text: data as string,
            mrkdwn: true,
          }
        : {
            channel: process.env.SLACK_CHANNEL_ID!,
            blocks: data,
          }
    );
    console.log('Slack notification sent successfully');
  } catch (error) {
    console.error('Error sending Slack notification:', error);
  }
}
