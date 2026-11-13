// Vercel serverless function. The API key stays here on the server, never in the page.
const BASE = process.env.AI_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.AI_MODEL || 'deepseek-chat';
const KEY = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY;

// Best-effort rate limit: 8 requests per minute per IP (resets when the function cold-starts).
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 8;
}

const SYSTEM = `You simulate the consequences of a decision. Return ONLY JSON in this shape:
{"options":[{"name":"short option name, max 4 words","outcomes":[{"t":"one realistic consequence, max 80 characters","p":integer percent chance,"i":integer impact from -10 (very bad) to 10 (very good)}]}]}
Rules: use the options the person names, otherwise "Do it" and "Don't do it". Give 2 or 3 options with exactly 3 outcomes each. Each option's p values sum to 100. Mix good and bad consequences realistically, weighing money, risk, time and wellbeing.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!KEY) return res.status(500).json({ error: 'Server is missing AI_API_KEY' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'Too many requests, try again in a minute' });

  const q = String(req.body?.q || '').trim().slice(0, 300);
  if (!q) return res.status(400).json({ error: 'Missing decision' });

  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: 'json_object' },
        max_tokens: 900,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: 'Decision: ' + q },
        ],
      }),
    });
    if (!r.ok) return res.status(502).json({ error: 'AI provider error ' + r.status });
    const j = await r.json();
    const text = (j.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    return res.status(200).json(JSON.parse(text));
  } catch (e) {
    return res.status(502).json({ error: 'Could not get a valid answer from the AI' });
  }
}
