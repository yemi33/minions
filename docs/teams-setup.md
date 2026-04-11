# Teams Integration Setup

End-to-end guide for connecting Minions to Microsoft Teams via Azure Bot Framework. After completing these steps, messages sent to a Teams channel will be routed to the Minions Command Center, and agent events (completions, PR merges, plan updates) will be posted back to Teams.

**Prerequisites:**

- An Azure subscription (free tier works)
- Azure CLI installed (`az --version`) or access to the [Azure Portal](https://portal.azure.com)
- Dev Tunnel CLI installed (`devtunnel --version`) — see [Step 5](#step-5-set-up-dev-tunnel) for installation
- Minions dashboard running locally (`minions dash`)
- Admin or owner permissions on the target Teams team (for side-loading)

## Step 1: Create an Azure Bot Resource

1. Open the [Azure Portal](https://portal.azure.com) and search for **Azure Bot** in the top search bar.
2. Click **Create**.
3. Fill in the basics:
   - **Bot handle**: A unique name (e.g., `minions-bot`). This is the internal identifier — it doesn't appear in Teams.
   - **Subscription**: Select your Azure subscription.
   - **Resource group**: Create a new one (e.g., `rg-minions`) or use an existing one.
   - **Data residency**: Choose **Global** unless you have regional compliance requirements.
   - **Pricing tier**: Select **F0 (Free)** for development.
4. Under **Microsoft App ID**, select **Single Tenant**.
   - Choose **Create new Microsoft App ID**.
   - This creates a new Entra ID (Azure AD) app registration for the bot.

   > **Why Single Tenant?** Single-tenant bots only accept tokens from your Azure AD tenant, which is more secure for an internal tool like Minions. Multi-tenant is needed only if the bot must work across organizations.

5. Click **Review + create**, then **Create**.
6. Wait for deployment to complete (usually under 1 minute), then click **Go to resource**.

## Step 2: Configure the Teams Channel

1. In your Azure Bot resource, click **Channels** in the left sidebar.
2. Click the **Microsoft Teams** icon in the available channels list.
3. Accept the Terms of Service.
4. Leave the channel settings at defaults:
   - **Messaging** tab: Enabled (default).
   - **Calling** and **Group Chat** tabs: Leave disabled unless needed.
5. Click **Apply**.

The Teams channel should now appear as **Running** in the channels list.

## Step 3: Obtain App ID and App Password

You need two credentials: the **App ID** (also called Microsoft App ID or Client ID) and the **App Password** (a client secret).

### Get the App ID

1. In your Azure Bot resource, click **Configuration** in the left sidebar.
2. Copy the **Microsoft App ID** value. This is a GUID like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`.
3. Save it — you'll add it to your Minions config.

### Create an App Password (Client Secret)

1. On the same **Configuration** page, click **Manage Password** next to the Microsoft App ID. This opens the Entra ID app registration.
2. In the app registration, click **Certificates & secrets** in the left sidebar.
3. Click **New client secret**.
4. Enter a description (e.g., `minions-bot-secret`) and choose an expiry (e.g., 24 months).
5. Click **Add**.
6. **Immediately copy the secret Value** (not the Secret ID). It is shown only once — if you navigate away, you cannot retrieve it again.

### Add Credentials to Minions Config

Add a `teams` section to your `config.json`:

```json
{
  "projects": [ ... ],
  "agents": { ... },
  "engine": { ... },
  "teams": {
    "enabled": true,
    "appId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "appPassword": "your-client-secret-value-here",
    "notifyEvents": ["pr-merged", "agent-completed", "plan-completed", "agent-failed"],
    "ccMirror": true,
    "inboxPollInterval": 15000
  }
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Master switch — `true` to activate Teams integration |
| `appId` | Microsoft App ID from the Azure Bot Configuration page |
| `appPassword` | Client secret value from Entra ID Certificates & secrets |
| `notifyEvents` | Which events trigger Teams notifications (see below) |
| `ccMirror` | Mirror CC dashboard responses to Teams (`true`/`false`) |
| `inboxPollInterval` | How often to check for new Teams messages, in ms (default: 15000) |

**Available notification events:** `pr-merged`, `agent-completed`, `plan-completed`, `agent-failed`, `pr-abandoned`, `pr-approved`, `pr-build-failed`, `plan-approved`, `plan-rejected`, `verify-created`

> **Security note:** `config.json` is gitignored by default and should never be committed. For shared machines, consider setting the app password via an environment variable and reading it in your config setup.

## Step 4: Set the Messaging Endpoint

The messaging endpoint is the URL that Azure Bot Framework sends incoming messages to. It must point to your Minions dashboard's `/api/bot` route.

1. In your Azure Bot resource, click **Configuration** in the left sidebar.
2. Set the **Messaging endpoint** to:
   ```
   https://<your-tunnel-url>/api/bot
   ```
   For local development, this will be your Dev Tunnel URL (see [Step 5](#step-5-set-up-dev-tunnel)).

   For example: `https://abc123.devtunnels.ms/api/bot`

3. Click **Apply** to save.

> The endpoint must be **HTTPS**. Bot Framework will not send messages to plain HTTP URLs. Dev Tunnels and production hosting (Azure App Service, etc.) both provide HTTPS by default.

> Changes to the messaging endpoint take effect immediately — no need to reinstall the bot in Teams.

## Step 5: Set Up Dev Tunnel

[Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview) create a public HTTPS URL that forwards traffic to your local machine. This lets Azure Bot Framework reach your locally running dashboard.

### Install Dev Tunnel CLI

If you don't have it installed:

```bash
# Windows (winget)
winget install Microsoft.devtunnel

# macOS (Homebrew)
brew install --cask devtunnel

# Linux (curl)
curl -sL https://aka.ms/DevTunnelCliInstall | bash
```

### Authenticate

```bash
devtunnel user login
```

This opens a browser for Microsoft account authentication. Sign in with the same account that has access to your Azure subscription.

### Start the Tunnel

```bash
devtunnel host -p 7331 --allow-anonymous
```

- `-p 7331` forwards to the Minions dashboard port.
- `--allow-anonymous` allows Bot Framework to reach the endpoint without additional auth (the Bot Framework adapter handles its own authentication via the App ID and Password).

You'll see output like:

```
Connect via browser: https://abc123.devtunnels.ms
Inspect network activity: https://abc123-7331.devtunnels.ms

Hosting port: 7331
  Connect via browser: https://abc123-7331.devtunnels.ms
```

### Copy the Forwarding URL to Azure Bot

1. Copy the **port-specific** tunnel URL from the output (e.g., `https://abc123-7331.devtunnels.ms`).
2. Go back to your Azure Bot resource > **Configuration**.
3. Set the **Messaging endpoint** to:
   ```
   https://abc123-7331.devtunnels.ms/api/bot
   ```
4. Click **Apply**.

### Persistent Tunnel (Optional)

By default, the tunnel URL changes each time you restart `devtunnel host`. To get a persistent URL:

```bash
# Create a named tunnel
devtunnel create minions-tunnel

# Add the port
devtunnel port create minions-tunnel -p 7331

# Host with anonymous access
devtunnel host minions-tunnel --allow-anonymous
```

The named tunnel keeps the same URL across restarts — you won't need to update the Azure Bot messaging endpoint each time.

### Verify Connectivity

With the tunnel running and the dashboard started (`minions dash`), open the tunnel URL in a browser:

```
https://abc123-7331.devtunnels.ms/api/routes
```

You should see the Minions API route list as JSON. If you get a connection error, check that:
- The dashboard is running (`minions dash`)
- The tunnel is active (`devtunnel host` is still running)
- The port number matches (7331)

## Step 6: Install the Bot in Teams

There are two ways to add the bot to a Teams channel: via App Studio / Teams Developer Portal (recommended for development) or via the Teams Admin Center (for org-wide deployment).

### Option A: Teams Developer Portal (Recommended for Development)

1. Open [Teams Developer Portal](https://dev.teams.microsoft.com/apps) in a browser.
2. Click **New app**.
3. Fill in the app details:
   - **Name**: `Minions Bot` (or any display name)
   - **Short description**: `Minions agent orchestration`
   - **Developer name**: Your name or team name
   - **Website**: `https://github.com/yemi33/minions` (or any URL)
   - **Privacy policy** and **Terms of use**: Can be any URL for development
4. Under **App features**, click **Bot**.
5. Select **Enter a bot ID manually** and paste the **App ID** from [Step 3](#step-3-obtain-app-id-and-app-password).
6. Check the scopes:
   - **Team** — enables the bot in team channels
   - **Group chat** — optional, enables the bot in group chats
7. Click **Save**.
8. Click **Publish** > **Publish to your org** (or **Download app package** to side-load manually).

### Side-Load the App Package

If your organization doesn't allow direct publishing:

1. In the Developer Portal, click **Download app package** to get a `.zip` file.
2. Open Microsoft Teams.
3. Click **Apps** in the left sidebar.
4. Click **Manage your apps** > **Upload an app**.
5. Select **Upload a custom app** (or **Upload a custom app for [org name]** if you have admin rights).
6. Choose the downloaded `.zip` file.
7. In the app details dialog, click **Add to a team**.
8. Select the team and channel where you want the bot.
9. Click **Set up a bot**.

### Option B: Teams Admin Center (Org-Wide Deployment)

For deploying to all users or specific groups:

1. Open [Teams Admin Center](https://admin.teams.microsoft.com/).
2. Go to **Teams apps** > **Manage apps**.
3. Click **Upload new app** and upload the app package `.zip`.
4. Go to **Teams apps** > **Setup policies**.
5. Edit the relevant policy and add the Minions Bot to the **Installed apps** list.

### Verify the Bot Works

1. Open the Teams channel where you installed the bot.
2. Send a message that @mentions the bot:
   ```
   @Minions Bot hello
   ```
3. If everything is configured correctly, the message will:
   - Reach your dashboard via the Dev Tunnel
   - Be written to `engine/teams-inbox.json`
   - Be processed by the CC on the next poll cycle
   - The CC response will appear as a thread reply in Teams

If you don't see a response, check:
- **Dashboard logs**: Look for incoming `/api/bot` requests
- **Dev Tunnel**: Ensure it's still running and the URL matches the Azure Bot messaging endpoint
- **Azure Bot**: Test the bot connection in the Azure Portal via **Test in Web Chat** (Configuration page)
- **Config**: Verify `config.json` has `teams.enabled: true` and correct `appId`/`appPassword`

## Troubleshooting

### "Unauthorized" or 401 Errors

The App ID or App Password in `config.json` doesn't match what's registered in Azure. Double-check:
- The App ID matches the Azure Bot's **Microsoft App ID** on the Configuration page.
- The App Password is the client secret **Value** (not the Secret ID) from Entra ID.
- The client secret hasn't expired.

### "Endpoint not reachable" in Azure Bot Test

- Verify the Dev Tunnel is running: `devtunnel host -p 7331 --allow-anonymous`
- Verify the messaging endpoint URL ends with `/api/bot`
- Verify the dashboard is running: `minions dash`
- Try opening the tunnel URL in a browser to confirm it's accessible

### Bot Doesn't Respond in Teams

- Check `engine/teams-inbox.json` — if messages appear there, the webhook is working but the CC processing loop may not be running.
- Check that the engine is running: `minions start`
- Check the engine logs for Teams-related errors.
- Ensure `config.teams.enabled` is `true`.

### "App not found" When Side-Loading

- Your Teams admin may have disabled custom app side-loading. Contact your Teams admin to enable **Upload custom apps** in the Teams Admin Center > Setup policies.
- Alternatively, ask an admin to upload the app via the Admin Center (Option B above).

## What's Next

Once the bot is responding to messages in Teams:

- **Agent notifications** will appear in the Teams channel when agents complete work, PRs are merged, or plans are finished.
- **CC mirror** mode (enabled by default) posts Command Center responses from the dashboard to Teams so the whole team sees orchestration activity.
- For production deployment (replacing Dev Tunnel with a stable public URL), see [docs/teams-production.md](teams-production.md).
