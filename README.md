# WhatIf: Decision Consequence Simulator

Type a decision; the AI generates options, outcomes, chances and impacts. The page draws the comparison and decision tree, and saves results in the browser.

## Deploy
1. Push this folder to a GitHub repo and import it in Vercel (or run `npx vercel` in this folder).
2. In Vercel > Project > Settings > Environment Variables add:
   - `AI_API_KEY` : your provider key (required)
   - `AI_BASE_URL` : default `https://api.deepseek.com`
   - `AI_MODEL` : default `deepseek-chat`
3. Redeploy. Open the site and press Simulate.

## Local test
`npm i -g vercel`, copy `.env.example` to `.env`, then run `vercel dev`.

## Other providers
Any OpenAI-compatible API works by changing `AI_BASE_URL`, `AI_MODEL` and `AI_API_KEY` (Groq, OpenRouter, Together, etc.). The URL must serve `/chat/completions` under the base. Check each provider's pricing and JSON-mode support.

## Safety
The key lives only on the server. Input is capped at 300 characters and each IP gets 8 requests per minute (best effort). Also set a spending limit in your provider dashboard.
