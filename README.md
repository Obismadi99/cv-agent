# CV Agent

An AI-powered CV tailoring tool. Add your CV and skills as documents, paste a job description, and the agent generates a tailored CV using Claude.

## Deploy to Render (free tier)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/cv-agent.git
git push -u origin main
```

### 2. Deploy on Render
1. Go to [render.com](https://render.com) and sign in
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` — click **Apply**
5. In the **Environment** tab, add: `ANTHROPIC_API_KEY` = your key from [console.anthropic.com](https://console.anthropic.com)
6. Click **Deploy** — your app will be live at `https://cv-agent.onrender.com` (or similar)

> **Note:** On Render's free tier, the service sleeps after 15 min of inactivity. First request after sleep takes ~30s to wake up.

## Run locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
# Open http://localhost:3000
```

## How it works

- **My Docs tab**: Add/edit documents (your CV, skills, projects, etc.). Stored as `.txt` files on disk — persists across deploys via Render's disk.
- **Generate CV tab**: Paste a job description. The agent:
  1. Lists your documents
  2. Reads each one
  3. Writes a tailored CV matching the job

## File structure
```
cv-agent/
  server.js        # Express server + Anthropic proxy
  package.json
  render.yaml      # Render deploy config
  public/
    index.html     # Frontend
  docs-store/      # Your documents (auto-created, not in git)
```
