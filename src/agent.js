export class AgentError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// SSE messages can straddle TCP chunks, including in the middle of a UTF-8 character.
export async function* readEvents(stream) {
  let buffer = '';
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}

function webCitation(citation) {
  if (citation.type !== 'url_citation') return false;
  try {
    return ['https:', 'http:'].includes(new URL(citation.url).protocol);
  } catch {
    return false;
  }
}

function getParts(response) {
  return (response.output || []).filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content)
    .flatMap(part => {
      if (part.type === 'refusal' && part.refusal) return [{ text: part.refusal, citations: [] }];
      if (part.type !== 'output_text' || !part.text.trim()) return [];
      return [{
        text: part.text,
        citations: (part.annotations || []).filter(webCitation)
          .map(({ url, title, start_index, end_index }) => ({ url, title, start: start_index, end: end_index })),
      }];
    });
}

export async function answer({ context, signal, emit, apiKey, model, fetchResponse = fetch }) {
  if (!apiKey) throw new AgentError('Set OPENAI_API_KEY in .env and restart the server.', 503);
  const upstream = await fetchResponse('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      ...context,
      store: false,
      stream: true,
      reasoning: { effort: 'low' },
      tools: [{ type: 'web_search', external_web_access: true }],
      tool_choice: 'auto',
      max_tool_calls: 14,
      max_output_tokens: 9500,
    }),
    signal,
  });
  if (!upstream.ok || !upstream.body) {
    const error = await upstream.json().catch(() => ({}));
    console.error('OpenAI request failed', upstream.status, error.error?.code, upstream.headers?.get('x-request-id'));
    const message = {
      401: 'OpenAI rejected the API key. Check .env and restart.',
      403: 'The API key cannot access this model. Check OPENAI_MODEL and project access.',
      404: 'The configured model is unavailable to this API project. Check OPENAI_MODEL.',
      429: error.error?.code === 'insufficient_quota'
        ? 'The OpenAI project is out of API quota. Check its billing settings.'
        : 'OpenAI is rate limiting this request. Try again shortly.',
    }[upstream.status];
    throw new AgentError(message || 'The model provider could not start a reply. Please try again.');
  }

  const searchIds = new Set();
  let firstTextAt;
  let firstSearchAt;
  for await (const event of readEvents(upstream.body)) {
    switch (event.type) {
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
        firstSearchAt ??= Date.now();
        if (!searchIds.has(event.item_id)) {
          searchIds.add(event.item_id);
          emit({ type: 'search' });
        }
        break;
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        firstTextAt ??= Date.now();
        if (event.delta) emit({ type: 'delta', text: event.delta });
        break;
      case 'response.completed': {
        const parts = getParts(event.response);
        if (!parts.length) throw new AgentError('The model returned an empty reply. Please try again.');
        return {
          parts,
          firstTextAt,
          firstSearchAt,
          searches: (event.response.output || []).filter(item =>
            item.type === 'web_search_call' && item.action?.type === 'search').length,
          usage: event.response.usage,
        };
      }
      case 'response.incomplete':
      case 'response.failed':
      case 'error':
        throw new AgentError('The model could not finish the reply. Please try again.');
    }
  }
  throw new AgentError('The connection ended before the reply completed. Please try again.');
}
