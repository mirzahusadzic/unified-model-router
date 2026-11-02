// Claude on Anthropic's Messages API: request and stream translation, and the
// refusals that move Claude to OpenRouter.
import { createHash, randomUUID } from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { contextOverflowPattern, isObject, maxEventLineChars, sseEvents } from './common.mjs';

// Claude on Anthropic's API speaks the Messages API, so the router translates
// at the wire (openUpstream): Codex's Responses request becomes a Messages request, and the
// streamed Messages events become Responses events. Everything above the wire
// (web search, recovery, usage logging) sees the Responses form.
const anthropicVersion = '2026-10-21';
// The binding control lets a request whose history changed run without the
// thinking blocks the change invalidated, instead of failing.
const anthropicBeta = 'thinking-binding-controls-2026-08-01';

// The Messages body is measured again after translation.
export function anthropicHeaders(apiKey, bodyLength) {
  return {
    'content-type': 'application/json',
    'content-length': String(bodyLength),
    'accept-encoding': 'identity',
    'x-api-key': apiKey,
    'anthropic-version': anthropicVersion,
    'anthropic-beta': anthropicBeta,
  };
}
const anthropicMaxTokens = 64000;
const anthropicMaxTokensLimit = 128000;
// Claude's thinking blocks, signatures included, ride in the reasoning item's
// encrypted_content, which Codex stores and sends back unchanged.
const anthropicThinkingPrefix = 'codex-router-anthropic-thinking:v1:';
const claudeEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function isAnthropicThinking(item) {
  return item?.type === 'reasoning' && typeof item.encrypted_content === 'string'
    && item.encrypted_content.startsWith(anthropicThinkingPrefix);
}

function encodeAnthropicThinking(block) {
  return `${anthropicThinkingPrefix}${Buffer.from(JSON.stringify(block)).toString('base64url')}`;
}

function decodeAnthropicThinking(item) {
  try {
    const block = JSON.parse(Buffer.from(item.encrypted_content.slice(anthropicThinkingPrefix.length), 'base64url')
      .toString('utf8'));
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && typeof block.signature === 'string') {
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    }
    if (block?.type === 'redacted_thinking' && typeof block.data === 'string') return { type: 'redacted_thinking', data: block.data };
  } catch {
    // An unreadable block is left out.
  }
  return null;
}

// Claude tool names allow letters, digits, `_` and `-`, up to 64 characters.
// A grouped tool such as multi_agent_v1.spawn_agent becomes
// multi_agent_v1__spawn_agent; the stream translation maps it back. A name
// Claude cannot take gets a suffix from the original, so two names that
// differ only in punctuation stay apart. Codex treats the `functions`
// namespace as none.
const toolNamespace = namespace => (namespace && namespace !== 'functions' ? namespace : undefined);

function claudeToolName(name, namespace) {
  const joined = toolNamespace(namespace) ? `${namespace}__${name}` : String(name);
  const safe = joined.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe === joined && safe.length <= 64 ? safe
    : `${safe.slice(0, 55)}_${createHash('sha256').update(joined).digest('hex').slice(0, 8)}`;
}

// A call ID Claude cannot take gets a suffix from the original, so two IDs
// that differ only in punctuation stay apart, and every request maps an ID
// the same way. Claude's own IDs pass unchanged.
function claudeCallId(callId) {
  const safe = callId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe === callId ? callId : `${safe}_${createHash('sha256').update(callId).digest('hex').slice(0, 8)}`;
}

const claudeImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function claudeImage(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url !== 'string') return null;
  const data = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (data && !claudeImageTypes.has(data[1])) return { type: 'text', text: `[image omitted: Claude does not read ${data[1]}]` };
  if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
  return /^https?:\/\//.test(url) ? { type: 'image', source: { type: 'url', url } } : null;
}

// Text and images carry over; Claude rejects empty text blocks, and other parts have no Messages form here.
function claudeContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    const text = part?.type === 'refusal' ? part.refusal : part?.text;
    if (['input_text', 'output_text', 'text', 'refusal'].includes(part?.type)) {
      return typeof text === 'string' && text ? [{ type: 'text', text }] : [];
    }
    const image = part?.type === 'input_image' ? claudeImage(part) : null;
    return image ? [image] : [];
  });
}

function claudeToolResult(callId, output) {
  const value = isObject(output) && typeof output.content === 'string' ? output.content : output;
  const content = typeof value === 'string' ? value : claudeContent(value);
  return { type: 'tool_result', tool_use_id: claudeCallId(callId), content: content.length > 0 ? content : '(no output)' };
}

function claudeCallInput(text) {
  try {
    const input = JSON.parse(text || '{}');
    return isObject(input) ? input : {};
  } catch {
    return {};
  }
}

function claudeTools(tools) {
  const declared = new Map();
  const definitions = [];
  const declare = (tool, namespace) => {
    if (!['function', 'custom'].includes(tool?.type) || typeof tool.name !== 'string' || !tool.name) return;
    const name = claudeToolName(tool.name, namespace);
    if (declared.has(name)) return;
    const custom = tool.type === 'custom';
    declared.set(name, { name: tool.name, namespace, custom });
    const grammar = custom && typeof tool.format?.definition === 'string'
      ? `\n\nThe input follows this ${tool.format.syntax ?? ''} grammar:\n${tool.format.definition}` : '';
    const description = `${tool.description ?? ''}${grammar}`;
    definitions.push({
      name,
      ...(description ? { description } : {}),
      input_schema: custom
        ? { type: 'object', properties: { input: { type: 'string', description: 'The complete input.' } }, required: ['input'] }
        : isObject(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
    });
  };
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) for (const member of tool.tools) declare(member, toolNamespace(tool.name));
    else declare(tool);
  }
  return { declared, definitions };
}

// The conversation as Messages. Codex's opening developer messages join the
// instructions in `system`; a later one becomes a system message just before
// Claude's next turn, which keeps the cached prefix and Claude's signed
// thinking valid. A step's items (thinking, text, calls) form one assistant
// turn, and its results follow in the next user turn. A call Codex never
// answered is left out, as is an output without its call.
function claudeMessages(request) {
  const system = typeof request.instructions === 'string' && request.instructions
    ? [{ type: 'text', text: request.instructions }] : [];
  const input = typeof request.input === 'string' ? [{ role: 'user', content: request.input }]
    : Array.isArray(request.input) ? request.input : [];
  // The first output for a call stands: a later duplicate would rewrite a turn Claude already saw.
  const outputs = new Map();
  for (const item of input) {
    if (['function_call_output', 'custom_tool_call_output'].includes(item?.type) && typeof item.call_id === 'string'
        && !outputs.has(item.call_id)) {
      outputs.set(item.call_id, item.output);
    }
  }
  const messages = [];
  const calls = new Set();
  let opening = true;
  let developer = [];
  let turn = null;
  const append = (role, content) => {
    if (content.length === 0) return;
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  };
  // A system message must follow a user turn; elsewhere the instructions join the user turn.
  const flushDeveloper = () => {
    if (developer.length === 0) return;
    if (messages.at(-1)?.role === 'user') messages.push({ role: 'system', content: developer });
    else append('user', developer);
    developer = [];
  };
  const closeTurn = () => {
    if (!turn) return;
    const answered = turn.calls.filter(callId => outputs.has(callId));
    const content = turn.content.filter(block => block.type !== 'tool_use' || answered.includes(block.callId))
      .map(({ callId, ...block }) => block);
    // A turn of thinking alone has nothing to reply to.
    if (content.some(block => !['thinking', 'redacted_thinking'].includes(block.type))) {
      append('assistant', content);
      append('user', answered.map(callId => claudeToolResult(callId, outputs.get(callId))));
    }
    turn = null;
  };
  const openTurn = () => {
    if (turn) return;
    flushDeveloper();
    turn = { content: [], calls: [] };
  };
  for (const item of input) {
    const type = item?.type ?? (item?.role ? 'message' : null);
    if (type === 'message' && ['developer', 'system'].includes(item.role)) {
      const text = claudeContent(item.content).filter(block => block.type === 'text');
      if (opening) system.push(...text);
      else {
        closeTurn();
        developer.push(...text);
      }
      continue;
    }
    opening = false;
    if (type === 'message' && item.role === 'assistant') {
      openTurn();
      turn.content.push(...claudeContent(item.content));
    } else if (type === 'message') {
      closeTurn();
      append('user', claudeContent(item.content));
    } else if (['function_call_output', 'custom_tool_call_output'].includes(type)) {
      // An output ends the step that made its call; its results follow that step's turn.
      if (turn?.calls.includes(item.call_id)) closeTurn();
    } else if (type === 'reasoning') {
      const block = isAnthropicThinking(item) ? decodeAnthropicThinking(item) : null;
      if (block) {
        openTurn();
        turn.content.push(block);
      }
    } else if (['function_call', 'custom_tool_call'].includes(type) && typeof item.call_id === 'string' && item.call_id
        && !calls.has(item.call_id)) {
      calls.add(item.call_id);
      openTurn();
      turn.calls.push(item.call_id);
      turn.content.push({
        type: 'tool_use',
        id: claudeCallId(item.call_id),
        name: claudeToolName(item.name, item.namespace),
        input: type === 'custom_tool_call' ? { input: String(item.input ?? '') } : claudeCallInput(item.arguments),
        callId: item.call_id,
      });
    }
  }
  closeTurn();
  flushDeveloper();
  // The conversation must open with a user turn, and these models reject one that ends with Claude's.
  if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(The conversation continues.)' }] });
  if (messages.at(-1)?.role === 'assistant') messages.push({ role: 'user', content: [{ type: 'text', text: '(Continue.)' }] });
  return { system, messages };
}

// Whether the Messages translation has a system prompt to mark: the
// instructions, or text in the developer or system messages that open the input.
export function hasSystemPrompt(request) {
  if (typeof request.instructions === 'string' && request.instructions) return true;
  for (const item of Array.isArray(request.input) ? request.input : []) {
    const type = item?.type ?? (item?.role ? 'message' : null);
    if (type !== 'message' || !['developer', 'system'].includes(item.role)) return false;
    if (claudeContent(item.content).some(block => block.type === 'text')) return true;
  }
  return false;
}

// promptCache is the caller's X-Codex-Router-Prompt-Cache: "instructions" puts
// the only breakpoint at the end of the system prompt, for one-shot callers whose
// prompts share it; "none" sets no breakpoint. Codex sends neither.
export function messagesRequest(request, { promptCache = null } = {}) {
  const { declared, definitions } = claudeTools(request.tools);
  const { system, messages } = claudeMessages(request);
  if (promptCache === 'instructions' && system.length > 0) {
    system[system.length - 1] = { ...system.at(-1), cache_control: { type: 'ephemeral' } };
  }
  const effort = request.reasoning?.effort;
  const outputConfig = {
    ...(claudeEfforts.has(effort) ? { effort } : ['none', 'minimal'].includes(effort) ? { effort: 'low' } : {}),
    ...(request.text?.format?.type === 'json_schema' && isObject(request.text.format.schema)
      ? { format: { type: 'json_schema', schema: request.text.format.schema } } : {}),
  };
  const maxTokens = Number.isInteger(request.max_output_tokens) && request.max_output_tokens > 0
    ? Math.min(request.max_output_tokens, anthropicMaxTokensLimit) : anthropicMaxTokens;
  return {
    declared,
    body: {
      model: request.model,
      max_tokens: maxTokens,
      stream: true,
      ...(system.length > 0 ? { system } : {}),
      messages,
      ...(definitions.length > 0 ? {
        tools: definitions,
        // Claude 5.5 models reject a forced tool choice, so `required` asks without forcing.
        tool_choice: request.tool_choice === 'none' ? { type: 'none' }
          : { type: 'auto', ...(request.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}) },
      } : {}),
      thinking: {
        type: 'adaptive',
        display: request.reasoning?.summary === 'none' ? 'omitted' : 'summarized',
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      },
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      // Codex resends the whole thread each step; the breakpoint moves with it.
      ...(promptCache ? {} : { cache_control: { type: 'ephemeral' } }),
    },
  };
}

// Codex reads cache reads and writes from input_tokens_details; Anthropic's
// input_tokens count only what was neither.
function responsesUsage(usage) {
  const count = name => (typeof usage[name] === 'number' && Number.isFinite(usage[name]) ? usage[name] : 0);
  const cached = count('cache_read_input_tokens');
  const written = count('cache_creation_input_tokens');
  const input = count('input_tokens') + cached + written;
  const output = count('output_tokens');
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    output_tokens: output,
    total_tokens: input + output,
  };
}

// Mid-stream Messages errors as Responses failure codes. Codex compacts on
// context_length_exceeded and retries the others; it would retry
// server_is_overloaded only with a delay, which a stream error never carries.
function responsesErrorCode(error) {
  if (error?.type === 'rate_limit_error') return 'rate_limit_exceeded';
  if (contextOverflowPattern.test(String(error?.message ?? ''))) return 'context_length_exceeded';
  return 'server_error';
}

// Streams Claude's Messages events to Codex as Responses events, one content
// block at a time. Text becomes a message, thinking a reasoning item that
// carries the signed block, and a tool call a function call under the name
// Codex declared.
function anthropicResponseStream({ declared, log }) {
  const decoder = new StringDecoder('utf8');
  const buffered = { pending: '' };
  let passThrough = false;
  let response = null;
  let usage = {};
  let stopReason = null;
  let stopDetails = null;
  let finished = false;
  const blocks = new Map();
  const output = [];
  let transform;
  const emit = event => transform.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const begin = message => {
    response = {
      id: `resp_${typeof message?.id === 'string' ? message.id : randomUUID().replaceAll('-', '')}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: message?.model ?? null,
    };
  };
  const addUsage = value => {
    if (!isObject(value)) return;
    for (const [name, count] of Object.entries(value)) if (typeof count === 'number') usage[name] = count;
  };

  const start = (index, block) => {
    const itemId = kind => `${kind}_${response.id.slice('resp_'.length)}_${index}`;
    const state = { outputIndex: output.length + blocks.size, text: '', json: '', signature: '' };
    if (block?.type === 'text') {
      Object.assign(state, { kind: 'text', item: { type: 'message', id: itemId('msg'), role: 'assistant', status: 'in_progress', content: [] } });
    } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      Object.assign(state, { kind: 'thinking', item: { type: 'reasoning', id: itemId('rs'), summary: [] }, data: block.data,
        signature: block.signature ?? '' });
    } else if (block?.type === 'tool_use') {
      const tool = declared.get(block.name) ?? { name: block.name };
      state.kind = tool.custom ? 'custom' : 'call';
      // The input normally streams as JSON deltas; a start block that already carries it is kept.
      state.startInput = isObject(block.input) && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : '';
      state.item = tool.custom
        ? { type: 'custom_tool_call', id: itemId('ctc'), call_id: block.id, name: tool.name, input: '' }
        : { type: 'function_call', id: itemId('fc'), call_id: block.id, name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: '', status: 'in_progress' };
    } else return;
    blocks.set(index, state);
    emit({ type: 'response.output_item.added', output_index: state.outputIndex, item: state.item });
    if (state.kind === 'text') {
      emit({ type: 'response.content_part.added', item_id: state.item.id, output_index: state.outputIndex, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } });
    }
    if (typeof block.text === 'string' && block.text) delta(index, { type: 'text_delta', text: block.text });
    if (typeof block.thinking === 'string' && block.thinking) delta(index, { type: 'thinking_delta', thinking: block.thinking });
  };

  const delta = (index, change) => {
    const state = blocks.get(index);
    if (!state) return;
    const ids = { item_id: state.item.id, output_index: state.outputIndex };
    if (change?.type === 'text_delta' && state.kind === 'text' && typeof change.text === 'string') {
      state.text += change.text;
      emit({ type: 'response.output_text.delta', ...ids, content_index: 0, delta: change.text });
    } else if (change?.type === 'thinking_delta' && state.kind === 'thinking' && typeof change.thinking === 'string') {
      if (!state.text && change.thinking) {
        emit({ type: 'response.reasoning_summary_part.added', ...ids, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
      state.text += change.thinking;
      if (change.thinking) emit({ type: 'response.reasoning_summary_text.delta', ...ids, summary_index: 0, delta: change.thinking });
    } else if (change?.type === 'signature_delta' && state.kind === 'thinking' && typeof change.signature === 'string') {
      state.signature += change.signature;
    } else if (change?.type === 'input_json_delta' && typeof change.partial_json === 'string') {
      state.json += change.partial_json;
      if (state.kind === 'call' && change.partial_json) emit({ type: 'response.function_call_arguments.delta', ...ids, delta: change.partial_json });
    }
  };

  const stop = index => {
    const state = blocks.get(index);
    if (!state) return;
    blocks.delete(index);
    const ids = { item_id: state.item.id, output_index: state.outputIndex };
    let item;
    if (state.kind === 'text') {
      const part = { type: 'output_text', text: state.text, annotations: [] };
      emit({ type: 'response.output_text.done', ...ids, content_index: 0, text: state.text });
      emit({ type: 'response.content_part.done', ...ids, content_index: 0, part });
      item = { ...state.item, status: 'completed', content: [part] };
    } else if (state.kind === 'thinking') {
      if (state.text) {
        emit({ type: 'response.reasoning_summary_text.done', ...ids, summary_index: 0, text: state.text });
        emit({ type: 'response.reasoning_summary_part.done', ...ids, summary_index: 0, part: { type: 'summary_text', text: state.text } });
      }
      // A block without its signature could not be sent back, so it is not kept.
      const block = state.data !== undefined ? { type: 'redacted_thinking', data: state.data }
        : state.signature ? { type: 'thinking', thinking: state.text, signature: state.signature } : null;
      item = { ...state.item, summary: state.text ? [{ type: 'summary_text', text: state.text }] : [],
        ...(block ? { encrypted_content: encodeAnthropicThinking(block) } : {}) };
    } else if (state.kind === 'call') {
      const text = state.json || state.startInput || '{}';
      emit({ type: 'response.function_call_arguments.done', ...ids, arguments: text });
      item = { ...state.item, arguments: text, status: 'completed' };
    } else {
      const input = claudeCallInput(state.json || state.startInput).input;
      item = { ...state.item, input: typeof input === 'string' ? input : '' };
    }
    output[state.outputIndex] = item;
    emit({ type: 'response.output_item.done', ...ids, item });
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    const items = output.filter(Boolean);
    const final = { ...response, output: items, usage: responsesUsage(usage) };
    if (stopReason === 'refusal') {
      const category = typeof stopDetails?.category === 'string' ? ` (${stopDetails.category})` : '';
      const message = { type: 'message', id: `msg_${response.id.slice('resp_'.length)}_refusal`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', annotations: [], text: `[router note] Claude declined to continue this request${category}.` }] };
      emit({ type: 'response.output_item.added', output_index: items.length, item: message });
      emit({ type: 'response.output_item.done', output_index: items.length, item: message });
      items.push(message);
    }
    log('info', 'anthropic.stop', { stopReason, ...(stopReason === 'refusal' ? { category: stopDetails?.category ?? null } : {}) });
    if (stopReason === 'model_context_window_exceeded') {
      emit({ type: 'response.failed', response: { ...final, status: 'failed',
        error: { code: 'context_length_exceeded', message: 'The conversation exceeds the model context window.' } } });
    } else if (stopReason === 'max_tokens') {
      emit({ type: 'response.incomplete', response: { ...final, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
    } else {
      emit({ type: 'response.completed', response: { ...final, status: 'completed' } });
    }
  };

  const fail = error => {
    if (finished) return;
    finished = true;
    if (!response) begin(null);
    const code = responsesErrorCode(error);
    log('error', 'anthropic.stream_error', { errorType: typeof error?.type === 'string' ? error.type : null, code });
    emit({ type: 'response.failed', response: { ...response, status: 'failed', output: output.filter(Boolean),
      usage: responsesUsage(usage), error: { code, message: typeof error?.message === 'string' ? error.message : 'Claude stopped with an error.' } } });
  };

  const handle = event => {
    if (event?.type === 'message_start') {
      begin(event.message);
      addUsage(event.message?.usage);
      const transformations = Array.isArray(event.message?.input_transformations) ? event.message.input_transformations : [];
      if (transformations.length > 0) {
        log('info', 'anthropic.thinking_dropped', { blocks: transformations.length,
          reasons: [...new Set(transformations.map(entry => entry?.reason).filter(reason => typeof reason === 'string'))] });
      }
      emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    } else if (event?.type === 'error') fail(event.error);
    else if (!response || finished) return;
    else if (event.type === 'content_block_start') start(event.index, event.content_block);
    else if (event.type === 'content_block_delta') delta(event.index, event.delta);
    else if (event.type === 'content_block_stop') stop(event.index);
    else if (event.type === 'message_delta') {
      stopReason = event.delta?.stop_reason ?? stopReason;
      stopDetails = event.delta?.stop_details ?? stopDetails;
      addUsage(event.usage);
    } else if (event.type === 'message_stop') finish();
  };

  // An event larger than the bound ends the translation; Codex sees the stream break off and retries.
  const processText = text => {
    if (passThrough) return;
    const events = sseEvents(buffered, text);
    if (buffered.pending.length > maxEventLineChars) {
      passThrough = true;
      fail({ type: 'api_error', message: 'Claude sent an event the router could not read.' });
      return;
    }
    for (const block of events) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try {
        handle(JSON.parse(data));
      } catch {
        // An unreadable event is skipped.
      }
    }
  };

  transform = new Transform({
    transform(chunk, _encoding, callback) {
      processText(decoder.write(chunk));
      callback();
    },
    flush(callback) {
      processText(`${decoder.end()}\n\n`);
      callback();
    },
  });
  return transform;
}

// A successful Claude stream is translated; anything else, such as an error, passes through as sent.
export function anthropicResponse(upstreamResponse, declared, log) {
  if (upstreamResponse.statusCode !== 200 || !/^text\/event-stream/i.test(upstreamResponse.headers?.['content-type'] || '')) {
    return upstreamResponse;
  }
  const events = anthropicResponseStream({ declared, log });
  events.statusCode = upstreamResponse.statusCode;
  events.headers = upstreamResponse.headers;
  pipeline(upstreamResponse, events, () => {});
  return events;
}

// Refusals no retry can fix: the key, the organization's access to the model,
// its credits, or a spend limit. Returns the reason, or null for any other error.
export function anthropicRefusal(status, body) {
  let error = null;
  try {
    error = JSON.parse(body.toString('utf8'))?.error ?? null;
  } catch {
    // Judged by the status alone.
  }
  const type = typeof error?.type === 'string' ? error.type : null;
  if ([401, 402, 403, 404].includes(status)) return type ?? `http_${status}`;
  if (status === 429 && error?.details?.error_code === 'enforced_spend_limit_reached') return 'enforced_spend_limit_reached';
  if (status === 400 && /credit balance|usage limits/i.test(String(error?.message ?? ''))) return 'billing';
  return null;
}
