// diagnose-repair.js — photo + description -> structured DIY diagnosis.
// Gemini analyzes the photo; a rule-based safety layer (below) then forces a
// "call a pro" verdict for hazard categories no matter what the model says.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // after base64 decode
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const TIMEOUT_MS = 55000;

// ---------- deterministic safety rules ----------
// Each rule: if any pattern matches the user's description OR the model's
// diagnosis title/cause, callPro is forced true and the reason is added.
const SAFETY_RULES = [
  { id: 'gas', reason: 'Possible gas involvement. Leave the house and call your gas utility if you smell gas. A licensed pro should handle any gas line or appliance connection.',
    patterns: [/\bgas\b/i, /rotten[- ]egg/i, /pilot light/i, /water heater.*(burner|flue|vent)/i] },
  { id: 'electrical-panel', reason: 'Work on the electrical panel, service wiring or aluminum wiring needs a licensed electrician.',
    patterns: [/(electrical|breaker|main|service) panel/i, /breaker box/i, /panel (is )?(hot|buzzing)/i, /service (line|entrance|drop)/i, /aluminum wir/i, /knob[- ]and[- ]tube/i, /burning smell/i, /scorch/i, /sparks?\b/i, /arcing/i, /melted (outlet|wire|plug)/i] },
  { id: 'structural', reason: 'Signs of a structural problem should be looked at by a structural engineer or a qualified contractor before you repair anything.',
    patterns: [/load[- ]bearing/i, /foundation crack/i, /sagging (ceiling|floor|beam|roof)/i, /\bjoist\b/i, /bowing wall/i, /stair-?step crack/i] },
  { id: 'asbestos-lead', reason: 'Materials in pre-1980 homes may contain asbestos or lead. Get them tested before you sand, cut or demo anything.',
    patterns: [/asbestos/i, /vermiculite/i, /popcorn ceiling/i, /lead paint/i, /9 ?x ?9 tile/i] },
  { id: 'mold', reason: 'Mold covering a large area, or mold coming back after cleaning, usually means a hidden moisture source. A remediation pro should assess it.',
    patterns: [/black mold/i, /mold (everywhere|spreading|keeps coming back)/i, /large (area of )?mold/i] },
  { id: 'roof-height', reason: 'Working on the roof or at height carries a serious fall risk. Consider a roofer.',
    patterns: [/on the roof/i, /roof (leak|repair|shingle)/i, /second[- ]stor(y|ey) (window|gutter)/i] },
  { id: 'sewer', reason: 'A sewage backup is a biohazard and can point to a main-line problem. A plumber should check it.',
    patterns: [/sewage/i, /sewer (backup|smell|line)/i, /main (drain|line) (backup|clog)/i] },
];

function applySafetyRules(userText, diagnosis) {
  // Only the diagnosis itself is scanned, not the steps: steps routinely say
  // "shut off the breaker panel" or "turn off the gas valve" and would
  // trigger false positives on every ordinary fix.
  const modelText = [diagnosis.title, diagnosis.likelyCause].join(' ');
  const haystack = `${userText || ''} ${modelText}`;
  const triggered = SAFETY_RULES.filter(r => r.patterns.some(p => p.test(haystack)));
  const safety = diagnosis.safety || { callPro: false, reasons: [], hazards: [] };
  safety.reasons = safety.reasons || [];
  safety.hazards = safety.hazards || [];
  safety.ruleFlags = triggered.map(r => r.id);
  if (triggered.length) {
    safety.callPro = true;
    for (const r of triggered) if (!safety.reasons.includes(r.reason)) safety.reasons.push(r.reason);
  }
  diagnosis.safety = safety;
  return diagnosis;
}

// ---------- model contract ----------
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isHomeRepairPhoto: { type: 'BOOLEAN' },
    title: { type: 'STRING' },
    likelyCause: { type: 'STRING' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    otherPossibilities: { type: 'ARRAY', items: { type: 'STRING' } },
    difficulty: { type: 'STRING', enum: ['easy', 'moderate', 'hard'] },
    estimatedTime: { type: 'STRING' },
    estimatedCostUSD: { type: 'OBJECT', properties: { low: { type: 'NUMBER' }, high: { type: 'NUMBER' } }, required: ['low', 'high'] },
    safety: {
      type: 'OBJECT',
      properties: {
        callPro: { type: 'BOOLEAN' },
        reasons: { type: 'ARRAY', items: { type: 'STRING' } },
        hazards: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['callPro', 'reasons', 'hazards'],
    },
    tools: { type: 'ARRAY', items: { type: 'STRING' } },
    parts: { type: 'ARRAY', items: { type: 'STRING' } },
    steps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { step: { type: 'STRING' }, detail: { type: 'STRING' }, caution: { type: 'STRING' } },
        required: ['step', 'detail'],
      },
    },
    stopIf: { type: 'ARRAY', items: { type: 'STRING' } },
    followUpQuestions: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['isHomeRepairPhoto', 'title', 'likelyCause', 'confidence', 'difficulty', 'safety', 'tools', 'parts', 'steps', 'stopIf'],
};

const SYSTEM_PROMPT = `You are a careful, experienced home-repair advisor helping a capable DIY homeowner in the US Midwest (Milwaukee/Chicago area, older housing stock, cold winters).
Look at the photo and read the description. Diagnose the most likely problem and give a practical fix.
Rules:
- Be honest about uncertainty. If the photo is unclear, set confidence "low" and list followUpQuestions (for example, "Is the stain still damp to the touch?").
- Steps must be concrete and ordered, starting with safety (shut off water or power at the breaker, and test with a non-contact voltage tester).
- Set safety.callPro true for gas, the electrical panel or service wiring, structural issues, suspected asbestos or lead, large mold areas, roof or high-ladder work, sewage, or anything that requires a permit. Even then, still explain what is going on and what the homeowner can safely do in the meantime.
- stopIf lists the conditions under which the homeowner should stop and call a pro partway through.
- Parts should be specific enough to buy at a hardware store (for example, "1/2-inch SharkBite push-to-connect coupling").
- Cost is a rough US-dollar DIY range for parts and tools, not labor.
- If the photo is not a home repair or maintenance subject, set isHomeRepairPhoto false and fill the other fields minimally.`;

// ---------- handler ----------
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

async function handler(event, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json(500, { error: 'GEMINI_API_KEY is not set in Netlify environment variables.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body.' }); }

  const description = String(body.description || '').slice(0, 1500).trim();
  const room = String(body.room || '').slice(0, 60);
  const homeAge = String(body.homeAge || '').slice(0, 40);
  const mimeType = String(body.mimeType || '');
  const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.replace(/^data:[^,]+,/, '') : '';

  if (!imageBase64 && !description) return json(400, { error: 'Add a photo, a description, or both.' });
  if (imageBase64) {
    if (!ALLOWED_MIME.includes(mimeType)) return json(400, { error: 'Photo must be JPEG, PNG or WebP.' });
    const bytes = Math.floor(imageBase64.length * 3 / 4);
    if (bytes > MAX_IMAGE_BYTES) return json(413, { error: 'Photo is too large (max 4 MB after compression).' });
  }

  const userText = [
    description && `Problem description: ${description}`,
    room && `Room/area: ${room}`,
    homeAge && `Home built: ${homeAge}`,
  ].filter(Boolean).join('\n') || 'No description provided; diagnose from the photo.';

  const parts = [{ text: userText }];
  if (imageBase64) parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 4096,
      temperature: 0.3,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    return json(aborted ? 504 : 502, { error: aborted ? 'The diagnosis took too long. Try again.' : 'Could not reach the AI service.' });
  }
  clearTimeout(timer);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `AI service error (${res.status})`;
    return json(res.status === 503 || res.status === 429 ? 503 : 502, { error: res.status === 503 ? 'The AI service is busy. Try again in a moment.' : msg });
  }

  const cand = data?.candidates?.[0];
  const text = cand?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) {
    return json(502, { error: cand?.finishReason === 'MAX_TOKENS' ? 'The response was cut off. Try again.' : 'The AI service returned an empty response. Try again.' });
  }

  let diagnosis;
  try { diagnosis = JSON.parse(text); } catch { return json(502, { error: 'The AI service returned malformed output. Try again.' }); }

  diagnosis = applySafetyRules(description, diagnosis);
  return json(200, { diagnosis, model: MODEL });
}

exports.handler = (event) => handler(event);
exports._test = { handler, applySafetyRules, SAFETY_RULES };
