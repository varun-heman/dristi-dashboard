# dristi-dashboard

Live issues health dashboard for [pucardotorg/dristi](https://github.com/pucardotorg/dristi).

Hosted at: **https://varun-heman.github.io/dristi-dashboard**

Data is refreshed automatically every night at 01:00 UTC (6:30 AM IST) via GitHub Actions.

---

## One-time setup

### 1 — Create the GitHub repo

1. Go to https://github.com/new
2. Repository name: `dristi-dashboard`
3. Owner: `varun-heman`
4. Set to **Public** (required for free GitHub Pages)
5. Click **Create repository**

### 2 — Push this code

```bash
cd dristi-dashboard          # this folder
git init
git add .
git commit -m "chore: initial dashboard setup"
git remote add origin https://github.com/varun-heman/dristi-dashboard.git
git branch -M main
git push -u origin main
```

### 3 — Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name      | Value |
|------------------|-------|
| `GH_TOKEN`       | A GitHub Personal Access Token (classic) with `public_repo` scope. Generate at: https://github.com/settings/tokens |
| `OPENROUTER_KEY` | Your OpenRouter API key (starts with `sk-or-v1-…`). Get one at: https://openrouter.ai/keys |

> **Note:** `GH_TOKEN` only needs read access to `pucardotorg/dristi` (a public repo), so the minimum `public_repo` scope is sufficient. The key is stored securely in GitHub Secrets and is never exposed in the source code.

### 4 — Enable GitHub Pages

1. Go to **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `gh-pages` / `/ (root)`
4. Click **Save**

### 5 — Run the first deploy

Go to **Actions → Fetch Data & Deploy to GitHub Pages → Run workflow**.

After it completes (~2 minutes), your dashboard will be live at:
`https://varun-heman.github.io/dristi-dashboard`

---

## File structure

```
dristi-dashboard/
├── .github/
│   └── workflows/
│       └── deploy.yml       # nightly fetch + deploy pipeline
├── data/
│   └── .gitkeep             # issues.json is generated, never committed
├── scripts/
│   └── fetch_data.py        # fetches REST issues + GraphQL project status
├── src/
│   ├── index.html           # page shell (two tabs)
│   ├── styles.css           # all styling
│   ├── dashboard.js         # metrics, charts, health scorecard
│   ├── search.js            # search/filter/sort table + timeline view
│   └── ai.js                # Claude AI analysis + chat (OpenRouter)
├── .gitignore
└── README.md
```

## How it works

1. **GitHub Actions** runs nightly, calling `scripts/fetch_data.py` with your `GH_TOKEN`.
2. The script fetches all issues from the GitHub REST API and project status fields from the GraphQL API, merging them into `data/issues.json`.
3. The workflow copies `src/` and `data/issues.json` into a `dist/` folder, substitutes your `OPENROUTER_KEY` into `ai.js`, and pushes `dist/` to the `gh-pages` branch.
4. GitHub Pages serves the `gh-pages` branch publicly.
5. The dashboard JavaScript loads `data/issues.json` at runtime — no API calls needed in the browser.

## Local development

```bash
# Fetch data locally (requires GH_TOKEN env var)
GH_TOKEN=ghp_xxx python scripts/fetch_data.py

# Serve the dashboard locally
cd src
python -m http.server 8080
# then open http://localhost:8080
# Note: local AI chat won't work unless you manually replace __OPENROUTER_KEY__ in ai.js
```
