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
| `⌘⌥C` | Copy conversation |
| `⌃X` | Delete chat |

## Privacy and security

- Your API key is stored by Raycast in its secure preference storage. It is **not** written to any file in this folder, so sharing this folder never shares your key.
- The extension talks to one server only: `https://api.anthropic.com`.
- Chats and the model list are saved in Raycast's local storage on your Mac. Nothing is sent anywhere else.
- Error messages are scrubbed of anything that looks like an API key.
- If a key ever leaks, delete it in the Claude Console and create a new one.
