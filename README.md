# discord-organizer

You're in 170 Discord servers, your sidebar is a wall of icons, and you've forgotten what half of them are. This script fixes that:

1. **Reads your servers**: channels, topics, a few recent messages, and how active each one is.
2. **Asks Claude what each server is** and groups them into folders by topic (Dev, Games, Anime, Minecraft...).
3. **Writes a report** you can review and tweak before anything changes.
4. **Builds the folders in your sidebar**, backing up your old layout first.
5. Optional: **mutes every server** and lets through only messages that mention you directly.

One script, two dependencies. No server, no database.

## ⚠️ Read this first

This uses your **user account token**, not a bot token. That's what's called a *selfbot*, and it's **against Discord's Terms of Service**. Your account could get suspended or banned. Use at your own risk.

A regular bot can't do this job: sidebar folders and notification settings belong to **your account**, and bots can't see or change them.

The script tries to leave as small a footprint as it can:

- random 1.5–4 s gap between requests, never a fixed rhythm;
- a single attempt to read messages per server;
- when Discord says to wait (429), it waits twice as long;
- data is collected once and reused (`data.json`);
- applying all the folders takes a single request, and so does changing notifications;
- it **never** sends messages, reacts, joins, or leaves servers.

The risk still isn't zero. Don't run it in a loop or on a schedule.

**Privacy:** to classify your servers, channel names and snippets of recent messages are sent to the Anthropic API. If you don't want that, see [Without an Anthropic key](#without-an-anthropic-key).

## Requirements

- Node.js 20.6+ (for `--env-file`)
- Your Discord token
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com). This one is optional, see below.

## Setup

```bash
git clone https://github.com/goul4rt/discord-organizer
cd discord-organizer
npm install
cp .env.example .env
```

Fill in `.env`, one variable per line:

```env
DISCORD_TOKEN=your_token_here
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### Getting your Discord token

1. Open Discord **in the browser** (discord.com/app) and log in.
2. Open DevTools (F12) and go to the **Network** tab.
3. Click any channel to generate traffic, then filter by `api`.
4. Click a request and copy the value of `authorization` under **Request Headers**.

> Your token gives full access to your account. Don't paste it anywhere, don't commit it, don't send it to anyone. If it leaks, **change your Discord password**: that invalidates the token right away.

## Usage

### 1. Collect and classify

```bash
npm run scan
```

This takes a few minutes: about 2 requests per server, with the random pauses. When it finishes you get:

- `data.json`: everything that was collected. Later runs reuse it. Delete it to collect again.
- `plan.json`: which folder each server goes into.
- `report.md`: one table per folder showing what each server is, how active it is, member count, and days since the last message.

A report looks like this:

| Server | What it is | Activity | Members | Days since last msg |
|---|---|---|---|---|
| Discord Developers | Official Discord API, bots, Activities and Social SDK | very active | 304690 | 0 |
| Hytale Brasil | Largest Brazilian Hytale community | active | 4718 | 0 |
| Survale | Hytale server that never took off | dead | 41 | 182 |

Folder names and descriptions come out in whatever language most of your servers use.

### 2. Review

Open `report.md`. To move a server, change its `folder` in `plan.json`. To rename or add folders, edit the `folders` list. Then rebuild the report to check:

```bash
npm run report
```

### 3. Apply the folders

```bash
npm run apply
```

Before touching anything, your current layout is saved to `backup-folders-<timestamp>.json`. Servers that aren't in the plan stay loose, outside any folder.

### 4. (Optional) Direct mentions only

```bash
npm run notify
```

This changes four settings on every server:

- **Mute the server:** no more unread dots.
- **Notifications:** only @mentions.
- **Ignore @everyone and @here.**
- **Ignore role mentions.**

You only get notified when someone mentions **you**. Muted servers still show the red mention badge.

## Undo

```bash
# put the folders back the way they were before apply
node --env-file=.env organize.mjs restore backup-folders-<timestamp>.json

# reset notifications to each server's default
npm run notify-reset
```

Your previous notification settings aren't backed up. `notify-reset` goes back to each server's default.

## Without an Anthropic key

Without `ANTHROPIC_API_KEY`, `scan` only collects: it saves `data.json` and stops. From there you can:

- ask [Claude Code](https://claude.com/claude-code) (or any other AI) to read `data.json` and write `plan.json` in the format below;
- or write `plan.json` by hand.

Then run `npm run report` and `npm run apply` as usual.

```json
{
  "folders": [{ "name": "Dev & Bots", "description": "Bots, programming and AI" }],
  "servers": [
    { "id": "613425648685547541", "folder": "Dev & Bots", "what_it_is": "Official Discord Developers server", "activity": "very active" }
  ]
}
```

`activity` is one of `very active`, `active`, `lukewarm`, or `dead`.

## Commands

| Command | What it does | Talks to Discord? |
|---|---|---|
| `npm run scan` | collect data and classify | yes (reads only) |
| `npm run report` | rebuild `report.md` from `plan.json` | no |
| `npm run apply` | build the folders, with a backup | 2 requests |
| `npm run notify` | direct mentions only, on every server | 1 request |
| `npm run notify-reset` | reset notifications to default | 1 request |
| `node --env-file=.env organize.mjs restore <file>` | restore folders from a backup | 1 request |
| `npm test` | check how folders get built | no |

## Limitations

- Folders go through the legacy `PATCH /users/@me/settings` endpoint. It works today, but Discord could turn it off without notice.
- Folder names longer than 32 characters get cut off.
- Folder colors come from a fixed palette, and you can't set them in `plan.json`.

## License

MIT. This project isn't affiliated with Discord or Anthropic.
