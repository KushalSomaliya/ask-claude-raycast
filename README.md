# Ask Claude

Chat with Claude from Raycast using your own Anthropic API key. Type a question, press Enter, keep typing to follow up. Chats are saved, and you can switch to any model your key can use.

## Install

You need Node.js 20+ and Raycast.

```bash
cd ask-claude-ext
npm install
npm run dev
```

When Terminal says **built extension successfully**, press `Ctrl+C`. The extension stays in Raycast.

## Add your API key

1. Create a key at **platform.claude.com → API keys**. Use your own account; don't share keys between people.
2. Open **Ask Claude** in Raycast. On first launch it asks for the key; paste it and continue.
   To change it later: open Ask Claude, press `⌘K`, then **Configure Extension**.

Tip: set a monthly **spend limit** on the workspace the key belongs to in the Claude Console, so a leaked key can't run up a big bill.

## Web search

Claude searches the web on its own when a question needs current information (prices, news, "today"), and shows the sources under the answer. Each search costs about $0.01 plus tokens on your API key. Turn it off, cap searches per question, or change the country used for local results in **Configure Extension**.

Claude can also **read links**: paste a URL ("summarize https://…") and it opens the page. It only opens links from your messages or its own search results. There's no extra fee; the page text counts as tokens, capped at about 30k per page. Turn it off with **Read Links** in Configure Extension.

## Chat titles

After a chat's first answer, Claude gives it a short title (2–6 words) using the fastest model your key has. It's one tiny extra request per chat. Turn it off with **Chat Titles** in Configure Extension.

## Updating

Ask Claude checks GitHub for a new version when you open it, at most once an hour. When there is one, Raycast's root search shows **2 updates available** next to Ask Claude, and its actions (`⌘K`) show **Update Ask Claude (2)**.

Press `⌘U` to see what's new, then **Enter** to install. It pulls the code, reinstalls dependencies if they changed, and rebuilds (the same as `git pull && npm run dev`, then `Ctrl+C`). It takes about 10 seconds and runs in the background; Ask Claude reloads with the new version and shows the result.

If this copy was installed from a zip, `⌘U` offers **Connect and Update** once, which links the folder to GitHub. Your chats and API key are stored in Raycast and aren't affected. If the extension lives somewhere other than `~/raycast-extensions/ask-claude-ext`, set **Extension Folder** in Configure Extension; turn the automatic check off with **Automatic Update Check** there (`⌘U` still works).

If Ask Claude ever won't open, update from Terminal instead: run `git pull && npm run dev` in the extension folder.

## Shortcuts

| Keys | Action |
| --- | --- |
| `Enter` | Send / reply |
| `⌘1`–`⌘9` | Jump to a chat |
| `⌘N` | New chat |
| `⌘P` | Switch model |
| `⌘.` | Stop the answer |
| `⌘E` | Show the full conversation (long chats show the latest messages first) |
| `⌘↵` | Copy last answer |
| `⌘U` | Update (or check for updates) |
| `⌘⌥C` | Copy conversation |
| `⌃X` | Delete chat |

## Privacy and security

- Your API key is stored by Raycast in its secure preference storage. It is **not** written to any file in this folder, so sharing this folder never shares your key.
- Your questions and chats go to one server only: `https://api.anthropic.com`. The update check talks to this extension's GitHub repo (a plain `git fetch`), which sends nothing about you or your chats.
- Chats and the model list are saved in Raycast's local storage on your Mac. Nothing is sent anywhere else.
- Error messages are scrubbed of anything that looks like an API key.
- If a key ever leaks, delete it in the Claude Console and create a new one.
