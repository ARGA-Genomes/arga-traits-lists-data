# ARGA - Traits Lists Sync Server
A service that monitors changes to files in `imported_*` folders in the ARGA traits lists data repository, syncs them with the [ALA Lists Tool](https://lists.test.ala.org.au), and reports them to Slack.

## Features

- 🚀 GitHub webhook integration using `@octokit/webhooks`
- 📢 Slack bot notifications for file changes
- 🔍 Monitors only files in folders prefixed with `imported_`
- 🐳 Fully containerized with Docker
- 🏥 Health check endpoints

## Prerequisites

- Node.js 20+ (for local development)
- Docker
- GitHub repository with webhook access
- Slack workspace with bot permissions

## Quick Start

### 1. Environment Setup

Copy the example environment file and configure your settings:

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
# GitHub Configuration
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here
GITHUB_TOKEN=your_github_personal_access_token_here_optional

# Slack Configuration
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token-here
SLACK_SIGNING_SECRET=your_slack_signing_secret_here
SLACK_CHANNEL_ID=your_slack_channel_id_here

# Server Configuration
PORT=3000
NODE_ENV=production
```

### 2. GitHub Webhook Setup

1. Go to your repository settings → Webhooks
2. Click "Add webhook"
3. Set the payload URL to: `https://yourdomain.com/webhook`
4. Set content type to: `application/json`
5. Set the secret to match your `GITHUB_WEBHOOK_SECRET`
6. Select events: "Push" and "Pull requests" (optional)
7. Save the webhook

**Optional: GitHub Personal Access Token**

To fetch file contents and avoid rate limiting, you can optionally provide a GitHub Personal Access Token:

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate a new token with `repo` scope (for private repos) or `public_repo` scope (for public repos only)
3. Add the token to your `.env` file as `GITHUB_TOKEN`

### 3. Slack Bot Setup

1. Go to [Slack API](https://api.slack.com/apps)
2. Create a new app or use an existing one
3. Navigate to "OAuth & Permissions"
4. Add these bot token scopes:
   - `chat:write`
   - `chat:write.public`
5. Install the app to your workspace
6. Copy the "Bot User OAuth Token" to your `.env` file
7. Get your Signing Secret from "Basic Information" → "App Credentials"
8. Find your channel ID by right-clicking a channel → "View channel details"

### 4. Deployment

#### Option A: Docker Compose (Recommended)

```bash
# Make deployment script executable
chmod +x deploy.sh

# Deploy the service
./deploy.sh
```

#### Option B: Manual Docker

```bash
# Build the image
docker build -t arga-lists-sync .

# Run the container
docker run -p 3000:3000 --env-file .env arga-lists-sync
```

#### Option C: Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Or build and run
npm run build
npm start
```

## API Endpoints

- `GET /health` - Health check endpoint
- `POST /webhook` - GitHub webhook endpoint

## Monitoring

The service monitors all files in folders that start with `imported_` and reports:

- ✅ Files added
- 📝 Files modified  
- 🗑️ Files removed

### Example Slack Notification

```
🚀 ARGA Traits Data Update

📂 Repository: ARGA-Genomes/arga-traits-lists-data
🌿 Branch: main
👤 Author: John Doe
📊 3 file(s) changed in imported_ folders across 2 commit(s)

🆕 ADDED:
• imported_GoogleSheets/Edible_species_list/new_data.csv

📝 MODIFIED:
• imported_GoogleSheets/Industry_and_commerce_list/existing_data.csv

💬 Latest commit: Update species data with new entries
🔗 View changes
🔗 View commit
```

## File Structure

```
lists-sync/
├── server.ts              # Main webhook server
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── Dockerfile             # Container definition
├── .env.example           # Environment template
├── .gitignore            # Git ignore rules
└── README.md             # This file
```

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode (with auto-reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

### Testing Webhooks Locally

Use a tool like [ngrok](https://ngrok.com/) to expose your local server:

```bash
# Install ngrok
npm install -g ngrok

# Expose port 3000
ngrok http 3000

# Use the provided HTTPS URL in your GitHub webhook settings
```

## Troubleshooting

### Common Issues

1. **Service not starting**: Check environment variables in `.env`
2. **GitHub webhook not working**: Verify webhook secret and URL
3. **Slack notifications not sending**: Check bot token and channel ID
4. **Permission errors**: Ensure Slack bot has proper scopes

### Viewing Logs

```bash
# Docker logs
docker logs <container-id>

# Local development logs appear in console
```

### Health Check

```bash
# Check if service is running
curl http://localhost:3000/health

# Expected response:
{
  "status": "healthy",
  "timestamp": "2025-08-05T12:00:00.000Z",
  "service": "arga-lists-sync"
}
```

## Security

- Environment variables are used for all sensitive configuration
- Non-root user in Docker container
- GitHub webhook signature verification
- Slack signing secret verification

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see the [LICENSE](../LICENSE) file for details.
