// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { handler, applySafetyRules } = require('../netlify/functions/diagnose-repair.js')._test;

process.env.GEMINI_API_KEY = 'test-key';

const baseDiag = (over = {}) => ({
  isHomeRepairPhoto: true,
  title: 'Running toilet: worn flapper',
  likelyCause: 'The flapper no longer seals, so water leaks into the bowl.',
  confidence: 'high', difficulty: 'easy', estimatedTime: '20 min',
  estimatedCostUSD: { low: 8, high: 20 },
  safety: { callPro: false, reasons: [], hazards: [] },
  tools: ['Sponge'], parts: ['Universal 2-inch flapper'],
  steps: [{ step: 'Shut off water', detail: 'Turn the supply valve clockwise.' }],
  stopIf: ['The tank itself is cracked'],
  ...over,
});

const geminiOk = (diag) => async (url, opts) => {
  geminiOk.last = { url, body: JSON.parse(opts.body), headers: opts.headers };
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(diag) }] }, finishReason: 'STOP' }] }) };
};
const ev = (body, method = 'POST') => ({ httpMethod: method, body: JSON.stringify(body) });
const tinyJpeg = Buffer.from('fake-jpeg-bytes').toString('base64');

test('rejects non-POST', async () => {
  const r = await handler({ httpMethod: 'GET' });
  assert.equal(r.statusCode, 405);
});

test('requires photo or description', async () => {
  const r = await handler(ev({}), { fetch: geminiOk(baseDiag()) });
  assert.equal(r.statusCode, 400);
});

test('rejects disallowed mime type', async () => {
  const r = await handler(ev({ imageBase64: tinyJpeg, mimeType: 'image/svg+xml' }), { fetch: geminiOk(baseDiag()) });
  assert.equal(r.statusCode, 400);
});

test('rejects oversized image', async () => {
  const big = 'A'.repeat(6 * 1024 * 1024);
  const r = await handler(ev({ imageBase64: big, mimeType: 'image/jpeg' }), { fetch: geminiOk(baseDiag()) });
  assert.equal(r.statusCode, 413);
});

test('happy path sends photo inline + schema, returns diagnosis', async () => {
  const r = await handler(ev({ description: 'Toilet keeps running', room: 'Bathroom', imageBase64: 'data:image/jpeg;base64,' + tinyJpeg, mimeType: 'image/jpeg' }), { fetch: geminiOk(baseDiag()) });
  assert.equal(r.statusCode, 200);
  const out = JSON.parse(r.body);
  assert.equal(out.diagnosis.title, 'Running toilet: worn flapper');
  assert.equal(out.diagnosis.safety.callPro, false);
  const sent = geminiOk.last.body;
  assert.equal(sent.contents[0].parts[1].inline_data.data, tinyJpeg, 'data: prefix stripped');
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  assert.ok(sent.generationConfig.maxOutputTokens >= 2048, 'enough tokens (CRM lesson)');
  assert.equal(geminiOk.last.headers['x-goog-api-key'], 'test-key');
  assert.ok(!geminiOk.last.url.includes('test-key'), 'key not in URL');
});

test('safety: user mentions gas smell -> forced callPro even if model says no', async () => {
  const r = await handler(ev({ description: 'Smells like rotten eggs near the stove' }), { fetch: geminiOk(baseDiag()) });
  const d = JSON.parse(r.body).diagnosis;
  assert.equal(d.safety.callPro, true);
  assert.ok(d.safety.ruleFlags.includes('gas'));
});

test('safety: model diagnosis mentions scorch marks -> electrical flag', () => {
  const d = applySafetyRules('outlet stopped working', baseDiag({ title: 'Scorched outlet', likelyCause: 'Loose connection causing arcing.' }));
  assert.equal(d.safety.callPro, true);
  assert.ok(d.safety.ruleFlags.includes('electrical-panel'));
});

test('safety: ordinary steps mentioning breaker panel do NOT trigger', () => {
  const d = applySafetyRules('light switch is loose', baseDiag({
    title: 'Loose light switch', likelyCause: 'Mounting screws backed out.',
    steps: [{ step: 'Kill power', detail: 'Flip the breaker at the main panel and verify with a tester.' }],
  }));
  assert.equal(d.safety.callPro, false);
  assert.deepEqual(d.safety.ruleFlags, []);
});

test('safety: furnace filter change stays DIY', () => {
  const d = applySafetyRules('time to change the furnace filter', baseDiag({ title: 'Dirty furnace filter', likelyCause: 'Filter clogged.' }));
  assert.equal(d.safety.callPro, false);
});

test('safety: popcorn ceiling flagged for asbestos', () => {
  const d = applySafetyRules('want to scrape the popcorn ceiling, house built 1962', baseDiag());
  assert.ok(d.safety.ruleFlags.includes('asbestos-lead'));
});

test('MAX_TOKENS empty response -> clear 502', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }) });
  const r = await handler(ev({ description: 'x' }), { fetch: f });
  assert.equal(r.statusCode, 502);
  assert.match(JSON.parse(r.body).error, /cut off/);
});

test('Gemini 503 -> friendly busy message', async () => {
  const f = async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'high demand' } }) });
  const r = await handler(ev({ description: 'x' }), { fetch: f });
  assert.equal(r.statusCode, 503);
  assert.match(JSON.parse(r.body).error, /busy/);
});

test('malformed JSON from model -> 502', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{not json' }] } }] }) });
  const r = await handler(ev({ description: 'x' }), { fetch: f });
  assert.equal(r.statusCode, 502);
});

test('missing API key -> 500 with setup hint', async () => {
  const k = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  const r = await handler(ev({ description: 'x' }));
  process.env.GEMINI_API_KEY = k;
  assert.equal(r.statusCode, 500);
  assert.match(JSON.parse(r.body).error, /GEMINI_API_KEY/);
});
