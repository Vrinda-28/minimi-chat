import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDay, resolveDays } from '../src/dates.js';
import { openStore } from '../src/store.js';
import { buildContext } from '../src/context.js';
import { answer } from '../src/agent.js';

const at = value => Date.parse(value);
const zone = 'Asia/Kolkata';
const saturday = at('2026-11-14T14:00:00Z');

test('date references use the browser calendar and never roll invalid dates forward', () => {
  assert.equal(localDay(at('2026-11-03T19:00:00Z'), zone), '2026-11-04');
  assert.deepEqual(resolveDays('On Monday and last Tuesday', saturday, zone), ['2026-11-09', '2026-11-03']);
  assert.deepEqual(resolveDays('What did I ask on 3 November? Is it correct today?', saturday, zone),
    ['2026-11-03', '2026-11-14']);
  assert.deepEqual(resolveDays('On Feb 29, 2026 or 2026-04-31?', saturday, zone), []);
  assert.deepEqual(resolveDays('On February 29?', saturday, zone), ['2024-02-29']);
  assert.deepEqual(resolveDays('yesterday', at('2026-03-09T07:10:00Z'), 'America/Los_Angeles'), ['2026-03-08']);
});

test('recalls correct cross-chat turns by local date and topic, scoped to the browser', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const old = store.create('alice', saturday);
  const active = store.create('alice', saturday);
  const stranger = store.create('bob', saturday);
  function seed(chat, time, question, text) {
    store.save({ id: randomUUID(), chatId: chat.id, askedAt: at(time), question, parts: [{ text, citations: [] }] });
  }
  seed(old, '2026-11-02T19:00:00Z', 'Compare three hosted Postgres options.', 'We shortlisted Neon, Supabase, and Render.');
  seed(old, '2026-11-03T19:00:00Z', 'What did we decide about a gift?', 'A book.');
  seed(active, '2026-11-13T12:00:00Z', 'Explain SQL joins.', 'A join combines rows.');
  seed(stranger, '2026-11-03T01:00:00Z', 'Private Postgres draft', 'Secret.');
  function context(question) {
    const input = buildContext({ store, owner: 'alice', chatId: active.id, question, now: saturday, zone }).input;
    return JSON.parse(input[0].content.split('\n')[1]);
  }
  const dated = context('What did I ask on 3 November? Is your answer still correct today?');
  assert.equal(dated.dateHints[0].completedTurns, 1);
  assert.match(dated.excerpts[0].priorAnswer, /Neon, Supabase, and Render/);
  assert.equal(dated.excerpts[0].date, '2026-11-03');
  assert.ok(!dated.excerpts.some(turn => /gift|Private/.test(turn.question)));
  const topical = context('Has Postgres hosting changed pricing since we talked?');
  assert.ok(topical.excerpts.some(turn => turn.kind === 'topic match' && /Neon/.test(turn.priorAnswer)));
  assert.ok(!topical.excerpts.some(turn => /Private/.test(turn.question)));
  assert.equal(context('What did I ask on 5 November?').dateHints[0].completedTurns, 0);
});

function fakeResponse(events) {
  const body = Buffer.from(events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < body.length; i += 3) controller.enqueue(body.subarray(i, i + 3));
      controller.close();
    },
  }));
}

test('streams split OpenAI frames and retains the authoritative citation annotations', async () => {
  const emitted = [];
  const result = await answer({
    context: { instructions: 'Test', input: [] }, apiKey: 'placeholder', model: 'fixture',
    emit: event => emitted.push(event),
    fetchResponse: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.tools, [{ type: 'web_search', external_web_access: true }]);
      assert.equal(payload.store, false);
      return fakeResponse([
        { type: 'response.web_search_call.in_progress', item_id: 'one' },
        { type: 'response.web_search_call.searching', item_id: 'one' },
        { type: 'response.output_text.delta', delta: 'Café' },
        { type: 'response.completed', response: { output: [
          { type: 'web_search_call', action: { type: 'search' } },
          { type: 'message', role: 'assistant', content: [{
            type: 'output_text', text: 'Café',
            annotations: [
              { type: 'url_citation', url: 'https://example.com', title: 'Source', start_index: 0, end_index: 4 },
              { type: 'url_citation', url: 'javascript:alert(1)' },
            ],
          }] },
        ] } },
      ]);
    },
  });
  assert.deepEqual(emitted, [{ type: 'search' }, { type: 'delta', text: 'Café' }]);
  assert.equal(result.searches, 1);
  assert.deepEqual(result.parts, [{
    text: 'Café', citations: [{ url: 'https://example.com', title: 'Source', start: 0, end: 4 }],
  }]);
});

test('a dropped upstream stream does not produce a completed answer', async () => {
  await assert.rejects(answer({
    context: {}, apiKey: 'placeholder', model: 'fixture', emit() {},
    fetchResponse: async () => fakeResponse([{ type: 'response.output_text.delta', delta: 'Partial' }]),
  }), /before the reply completed/);
});
