// Vercel serverless function. The API key stays on the server, never in the page.
const BASE = process.env.AI_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.AI_MODEL || 'deepseek-chat';
const KEY = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY;

// Best-effort rate limit: 8 requests per minute per IP (resets on cold start).
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 12;
}

const SYSTEM = `You are a careful decision analyst. Estimate the realistic consequences of the decision the person describes.

Return ONLY a JSON object, no other text:
{"note":"one sentence stating the key assumptions you made, max 160 characters","options":[{"name":"short option name, max 4 words","outcomes":[{"t":"one concrete consequence, max 80 characters","p":integer percent chance,"i":integer impact -10..10}]}]}

Rules:
- Use the options the person names. If they name only one action, use "Do it" and "Don't do it". Give 2 or 3 options.
- Give exactly 3 outcomes per option. They must be mutually exclusive and cover the most likely ways it could go, not rare extremes.
- Each option's p values must add up to exactly 100.
- Calibrate p to real-world base rates for this kind of decision. Avoid false certainty: do not use p above 80 or below 5 unless it is nearly certain. Do not make options suspiciously symmetric.
- Impact scale: -10 life-changing harm, -5 clearly bad, 0 neutral, +5 clearly good, +10 life-changing benefit. Most everyday outcomes fall between -6 and +6.
- Use the details the person gave (amounts, dates, constraints, their situation). If key details are missing, assume the most typical situation and say so in "note".
- Be concrete and specific to this decision, not generic advice.
- For medical, legal or safety-critical decisions, say in "note" that a professional should be consulted.
- Judge impact for the person's overall wellbeing: money, time, stress, relationships, long-term goals.

Format example only (do not reuse its numbers or wording):
Decision: Should I take a job offer in another city or stay at my current job?
{"note":"Assumes a pay raise, no family nearby in the new city, and stable current job.","options":[{"name":"Take the offer","outcomes":[{"t":"Higher pay and faster career growth","p":50,"i":6},{"t":"Lonely first year, but you settle in","p":35,"i":-1},{"t":"Poor fit, you leave within a year","p":15,"i":-6}]},{"name":"Stay put","outcomes":[{"t":"Stable income, steady progress","p":55,"i":3},{"t":"Growth stalls, you feel stuck","p":30,"i":-4},{"t":"A promotion opens up here anyway","p":15,"i":5}]}]}`;

function fix(d) {
  if (!d || !Array.isArray(d.options)) return null;
  const options = d.options.slice(0, 3).map(o => {
    const outs = (Array.isArray(o.outcomes) ? o.outcomes : []).slice(0, 4)
      .map(c => ({ t: String(c.t || '').slice(0, 90), p: Math.max(1, +c.p || 0), i: Math.max(-10, Math.min(10, Math.round(+c.i) || 0)) }))
      .filter(c => c.t);
    const total = outs.reduce((a, c) => a + c.p, 0);
    outs.forEach(c => (c.p = Math.round((c.p / total) * 100)));
    if (outs.length) outs[0].p += 100 - outs.reduce((a, c) => a + c.p, 0); // force sum to 100
    return { name: String(o.name || '').slice(0, 30), outcomes: outs };
  }).filter(o => o.name && o.outcomes.length >= 2);
  return options.length >= 2 ? { note: String(d.note || '').slice(0, 200), options } : null;
}

async function ask(q) {
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 3000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'Decision: ' + q },
      ],
    }),
  });
  if (!r.ok) throw new Error('provider ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const text = (j.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
  return fix(JSON.parse(text));
}

const QSYS = `You help a person get a better decision analysis. Return ONLY JSON: {"questions":[{"q":"short question, max 70 characters","choices":["short answer","short answer","short answer"]}]}
Ask exactly 2 questions about the facts that would most change the outcome of the decision (for example budget, deadline, urgency, risk tolerance, current situation) and that the decision text does not already answer. Each question has 3 or 4 short, mutually exclusive choices, max 28 characters each. If the decision already has enough detail, return {"questions":[]}.`;

function fixQ(d) {
  const qs = (Array.isArray(d?.questions) ? d.questions : []).slice(0, 2).map(x => ({
    q: String(x.q || '').slice(0, 80),
    choices: (Array.isArray(x.choices) ? x.choices : []).map(c => String(c).slice(0, 30)).filter(Boolean).slice(0, 4),
  })).filter(x => x.q && x.choices.length >= 2);
  return { questions: qs };
}

async function askQuestions(q) {
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: MODEL, temperature: 0.3, response_format: { type: 'json_object' }, max_tokens: 2000,
      messages: [{ role: 'system', content: QSYS }, { role: 'user', content: 'Decision: ' + q }],
    }),
  });
  if (!r.ok) throw new Error('provider ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const text = (j.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
  return fixQ(JSON.parse(text));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!KEY) return res.status(500).json({ error: 'Server is missing AI_API_KEY' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'Too many requests, try again in a minute' });

  const q = String(req.body?.q || '').trim().slice(0, 700);
  if (!q) return res.status(400).json({ error: 'Missing decision' });

  if (req.body?.mode === 'questions') {
    try { return res.status(200).json(await askQuestions(q)); }
    catch (e) { return res.status(502).json({ error: 'AI error: ' + String(e.message) }); }
  }

  let lastErr = 'no valid answer';
  for (let attempt = 0; attempt < 2; attempt++) { // retry once if the answer is invalid
    try {
      const out = await ask(q);
      if (out) return res.status(200).json(out);
      lastErr = 'answer had the wrong format';
    } catch (e) {
      lastErr = String(e.message);
      if (lastErr.startsWith('provider 4')) break; // client errors will not fix themselves
    }
  }
  return res.status(502).json({ error: 'AI error: ' + lastErr });
}