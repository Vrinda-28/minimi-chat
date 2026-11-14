import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { answer } from '../src/agent.js';
import { openStore } from '../src/store.js';
import { buildContext } from '../src/context.js';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY in .env to run live cases.');
  process.exit(1);
}

const store = openStore(':memory:');
const owner = 'evaluator';
const zone = 'America/New_York';
const now = Date.parse('2026-11-14T15:00:00Z');
const seed = store.create(owner, now);
const active = store.create(owner, now);
function prior(day, question, text) {
  store.save({
    id: randomUUID(), chatId: seed.id, askedAt: Date.parse(day + 'T16:00:00Z'),
    question, parts: [{ text, citations: [] }],
  });
}
prior('2026-11-09', 'Shortlist five CRM tools for a 20-person sales team.',
  'We shortlisted HubSpot Sales Hub, Pipedrive, Salesforce Sales Cloud, Zoho CRM, and Freshsales.');
prior('2026-11-03', 'Which managed Postgres hosts offer a free plan?',
  'We discussed Neon, Supabase, and Render. The answer said that all three offer a free tier.');

const cases = {
  crm: ['On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?', true],
  postgres: ['Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', true],
  date: ['What did I ask you on 3 November? Is your answer still correct today?', true],
  recall: ['What exactly did I ask you on 3 November? Only quote my question.', false],
  missing: ['What did I ask you on 5 November? Is your answer still correct today?', false],
  casual: ['Thanks! Please say goodnight in one sentence.', false],
};

try {
  const selected = process.argv[2] ? [process.argv[2]] : Object.keys(cases);
  for (const name of selected) {
    assert.ok(cases[name], 'Choose one of ' + Object.keys(cases).join(', '));
    const [question, needsSearch] = cases[name];
    const start = Date.now();
    const result = await answer({
      context: buildContext({ store, owner, chatId: active.id, question, now, zone }),
      model: process.env.OPENAI_MODEL || 'gpt-6-astra',
      apiKey: process.env.OPENAI_API_KEY,
      signal: AbortSignal.timeout(85_000),
      emit() {},
    });
    const citations = result.parts.flatMap(part => part.citations);
    console.log(JSON.stringify({
      case: name, searches: result.searches, sources: [...new Set(citations.map(c => c.url))],
      firstTextMs: result.firstTextAt && result.firstTextAt - start, elapsedMs: Date.now() - start,
    }));
    console.log(result.parts.map(part => part.text).join('\n\n') + '\n');
    assert.equal(result.searches > 0, needsSearch, name + ' search behavior');
    if (needsSearch) assert.ok(citations.length, name + ' needs citations');
  }
} finally {
  store.close();
}
