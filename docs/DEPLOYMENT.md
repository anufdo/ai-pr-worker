# Ubuntu VPS Deployment

## Install system packages

```bash
sudo apt update
sudo apt install -y git nodejs npm nginx certbot python3-certbot-nginx
sudo npm install -g pm2
```

Use Node.js 20 or newer. Install the selected AI CLI separately and authenticate it as the dedicated worker user.

## Install the app

```bash
git clone https://github.com/YOUR_NAME/ai-pr-worker.git
cd ai-pr-worker
cp .env.example .env
npm install
npm run build
pm2 start dist/server.js --name ai-pr-worker
pm2 save
```

## Nginx

```nginx
server {
    server_name agent.example.com;

    location /webhooks/github {
        proxy_pass http://127.0.0.1:8787/webhooks/github;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable TLS:

```bash
sudo certbot --nginx -d agent.example.com
```

The app binds to `127.0.0.1` intentionally. Expose it through Nginx.
