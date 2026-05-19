# Owner Deck Generator

AI-powered Google Slides sales deck generator for Owner.com restaurant sales reps. Enter a prospect's details and it automatically builds a personalized pitch deck — with scraped website data, tech stack detection, a prospect logo, and AI-written slide copy.

## What it does

- Scrapes the prospect's website for tech stack, content, and logo
- Calls Claude (Haiku) to generate personalized slide copy for each prospect
- Takes a desktop screenshot of their website via Microlink
- Pulls their logo via OpenBrand
- Builds a complete Google Slides deck in a shared Drive folder
- Returns a direct link to the finished deck

## Prerequisites

- Node.js 18+
- A Google Cloud project with the Slides API and Drive API enabled
- OAuth 2.0 credentials (Desktop app) downloaded from Google Cloud Console
- API keys for Anthropic and OpenBrand
- A Google Drive folder to save decks into

## Setup

### 1. Clone the repo and install dependencies

```bash
npm install
```

### 2. Set up environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `OPENBRAND_API_KEY` | [openbrand.sh](https://openbrand.sh) |
| `GOOGLE_DRIVE_FOLDER_ID` | The ID at the end of your Google Drive folder URL |
| `PORT` | Default is `3000` |

### 3. Add Google OAuth credentials

Download your OAuth 2.0 credentials JSON from Google Cloud Console (APIs & Services → Credentials → your OAuth client → Download JSON) and save it as `oauth_credentials.json` in the project root.

**Never commit this file.** It's already in `.gitignore`.

### 4. Run the server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 5. Authorize Google on first run

Click the **Authorize with Google** button in the UI and complete the OAuth flow. This saves a `token.json` locally — you only need to do this once.

## Usage

Fill in the form:
- **Restaurant name** and **website URL**
- **Rep name** (appears on the cover slide)
- **Deal notes** — the more context the better (tech stack, pain points, competitor mentions, 3PD volumes)
- **Monthly 3PD volume** and **commission rate** (optional — used for the commission calculator slide)

Hit **Generate Deck** and a link to the finished Google Slides deck will appear in ~30 seconds.

## Project structure

```
server.js          # Express server, all slide-building logic
public/index.html  # Form UI
.env.example       # Environment variable template
```
