// Where a model's requests go and how they travel: routes, upstream headers,
// the shared request opener, error bodies, and the usage tap.
import https from 'node:https';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { anthropicHeaders, anthropicResponse, messagesRequest } from './anthropic.mjs';
import { contextOverflowPattern, isObject, maxEventLineChars } from './common.mjs';
import { anthropicApiKey, configuredLogLevel, logLevels, openrouterApiKey } from './config.mjs';

export const contextOverflowMessage = 'The conversation exceeds the model context window.';

const maxCapturedUpstreamErrorBytes = 256 * 1024;

// OpenRouter slugs: `deepseek/` and `openrouter/<vendor>/<model>`, plus the
// `ultra-spark/` and `ultra-spark-private/` aliases, which select DeepSeek with
// a delegation policy: to Contributor workers, or to non-training ones.
const openrouterPrefixes = ['deepseek/', 'openrouter/', 'ultra-spark/', 'ultra-spark-private/'];
// `anthropic/<model ID>` selects Claude on its route: Anthropic's API, or
// OpenRouter's copy of the same model (see claudeRoute).
const anthropicPrefix = 'anthropic/';
const anthropicTarget = {
  provider: 'anthropic',
  hostname: 'api.anthropic.com',
  path: '/v1/messages',
  protocol: https,
};

export function routeFor(model) {
  if (typeof model === 'string' && model.startsWith(anthropicPrefix)) return anthropicTarget;
  if (typeof model === 'string' && openrouterPrefixes.some(prefix => model.startsWith(prefix))) {
    return {
      provider: 'openrouter',
      hostname: 'openrouter.ai',
      path: '/api/v1/responses',
      protocol: https,
    };
  }
  return {
    provider: 'openai',
    hostname: 'chatgpt.com',
    path: '/backend-api/codex/responses',
    protocol: https,
  };
}

export function upstreamModelFor(model, provider) {
  if (typeof model !== 'string') return model;
  if (provider === 'anthropic') return model.slice(anthropicPrefix.length);
  if (provider !== 'openrouter') return model;
  // OpenRouter writes Claude's version with a dot: claude-sonnet-5-5 is anthropic/claude-sonnet-5.5.
  if (model.startsWith(anthropicPrefix)) return model.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  if (model.startsWith('openrouter/')) return model.slice('openrouter/'.length);
  if (model.startsWith('ultra-spark/')) return `deepseek/${model.slice('ultra-spark/'.length)}`;
  if (model.startsWith('ultra-spark-private/')) return `deepseek/${model.slice('ultra-spark-private/'.length)}`;
  return model;
}

export function upstreamTrace(headers) {
  const value = name => {
    const candidate = headers?.[name];
    return typeof candidate === 'string' && candidate.length <= 256 ? candidate : null;
  };
  return {
    generationId: value('x-generation-id'),
    providerName: value('x-provider-name'),
    upstreamRequestId: value('x-request-id') || value('request-id'),
    cloudflareRayId: value('cf-ray'),
  };
}

export function upstreamHeaders(requestHeaders, provider, bodyLength) {
  if (provider === 'anthropic') {
    if (!anthropicApiKey) {
      const error = new Error('ANTHROPIC_API_KEY is not configured for the Unified Model Router');
      error.statusCode = 503;
      throw error;
    }
    return anthropicHeaders(anthropicApiKey, bodyLength);
  }
  const allowed = ['accept', 'user-agent'];
  if (provider === 'openai') {
    // Codex 0.163 sends hyphenated session headers; earlier versions used
    // session_id and conversation_id.
    allowed.push('authorization', 'chatgpt-account-id', 'openai-beta', 'originator',
      'version', 'session-id', 'thread-id', 'session_id', 'conversation_id', 'x-request-id',
      'x-client-request-id', 'x-codex-window-id', 'x-codex-turn-metadata', 'x-codex-turn-state',
      'x-codex-beta-features', 'x-openai-internal-codex-responses-lite');
  }
  const headers = Object.fromEntries(allowed
    .filter(name => requestHeaders[name] !== undefined)
    .map(name => [name, requestHeaders[name]]));
  headers['content-length'] = String(bodyLength);
  headers['accept-encoding'] = 'identity';
  headers['content-type'] = 'application/json';

  if (provider === 'openrouter') {
    if (!openrouterApiKey) {
      const error = new Error('OPENROUTER_API_KEY is not configured for the Unified Model Router');
      error.statusCode = 503;
      throw error;
    }
    headers.authorization = `Bearer ${openrouterApiKey}`;
  } else if (!headers.authorization) {
    const error = new Error('The OpenAI request did not include Codex authentication');
    error.statusCode = 401;
    throw error;
  }
  return headers;
}

const upstreamTimeoutMs = 300000;
export const openrouterTarget = routeFor('openrouter/');

// Every request the router sends upstream starts here: the same options,
// timeout, and error handling, and the body is sent at once. Callers track the
// returned request so a client disconnect can cancel it.
export function openUpstream({ target, headers, body, timeoutMs = upstreamTimeoutMs, onError, log = () => {}, promptCache = null }, onResponse) {
  let sent = body;
  let respond = onResponse;
  if (target.provider === 'anthropic') {
    const translated = messagesRequest(JSON.parse(body.toString('utf8')), { promptCache });
    sent = Buffer.from(JSON.stringify(translated.body));
    headers = { ...headers, 'content-length': String(sent.length) };
    respond = upstreamResponse => onResponse(anthropicResponse(upstreamResponse, translated.declared, log));
  }
  const upstream = target.protocol.request({
    hostname: target.hostname,
    path: target.path,
    method: 'POST',
    headers,
    timeout: timeoutMs,
  }, respond);
  upstream.on('timeout', () => upstream.destroy(new Error('Upstream request timed out')));
  upstream.on('error', onError);
  upstream.end(sent);
  return upstream;
}

export function parseUpstreamError(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const messages = [parsed?.error?.message, parsed?.error?.metadata?.raw]
      .filter(value => typeof value === 'string');
    const errorType = parsed?.error_type ?? parsed?.error?.type ?? null;
    return {
      errorCode: parsed?.error?.code ?? null,
      errorType,
      // OpenRouter's Responses API can report the overflow only in error_type.
      contextOverflow: [parsed?.error?.code, errorType].includes('context_length_exceeded')
        || messages.some(message => contextOverflowPattern.test(message)),
    };
  } catch {
    return { errorCode: null, errorType: null, contextOverflow: false };
  }
}

export function readUpstreamBody(stream, limit = maxCapturedUpstreamErrorBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    stream.on('data', chunk => {
      const buffer = Buffer.from(chunk);
      if (bytes + buffer.length > limit) {
        const remaining = Math.max(0, limit - bytes);
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        bytes = limit;
        truncated = true;
        succeed({ body: Buffer.concat(chunks), bytes, truncated });
        stream.destroy();
        return;
      }
      chunks.push(buffer);
      bytes += buffer.length;
    });
    stream.once('error', fail);
    stream.once('aborted', () => fail(new Error('Upstream response was aborted')));
    stream.once('close', () => fail(new Error('Upstream response closed before it ended')));
    stream.once('end', () => succeed({ body: Buffer.concat(chunks), bytes, truncated }));
  });
}

// A Responses stream ends with a response.completed, response.incomplete, or
// response.failed event whose response carries the token usage. The tap reads
// it as chunks pass through, without holding any back. It buffers one SSE line
// at a time, up to a bound, and parses only a line that names a final event
// type, wherever the type appears in it: JSON does not fix property order, and
// OpenRouter sends no `event:` lines. It runs only at `info` level.
export const usageLogging = logLevels[configuredLogLevel] >= logLevels.info;
export const finalEventTypes = new Set(['response.completed', 'response.incomplete', 'response.failed']);
const finalEventPattern = /"type"\s*:\s*"response\.(?:completed|incomplete|failed)"/;

// Only numbers are kept, one level deep, so usage can never carry content.
function tokenCounts(usage) {
  if (!isObject(usage)) return null;
  const counts = {};
  for (const [name, value] of Object.entries(usage)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[name] = value;
    else if (isObject(value)) {
      const nested = Object.fromEntries(Object.entries(value)
        .filter(([, item]) => typeof item === 'number' && Number.isFinite(item)));
      if (Object.keys(nested).length > 0) counts[name] = nested;
    }
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

export function usageTap(onUsage) {
  const decoder = new StringDecoder('utf8');
  let line = '';
  let overflow = false;
  const endLine = () => {
    if (!overflow && line.startsWith('data:') && finalEventPattern.test(line)) {
      try {
        const event = JSON.parse(line.slice('data:'.length));
        const usage = finalEventTypes.has(event?.type) ? tokenCounts(event.response?.usage) : null;
        if (usage) onUsage({ responseStatus: event.response.status ?? null, usage });
      } catch {
        // A malformed final event leaves nothing to log.
      }
    }
    line = '';
    overflow = false;
  };
  const scan = text => {
    for (let start = 0; start < text.length;) {
      const end = text.indexOf('\n', start);
      if (!overflow) {
        line += end === -1 ? text.slice(start) : text.slice(start, end);
        if (line.length > maxEventLineChars) {
          overflow = true;
          line = '';
        }
      }
      if (end === -1) break;
      endLine();
      start = end + 1;
    }
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        scan(decoder.write(chunk));
      } catch {
        overflow = true;
        line = '';
      }
      callback(null, chunk);
    },
    flush(callback) {
      try {
        scan(decoder.end());
        endLine();
      } catch {
        // Logging never affects the response.
      }
      callback();
    },
  });
}
