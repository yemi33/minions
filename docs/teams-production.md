# Teams Production Endpoint Migration

Guide for migrating the Minions Teams bot from a Dev Tunnel to a stable public HTTPS endpoint for production use. Choose one of the three deployment options below based on your infrastructure.

**Key fact:** The Azure Bot messaging endpoint URL can be changed at any time in the Azure Portal — it takes effect immediately. No bot reinstallation is needed in Teams. This means you can switch between Dev Tunnel and production endpoints freely.

**Prerequisites:**

- A working Teams integration via Dev Tunnel (see [docs/teams-setup.md](teams-setup.md))
- Azure CLI installed (`az --version`) for Options 1 and 2
- A public-facing server or VM for Option 3

---

## Option 1: Azure App Service

Deploy the Minions dashboard as an Azure App Service with a stable FQDN.

### Steps

1. **Create an App Service Plan** (skip if you have one):

   ```bash
   az appservice plan create \
     --name minions-plan \
     --resource-group rg-minions \
     --sku B1 \
     --is-linux
   ```

2. **Create the Web App:**

   ```bash
   az webapp create \
     --name minions-dashboard \
     --resource-group rg-minions \
     --plan minions-plan \
     --runtime "NODE:20-lts"
   ```

   This creates a publicly accessible URL: `https://minions-dashboard.azurewebsites.net`

3. **Configure environment variables:**

   ```bash
   az webapp config appsettings set \
     --name minions-dashboard \
     --resource-group rg-minions \
     --settings \
       PORT=8080 \
       NODE_ENV=production
   ```

   > Azure App Service routes external port 443 (HTTPS) to your app's internal port (default 8080). Set `PORT=8080` so the dashboard listens on the expected port.

4. **Deploy the code:**

   ```bash
   # From the minions repository root
   az webapp deploy \
     --name minions-dashboard \
     --resource-group rg-minions \
     --src-path . \
     --type zip
   ```

   Alternatively, configure continuous deployment from your Git repository:

   ```bash
   az webapp deployment source config \
     --name minions-dashboard \
     --resource-group rg-minions \
     --repo-url https://github.com/your-org/minions \
     --branch master \
     --manual-integration
   ```

5. **Copy `config.json` to the App Service.** The simplest approach is to use the Kudu console or App Service Editor to upload your `config.json` to the application root. Alternatively, mount an Azure File Share containing your config.

6. **Update the Azure Bot messaging endpoint:**

   - Open the [Azure Portal](https://portal.azure.com) > your Azure Bot resource > **Configuration**.
   - Change the **Messaging endpoint** to:
     ```
     https://minions-dashboard.azurewebsites.net/api/bot
     ```
   - Click **Apply**. The change takes effect immediately.

### Verify

1. Open `https://minions-dashboard.azurewebsites.net/api/routes` in a browser — you should see the API route list.
2. In the Azure Bot resource, click **Test in Web Chat** and send a message.
3. Send a message in Teams to the bot — confirm it receives and responds.

### Rollback

To revert to Dev Tunnel:

1. Start your local Dev Tunnel: `devtunnel host -p 7331 --allow-anonymous`
2. Update the Azure Bot messaging endpoint back to your tunnel URL: `https://<tunnel>.devtunnels.ms/api/bot`
3. Click **Apply**. Traffic returns to your local machine immediately.

---

## Option 2: Azure Container App

Containerize the dashboard and deploy to Azure Container Apps with a stable FQDN.

### Steps

1. **Create a Dockerfile** in the repository root:

   ```dockerfile
   FROM node:20-slim
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev 2>/dev/null || true
   COPY . .
   EXPOSE 7331
   CMD ["node", "dashboard.js"]
   ```

   > Minions has zero npm dependencies beyond Node.js built-ins, so `npm ci` may be a no-op. The botbuilder package (added by this feature branch) is the exception.

2. **Build and push to Azure Container Registry:**

   ```bash
   # Create a container registry (skip if you have one)
   az acr create \
     --name minionsacr \
     --resource-group rg-minions \
     --sku Basic

   # Build and push
   az acr build \
     --registry minionsacr \
     --image minions-dashboard:latest .
   ```

3. **Create a Container Apps environment** (skip if you have one):

   ```bash
   az containerapp env create \
     --name minions-env \
     --resource-group rg-minions \
     --location eastus
   ```

4. **Deploy the container:**

   ```bash
   az containerapp create \
     --name minions-dashboard \
     --resource-group rg-minions \
     --environment minions-env \
     --image minionsacr.azurecr.io/minions-dashboard:latest \
     --registry-server minionsacr.azurecr.io \
     --target-port 7331 \
     --ingress external \
     --min-replicas 1 \
     --max-replicas 1 \
     --env-vars NODE_ENV=production
   ```

   > Use `--min-replicas 1 --max-replicas 1` because the Minions engine uses file-based state that doesn't support multiple replicas.

5. **Get the FQDN:**

   ```bash
   az containerapp show \
     --name minions-dashboard \
     --resource-group rg-minions \
     --query "properties.configuration.ingress.fqdn" \
     --output tsv
   ```

   This returns something like: `minions-dashboard.happyfield-abc123.eastus.azurecontainerapps.io`

6. **Update the Azure Bot messaging endpoint:**

   - Open the [Azure Portal](https://portal.azure.com) > your Azure Bot resource > **Configuration**.
   - Change the **Messaging endpoint** to:
     ```
     https://minions-dashboard.happyfield-abc123.eastus.azurecontainerapps.io/api/bot
     ```
   - Click **Apply**. The change takes effect immediately.

### Verify

1. Open `https://<your-fqdn>/api/routes` in a browser.
2. Test via Azure Bot **Test in Web Chat**.
3. Send a message in Teams — confirm end-to-end flow works.

### Rollback

To revert to Dev Tunnel:

1. Start your local Dev Tunnel: `devtunnel host -p 7331 --allow-anonymous`
2. Update the Azure Bot messaging endpoint back to your tunnel URL.
3. Click **Apply**. Immediate switchover.

Optionally stop the container to save costs:

```bash
az containerapp update \
  --name minions-dashboard \
  --resource-group rg-minions \
  --min-replicas 0 --max-replicas 0
```

---

## Option 3: Reverse Proxy (nginx / Caddy)

For servers with a public IP address or an existing reverse proxy setup.

### Steps (Caddy — recommended for simplicity)

Caddy automatically provisions and renews TLS certificates via Let's Encrypt.

1. **Install Caddy:**

   ```bash
   # Debian/Ubuntu
   sudo apt install -y caddy

   # macOS
   brew install caddy
   ```

2. **Configure Caddy.** Create or edit `/etc/caddy/Caddyfile`:

   ```
   minions.yourdomain.com {
     reverse_proxy localhost:7331
   }
   ```

   > Replace `minions.yourdomain.com` with your actual domain. Ensure a DNS A record points this domain to your server's public IP.

3. **Start Caddy:**

   ```bash
   sudo systemctl enable --now caddy
   ```

   Caddy automatically obtains a Let's Encrypt TLS certificate for your domain.

4. **Start the Minions dashboard:**

   ```bash
   minions dash
   ```

   Or run it as a systemd service for persistence:

   ```bash
   # /etc/systemd/system/minions-dashboard.service
   [Unit]
   Description=Minions Dashboard
   After=network.target

   [Service]
   Type=simple
   User=your-user
   WorkingDirectory=/path/to/minions
   ExecStart=/usr/bin/node dashboard.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl enable --now minions-dashboard
   ```

5. **Update the Azure Bot messaging endpoint:**

   - Open the Azure Portal > your Azure Bot resource > **Configuration**.
   - Change the **Messaging endpoint** to:
     ```
     https://minions.yourdomain.com/api/bot
     ```
   - Click **Apply**. The change takes effect immediately.

### Steps (nginx)

1. **Install nginx and certbot:**

   ```bash
   sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. **Configure nginx.** Create `/etc/nginx/sites-available/minions`:

   ```nginx
   server {
     listen 80;
     server_name minions.yourdomain.com;

     location / {
       proxy_pass http://localhost:7331;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection 'upgrade';
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

   ```bash
   sudo ln -s /etc/nginx/sites-available/minions /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. **Obtain a TLS certificate:**

   ```bash
   sudo certbot --nginx -d minions.yourdomain.com
   ```

   Certbot modifies the nginx config to add TLS and sets up auto-renewal.

4. **Start the Minions dashboard** (same as Caddy option above).

5. **Update the Azure Bot messaging endpoint** (same as Caddy option above).

### Verify

1. Open `https://minions.yourdomain.com/api/routes` in a browser — confirm the route list loads over HTTPS.
2. Check the TLS certificate: `curl -vI https://minions.yourdomain.com 2>&1 | grep "SSL certificate"`.
3. Test via Azure Bot **Test in Web Chat**.
4. Send a message in Teams — confirm the bot responds.

### Rollback

To revert to Dev Tunnel:

1. Start your local Dev Tunnel: `devtunnel host -p 7331 --allow-anonymous`
2. Update the Azure Bot messaging endpoint back to your tunnel URL.
3. Click **Apply**. Immediate switchover.

The reverse proxy can remain running — it just won't receive Bot Framework traffic until the endpoint is pointed back.

---

## Choosing an Option

| Criteria | App Service | Container App | Reverse Proxy |
|----------|-------------|---------------|---------------|
| Setup complexity | Medium | Medium | Low (Caddy) / Medium (nginx) |
| TLS management | Automatic | Automatic | Automatic (Caddy/certbot) |
| Cost | ~$13/mo (B1) | Pay-per-use | Free (your server + Let's Encrypt) |
| Custom domain | Supported | Supported | Required |
| Scaling | Supported but not needed | Supported but not needed | Manual |
| Best for | Azure-native teams | Container workflows | Existing servers |

> **Note on replicas:** Minions uses file-based state (`engine/*.json`). Do not run multiple replicas — use exactly 1 instance. All three options above default to single-instance deployment.

## Common Notes

- **Endpoint changes are immediate.** When you update the messaging endpoint in the Azure Bot Configuration, it takes effect right away. No bot reinstallation, no downtime, no user-visible change in Teams.
- **No deprecated webhooks.** This guide uses Azure Bot Framework exclusively. Do not use deprecated O365 Connector webhooks or Power Automate flows — they are being removed by Microsoft.
- **Config portability.** The same `config.json` works across all environments. Just ensure the `teams.appId` and `teams.appPassword` are correct for the bot registration that points to your production URL.
