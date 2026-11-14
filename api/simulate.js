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

function isDecision(q) {
  const isQ = /\?\s*$/.test(q) || /^(should|shall|can|could|would|do|does|did|is|are|am|will|which|what|whether|how)\b/i.test(q);
  return isQ && (/\b(or|vs\.?|versus|rather than|instead of)\b/i.test(q) || /\bbetween\b.+\band\b/i.test(q));
}

const SYSTEM = `You are a careful decision analyst. Estimate the realistic consequences of the decision the person describes.

Return ONLY a JSON object, no other text:
{"note":"one sentence stating the key assumptions you made, max 160 characters","options":[{"name":"short option name, max 4 words","outcomes":[{"t":"one concrete consequence, max 80 characters","p":integer percent chance,"h":[impact at 1 month, impact at 1 year, impact at 5 years],"d":[money, time, stress and wellbeing, career and learning, relationships]}]}]}

Rules:
- Use every option the person names (up to 5). If they name only one action, use "Do it" and "Don't do it". Give at least 2 options.
- Give 3 to 5 outcomes per option, as many as are realistically distinct. They must be mutually exclusive and cover the most likely ways it could go, not rare extremes.
- Each option's p values must add up to exactly 100.
- Calibrate p to real-world base rates for this kind of decision. Avoid false certainty: do not use p above 80 or below 5 unless it is nearly certain. Do not make options suspiciously symmetric.
- "h" holds three integers from -10 to 10: the overall effect on the person's life at 1 month, 1 year and 5 years. Let it evolve realistically: some outcomes hurt early and pay off later, others feel good now and cost more later. Do not repeat one number three times unless the effect truly does not change.
- "d" holds five integers from -10 to 10: how much the outcome affects money, time, stress and wellbeing, career and learning, and relationships, in that order. Use 0 when an area is not affected. Judge d at the 1 year mark.
- Impact scale: -10 life-changing harm, -5 clearly bad, 0 neutral, +5 clearly good, +10 life-changing benefit. Most everyday outcomes fall between -6 and +6.
- Use the details the person gave (amounts, dates, constraints, their situation). If key details are missing, assume the most typical situation and say so in "note".
- Be concrete and specific to this decision, not generic advice.
- For medical, legal or safety-critical decisions, say in "note" that a professional should be consulted.

Format example only (do not reuse its numbers or wording):
Decision: Should I take a job offer in another city or stay at my current job?
{"note":"Assumes a pay raise, no family nearby in the new city, and a stable current job.","options":[{"name":"Take the offer","outcomes":[{"t":"Higher pay and faster career growth","p":50,"h":[2,5,8],"d":[7,-2,-1,8,-3]},{"t":"Lonely first year, but you settle in","p":35,"h":[-4,-1,3],"d":[3,-3,-5,4,-6]},{"t":"Poor fit, you leave within a year","p":15,"h":[-5,-6,-2],"d":[-3,-4,-7,-4,-4]}]},{"name":"Stay put","outcomes":[{"t":"Stable income, steady progress","p":55,"h":[3,3,1],"d":[2,1,3,1,3]},{"t":"Growth stalls, you feel stuck","p":30,"h":[1,-4,-7],"d":[-1,0,-5,-6,0]},{"t":"A promotion opens up here anyway","p":15,"h":[1,5,6],"d":[5,-1,2,6,1]}]}]}`;

const cl = v => Math.max(-10, Math.min(10, Math.round(+v) || 0));
const arr = (a, n) => (Array.isArray(a) && a.length === n ? a.map(cl) : null);

function fix(d) {
  if (!d || !Array.isArray(d.options)) return null;
  const options = d.options.slice(0, 5).map(o => {
    const outs = (Array.isArray(o.outcomes) ? o.outcomes : []).slice(0, 5)
      .map(c => { const h = arr(c.h, 3); return { t: String(c.t || '').slice(0, 90), p: Math.max(1, +c.p || 0), i: h ? h[1] : cl(c.i), h, d: arr(c.d, 5) }; })
      .filter(c => c.t);
    const total = outs.reduce((a, c) => a + c.p, 0);
    outs.forEach(c => (c.p = Math.round((c.p / total) * 100)));
    if (outs.length) outs[0].p += 100 - outs.reduce((a, c) => a + c.p, 0);
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
      max_tokens: 4500,
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
Ask 2 to 4 questions about the facts that would most change the outcome of the decision (for example budget, deadline, urgency, risk tolerance, current situation) and that the decision text does not already answer. Each question has 3 to 5 short, mutually exclusive choices, max 28 characters each. If the decision already has enough detail, return {"questions":[]}.`;

function fixQ(d) {
  const qs = (Array.isArray(d?.questions) ? d.questions : []).slice(0, 4).map(x => ({
    q: String(x.q || '').slice(0, 80),
    choices: (Array.isArray(x.choices) ? x.choices : []).map(c => String(c).slice(0, 30)).filter(Boolean).slice(0, 5),
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

  if (!isDecision(q)) return res.status(400).json({ error: 'Not a decision question with at least two choices' });

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