// Shaping a request for its upstream, and the bounded retry after a rejected
// step.
import { claudeEffort, hasSystemPrompt, isAnthropicThinking } from './anthropic.mjs';
import { openrouterApiKey, providerOrders } from './config.mjs';
import { claudeEffortChanges } from './sessions.mjs';
import { overrideWebSearchForOpenRouter } from './web-search.mjs';

const openrouterRecoveryCompactBytes = 1024 * 1024;
const openrouterRecoveryCompactItems = 80;
// Codex sends its context as a developer message followed by user messages
// (injected AGENTS.md and environment context). A new thread opens with it; a
// compacted thread lists its retained user messages first and places the
// context just before the compaction summary. A compacted retry keeps that
// block, from the first developer message, up to this many items.
const openrouterRecoveryContextItems = 16;
const openrouterRecoveryOmissionNotice = '[router note] The provider rejected this thread\'s full history, so this retry omits earlier conversation items. The thread\'s context and instructions, the latest user message, and the most recent items are kept. Treat anything else from earlier in the thread as unknown: re-read files and re-check state before relying on it, and ask the user if an earlier decision matters.';

// DeepSeek's endpoint offers JSON mode but rejects JSON schemas. Request JSON
// mode and append the schema as the final instruction, which keeps the cached
// prompt prefix intact. Other models receive the schema unchanged.
function adaptStructuredOutputForDeepSeek(request, model) {
  const format = request.text?.format;
  if (!model.startsWith('deepseek/') || format?.type !== 'json_schema') return null;
  request.text = { ...request.text, format: { type: 'json_object' } };
  // The format's name stays out: told of "a JSON object named X", DeepSeek
  // wraps its answer in an X key about a quarter of the time.
  const instruction = {
    type: 'message',
    role: 'developer',
    content: [{
      type: 'input_text',
      text: 'Respond with only a JSON object that conforms to this JSON schema, '
        + `at the top level, not wrapped in another key:\n${JSON.stringify(format.schema ?? {})}`,
    }],
  };
  if (Array.isArray(request.input)) request.input = [...request.input, instruction];
  else if (typeof request.input === 'string') request.input = [{ role: 'user', content: request.input }, instruction];
  else request.input = [instruction];
  return instruction;
}

// DeepSeek accepts only low, high, max, and none. Other efforts round up to the
// next accepted level, so `minimal` keeps some reasoning instead of turning it
// off. Other OpenRouter models take OpenRouter's standard efforts, which it
// translates for each provider.
function normalizeReasoningForOpenRouter(value, model) {
  if (!value || typeof value !== 'object' || value.effort == null || !model.startsWith('deepseek/')) return;
  const effort = String(value.effort);
  if (['low', 'high', 'max', 'none'].includes(effort)) return;
  value.effort = effort === 'minimal' ? 'low' : effort === 'medium' ? 'high' : 'max';
}

// The Claude models that take an effort change inside the conversation, on
// each route: Anthropic's per-message effort, and OpenRouter's
// configuration_update item, which OpenRouter lists for fewer models.
const effortUpdateModels = {
  anthropic: new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-mythos-5-2', 'claude-mythos-5-1',
    'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']),
  openrouter: new Set(['anthropic/claude-fable-5.2', 'anthropic/claude-fable-5.1', 'anthropic/claude-opus-5']),
};

// When Codex changes Claude's effort in the middle of a thread, the
// top-level effort stays the one the thread started with, and each change
// becomes a configuration_update item just before the user message whose
// request first carried it. Later requests place the same items again, so
// the history stays a prefix of the next and the prompt cache holds. A
// thread whose effort never changed goes out unchanged. Returns the number
// of items added.
function addEffortUpdates(request, provider, upstreamModel, thread, { thinkingBudget = null } = {}) {
  if (!effortUpdateModels[provider]?.has(upstreamModel) || thinkingBudget || !Array.isArray(request.input)) return 0;
  const isUser = item => isMessageForRole(item, 'user');
  const userMessages = request.input.filter(isUser).length;
  // On Anthropic's API, the effort Claude runs: `none` and `minimal` are its `low`,
  // so moving between them is no change, and an effort Claude lacks keeps today's request.
  const effort = provider === 'anthropic' ? claudeEffort(request.reasoning?.effort) : request.reasoning?.effort;
  const efforts = claudeEffortChanges(thread, userMessages, effort);
  if (!efforts || efforts.length < 2) return 0;
  const changes = new Map(efforts.slice(1));
  const input = [];
  let count = 0;
  for (const item of request.input) {
    if (isUser(item)) {
      count += 1;
      if (changes.has(count)) input.push({ type: 'configuration_update', reasoning: { effort: changes.get(count) } });
    }
    input.push(item);
  }
  request.input = input;
  request.reasoning = { ...request.reasoning, effort: efforts[0][1] };
  return changes.size;
}

// A retry with trimmed history restarts the cache anyway, so it sets the
// current effort at the top level again, without the update items.
function withoutEffortUpdates(request) {
  if (!Array.isArray(request.input)) return request;
  const updates = request.input.filter(item => item?.type === 'configuration_update');
  if (updates.length === 0) return request;
  return {
    ...request,
    reasoning: { ...request.reasoning, effort: updates.at(-1).reasoning.effort },
    input: request.input.filter(item => item?.type !== 'configuration_update'),
  };
}

// Claude caches a prompt only at a cache_control breakpoint, and OpenRouter's
// Responses API exposes only the top-level form, which places the breakpoint
// on the last cacheable block and moves it as the thread grows. Without it,
// every step bills the whole history at the full input price.
function addClaudePromptCaching(request, model) {
  if (!model.startsWith('anthropic/') || request.cache_control !== undefined) return false;
  request.cache_control = { type: 'ephemeral' };
  return true;
}

function normalizeStateForOpenRouter(request) {
  let changed = false;
  if (request.previous_response_id != null) {
    delete request.previous_response_id;
    changed = true;
  }
  if (request.store === true) {
    request.store = false;
    changed = true;
  }
  return changed;
}

function normalizeToolHistoryForOpenRouter(input) {
  const repairs = {
    changed: false,
    droppedInvalidCalls: 0,
    droppedDuplicateCalls: 0,
    droppedUnansweredCalls: 0,
    droppedOrphanOutputs: 0,
    droppedDuplicateOutputs: 0,
    droppedToolDeclarations: 0,
  };
  if (!Array.isArray(input)) return { input, repairs };

  const runs = [];
  for (let index = 0; index < input.length;) {
    if (input[index]?.type !== 'function_call') {
      index += 1;
      continue;
    }
    // A step's calls form one run across the reasoning and text between them,
    // as when Claude writes a progress note before each call, so the step's
    // outputs follow its last call and the provider sees one assistant turn.
    const run = { start: index, end: index, calls: [] };
    while (index < input.length) {
      if (input[index]?.type === 'function_call') {
        run.calls.push({ index, item: input[index] });
        run.end = index;
        index += 1;
        continue;
      }
      let ahead = index;
      while (ahead < input.length && (input[ahead]?.type === 'reasoning' || isMessageForRole(input[ahead], 'assistant'))) ahead += 1;
      if (ahead === index || input[ahead]?.type !== 'function_call') break;
      index = ahead;
    }
    index = run.end + 1;
    runs.push(run);
  }

  const validCallId = id => typeof id === 'string' && id.length > 0;
  const callIds = new Set(runs.flatMap(run => run.calls.map(call => call.item.call_id)).filter(validCallId));
  const outputsByCallId = new Map();
  for (const [index, item] of input.entries()) {
    if (item?.type !== 'function_call_output') continue;
    if (!callIds.has(item.call_id)) {
      repairs.droppedOrphanOutputs += 1;
      continue;
    }
    if (outputsByCallId.has(item.call_id)) repairs.droppedDuplicateOutputs += 1;
    // The latest output is the most useful observation if an interrupted turn
    // left more than one result for the same call ID.
    outputsByCallId.set(item.call_id, { index, item });
  }

  // When a call ID repeats, keep the occurrence the output answers: the last
  // one before it. Other items stay in their original order.
  const retainedByCallId = new Map();
  for (const run of runs) {
    for (const call of run.calls) {
      const id = call.item.call_id;
      if (!validCallId(id)) {
        repairs.droppedInvalidCalls += 1;
        continue;
      }
      if (!retainedByCallId.has(id)) {
        retainedByCallId.set(id, call.index);
        continue;
      }
      repairs.droppedDuplicateCalls += 1;
      const output = outputsByCallId.get(id);
      if (!output || call.index < output.index) retainedByCallId.set(id, call.index);
    }
  }
  for (const id of retainedByCallId.keys()) {
    if (!outputsByCallId.has(id)) {
      repairs.droppedUnansweredCalls += 1;
      retainedByCallId.delete(id);
    }
  }
  const retainedCallIndexes = new Set(retainedByCallId.values());

  const normalized = [];
  const runsByStart = new Map(runs.map(run => [run.start, run]));
  for (let index = 0; index < input.length;) {
    const run = runsByStart.get(index);
    if (run) {
      for (let member = run.start; member <= run.end; member += 1) {
        if (input[member]?.type !== 'function_call' || retainedCallIndexes.has(member)) normalized.push(input[member]);
      }
      for (const call of run.calls.filter(item => retainedCallIndexes.has(item.index))) {
        const output = outputsByCallId.get(call.item.call_id);
        if (output) normalized.push(output.item);
      }
      index = run.end + 1;
      continue;
    }
    // Codex 0.164 records Responses Lite tool declarations in the history of
    // threads that used a native model. OpenRouter rejects these items, and the
    // request's `tools` field already declares the selected model's tools.
    if (input[index]?.type === 'additional_tools') repairs.droppedToolDeclarations += 1;
    else if (input[index]?.type !== 'function_call_output') normalized.push(input[index]);
    index += 1;
  }

  repairs.changed = normalized.length !== input.length
    || normalized.some((item, index) => item !== input[index]);
  return { input: normalized, repairs };
}

// Shapes a request for its upstream in place and reports what changed, for the
// forwarding log. OpenAI requests only lose other providers' reasoning, and
// Claude's requests are translated to Messages at the wire (openUpstream).
export function adaptForUpstream(request, provider, upstreamModel, scope, {
  protectedSession = false, promptCache = null, endpoints = null, thread = null, thinkingBudget = null,
} = {}) {
  const adaptation = {
    stateReset: false, providerOrder: null, toolHistoryRepairs: null, structuredOutputInstruction: null,
    promptCachingAdded: false, webSearch: { offered: false, restored: 0 }, effortUpdates: 0,
  };
  if (provider === 'openai') {
    request.input = normalizeInputForOpenAI(request.input);
    return adaptation;
  }
  if (provider === 'anthropic') {
    // Searches run through OpenRouter's web plugin, so without its key Codex's search is not offered.
    if (!openrouterApiKey && Array.isArray(request.tools)) {
      request.tools = request.tools.filter(tool => !['web_search', 'web_search_preview'].includes(tool?.type));
    }
    adaptation.stateReset = normalizeStateForOpenRouter(request);
    adaptation.webSearch = overrideWebSearchForOpenRouter(request, scope);
    // The Messages translation pairs calls with their outputs and adds the cache
    // breakpoint: at the end of the system prompt in `instructions` mode, if there is one.
    adaptation.promptCachingAdded = !promptCache || (promptCache === 'instructions' && hasSystemPrompt(request));
    adaptation.effortUpdates = addEffortUpdates(request, provider, upstreamModel, thread, { thinkingBudget });
    return adaptation;
  }
  // Claude's signed thinking is readable only on Anthropic's API.
  if (Array.isArray(request.input)) request.input = request.input.filter(item => !isAnthropicThinking(item));
  // A caller's pinned endpoints run in that order, with no fallbacks. The
  // router's own order keeps fallbacks enabled, so an outage costs a cache miss.
  if (endpoints) {
    adaptation.providerOrder = endpoints;
    request.provider = { ...request.provider, order: endpoints, allow_fallbacks: false };
  } else if (providerOrders.has(upstreamModel) && request.provider === undefined) {
    adaptation.providerOrder = providerOrders.get(upstreamModel);
    request.provider = { order: adaptation.providerOrder };
  }
  // After an OpenAI or Claude model, a session reaches only endpoints
  // that do not collect data, so their output never goes where it may be
  // trained on. A model pinned to such an endpoint still runs there; DeepSeek's
  // own endpoint, which may train on prompts, does not qualify. A caller's own
  // `allow` does not override it; a caller's `deny` elsewhere is kept.
  if (protectedSession) request.provider = { ...request.provider, data_collection: 'deny' };
  adaptation.stateReset = normalizeStateForOpenRouter(request);
  normalizeReasoningForOpenRouter(request.reasoning, upstreamModel);
  adaptation.webSearch = overrideWebSearchForOpenRouter(request, scope);
  const normalizedHistory = normalizeToolHistoryForOpenRouter(request.input);
  request.input = normalizedHistory.input;
  adaptation.toolHistoryRepairs = normalizedHistory.repairs;
  adaptation.structuredOutputInstruction = adaptStructuredOutputForDeepSeek(request, upstreamModel);
  // OpenRouter takes only the top-level breakpoint, which caches the whole
  // prompt, so a caller's own prompt cache choice leaves it off there, a
  // breakpoint in the caller's own body included.
  if (promptCache && upstreamModel.startsWith('anthropic/')) delete request.cache_control;
  adaptation.promptCachingAdded = !promptCache && addClaudePromptCaching(request, upstreamModel);
  adaptation.effortUpdates = addEffortUpdates(request, provider, upstreamModel, thread);
  return adaptation;
}

function normalizeInputForOpenAI(input) {
  if (!Array.isArray(input)) return input;
  return input.flatMap(item => {
    // Claude's signed thinking would fail the backend's decryption.
    if (isAnthropicThinking(item)) return [];
    if (item?.type !== 'reasoning' || !Array.isArray(item.content) || item.content.length === 0) {
      return [item];
    }
    // Codex replays OpenRouter's plaintext reasoning after a model switch, but
    // the native backend requires reasoning content to be absent or empty.
    if (!item.encrypted_content) return [];
    const { content, ...reasoning } = item;
    return [reasoning];
  });
}

function isMessageForRole(item, role) {
  return item?.role === role && (item.type == null || item.type === 'message');
}

function completeToolPairs(input, retainedIndexes) {
  const calls = new Map();
  const outputs = new Map();
  for (const [index, item] of input.entries()) {
    const target = item?.type === 'function_call' ? calls
      : item?.type === 'function_call_output' ? outputs : null;
    if (!target || typeof item.call_id !== 'string' || item.call_id.length === 0) continue;
    if (!target.has(item.call_id)) target.set(item.call_id, []);
    target.get(item.call_id).push(index);
  }
  const partners = new Map();
  for (const [callId, callIndexes] of calls) {
    const outputIndexes = outputs.get(callId);
    if (!outputIndexes) continue;
    for (const index of [...callIndexes, ...outputIndexes]) {
      if (!partners.has(index)) partners.set(index, []);
      partners.get(index).push(...callIndexes, ...outputIndexes);
    }
  }
  const completed = new Set(retainedIndexes);
  const pending = [...completed];
  while (pending.length > 0) {
    for (const index of partners.get(pending.pop()) || []) {
      if (completed.has(index)) continue;
      completed.add(index);
      pending.push(index);
    }
  }
  return completed;
}

function codexContextIndexes(input) {
  const indexes = [];
  const first = Math.max(input.findIndex(item => isMessageForRole(item, 'developer')), 0);
  for (let index = first; index < input.length; index += 1) {
    if (indexes.length >= openrouterRecoveryContextItems) break;
    if (!['developer', 'system', 'user'].some(role => isMessageForRole(input[index], role))) break;
    indexes.push(index);
  }
  return indexes;
}

export function omissionNotice() {
  return {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: openrouterRecoveryOmissionNotice }],
  };
}

function compactOpenRouterHistory(input, requestBytes) {
  if (!Array.isArray(input)
      || (requestBytes <= openrouterRecoveryCompactBytes
        && input.length <= openrouterRecoveryCompactItems)) {
    return { input, changed: false, droppedItems: 0, strategy: null, omissionNotice: false };
  }

  const lastUserIndex = input.findLastIndex(item => isMessageForRole(item, 'user'));
  const lastDeveloperIndex = input.findLastIndex(item => isMessageForRole(item, 'developer'));
  const context = codexContextIndexes(input);
  // Codex's context, the current developer context and the task statement
  // always survive, even when the rest of the latest turn has to be cut to a
  // recent tail. Dropping Codex's context would remove the rules the thread
  // runs under (AGENTS.md among them) and any compaction summary for this step.
  const pinned = new Set([...context, lastDeveloperIndex, lastUserIndex].filter(index => index >= 0));
  const itemBytes = index => Buffer.byteLength(JSON.stringify(input[index]) ?? '');
  const notice = omissionNotice();
  // Reserve room for the omission notice so the retry stays within both limits.
  let itemBudget = openrouterRecoveryCompactItems - pinned.size - 1;
  let byteBudget = [...pinned].reduce((budget, index) => budget - itemBytes(index),
    openrouterRecoveryCompactBytes - Buffer.byteLength(JSON.stringify(notice)));

  let start = input.length;
  let taken = 0;
  while (start > lastUserIndex + 1 && itemBudget > 0) {
    const index = start - 1;
    // A pinned item inside the tail is already counted against the budgets.
    if (pinned.has(index)) {
      start -= 1;
      continue;
    }
    const bytes = itemBytes(index);
    if (bytes > byteBudget && taken > 0) break;
    itemBudget -= 1;
    byteBudget -= bytes;
    taken += 1;
    start -= 1;
  }

  const selectedIndexes = new Set(pinned);
  for (let index = start; index < input.length; index += 1) selectedIndexes.add(index);
  // Selecting a tail can begin between a tool call and its output. Restore both
  // sides before normalization, which would otherwise discard the orphan.
  const retainedIndexes = completeToolPairs(input, selectedIndexes);
  const compacted = input.filter((_item, index) => retainedIndexes.has(index));
  const droppedItems = input.length - compacted.length;
  // Tell the model its view is partial, right after Codex's context, so it
  // does not mistake missing history for history that never happened.
  if (droppedItems > 0) {
    compacted.splice(context.length > 0 ? compacted.indexOf(input[context.at(-1)]) + 1 : 0, 0, notice);
  }
  return {
    input: compacted,
    changed: droppedItems > 0,
    droppedItems,
    strategy: lastUserIndex >= 0 && start === lastUserIndex + 1 ? 'latest-user-turn' : 'recent-tail',
    omissionNotice: droppedItems > 0,
  };
}

export function prepareOpenRouterRecovery(primary, primaryBody, structuredOutputInstruction) {
  const parsed = withoutEffortUpdates(primary);
  // `parsed` already carries the OpenRouter state, reasoning, and tool-history
  // normalization, so the retry only changes which history items are sent.
  // Encrypted reasoning is bound to the provider that produced it; drop it
  // instead of resending the same opaque payload.
  let input = parsed.input;
  let schemaInstruction = null;
  if (Array.isArray(input) && structuredOutputInstruction && input.at(-1) === structuredOutputInstruction) {
    schemaInstruction = input.at(-1);
    input = input.slice(0, -1);
  }
  input = Array.isArray(input)
    ? input.filter(item => !(item?.type === 'reasoning' && item.encrypted_content))
    : input;
  const droppedReasoningItems = Array.isArray(input) ? parsed.input.length - input.length - (schemaInstruction ? 1 : 0) : 0;
  const compacted = compactOpenRouterHistory(input, primaryBody.length);
  const repaired = normalizeToolHistoryForOpenRouter(compacted.input);
  const recoveryInput = Array.isArray(repaired.input) && schemaInstruction
    ? [...repaired.input, schemaInstruction] : repaired.input;
  const body = Buffer.from(JSON.stringify({ ...parsed, input: recoveryInput }));
  return {
    body,
    changed: !body.equals(primaryBody),
    compactionStrategy: compacted.changed ? compacted.strategy : null,
    droppedItems: compacted.droppedItems,
    omissionNotice: compacted.omissionNotice,
    droppedReasoningItems,
    inputItems: Array.isArray(recoveryInput) ? recoveryInput.length : null,
    historyRepairs: repaired.repairs,
  };
}
