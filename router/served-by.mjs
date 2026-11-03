// Which provider served a response, for callers that ask with
// `X-Codex-Router-Report: provider`. The final event says it at once:
// Anthropic or OpenAI on those routes, and `unknown` on OpenRouter, whose
// Responses API names no provider and records it only some seconds after the
// stream ends, often more than 20. The caller asks later with
// `GET /v1/generations/<id>`, and the router looks the generation up then, with
// its own key. It keeps only the ID, the provider and a time, in memory.
import https from 'node:https';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { sseEvents } from './common.mjs';
import { openrouterApiKey } from './config.mjs';
import { finalEventTypes } from './upstream.mjs';

export const reportValues = ['provider'];
const lookupTimeoutMs = 5000;
const maxLookupBytes = 64 * 1024;
// A generation is answerable for a day, and pending for half an hour: after
// that, a record OpenRouter still lacks is reported as unknown.
const keepMs = 24 * 60 * 60 * 1000;
const pendingMs = 30 * 60 * 1000;
const maxGenerations = 10000;
// OpenRouter's Responses `id` is the generation ID.
const generationIdPattern = /^gen-[A-Za-z0-9-]{1,128}$/;
const finalEventPattern = /"type"\s*:\s*"response\.(?:completed|incomplete|failed)"/;
const generations = new Map();

function lookupOnce(id) {
  return new Promise(resolve => {
    const request = https.request({
      hostname: 'openrouter.ai',
      path: `/api/v1/generation?id=${encodeURIComponent(id)}`,
      method: 'GET',
      headers: { authorization: `Bearer ${openrouterApiKey}`, accept: 'application/json' },
      timeout: lookupTimeoutMs,
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes <= maxLookupBytes) chunks.push(data);
      });
      response.on('end', () => {
        let name = null;
        if (response.statusCode === 200 && bytes <= maxLookupBytes) {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.data?.provider_name;
            if (typeof value === 'string' && value.length > 0 && value.length <= 100) name = value;
          } catch {
            // An unreadable record names no provider.
          }
        }
        resolve({ status: response.statusCode ?? null, name });
      });
      response.on('error', () => resolve({ status: null, name: null }));
    });
    request.on('timeout', () => request.destroy(new Error('Generation lookup timed out')));
    request.on('error', () => resolve({ status: null, name: null }));
    request.end();
  });
}

function rememberGeneration(id) {
  if (typeof id !== 'string' || !generationIdPattern.test(id) || generations.has(id)) return;
  const cutoff = Date.now() - keepMs;
  for (const [key, entry] of generations) {
    if (entry.at > cutoff && generations.size < maxGenerations) break;
    generations.delete(key);
  }
  generations.set(id, { at: Date.now(), provider: null, final: false });
}

// The answer for `GET /v1/generations/<id>`, or null for an ID this router did
// not serve with the report in the last day. `status` is `resolved` with the
// provider's name, `pending` while OpenRouter has no record yet, or `unknown`.
export async function generationReport(id) {
  const entry = generations.get(id);
  if (!entry || Date.now() - entry.at >= keepMs) return null;
  if (!entry.final && openrouterApiKey) {
    const { status, name } = await lookupOnce(id);
    if (name) Object.assign(entry, { provider: name, final: true });
    else if (status !== null && status !== 404 && status < 500) entry.final = true;
  }
  if (!entry.final && Date.now() - entry.at >= pendingMs) entry.final = true;
  const status = entry.provider ? 'resolved' : entry.final ? 'unknown' : 'pending';
  return { id, status, provider: entry.provider ?? 'unknown' };
}

function finalEvent(block) {
  const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).replace(/^ /, '')).join('\n');
  if (!data || !finalEventPattern.test(data)) return null;
  try {
    const event = JSON.parse(data);
    return finalEventTypes.has(event?.type) && event.response && typeof event.response === 'object' ? event : null;
  } catch {
    return null;
  }
}

// Passes every event through as it completes, and adds to the final one
// `response.provider`: the route's own name (Anthropic, OpenAI), or `unknown` on
// OpenRouter, whose generation is remembered for a later lookup. A request
// pinned to exactly one endpoint also gets `response.endpoint`, that tag.
export function servedByStream({ provider = null, endpoint = null } = {}) {
  const decoder = new StringDecoder('utf8');
  const buffered = { pending: '' };
  const pass = (stream, text) => {
    for (const block of sseEvents(buffered, text)) {
      const event = finalEvent(block);
      if (!event) {
        stream.push(`${block}\n\n`);
        continue;
      }
      event.response.provider = provider ?? 'unknown';
      if (endpoint) event.response.endpoint = endpoint;
      if (!provider) rememberGeneration(event.response.id);
      const eventLine = block.split(/\r?\n/).find(line => line.startsWith('event:'));
      stream.push(`${eventLine ? `${eventLine}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
    }
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      pass(this, decoder.write(chunk));
      callback();
    },
    flush(callback) {
      pass(this, decoder.end());
      if (buffered.pending) this.push(buffered.pending);
      callback();
    },
  });
}
