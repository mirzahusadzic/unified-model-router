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
// A full store drops its oldest generation first.
const maxGenerations = 50000;
// One lookup per generation at a time, and at most one every few seconds.
const minLookupGapMs = 5000;
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

// `id` is the response ID the caller sees; `generation` is the OpenRouter
// generation that produced the final answer, which differs after a search.
function rememberGeneration(id, generation = id) {
  if (typeof id !== 'string' || typeof generation !== 'string' || !generationIdPattern.test(generation)
    || generations.has(id)) return;
  const cutoff = Date.now() - keepMs;
  for (const [key, entry] of generations) {
    if (entry.at > cutoff && generations.size < maxGenerations) break;
    generations.delete(key);
  }
  generations.set(id, { at: Date.now(), generation, provider: null, lookedUpAt: 0, inFlight: null });
}

// The answer for `GET /v1/generations/<id>`, or null for an ID this router did
// not serve with the report in the last day. `status` is `resolved` with the
// provider's name, `pending` while OpenRouter has no record yet, or `unknown`.
// Only a provider's name resolves a generation; any other answer, a rate limit
// included, leaves it pending until the half hour is up.
export async function generationReport(id) {
  const entry = generations.get(id);
  if (!entry || Date.now() - entry.at >= keepMs) return null;
  const open = () => !entry.provider && Date.now() - entry.at < pendingMs;
  if (open() && openrouterApiKey && !entry.inFlight && Date.now() - entry.lookedUpAt >= minLookupGapMs) {
    entry.lookedUpAt = Date.now();
    entry.inFlight = lookupOnce(entry.generation).then(({ name }) => {
      if (name) entry.provider = name;
    }).finally(() => {
      entry.inFlight = null;
    });
  }
  if (entry.inFlight) await entry.inFlight;
  const status = entry.provider ? 'resolved' : open() ? 'pending' : 'unknown';
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
// pinned to exactly one endpoint also gets `response.endpoint`, that tag, when
// an upstream produced the final event. `source`, filled in by the search
// step, names the generation behind the final event and whether an upstream
// produced it rather than the router.
export function servedByStream({ provider = null, endpoint = null, source = {} } = {}) {
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
      if (endpoint && source.upstreamFinal !== false) event.response.endpoint = endpoint;
      if (!provider && source.upstreamFinal !== false) rememberGeneration(event.response.id, source.generationId ?? event.response.id);
      // Only the data changes; the event's other lines keep their place.
      const lines = block.split(/\r?\n/);
      const firstData = lines.findIndex(line => line.startsWith('data:'));
      const kept = lines.flatMap((line, index) => (index === firstData ? [`data: ${JSON.stringify(event)}`]
        : line.startsWith('data:') ? [] : [line]));
      const newline = block.includes('\r\n') ? '\r\n' : '\n';
      stream.push(`${kept.join(newline)}${newline}${newline}`);
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
