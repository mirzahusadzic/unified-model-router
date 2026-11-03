// Web search for router models, and the stream rewriter that runs it and
// normalizes tool arguments on the way to Codex.
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isObject, maxEventLineChars, sseEvents } from './common.mjs';
import { envFile, logEvent, modelCatalogFile, persistJson, providerOrders } from './config.mjs';
import { contextOverflowMessage, finalEventTypes, openUpstream, openrouterTarget, readUpstreamBody, upstreamHeaders } from './upstream.mjs';

// Web search for OpenRouter models runs in the router. Codex's hosted
// web_search tool would run on OpenRouter's side, which returns the results
// only as citations: later turns never show the model what it found, and for
// some models the step fails outright. The router offers the model a
// web_search function instead, runs each search through OpenRouter's web
// plugin on the selected model, and streams Codex a native web_search_call
// item. It keeps the results, so later requests carry each search as a call
// with its output.
const webSearchFunction = {
  type: 'function',
  name: 'web_search',
  description: 'Search the web. Returns the title, address, and an excerpt of each top result.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to search for.' } },
    required: ['query'],
    additionalProperties: false,
  },
  strict: false,
};
const webSearchResultsFile = join(dirname(envFile), 'web-search-results.json');
const webSearchRetentionMs = 30 * 24 * 60 * 60 * 1000;
const maxStoredWebSearches = 1000;
const maxWebSearchesPerRequest = 8;
const webSearchResultCount = 5;
// A replayed result counts as used, so a thread that keeps replaying a search
// keeps the same tool result, and with it Claude's cached prefix and signed
// thinking. A request that renews a result saved over an hour ago saves the
// results once, so a restart cannot bring back the old expiry; other uses are
// saved with the next write or the hourly maintenance.
const webSearchUseSaveMs = 60 * 60 * 1000;
const webSearchResults = loadWebSearchResults();
let webSearchesSavedAt = Date.now();
let webSearchesUsed = false;

function saveWebSearchResults() {
  webSearchesSavedAt = Date.now();
  webSearchesUsed = false;
  persistJson(webSearchResultsFile, Object.fromEntries(webSearchResults), 'web_search.persist_failed');
}

function loadWebSearchResults() {
  try {
    const stored = JSON.parse(readFileSync(webSearchResultsFile, 'utf8'));
    const now = Date.now();
    const entries = Object.entries(isObject(stored) ? stored : {});
    const current = new Map(entries
      .filter(([, entry]) => isObject(entry) && typeof entry.text === 'string' && now - entry.at < webSearchRetentionMs));
    // Expired results leave the file as well as memory.
    if (current.size < entries.length) persistJson(webSearchResultsFile, Object.fromEntries(current), 'web_search.persist_failed');
    return current;
  } catch (error) {
    if (error.code !== 'ENOENT') logEvent('error', 'web_search.load_failed', { errorCode: error.code || null });
    return new Map();
  }
}

function pruneWebSearchResults() {
  const now = Date.now();
  let pruned = false;
  for (const [key, entry] of webSearchResults) {
    if (now - entry.at >= webSearchRetentionMs) {
      webSearchResults.delete(key);
      pruned = true;
    }
  }
  return pruned;
}
// A router that runs for weeks without a search still drops expired results.
setInterval(() => {
  if (pruneWebSearchResults() || webSearchesUsed) saveWebSearchResults();
}, webSearchUseSaveMs).unref();

// Results belong to the session that searched: call IDs are unique only
// within a thread, so another session's call with the same ID never sees them.
const webSearchKey = (scope, callId) => JSON.stringify([scope ?? '', callId]);

// Without a session there is nothing to scope results to, so none are kept.
function storedWebSearchResults(scope, callId) {
  if (!scope) return null;
  const key = webSearchKey(scope, callId);
  const entry = webSearchResults.get(key);
  const now = Date.now();
  if (entry && now - entry.at < webSearchRetentionMs) {
    // Its 30 days start again, and it moves to the back of the eviction order.
    webSearchResults.delete(key);
    webSearchResults.set(key, { ...entry, at: now });
    webSearchesUsed = true;
    return { ...entry, renewed: now - entry.at >= webSearchUseSaveMs };
  }
  if (entry) {
    webSearchResults.delete(key);
    saveWebSearchResults();
  }
  return null;
}

function storeWebSearchResults(scope, callId, text, continued) {
  if (!scope) return;
  const now = Date.now();
  pruneWebSearchResults();
  const key = webSearchKey(scope, callId);
  webSearchResults.delete(key);
  webSearchResults.set(key, { at: now, text, continued: Boolean(continued) });
  while (webSearchResults.size > maxStoredWebSearches) webSearchResults.delete(webSearchResults.keys().next().value);
  saveWebSearchResults();
}

const callItemTypes = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'mcp_call', 'computer_call']);

// A caller that declares its own top-level web_search keeps it: the router
// offers its search under that name only when the name is free.
const ownsWebSearchName = tools => Array.isArray(tools)
  && tools.some(tool => tool?.type === 'function' && tool.name === webSearchFunction.name);

export function overrideWebSearchForOpenRouter(request, scope) {
  let offered = false;
  const nameTaken = ownsWebSearchName(request.tools);
  if (Array.isArray(request.tools)) {
    request.tools = request.tools.flatMap(tool => {
      if (!['web_search', 'web_search_preview'].includes(tool?.type)) return [tool];
      if (nameTaken) return [];
      offered = true;
      return [webSearchFunction];
    });
  }
  let restored = 0;
  let renewed = false;
  if (Array.isArray(request.input)) {
    // A step's calls stay together, so the provider sees one assistant turn
    // with its reasoning: each search becomes a call in place, and its output
    // follows the step's last call, beside the outputs Codex returns. A step
    // of searches alone was continued with their results, so whatever follows
    // it belongs to the next step. A step that also made other calls ends at
    // its last call, across the reasoning and text between them; only results
    // stored as such (`continued: false`) are kept back that way.
    const input = [];
    let outputs = [];
    let heldAcrossStep = true;
    const flush = () => {
      input.push(...outputs);
      outputs = [];
      heldAcrossStep = true;
    };
    const stepItem = item => item?.type === 'reasoning' || (item?.role === 'assistant' && (item.type == null || item.type === 'message'));
    const callFollows = index => {
      let ahead = index;
      while (ahead < request.input.length && stepItem(request.input[ahead])) ahead += 1;
      return callItemTypes.has(request.input[ahead]?.type) || request.input[ahead]?.type === 'web_search_call';
    };
    for (const [index, item] of request.input.entries()) {
      if (item?.type === 'web_search_call') {
        restored += 1;
        const callId = typeof item.id === 'string' && item.id ? item.id : `ws_restored_${restored}`;
        const query = typeof item.action?.query === 'string' ? item.action.query : '';
        const stored = storedWebSearchResults(scope, callId);
        input.push({ type: 'function_call', call_id: callId, name: 'web_search', arguments: JSON.stringify({ query }) });
        outputs.push({ type: 'function_call_output', call_id: callId, output: stored?.text
          ?? 'The results of this search are not available any more. Search again if they matter.' });
        if (stored?.continued !== false) heldAcrossStep = false;
        if (stored?.renewed) renewed = true;
        continue;
      }
      if (!callItemTypes.has(item?.type) && !(outputs.length > 0 && heldAcrossStep && stepItem(item) && callFollows(index))) flush();
      input.push(item);
    }
    flush();
    request.input = input;
  }
  if (renewed) saveWebSearchResults();
  // A restored call needs its function declared, even when Codex offered no search this time.
  if (restored > 0 && !offered && !nameTaken) {
    request.tools = [...(Array.isArray(request.tools) ? request.tools : []), webSearchFunction];
    offered = true;
  }
  return { offered, restored };
}

// The search runs at the lowest effort the model's catalog entry offers.
export function webSearchEffort(requestedModel) {
  try {
    const catalog = JSON.parse(readFileSync(modelCatalogFile, 'utf8'));
    const levels = (catalog.models ?? []).find(model => model.slug === requestedModel)?.supported_reasoning_levels
      ?.map(level => level.effort) ?? [];
    return levels.includes('none') ? 'none' : levels[0] ?? 'low';
  } catch {
    return 'low';
  }
}

// The excerpts of one search share a budget. Exa sizes them unevenly, often
// four short ones and one many times longer, so the short ones keep all their
// text and the long ones split what the short ones leave.
const webSearchExcerptChars = 10000;
function excerptLimits(lengths) {
  const limits = [];
  let left = webSearchExcerptChars;
  const shortestFirst = lengths.map((length, index) => index).sort((a, b) => lengths[a] - lengths[b]);
  shortestFirst.forEach((index, position) => {
    limits[index] = Math.min(lengths[index], Math.floor(left / (lengths.length - position)));
    left -= limits[index];
  });
  return limits;
}

// Every part is bounded, so one stored search stays under about 18 KiB.
const shorten = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
function formatWebSearchResults(query, results, failure) {
  const asked = shorten(query.replace(/\s+/g, ' ').trim(), 500);
  if (failure) return `The web search for "${asked}" failed: ${failure}. Say so, and answer from what you already know or try another query.`;
  if (results.length === 0) return `The web search for "${asked}" returned no results.`;
  const shown = results.slice(0, webSearchResultCount);
  const excerpts = shown.map(result => result.content.replace(/\s+/g, ' ').trim());
  const limits = excerptLimits(excerpts.map(excerpt => excerpt.length));
  return [`Web search results for "${asked}":`, ...shown.map((result, index) => [
    `${index + 1}. ${shorten(result.title.replace(/\s+/g, ' ').trim() || result.url, 300)}`, `   ${shorten(result.url, 1000)}`,
    `   ${shorten(excerpts[index], limits[index])}`].join('\n'))].join('\n\n');
}

// One search through OpenRouter's web plugin: the reply is a token or two, and
// the results arrive as its citations, each with an excerpt of the page.
export function runWebSearch({ query, upstreamModel, effort, dataCollection, endpoints = null, log, register }) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (results, failure, cost = null) => {
      if (settled) return;
      settled = true;
      log(failure ? 'error' : 'info', 'web_search.executed', {
        results: results.length, failed: Boolean(failure), durationMs: Date.now() - startedAt, cost,
      });
      resolve(formatWebSearchResults(query, results, failure));
    };
    const body = Buffer.from(JSON.stringify({
      model: upstreamModel,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Search the web for: ${query}\nReply with the word OK.` }] }],
      // Exa returns every result as a citation for any model; a provider's native search returns only what the reply cites.
      plugins: [{ id: 'web', engine: 'exa', max_results: webSearchResultCount }],
      reasoning: { effort },
      max_output_tokens: 4096,
      store: false,
      // The model's configured endpoint order applies, and a protected session's
      // query goes only to endpoints that do not collect data.
      ...(endpoints || providerOrders.has(upstreamModel) || dataCollection ? { provider: {
        // A caller's pinned endpoints cover the search too, with no fallbacks.
        ...(endpoints ? { order: endpoints, allow_fallbacks: false }
          : providerOrders.has(upstreamModel) ? { order: providerOrders.get(upstreamModel) } : {}),
        ...(dataCollection ? { data_collection: dataCollection } : {}),
      } } : {}),
    }));
    try {
      const searchRequest = openUpstream({
        target: openrouterTarget,
        headers: upstreamHeaders({}, 'openrouter', body.length),
        body,
        timeoutMs: 120000,
        onError: () => finish([], 'the search request failed'),
      }, searchResponse => {
        readUpstreamBody(searchResponse, 8 * 1024 * 1024).then(({ body: raw }) => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            // Reported below as an unreadable response.
          }
          if (searchResponse.statusCode !== 200 || !isObject(parsed)) {
            finish([], `the search service answered with HTTP ${searchResponse.statusCode}`);
            return;
          }
          const results = [];
          const urls = new Set();
          for (const item of Array.isArray(parsed.output) ? parsed.output : []) {
            for (const part of Array.isArray(item?.content) ? item.content : []) {
              for (const note of Array.isArray(part?.annotations) ? part.annotations : []) {
                if (note?.type !== 'url_citation' || typeof note.url !== 'string' || urls.has(note.url)) continue;
                urls.add(note.url);
                results.push({ title: String(note.title ?? ''), url: note.url, content: String(note.content ?? '') });
              }
            }
          }
          finish(results, null, typeof parsed.usage?.cost === 'number' ? parsed.usage.cost : null);
        }, () => finish([], 'the search response could not be read'));
      });
      // Cancelling the search when Codex leaves also settles it.
      register(searchRequest, () => finish([], 'the search was cancelled'));
    } catch {
      finish([], 'the search request failed');
    }
  });
}

// The router's own search has no namespace; a grouped tool of the same name belongs to the caller.
const isWebSearchCall = item => item?.type === 'function_call' && item.name === webSearchFunction.name
  && (item.namespace == null || item.namespace === '' || item.namespace === 'functions');

// Some models write whole numbers in tool arguments as floats, such as
// DeepSeek's `"timeout_ms": 60000.0`, and Codex rejects a float where it
// expects an integer. Codex parses a call's finished arguments, not its
// streamed deltas, so the finished copy is rewritten, token by token: only a
// number like 60000.0 changes, and strings and everything else stay as sent.
function wholeNumberArguments(text) {
  if (typeof text !== 'string' || !/\d\.0/.test(text)) return text;
  let result = '';
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      result += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const number = character === '-' || (character >= '0' && character <= '9')
      ? text.slice(index).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0] : null;
    if (!number) {
      result += character;
      index += 1;
      continue;
    }
    result += /^-?\d+\.0+$/.test(number) ? number.slice(0, number.indexOf('.')) : number;
    index += number.length;
  }
  return result;
}

const wholeNumberCall = item => (item?.type === 'function_call' && typeof item.arguments === 'string'
  ? { ...item, arguments: wholeNumberArguments(item.arguments) } : item);

function addUsage(total, usage) {
  if (!isObject(usage)) return total;
  const sum = { ...(total ?? {}) };
  for (const [name, value] of Object.entries(usage)) {
    if (typeof value === 'number') sum[name] = (typeof sum[name] === 'number' ? sum[name] : 0) + value;
    else if (isObject(value)) sum[name] = addUsage(isObject(sum[name]) ? sum[name] : {}, value);
  }
  return sum;
}

// Every OpenRouter event stream passes through here as it arrives. Finished
// tool calls get whole-number arguments. When the router offered its own
// web_search, it holds back the model's search calls; at the end of a
// response it runs the searches, streams native web_search_call items, and,
// when no other call is pending, continues the same response upstream with
// the results, up to a bound.
export function openRouterStream({ interceptSearches = false, requestBody, sendContinuation, search, log = () => {}, closed = () => false, scope = '', source = {} }) {
  const decoder = new StringDecoder('utf8');
  const firstBuffer = { pending: '', passThrough: false };
  let searches = 0;
  let finished = false;
  let firstResponseId = null;
  let earlierOutput = [];
  let earlierUpstreamItems = [];
  let usage = null;
  let transform;
  const emit = event => transform.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

  const newRound = continuation => ({ continuation, hidden: new Set(), calls: [], otherCalls: false, streamed: [], open: new Map() });
  let round = newRound(false);

  const handleEvent = async (block, event) => {
    const type = event?.type;
    const item = event?.item;
    if (type === 'response.created' && !round.continuation) firstResponseId = event.response?.id ?? null;
    if (round.continuation && (type === 'response.created' || type === 'response.in_progress')) return;
    if (interceptSearches && (type === 'response.output_item.added' || type === 'response.output_item.done') && isWebSearchCall(item)) {
      round.hidden.add(item.id);
      if (type === 'response.output_item.done') round.calls.push(item);
      return;
    }
    if (typeof type === 'string' && type.startsWith('response.function_call_arguments.') && round.hidden.has(event.item_id)) return;
    if (type === 'response.output_item.added' && callItemTypes.has(item?.type)) round.otherCalls = true;
    if (!finalEventTypes.has(type)) {
      // A continuation's finished items stay part of the response if it breaks off later,
      // and a message it started is closed with the text streamed so far.
      if (round.continuation && type === 'response.output_item.added' && item?.type === 'message') round.open.set(item.id, { item, text: '' });
      if (round.continuation && type === 'response.output_text.delta' && round.open.has(event.item_id)) {
        round.open.get(event.item_id).text += typeof event.delta === 'string' ? event.delta : '';
      }
      // Codex parses the finished copy of a call's arguments.
      let forwarded = null;
      if (type === 'response.output_item.done' && item?.type === 'function_call') {
        const fixed = wholeNumberCall(item);
        if (fixed.arguments !== item.arguments) forwarded = { ...event, item: fixed };
      }
      if (type === 'response.function_call_arguments.done' && typeof event.arguments === 'string') {
        const fixed = wholeNumberArguments(event.arguments);
        if (fixed !== event.arguments) forwarded = { ...event, arguments: fixed };
      }
      if (forwarded) log('info', 'tool_arguments.normalized', { name: forwarded.item?.name ?? null });
      if (round.continuation && type === 'response.output_item.done' && item) {
        round.open.delete(item.id);
        round.streamed.push(forwarded?.item ?? item);
      }
      if (forwarded) emit(forwarded);
      else transform.push(`${block}\n\n`);
      return;
    }

    usage = addUsage(usage, event.response?.usage);
    const upstreamOutput = (Array.isArray(event.response?.output) ? event.response.output : []).map(wholeNumberCall);
    const calls = !interceptSearches ? [] : round.calls.length > 0 ? round.calls : upstreamOutput.filter(isWebSearchCall);
    // `upstream` is false when the router wrote the answer: the served-by report
    // then names no endpoint and looks up no generation.
    const finalize = (output, { upstream = true } = {}) => {
      finished = true;
      // The served-by report follows the generation that produced the answer.
      Object.assign(source, { generationId: event.response?.id ?? null, upstreamFinal: upstream });
      emit({ ...event, response: { ...event.response, id: firstResponseId ?? event.response?.id,
        output: [...earlierOutput, ...output], ...(usage ? { usage } : {}) } });
    };
    // A continuation that cannot finish still ends the response Codex is
    // reading: the searches, whatever the continuation already finished, and
    // the router's diagnostic.
    const diagnose = text => {
      const unfinished = [...round.open.values()].map(({ item: started, text: streamed }) => ({ ...started, status: 'incomplete',
        content: [{ type: 'output_text', annotations: [], text: streamed }] }));
      for (const started of unfinished) emit({ type: 'response.output_item.done', item: started });
      round.streamed.push(...unfinished);
      round.open.clear();
      const message = { type: 'message', id: `msg_router_${randomUUID().replaceAll('-', '')}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', annotations: [], text }] };
      emit({ type: 'response.output_item.added', item: message });
      emit({ type: 'response.output_item.done', item: message });
      finalize([...round.streamed, message], { upstream: false });
    };
    if (calls.length === 0) {
      // Nothing to merge or rewrite: the final event passes through exactly as sent.
      const original = Array.isArray(event.response?.output) ? event.response.output : [];
      if (!round.continuation && earlierOutput.length === 0 && upstreamOutput.every((entry, index) => entry === original[index])) {
        finished = true;
        Object.assign(source, { generationId: event.response?.id ?? null, upstreamFinal: true });
        transform.push(`${block}\n\n`);
        return;
      }
      finalize(upstreamOutput);
      return;
    }
    // A failed or incomplete response ends here; its search calls are dropped, never run.
    if (type !== 'response.completed') {
      finalize(upstreamOutput.filter(entry => !isWebSearchCall(entry)));
      return;
    }

    const searchItems = [];
    const results = [];
    let dropped = 0;
    // Codex runs its own calls and comes back with the searches in its history;
    // a step of searches alone continues here. Each stored result records
    // which, so a later request restores the step as the model saw it.
    const otherCalls = round.otherCalls || upstreamOutput.some(entry => callItemTypes.has(entry?.type) && !isWebSearchCall(entry));
    const continues = !otherCalls && searches + calls.length <= maxWebSearchesPerRequest;
    for (const call of calls) {
      // Nothing more runs once Codex has gone.
      if (closed()) return;
      // Calls beyond the bound are dropped from the response, and it ends.
      if (searches >= maxWebSearchesPerRequest) {
        dropped += 1;
        continue;
      }
      let query = '';
      try {
        query = String(JSON.parse(call.arguments || '{}').query ?? '');
      } catch {
        // An unreadable call searches for nothing and says so.
      }
      const callId = call.call_id || call.id;
      const searchItem = { type: 'web_search_call', id: callId, status: 'in_progress', action: { type: 'search', query } };
      emit({ type: 'response.output_item.added', item: searchItem });
      searches += 1;
      const text = query ? await search(query) : 'The web search had no query.';
      if (closed()) return;
      storeWebSearchResults(scope, callId, text, continues);
      const done = { ...searchItem, status: 'completed' };
      emit({ type: 'response.output_item.done', item: done });
      searchItems.push(done);
      results.push({ type: 'function_call_output', call_id: callId, output: text });
    }
    if (dropped > 0) log('error', 'web_search.limit_reached', { dropped, limit: maxWebSearchesPerRequest });
    const output = upstreamOutput.flatMap(entry => (isWebSearchCall(entry)
      ? searchItems.filter(searchItem => searchItem.id === (entry.call_id || entry.id)) : [entry]));
    // Searches Codex was shown stay in the output even if the final event left them out.
    for (const searchItem of searchItems) if (!output.includes(searchItem)) output.push(searchItem);
    if (!continues || dropped > 0) {
      finalize(output);
      return;
    }
    earlierOutput = [...earlierOutput, ...output];
    earlierUpstreamItems = [...earlierUpstreamItems, ...upstreamOutput, ...results];
    round = newRound(true);
    const continued = await sendContinuation({ ...requestBody, input: [...(Array.isArray(requestBody.input) ? requestBody.input : []),
      ...earlierUpstreamItems] });
    if (closed()) {
      continued?.stream?.destroy();
      return;
    }
    if (continued?.contextOverflow) {
      // As for any request, a context overflow fails the response so Codex compacts the thread.
      finished = true;
      source.upstreamFinal = false;
      emit({ type: 'response.failed', response: { ...event.response, id: firstResponseId ?? event.response?.id, status: 'failed',
        output: earlierOutput, error: { code: 'context_length_exceeded', message: contextOverflowMessage }, ...(usage ? { usage } : {}) } });
      return;
    }
    // A continuation that never answered, or one the upstream will take on a retry, fails so Codex retries the step.
    const refused = !continued ? { code: 'server_error', message: 'The step after the web search did not reach the upstream.' }
      : continued.failure;
    if (refused) {
      finished = true;
      source.upstreamFinal = false;
      emit({ type: 'response.failed', response: { ...event.response, id: firstResponseId ?? event.response?.id, status: 'failed',
        output: earlierOutput, error: refused, ...(usage ? { usage } : {}) } });
      return;
    }
    if (!continued.stream) {
      diagnose(continued.diagnostic);
      return;
    }
    let failure = null;
    try {
      await consume(continued.stream);
    } catch (error) {
      failure = error?.code || 'STREAM_ERROR';
    }
    // A continuation that breaks off, or ends without a final event, still gets one.
    if (!finished && !closed()) {
      log('error', 'web_search.continuation_failed', { errorCode: failure ?? 'ENDED_WITHOUT_FINAL_EVENT' });
      diagnose('[router diagnostic] The web search ran, but the next step was interrupted. The thread is intact; retry or start a new thread.');
    }
  };

  // Each upstream stream keeps its own partial event between chunks. An event
  // larger than the bound switches that stream to plain pass-through, so a
  // malformed stream never holds unbounded memory.
  const processText = async (buffer, text) => {
    if (buffer.passThrough) {
      if (text) transform.push(text);
      return;
    }
    const blocks = sseEvents(buffer, text);
    if (buffer.pending.length > maxEventLineChars) {
      log('error', 'web_search.stream_passthrough', { pendingChars: buffer.pending.length });
      buffer.passThrough = true;
    }
    for (const block of blocks) {
      if (!block.trim()) continue;
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      let event = null;
      try {
        event = data ? JSON.parse(data) : null;
      } catch {
        // Not JSON: passed through unchanged below.
      }
      if (event === null) transform.push(`${block}\n\n`);
      else await handleEvent(block, event);
    }
    if (buffer.passThrough) {
      transform.push(buffer.pending);
      buffer.pending = '';
    }
  };

  // A continuation is read the same way as the first response, through this stream's state.
  const consume = stream => new Promise((resolve, reject) => {
    const continuationDecoder = new StringDecoder('utf8');
    const buffer = { pending: '', passThrough: false };
    let chain = Promise.resolve();
    stream.on('data', chunk => {
      chain = chain.then(() => processText(buffer, continuationDecoder.write(chunk)));
    });
    stream.once('error', reject);
    stream.once('end', () => {
      chain.then(() => processText(buffer, `${continuationDecoder.end()}\n\n`)).then(resolve, reject);
    });
  });

  transform = new Transform({
    transform(chunk, _encoding, callback) {
      processText(firstBuffer, decoder.write(chunk)).then(() => callback(), callback);
    },
    flush(callback) {
      processText(firstBuffer, `${decoder.end()}\n\n`).then(() => callback(), callback);
    },
  });
  return transform;
}
