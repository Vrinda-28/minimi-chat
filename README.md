# Minimi Chat

A local research chat that can recall a prior conversation and check what has changed using public web search.

## Run locally

Requires Node.js 24 or newer and an OpenAI API key with access to a Responses API model that supports the hosted web search tool.

```sh
npm install
cp .env.example .env
# Set OPENAI_API_KEY in .env.
npm run dev
```

Open http://localhost:3000. The app defaults to `gpt-6-astra`. You can set `OPENAI_MODEL` in `.env` to another Responses model that accepts low reasoning effort and hosted web search. Live requests may incur API charges. [OpenAI web search documentation](https://developers.openai.com/api/docs/guides/tools-web-search?api-mode=responses)

Try a comparison in one chat, then open **New chat** and ask whether any prices or features from the earlier conversation have changed. For a date lookup, use today's date or the day you actually sent the original message. **Chats** on mobile opens the sidebar. Enter sends a message and Shift+Enter inserts a newline.

SQLite stores completed turns under `data/`. History is scoped to the current browser cookie. The server listens on loopback for local evaluation. The model receives the new message and selected excerpts from your previous chats.

## Check the agent

```sh
npm test
npm run eval          # Six live cases, including the three challenge prompts
npm run eval -- crm   # One case
```

The automated checks run offline. The live evaluation uses seeded history and reports citations, search counts, and latency. Review the printed answers for correct shortlist coverage, dates, comparable pricing terms, and whether each cited source supports the alleged change. A passing search assertion alone does not measure answer quality.

[Design notes](DESIGN.md)
