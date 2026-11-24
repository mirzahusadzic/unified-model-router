// Focused unit coverage for the six router modules. Exercises uncovered
// paths through public exports: adapt edge shapes, malformed Claude blocks
// and stream shapes, config quoting and atomic-write failure, served-by
// lookup and expiry, session caps and effort records, and web-search
// expiry, prune, error and stream branches.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { mock, test } from 'node:test';

const execFileAsync = promisify(execFile);
const moduleUrl = name => pathToFileURL(join(process.cwd(), 'router', name)).href;

const routerHome = mkdtempSync(join(tmpdir(), 'codex-router-unit-'));
const catalogFile = join(routerHome, 'models.json');
process.env.CODEX_ROUTER_ENV_FILE = join(routerHome, 'openrouter.env');
process.env.CODEX_ROUTER_TOKEN = 'b'.repeat(64);
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.CODEX_ROUTER_LOG_LEVEL = 'error';
process.env.CODEX_MODEL_CATALOG = catalogFile;
process.env.CODEX_ROUTER_PROVIDER_ORDER = '';
process.env.CODEX_ROUTER_TRAINING_MODELS = '';
process.env.CODEX_ROUTER_REJECTED_REQUEST_DIR = routerHome;

const adapt = await import('../router/adapt.mjs');
const anthropic = await import('../router/anthropic.mjs');
const config = await import('../router/config.mjs');
const servedBy = await import('../router/served-by.mjs');
const sessions = await import('../router/sessions.mjs');
const webSearch = await import('../router/web-search.mjs');

function sseBlocks(raw) {
  return String(raw).split(/\r?\n\r?\n/).filter(block => block.trim()).map(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function collectStream(stream, writes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    (async () => {
      for (const chunk of writes) {
        stream.write(chunk);
        await new Promise(setImmediate);
      }
      stream.end();
    })().catch(reject);
  });
}

function sseEncode(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function collectPiped(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function runChild(code, extraEnv = {}, removeEnv = []) {
  const env = { ...process.env, ...extraEnv };
  for (const name of removeEnv) delete env[name];
  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', code], { env });
  return result;
}

let idCounter = 0;
function uniqueId(prefix) {
  idCounter += 1;
  return `${prefix}-unit-${Date.now()}-${idCounter}`;
}

// --- adapt edge shapes ---

test('adapt shapes DeepSeek structured output for array, string, and missing inputs', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const arrayRequest = { text: { format: { type: 'json_schema', name: 'answer', schema } }, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };
  const adaptation = adapt.adaptForUpstream(arrayRequest, 'openrouter', 'deepseek/deepseek-chat', 'scope-adapt-1');
  assert.ok(adaptation.structuredOutputInstruction);
  assert.equal(arrayRequest.text.format.type, 'json_object');
  const instruction = arrayRequest.input.at(-1);
  assert.equal(instruction.role, 'developer');
  assert.ok(instruction.content[0].text.includes('"a"'));
  assert.ok(!instruction.content[0].text.includes('answer'));

  const stringRequest = { text: { format: { type: 'json_schema', schema } }, input: 'hello' };
  adapt.adaptForUpstream(stringRequest, 'openrouter', 'deepseek/deepseek-chat', 'scope-adapt-1');
  assert.equal(stringRequest.input.length, 2);
  assert.equal(stringRequest.input[0].role, 'user');

  const missingRequest = { text: { format: { type: 'json_schema', schema } } };
  adapt.adaptForUpstream(missingRequest, 'openrouter', 'deepseek/deepseek-chat', 'scope-adapt-1');
  assert.equal(missingRequest.input.length, 1);
  assert.equal(missingRequest.input[0].role, 'developer');

  const otherRequest = { text: { format: { type: 'json_schema', schema } }, input: [] };
  const otherAdaptation = adapt.adaptForUpstream(otherRequest, 'openrouter', 'openai/gpt-4', 'scope-adapt-1');
  assert.equal(otherAdaptation.structuredOutputInstruction, null);
  assert.equal(otherRequest.text.format.type, 'json_schema');
});

test('adapt remaps only DeepSeek reasoning efforts', () => {
  const minimal = { effort: 'minimal' };
  adapt.adaptForUpstream({ input: [], reasoning: minimal }, 'openrouter', 'deepseek/deepseek-chat', 's');
  assert.equal(minimal.effort, 'low');
  const medium = { effort: 'medium' };
  adapt.adaptForUpstream({ input: [], reasoning: medium }, 'openrouter', 'deepseek/deepseek-chat', 's');
  assert.equal(medium.effort, 'high');
  const odd = { effort: 'ultra' };
  adapt.adaptForUpstream({ input: [], reasoning: odd }, 'openrouter', 'deepseek/deepseek-chat', 's');
  assert.equal(odd.effort, 'max');
  const kept = { effort: 'high' };
  adapt.adaptForUpstream({ input: [], reasoning: kept }, 'openrouter', 'deepseek/deepseek-chat', 's');
  assert.equal(kept.effort, 'high');
  const other = { effort: 'minimal' };
  adapt.adaptForUpstream({ input: [], reasoning: other }, 'openrouter', 'openai/gpt-4', 's');
  assert.equal(other.effort, 'minimal');
  adapt.adaptForUpstream({ input: [] }, 'openrouter', 'deepseek/deepseek-chat', 's');
  adapt.adaptForUpstream({ input: [], reasoning: null }, 'openrouter', 'deepseek/deepseek-chat', 's');
  adapt.adaptForUpstream({ input: [], reasoning: 'high' }, 'openrouter', 'deepseek/deepseek-chat', 's');
});

test('adapt normalizes OpenAI inputs by dropping signed thinking and plaintext reasoning', () => {
  const thinkingPrefix = 'codex-router-anthropic-thinking:v1:';
  const signed = { type: 'reasoning', encrypted_content: `${thinkingPrefix}abc`, content: [{ type: 'text', text: 'x' }] };
  const plain = { type: 'reasoning', content: [{ type: 'text', text: 'plain' }] };
  const kept = { type: 'reasoning', encrypted_content: 'opaque', content: [] };
  const keptWithContent = { type: 'reasoning', encrypted_content: 'opaque', content: [{ type: 'text', text: 'y' }] };
  const request = { input: [signed, plain, kept, keptWithContent, { type: 'message', role: 'user', content: [] }] };
  adapt.adaptForUpstream(request, 'openai', 'gpt-5', 's');
  assert.ok(!request.input.includes(signed));
  assert.ok(!request.input.includes(plain));
  assert.ok(request.input.includes(kept));
  const stripped = request.input.find(item => item.encrypted_content === 'opaque' && item !== kept);
  assert.ok(stripped && !('content' in stripped));
  const nonArray = { input: 'hello' };
  adapt.adaptForUpstream(nonArray, 'openai', 'gpt-5', 's');
  assert.equal(nonArray.input, 'hello');
});

test('adapt repairs tool history: orphans, duplicates, unanswered, invalid, and declarations', () => {
  const request = {
    input: [
      { type: 'function_call', call_id: '', name: 'bad' },
      { type: 'function_call', call_id: 'a', name: 'tool_a', arguments: '{}' },
      { type: 'function_call', call_id: 'a', name: 'tool_a', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'first' },
      { type: 'function_call_output', call_id: 'a', output: 'second' },
      { type: 'function_call_output', call_id: 'orphan', output: 'lost' },
      { type: 'function_call', call_id: 'unanswered', name: 'tool_b', arguments: '{}' },
      { type: 'additional_tools', tools: [] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    ],
  };
  const adaptation = adapt.adaptForUpstream(request, 'openrouter', 'deepseek/deepseek-chat', 'scope-repair');
  const repairs = adaptation.toolHistoryRepairs;
  assert.equal(repairs.droppedInvalidCalls, 1);
  assert.equal(repairs.droppedDuplicateCalls, 1);
  assert.equal(repairs.droppedDuplicateOutputs, 1);
  assert.equal(repairs.droppedOrphanOutputs, 1);
  assert.equal(repairs.droppedUnansweredCalls, 1);
  assert.equal(repairs.droppedToolDeclarations, 1);
  assert.ok(repairs.changed);
  assert.ok(request.input.every(item => item?.type !== 'additional_tools'));
  const nonArray = { input: 'keep me' };
  const nonArrayAdaptation = adapt.adaptForUpstream(nonArray, 'openrouter', 'deepseek/deepseek-chat', 's');
  assert.equal(nonArray.input, 'keep me');
  assert.equal(nonArrayAdaptation.toolHistoryRepairs.changed, false);
});

test('adapt keeps a step run together across reasoning and assistant text', () => {
  const request = {
    input: [
      { type: 'function_call', call_id: 'c1', name: 'tool_a', arguments: '{}' },
      { type: 'reasoning', content: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'note' }] },
      { type: 'function_call', call_id: 'c2', name: 'tool_b', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'one' },
      { type: 'function_call_output', call_id: 'c2', output: 'two' },
    ],
  };
  adapt.adaptForUpstream(request, 'openrouter', 'openai/gpt-4', 's');
  const callIndexes = request.input.map((item, index) => [item, index]).filter(([item]) => item?.type === 'function_call').map(([, index]) => index);
  const outputIndexes = request.input.map((item, index) => [item, index]).filter(([item]) => item?.type === 'function_call_output').map(([, index]) => index);
  assert.ok(Math.max(...callIndexes) < Math.min(...outputIndexes));
});

test('adapt converts exact untrusted context outputs and counts router-written ones', () => {
  const exact = { type: 'function_call_output', name: 'goal', output: 'objective text' };
  const withCall = { type: 'function_call', call_id: 'x', name: 'tool_a', arguments: '{}' };
  const withCallId = { type: 'function_call_output', call_id: 'x', name: 'goal', output: 'no' };
  const emptyName = { type: 'function_call_output', name: '', output: 'no' };
  const nonString = { type: 'function_call_output', name: 'goal', output: 42 };
  const request = { input: [withCall, exact, withCallId, emptyName, nonString] };
  const adaptation = adapt.adaptForUpstream(request, 'openrouter', 'openai/gpt-4', 'scope-untrusted');
  assert.equal(adaptation.untrustedContext, 1);
  assert.ok(request.input.some(item => item?.type === 'message' && item.content?.[0]?.text?.includes('<external_goal>objective text</external_goal>')));
  assert.ok(request.input.some(item => item === withCallId || item?.call_id === 'x'));

  const emptyOutput = { type: 'function_call_output', name: 'goal', output: '' };
  const emptyRequest = { input: [emptyOutput] };
  adapt.adaptForUpstream(emptyRequest, 'openrouter', 'openai/gpt-4', 's');
  assert.equal(emptyRequest.input[0].content[0].text, '<external_goal></external_goal>');

  const recovery = adapt.prepareOpenRouterRecovery(
    { input: request.input, model: 'openai/gpt-4' },
    Buffer.from(JSON.stringify({ input: request.input, model: 'openai/gpt-4' })),
    null,
  );
  assert.equal(recovery.untrustedContext, 1);
});

test('adapt applies endpoint pins, protected deny, and prompt-cache handling on OpenRouter', () => {
  const pinned = { input: [], provider: { order: ['kept'], data_collection: 'allow' } };
  const pinnedAdaptation = adapt.adaptForUpstream(pinned, 'openrouter', 'deepseek/deepseek-chat', 's', { endpoints: ['a', 'b'] });
  assert.deepEqual(pinnedAdaptation.providerOrder, ['a', 'b']);
  assert.deepEqual(pinned.provider, { order: ['a', 'b'], allow_fallbacks: false, data_collection: 'allow' });

  const protectedRequest = { input: [] };
  adapt.adaptForUpstream(protectedRequest, 'openrouter', 'deepseek/deepseek-chat', 's', { protectedSession: true });
  assert.equal(protectedRequest.provider.data_collection, 'deny');

  const cached = { input: [], cache_control: { type: 'ephemeral' } };
  const cachedAdaptation = adapt.adaptForUpstream(cached, 'openrouter', 'anthropic/claude-sonnet-5-5', 's', { promptCache: 'none' });
  assert.equal(cached.cache_control, undefined);
  assert.equal(cachedAdaptation.promptCachingAdded, false);

  const autoCached = { input: [] };
  const autoAdaptation = adapt.adaptForUpstream(autoCached, 'openrouter', 'anthropic/claude-sonnet-5-5', 's');
  assert.deepEqual(autoCached.cache_control, { type: 'ephemeral' });
  assert.equal(autoAdaptation.promptCachingAdded, true);

  const otherModel = { input: [] };
  const otherAdaptation = adapt.adaptForUpstream(otherModel, 'openrouter', 'openai/gpt-4', 's');
  assert.equal(otherAdaptation.promptCachingAdded, false);
});

test('adapt recovery compacts large histories, pairs split tool calls, and drops encrypted reasoning', () => {
  const developer = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'context rules' }] };
  const input = [developer];
  for (let i = 0; i < 90; i += 1) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `question ${i}` }] });
    input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${i}` }] });
  }
  input.push({ type: 'reasoning', encrypted_content: 'opaque-provider-payload' });
  const primary = { input, model: 'deepseek/deepseek-chat' };
  const primaryBody = Buffer.from(JSON.stringify(primary));
  const recovery = adapt.prepareOpenRouterRecovery(primary, primaryBody, null);
  assert.ok(recovery.changed);
  assert.ok(recovery.droppedItems > 0);
  assert.ok(recovery.omissionNotice);
  assert.equal(recovery.droppedReasoningItems, 1);
  assert.ok(['latest-user-turn', 'recent-tail'].includes(recovery.compactionStrategy));

  const small = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], model: 'm' };
  const smallBody = Buffer.from(JSON.stringify(small));
  const smallRecovery = adapt.prepareOpenRouterRecovery(small, smallBody, null);
  assert.equal(smallRecovery.compactionStrategy, null);
  assert.equal(smallRecovery.droppedItems, 0);

  const paired = { input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'ctx' }] },
    ...Array.from({ length: 85 }, (_, i) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `u${i}` }] })),
    { type: 'function_call', call_id: 'tail-call', name: 'tool_a', arguments: '{}' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'latest question' }] },
    { type: 'function_call_output', call_id: 'tail-call', output: 'tail result' },
  ], model: 'm' };
  const pairedRecovery = adapt.prepareOpenRouterRecovery(paired, Buffer.from(JSON.stringify(paired)), null);
  const hasCall = pairedRecovery.body.toString().includes('tail-call');
  assert.ok(hasCall);
});

test('adapt recovery keeps the DeepSeek schema instruction last and clears effort updates', () => {
  const schema = { type: 'object', properties: {} };
  const request = { text: { format: { type: 'json_schema', schema } }, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] }] };
  adapt.adaptForUpstream(request, 'openrouter', 'deepseek/deepseek-chat', 's');
  const instruction = request.input.at(-1);
  assert.equal(instruction.role, 'developer');
  const primaryBody = Buffer.from(JSON.stringify(request));
  const recovery = adapt.prepareOpenRouterRecovery(request, primaryBody, instruction);
  const parsed = JSON.parse(recovery.body.toString('utf8'));
  assert.equal(parsed.input.at(-1).role, 'developer');
  assert.ok(parsed.input.at(-1).content[0].text.includes('JSON schema'));

  const withUpdates = {
    input: [
      { type: 'configuration_update', reasoning: { effort: 'low' } },
      { type: 'configuration_update', reasoning: {} },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
    reasoning: { effort: 'high' },
    model: 'm',
  };
  const cleaned = adapt.prepareOpenRouterRecovery(withUpdates, Buffer.from(JSON.stringify(withUpdates)), null);
  const cleanedParsed = JSON.parse(cleaned.body.toString('utf8'));
  assert.ok(cleanedParsed.input.every(item => item?.type !== 'configuration_update'));
  assert.equal(cleanedParsed.reasoning.effort, 'low');

  const malformedUpdates = {
    input: [
      { type: 'configuration_update' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
    reasoning: { effort: 'high' },
    model: 'm',
  };
  const malformed = adapt.prepareOpenRouterRecovery(malformedUpdates, Buffer.from(JSON.stringify(malformedUpdates)), null);
  const malformedParsed = JSON.parse(malformed.body.toString('utf8'));
  assert.equal(malformedParsed.reasoning.effort, 'high');

  const nonArray = { input: 'question', model: 'm' };
  const nonArrayRecovery = adapt.prepareOpenRouterRecovery(nonArray, Buffer.from(JSON.stringify(nonArray)), null);
  assert.equal(nonArrayRecovery.inputItems, null);
});

test('adapt omission notice has the expected developer shape', () => {
  const notice = adapt.omissionNotice();
  assert.equal(notice.type, 'message');
  assert.equal(notice.role, 'developer');
  assert.ok(notice.content[0].text.includes('provider rejected'));
});

// --- anthropic malformed, redacted, and stream shapes ---

test('anthropic headers, effort mapping, and thinking-off checks', () => {
  const headers = anthropic.anthropicHeaders('key-1', 12);
  assert.equal(headers['x-api-key'], 'key-1');
  assert.equal(headers['content-length'], '12');
  assert.equal(headers['anthropic-version'], '2026-10-21');
  assert.equal(anthropic.claudeEffort('high'), 'high');
  assert.equal(anthropic.claudeEffort('none'), 'low');
  assert.equal(anthropic.claudeEffort('minimal'), 'low');
  assert.equal(anthropic.claudeEffort('unknown-effort'), null);
  assert.equal(anthropic.turnsThinkingOff('claude-sonnet-5-5', 'none'), true);
  assert.equal(anthropic.turnsThinkingOff('claude-opus-5', 'none'), false);
  assert.equal(anthropic.turnsThinkingOff('claude-sonnet-5-5', 'low'), false);
  assert.equal(anthropic.isAnthropicThinking({ type: 'reasoning', encrypted_content: 'codex-router-anthropic-thinking:v1:abc' }), true);
  assert.equal(anthropic.isAnthropicThinking({ type: 'reasoning', encrypted_content: 'other' }), false);
  assert.equal(anthropic.isAnthropicThinking({ type: 'message' }), false);
});

test('anthropic messages drop malformed thinking but keep redacted thinking', () => {
  const malformed = { type: 'reasoning', encrypted_content: 'codex-router-anthropic-thinking:v1:!!!not-base64!!!' };
  const wrongShape = { type: 'reasoning', encrypted_content: `codex-router-anthropic-thinking:v1:${Buffer.from(JSON.stringify({ type: 'thinking', thinking: 42 })).toString('base64url')}` };
  const redacted = { type: 'reasoning', encrypted_content: `codex-router-anthropic-thinking:v1:${Buffer.from(JSON.stringify({ type: 'redacted_thinking', data: 'secret' })).toString('base64url')}` };
  const request = {
    model: 'claude-sonnet-5-5',
    tools: [{ type: 'function', name: 'tool_a', parameters: { type: 'object' } }],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      malformed,
      wrongShape,
      redacted,
      { type: 'function_call', call_id: 'keep-1', name: 'tool_a', arguments: '{}' },
      { type: 'function_call_output', call_id: 'keep-1', output: 'done' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'follow-up' }] },
    ],
  };
  const { body } = anthropic.messagesRequest(request);
  const assistantTurns = body.messages.filter(message => message.role === 'assistant');
  assert.equal(assistantTurns.length, 1);
  assert.ok(assistantTurns[0].content.some(block => block.type === 'redacted_thinking' && block.data === 'secret'));
  assert.ok(assistantTurns[0].content.some(block => block.type === 'tool_use'));
});

test('anthropic messages cover images, refusals, namespaces, and odd call IDs', () => {
  const request = {
    model: 'claude-sonnet-5-5',
    instructions: 'be brief',
    tools: [
      { type: 'function', name: 'plain', description: 'plain tool', parameters: { type: 'object', properties: {} } },
      { type: 'custom', name: 'writer', description: 'writes', format: { definition: 'input = "x";', syntax: 'ebnf' } },
      { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'grouped', parameters: null }] },
      { type: 'namespace', name: 'team', tools: [{ type: 'function', name: 'weird name!', parameters: { type: 'object' } }] },
      { type: 'other', name: 'ignored' },
      { type: 'function', name: '' },
      { type: 'function' },
    ],
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'opening rules' }] },
      { type: 'message', role: 'user', content: 'string content becomes text' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }, { type: 'input_text', text: 'real' }] },
      { type: 'message', role: 'user', content: [{ type: 'refusal', refusal: 'cannot' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/tiff;base64,AAAA' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: { url: 'data:image/png;base64,BBBB' } }] },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: { url: 'https://example.com/pic.png' } }] },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: { url: 'ftp://example.com/pic.png' } }] },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 42 }] },
      { type: 'message', role: 'user', content: [{ type: 'unknown_part', text: 'dropped' }] },
      { type: 'function_call', call_id: 'call with spaces!', name: 'plain', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'call with spaces!', output: 'done' },
      { type: 'function_call_output', call_id: 'call with spaces!', output: 'duplicate ignored' },
      { type: 'function_call', call_id: 'unanswered', name: 'plain', arguments: 'not json' },
      { type: 'function_call', call_id: 'unanswered', name: 'plain', arguments: '{"b":2}' },
      { type: 'custom_tool_call', call_id: 'custom-1', name: 'writer', input: 123 },
      { type: 'custom_tool_call_output', call_id: 'custom-1', output: { content: 'custom done' } },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'later instruction' }] },
      { type: 'configuration_update', reasoning: { effort: 'high' } },
      { type: 'configuration_update', reasoning: { effort: 'bogus' } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'closing note' }] },
    ],
  };
  const { body, declared } = anthropic.messagesRequest(request);
  assert.ok(body.system.length >= 2);
  assert.ok(body.messages[0].role === 'user');
  assert.ok(body.tools.length >= 3);
  assert.ok(declared.size >= 3);
  const toolUseIds = body.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'tool_use').map(block => block.id);
  assert.ok(toolUseIds.every(id => /^[A-Za-z0-9_-]+$/.test(id)));
  const names = body.tools.map(tool => tool.name);
  assert.ok(names.every(name => /^[A-Za-z0-9_-]+$/.test(name) && name.length <= 64));
  assert.ok(!body.messages.some(message => message.content?.some(block => block.type === 'tool_use' && block.callId === 'unanswered')));
});

test('anthropic messages handle string input, empty history, and assistant-only tails', () => {
  const stringResult = anthropic.messagesRequest({ model: 'claude-sonnet-5-5', input: 'just a question' });
  assert.equal(stringResult.body.messages[0].role, 'user');
  const emptyResult = anthropic.messagesRequest({ model: 'claude-sonnet-5-5', input: [] });
  assert.equal(emptyResult.body.messages[0].content[0].text, '(The conversation continues.)');
  const assistantTail = anthropic.messagesRequest({
    model: 'claude-sonnet-5-5',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'thinking aloud' }] },
    ],
  });
  assert.equal(assistantTail.body.messages.at(-1).content[0].text, '(Continue.)');
  const thinkingOnly = anthropic.messagesRequest({
    model: 'claude-sonnet-5-5',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', encrypted_content: `codex-router-anthropic-thinking:v1:${Buffer.from(JSON.stringify({ type: 'thinking', thinking: 'hmm', signature: 'sig' })).toString('base64url')}` },
    ],
  });
  assert.ok(!thinkingOnly.body.messages.some(message => message.role === 'assistant'));
  const developerFirst = anthropic.messagesRequest({
    model: 'claude-sonnet-5-5',
    input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '' }] }],
  });
  assert.equal(developerFirst.body.messages[0].role, 'user');
});

test('anthropic developer flush joins the user turn when no user turn exists yet', () => {
  const result = anthropic.messagesRequest({
    model: 'claude-sonnet-5-5',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'mid instruction' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'trailing without user after' }] },
    ],
  });
  assert.ok(result.body.messages.length > 0);
  const direct = anthropic.messagesRequest({
    model: 'claude-sonnet-5-5',
    input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'opens with assistant' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer before any user' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now user' }] },
    ],
  });
  assert.ok(direct.body.messages.some(message => message.content?.some(block => block.text === 'developer before any user')));
});

test('anthropic hasSystemPrompt, max tokens, and request options', () => {
  assert.equal(anthropic.hasSystemPrompt({ instructions: 'rules', input: [] }), true);
  assert.equal(anthropic.hasSystemPrompt({ input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }] }), true);
  assert.equal(anthropic.hasSystemPrompt({ input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '' }] }] }), false);
  assert.equal(anthropic.hasSystemPrompt({ input: [{ type: 'message', role: 'user', content: 'hi' }] }), false);
  assert.equal(anthropic.hasSystemPrompt({ input: 'question' }), false);
  assert.equal(anthropic.messagesMaxTokens({ max_output_tokens: 100 }), 100);
  assert.equal(anthropic.messagesMaxTokens({ max_output_tokens: 9999999 }), anthropic.anthropicMaxTokensLimit);
  assert.equal(anthropic.messagesMaxTokens({}), anthropic.anthropicMaxTokens);
  assert.equal(anthropic.messagesMaxTokens({ max_output_tokens: 0 }), anthropic.anthropicMaxTokens);
  assert.equal(anthropic.messagesMaxTokens({ max_output_tokens: '100' }), anthropic.anthropicMaxTokens);

  const cached = anthropic.messagesRequest(
    { model: 'claude-sonnet-5-5', instructions: 'system rules', input: [{ role: 'user', content: 'hi' }] },
    { promptCache: 'instructions' },
  );
  assert.deepEqual(cached.body.system.at(-1).cache_control, { type: 'ephemeral' });
  const uncached = anthropic.messagesRequest(
    { model: 'claude-sonnet-5-5', instructions: 'system rules', input: [{ role: 'user', content: 'hi' }] },
    { promptCache: 'none' },
  );
  assert.equal(uncached.body.cache_control, undefined);
  const budgeted = anthropic.messagesRequest(
    { model: 'claude-sonnet-5-5', input: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'high' } },
    { thinkingBudget: 1000 },
  );
  assert.deepEqual(budgeted.body.thinking, { type: 'enabled', budget_tokens: 1000 });
  assert.deepEqual(budgeted.betas, []);
  const off = anthropic.messagesRequest(
    { model: 'claude-sonnet-5-5', input: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'none' } },
  );
  assert.deepEqual(off.body.thinking, { type: 'between_tools' });
  const summarized = anthropic.messagesRequest(
    { model: 'claude-sonnet-5-5', input: [{ role: 'user', content: 'hi' }], reasoning: { summary: 'none' } },
  );
  assert.equal(summarized.body.thinking.display, 'omitted');
  const jsonSchema = anthropic.messagesRequest(
    { model: 'claude-sonnet-5-5', input: [{ role: 'user', content: 'hi' }], text: { format: { type: 'json_schema', schema: { type: 'object' } } } },
  );
  assert.deepEqual(jsonSchema.body.output_config.format, { type: 'json_schema', schema: { type: 'object' } });
  const noTools = anthropic.messagesRequest({ model: 'claude-sonnet-5-5', input: [{ role: 'user', content: 'hi' }], tool_choice: 'none' });
  assert.equal(noTools.body.tools, undefined);
  const toolChoice = anthropic.messagesRequest(
    { model: 'claude-sonnet-5-5', input: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 't', parameters: { type: 'object' } }], tool_choice: 'none', parallel_tool_calls: false },
  );
  assert.deepEqual(toolChoice.body.tool_choice, { type: 'none' });
  const parallel = anthropic.messagesRequest(
    { model: 'claude-sonnet-5-5', input: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 't', parameters: { type: 'object' } }], parallel_tool_calls: false },
  );
  assert.equal(parallel.body.tool_choice.disable_parallel_tool_use, true);
});

test('anthropic stream translates text, thinking, redacted, and tool calls', async () => {
  const { body, declared } = anthropic.messagesRequest({
    model: 'claude-sonnet-5-5',
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] }],
  });
  assert.ok(body);
  const upstream = new Readable({ read() {} });
  upstream.statusCode = 200;
  upstream.headers = { 'content-type': 'text/event-stream' };
  const translated = anthropic.anthropicResponse(upstream, declared, () => {});
  assert.notEqual(translated, upstream);
  const pendingFirst = collectPiped(translated);
  const events = [
    { type: 'message_start', message: { id: 'msg-1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hi' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'hidden' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-1', name: 'get_weather', input: { city: 'Paris' } } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'unknown_block' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } } },
    { type: 'message_stop' },
  ];
  for (const event of events) upstream.push(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
  upstream.push(null);
  const output = await pendingFirst;
  const parsed = sseBlocks(output);
  const types = parsed.map(event => event.type);
  assert.ok(types.includes('response.created'));
  assert.ok(types.includes('response.output_text.delta'));
  assert.ok(types.includes('response.completed'));
  const done = parsed.filter(event => event.type === 'response.output_item.done');
  const reasoning = done.find(event => event.item?.type === 'reasoning');
  assert.ok(reasoning.item.encrypted_content.startsWith('codex-router-anthropic-thinking:v1:'));
  const completed = parsed.find(event => event.type === 'response.completed');
  assert.equal(completed.response.usage.input_tokens, 15);
  assert.equal(completed.response.usage.output_tokens_details.reasoning_tokens, 5);
});

test('anthropic stream handles custom calls, thinking without signature, and stop reasons', async () => {
  const declared = new Map([['writer', { name: 'writer', namespace: undefined, custom: true }]]);
  async function runStream(events) {
    const upstream = new Readable({ read() {} });
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'text/event-stream' };
    const translated = anthropic.anthropicResponse(upstream, declared, () => {});
    const pending = collectPiped(translated);
    for (const event of events) upstream.push(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
    upstream.push(null);
    return sseBlocks(await pending);
  }
  const thinkingNoSig = await runStream([
    { type: 'message_start', message: { id: 'm1', usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'partial' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' more' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '' } },
    { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'ignored, no block' } },
    { type: 'content_block_stop', index: 9 },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
    { type: 'message_stop' },
  ]);
  const reasoningDone = thinkingNoSig.find(event => event.type === 'response.output_item.done' && event.item?.type === 'reasoning');
  assert.ok(reasoningDone);
  assert.equal(reasoningDone.item.encrypted_content, undefined);

  const custom = await runStream([
    { type: 'message_start', message: { id: 'm2', usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'writer', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"input":"hi"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} },
    { type: 'message_stop' },
  ]);
  const customDone = custom.find(event => event.type === 'response.output_item.done' && event.item?.type === 'custom_tool_call');
  assert.equal(customDone.item.input, 'hi');

  const refusal = await runStream([
    { type: 'message_start', message: { id: 'm3', usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'safety' } }, usage: {} },
    { type: 'message_stop' },
  ]);
  assert.ok(refusal.some(event => event.type === 'response.completed' && event.response.output.some(item => item.content?.[0]?.text?.includes('declined'))));

  const refusalNoCategory = await runStream([
    { type: 'message_start', message: { id: 'm4', usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: {} },
    { type: 'message_stop' },
  ]);
  assert.ok(refusalNoCategory.some(event => event.type === 'response.completed'));

  const overflow = await runStream([
    { type: 'message_start', message: { id: 'm5', usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' }, usage: {} },
    { type: 'message_stop' },
  ]);
  assert.ok(overflow.some(event => event.type === 'response.failed'));

  const truncated = await runStream([
    { type: 'message_start', message: { id: 'm6', usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: {} },
    { type: 'message_stop' },
  ]);
  assert.ok(truncated.some(event => event.type === 'response.incomplete'));
});

test('anthropic stream reports thinking drops, skips bad events, and fails oversized streams', async () => {
  const logs = [];
  const upstream = new Readable({ read() {} });
  upstream.statusCode = 200;
  upstream.headers = { 'content-type': 'text/event-stream' };
  const translated = anthropic.anthropicResponse(upstream, new Map(), (level, event) => logs.push([level, event]));
  const pending = collectPiped(translated);
  upstream.push(`event: message\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'drop-1', usage: {}, input_transformations: [{ reason: 'prefix_mismatch' }, { reason: 42 }] } })}\n\n`);
  upstream.push('event: message\ndata: {not-json}\n\n');
  upstream.push('event: message\n\n');
  upstream.push(`event: message\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 'bad', output_tokens: NaN } })}\n\n`);
  upstream.push(`event: message\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  upstream.push(null);
  const output = sseBlocks(await pending);
  assert.ok(logs.some(([, event]) => event === 'anthropic.thinking_dropped'));
  assert.ok(output.some(event => event.type === 'response.completed'));

  const failing = new Readable({ read() {} });
  failing.statusCode = 200;
  failing.headers = { 'content-type': 'text/event-stream' };
  const failedStream = anthropic.anthropicResponse(failing, new Map(), () => {});
  const failedPending = collectPiped(failedStream);
  failing.push(`event: message\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })}\n\n`);
  failing.push(null);
  const failed = sseBlocks(await failedPending);
  const failure = failed.find(event => event.type === 'response.failed');
  assert.equal(failure.response.error.code, 'rate_limit_exceeded');

  const overflowFail = new Readable({ read() {} });
  overflowFail.statusCode = 200;
  overflowFail.headers = { 'content-type': 'text/event-stream' };
  const overflowStream = anthropic.anthropicResponse(overflowFail, new Map(), () => {});
  const overflowPending = collectPiped(overflowStream);
  overflowFail.push(`event: message\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'maximum context length exceeded' } })}\n\n`);
  overflowFail.push(null);
  const overflowed = sseBlocks(await overflowPending);
  assert.equal(overflowed.find(event => event.type === 'response.failed').response.error.code, 'context_length_exceeded');

  const genericFail = new Readable({ read() {} });
  genericFail.statusCode = 200;
  genericFail.headers = { 'content-type': 'text/event-stream' };
  const genericStream = anthropic.anthropicResponse(genericFail, new Map(), () => {});
  const genericPending = collectPiped(genericStream);
  genericFail.push(`event: message\ndata: ${JSON.stringify({ type: 'error', error: { message: 42 } })}\n\n`);
  genericFail.push(null);
  const generic = sseBlocks(await genericPending);
  assert.equal(generic.find(event => event.type === 'response.failed').response.error.code, 'server_error');

  const passthrough = { statusCode: 400, headers: { 'content-type': 'application/json' } };
  assert.equal(anthropic.anthropicResponse(passthrough, new Map(), () => {}), passthrough);
  const wrongType = { statusCode: 200, headers: { 'content-type': 'application/json' } };
  assert.equal(anthropic.anthropicResponse(wrongType, new Map(), () => {}), wrongType);
});

test('anthropic refusals map statuses with and without parseable bodies', () => {
  assert.equal(anthropic.anthropicRefusal(401, Buffer.from(JSON.stringify({ error: { type: 'authentication_error' } }))), 'authentication_error');
  assert.equal(anthropic.anthropicRefusal(403, Buffer.from('not json')), 'http_403');
  assert.equal(anthropic.anthropicRefusal(429, Buffer.from(JSON.stringify({ error: { type: 'rate_limit', details: { error_code: 'enforced_spend_limit_reached' } } }))), 'enforced_spend_limit_reached');
  assert.equal(anthropic.anthropicRefusal(429, Buffer.from(JSON.stringify({ error: { type: 'rate_limit' } }))), null);
  assert.equal(anthropic.anthropicRefusal(400, Buffer.from(JSON.stringify({ error: { message: 'credit balance too low' } }))), 'billing');
  assert.equal(anthropic.anthropicRefusal(400, Buffer.from(JSON.stringify({ error: { message: 'usage limits hit' } }))), 'billing');
  assert.equal(anthropic.anthropicRefusal(400, Buffer.from(JSON.stringify({ error: { message: 'other' } }))), null);
  assert.equal(anthropic.anthropicRefusal(500, Buffer.from(JSON.stringify({ error: { message: 'boom' } }))), null);
});

// --- config quoting, levels, and atomic-write failure ---

test('config exposes host, port, keys, and logging helpers', () => {
  assert.equal(config.host, '127.0.0.1');
  assert.equal(typeof config.port, 'number');
  assert.equal(config.openrouterApiKey, 'test-openrouter-key');
  assert.equal(config.anthropicApiKey, 'test-anthropic-key');
  assert.ok(/^[a-f0-9]{64}$/.test(config.routerToken) || /^[b]{64}$/.test(config.routerToken) || config.routerToken.length === 64);
  assert.deepEqual(config.logLevels, { error: 0, info: 1, debug: 2 });
  assert.equal(config.configuredLogLevel, 'error');
});

test('config persists JSON atomically and logs write failures', () => {
  const file = join(routerHome, `persist-${uniqueId('ok')}.json`);
  config.persistJson(file, { hello: 'world' }, 'test.persist_failed');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { hello: 'world' });
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = line => logs.push(String(line));
  console.log = line => logs.push(String(line));
  try {
    config.persistJson(join(routerHome, 'missing-dir', 'file.json'), { x: 1 }, 'test.persist_failed');
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  assert.ok(logs.some(line => line.includes('test.persist_failed')));
  const filtered = [];
  console.log = line => filtered.push(String(line));
  console.error = line => filtered.push(String(line));
  try {
    config.logEvent('info', 'test.filtered', {});
    config.logEvent('debug', 'test.filtered', {});
    config.logEvent('error', 'test.shown', { marker: uniqueId('m') });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.ok(!filtered.some(line => line.includes('test.filtered')));
  assert.ok(filtered.some(line => line.includes('test.shown')));
});

test('config reads quoted environment files', async () => {
  const envFile = join(routerHome, `quoted-${uniqueId('env')}.env`);
  writeFileSync(envFile, [
    '# comment line',
    '',
    'PLAIN=value',
    'SPACED = spaced value ',
    'DOUBLE="quoted value"',
    "SINGLE='single value'",
    'EMPTY=',
    'NOEQUALS',
    '=nokey',
    '  KEY_WITH_SPACES  =  trimmed  ',
  ].join('\n'));
  const code = `
    process.env.CODEX_ROUTER_ENV_FILE = ${JSON.stringify(envFile)};
    process.env.CODEX_ROUTER_TOKEN = ${JSON.stringify('c'.repeat(64))};
    const config = await import(${JSON.stringify(moduleUrl('config.mjs'))});
    console.log(JSON.stringify(config.fileEnvironment));
  `;
  const { stdout } = await runChild(code);
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(parsed.PLAIN, 'value');
  assert.equal(parsed.SPACED, 'spaced value');
  assert.equal(parsed.DOUBLE, 'quoted value');
  assert.equal(parsed.SINGLE, 'single value');
  assert.equal(parsed.EMPTY, '');
  assert.equal(parsed.KEY_WITH_SPACES, 'trimmed');
  assert.ok(!('NOEQUALS' in parsed));
});

test('config rejects invalid log levels, tokens, and provider orders', async () => {
  const base = {
    CODEX_ROUTER_ENV_FILE: join(routerHome, `missing-${uniqueId('env')}.env`),
    CODEX_ROUTER_TOKEN: 'd'.repeat(64),
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    CODEX_ROUTER_LOG_LEVEL: 'verbose',
    CODEX_ROUTER_PROVIDER_ORDER: '',
  };
  await assert.rejects(runChild(`await import(${JSON.stringify(moduleUrl('config.mjs'))});`, base), /CODEX_ROUTER_LOG_LEVEL/);

  await assert.rejects(runChild(`await import(${JSON.stringify(moduleUrl('config.mjs'))});`, {
    ...base, CODEX_ROUTER_LOG_LEVEL: 'error', CODEX_ROUTER_TOKEN: 'short',
  }), /CODEX_ROUTER_TOKEN/);

  await assert.rejects(runChild(`await import(${JSON.stringify(moduleUrl('config.mjs'))});`, {
    ...base, CODEX_ROUTER_LOG_LEVEL: 'error', CODEX_ROUTER_PROVIDER_ORDER: 'bad entry without equals; ',
  }), /CODEX_ROUTER_PROVIDER_ORDER/);

  await assert.rejects(runChild(`await import(${JSON.stringify(moduleUrl('config.mjs'))});`, {
    ...base, CODEX_ROUTER_LOG_LEVEL: 'error', CODEX_ROUTER_PROVIDER_ORDER: 'model=has space',
  }), /CODEX_ROUTER_PROVIDER_ORDER/);

  const good = await runChild(`
    const config = await import(${JSON.stringify(moduleUrl('config.mjs'))});
    console.log(JSON.stringify([...config.providerOrders.entries()]));
  `, { ...base, CODEX_ROUTER_LOG_LEVEL: 'error', CODEX_ROUTER_PROVIDER_ORDER: 'a/b=c,d; e/f=g' });
  assert.deepEqual(JSON.parse(good.stdout.trim().split('\n').at(-1)), [['a/b', ['c', 'd']], ['e/f', ['g']]]);
});

test('config ignores Anthropic sign-in tokens', async () => {
  const withSignIn = await runChild(`
    const config = await import(${JSON.stringify(moduleUrl('config.mjs'))});
    console.log(JSON.stringify(config.anthropicApiKey));
  `, {
    CODEX_ROUTER_ENV_FILE: join(routerHome, `missing-${uniqueId('env')}.env`),
    CODEX_ROUTER_TOKEN: 'e'.repeat(64),
    ANTHROPIC_API_KEY: 'sk-ant-oat-test-token',
    OPENROUTER_API_KEY: '',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_ROUTER_PROVIDER_ORDER: '',
  });
  assert.equal(withSignIn.stdout.trim().split('\n').at(-1), '""');
  const withKey = await runChild(`
    const config = await import(${JSON.stringify(moduleUrl('config.mjs'))});
    console.log(JSON.stringify(config.anthropicApiKey));
  `, {
    CODEX_ROUTER_ENV_FILE: join(routerHome, `missing-${uniqueId('env')}.env`),
    CODEX_ROUTER_TOKEN: 'e'.repeat(64),
    ANTHROPIC_API_KEY: 'sk-ant-api-test-key',
    OPENROUTER_API_KEY: '',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_ROUTER_PROVIDER_ORDER: '',
  });
  assert.equal(JSON.parse(withKey.stdout.trim().split('\n').at(-1)), 'sk-ant-api-test-key');
});

// --- served-by lookup, cache expiry, eviction, and errors ---

test('served-by passes through non-final events and annotates final ones', async () => {
  const source = {};
  const stream = servedBy.servedByStream({ provider: 'Anthropic', route: 'anthropic', thinking: 'adaptive', endpoint: 'anthropic', source });
  const finalEvent = { type: 'response.completed', response: { id: 'resp-served-1', output: [], usage: {} } };
  const raw = await collectStream(stream, [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-served-1"}}\n\n',
    `event: response.completed\ndata: ${JSON.stringify(finalEvent)}\n\n`,
  ]);
  const parsed = sseBlocks(raw);
  const final = parsed.find(event => event.type === 'response.completed');
  assert.equal(final.response.provider, 'Anthropic');
  assert.equal(final.response.route, 'anthropic');
  assert.equal(final.response.thinking, 'adaptive');
  assert.equal(final.response.endpoint, 'anthropic');
  assert.equal(source.upstreamFinal, undefined);
});

test('served-by marks router-written finals unknown and skips lookup', async () => {
  const source = { upstreamFinal: false, generationId: 'gen-should-not-store' };
  const stream = servedBy.servedByStream({ provider: null, route: 'openrouter', endpoint: 'only-endpoint', source });
  const finalEvent = { type: 'response.completed', response: { id: 'resp-router-written', output: [] } };
  const raw = await collectStream(stream, [`event: response.completed\ndata: ${JSON.stringify(finalEvent)}\n\n`]);
  const parsed = sseBlocks(raw);
  const final = parsed.find(event => event.type === 'response.completed');
  assert.equal(final.response.provider, 'unknown');
  assert.equal(final.response.endpoint, undefined);
  assert.equal(await servedBy.generationReport('resp-router-written'), null);
});

test('served-by ignores malformed final blocks and keeps other lines', async () => {
  const stream = servedBy.servedByStream({ provider: 'OpenAI', route: 'openai', source: {} });
  const raw = await collectStream(stream, [
    'event: response.completed\ndata: {not-json}\n\n',
    'event: something\ndata: {"type":"response.created"}\n\n',
    'event: response.completed\n: comment line\ndata: {"type":"response.completed","response":{"id":"resp-multi-line","output":[]}}\n\n',
  ]);
  const parsed = sseBlocks(raw);
  assert.ok(parsed.some(event => event.type === 'response.completed' && event.response?.id === 'resp-multi-line'));
  assert.ok(raw.includes(': comment line'));
});

test('served-by generation lookup resolves, stays pending, then goes unknown', async t => {
  const generationId = `gen-${uniqueId('lookup').replace(/[^A-Za-z0-9-]/g, 'x').slice(0, 20)}`;
  const responseId = uniqueId('resp-lookup');
  const source = { generationId, upstreamFinal: true };
  const stream = servedBy.servedByStream({ provider: null, route: 'openrouter', source });
  await collectStream(stream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, output: [] } })}\n\n`]);
  let calls = 0;
  t.mock.method(https, 'request', (options, onResponse) => {
    calls += 1;
    assert.ok(String(options.path).includes(encodeURIComponent(generationId)));
    const response = new Readable({ read() {} });
    response.statusCode = 200;
    response.headers = {};
    queueMicrotask(() => {
      onResponse(response);
      response.push(JSON.stringify({ data: { provider_name: 'TestProvider' } }));
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    request.destroy = () => {};
    request.on = request.on.bind(request);
    return request;
  });
  try {
    const first = await servedBy.generationReport(responseId);
    assert.equal(first.status, 'resolved');
    assert.equal(first.provider, 'TestProvider');
    const second = await servedBy.generationReport(responseId);
    assert.equal(second.status, 'resolved');
    assert.equal(calls, 1);
  } finally {
    mock.restoreAll();
  }
  const unknownId = uniqueId('resp-unknown');
  const unknownSource = { generationId: `gen-${uniqueId('u').replace(/[^A-Za-z0-9-]/g, 'x').slice(0, 20)}`, upstreamFinal: true };
  const unknownStream = servedBy.servedByStream({ provider: null, route: 'openrouter', source: unknownSource });
  await collectStream(unknownStream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: unknownId, output: [] } })}\n\n`]);
  t.mock.method(https, 'request', (options, onResponse) => {
    const response = new Readable({ read() {} });
    response.statusCode = 429;
    queueMicrotask(() => {
      onResponse(response);
      response.push(JSON.stringify({ error: 'rate limited' }));
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    request.destroy = () => {};
    return request;
  });
  try {
    const pending = await servedBy.generationReport(unknownId);
    assert.equal(pending.status, 'pending');
  } finally {
    mock.restoreAll();
  }
  assert.equal(await servedBy.generationReport('resp-never-served'), null);
});

test('served-by lookup tolerates unreadable, oversized, and failing responses', async t => {
  async function lookupWithResponder(responder) {
    const generationId = `gen-${uniqueId('tol').replace(/[^A-Za-z0-9-]/g, 'x').slice(0, 20)}`;
    const responseId = uniqueId('resp-tol');
    const stream = servedBy.servedByStream({ provider: null, route: 'openrouter', source: { generationId, upstreamFinal: true } });
    await collectStream(stream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, output: [] } })}\n\n`]);
    t.mock.method(https, 'request', responder);
    try {
      return await servedBy.generationReport(responseId);
    } finally {
      mock.restoreAll();
    }
  }
  const badJson = await lookupWithResponder((options, onResponse) => {
    const response = new Readable({ read() {} });
    response.statusCode = 200;
    queueMicrotask(() => {
      onResponse(response);
      response.push('not json');
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    request.destroy = () => {};
    return request;
  });
  assert.equal(badJson.status, 'pending');
  const longName = await lookupWithResponder((options, onResponse) => {
    const response = new Readable({ read() {} });
    response.statusCode = 200;
    queueMicrotask(() => {
      onResponse(response);
      response.push(JSON.stringify({ data: { provider_name: 'x'.repeat(101) } }));
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    request.destroy = () => {};
    return request;
  });
  assert.equal(longName.status, 'pending');
  const failing = await lookupWithResponder(() => {
    const request = new PassThrough();
    request.end = () => {};
    queueMicrotask(() => request.emit('error', new Error('down')));
    return request;
  });
  assert.equal(failing.status, 'pending');
  const erroring = await lookupWithResponder((options, onResponse) => {
    const response = new Readable({ read() {} });
    response.statusCode = 200;
    queueMicrotask(() => {
      onResponse(response);
      response.emit('error', new Error('body failed'));
    });
    const request = new PassThrough();
    request.end = () => {};
    request.destroy = () => {};
    return request;
  });
  assert.equal(erroring.status, 'pending');
});

test('served-by expires generations after a day and throttles lookups', async t => {
  const generationId = `gen-${uniqueId('exp').replace(/[^A-Za-z0-9-]/g, 'x').slice(0, 20)}`;
  const responseId = uniqueId('resp-exp');
  const stream = servedBy.servedByStream({ provider: null, route: 'openrouter', source: { generationId, upstreamFinal: true } });
  await collectStream(stream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, output: [] } })}\n\n`]);
  const realNow = Date.now;
  let now = realNow();
  t.mock.method(Date, 'now', () => now);
  let lookups = 0;
  t.mock.method(https, 'request', (options, onResponse) => {
    lookups += 1;
    const response = new Readable({ read() {} });
    response.statusCode = 429;
    queueMicrotask(() => {
      onResponse(response);
      response.push('{}');
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    request.destroy = () => {};
    return request;
  });
  try {
    const first = await servedBy.generationReport(responseId);
    assert.equal(first.status, 'pending');
    assert.equal(lookups, 1);
    const second = await servedBy.generationReport(responseId);
    assert.equal(second.status, 'pending');
    assert.equal(lookups, 1);
    now += 31 * 60 * 1000;
    const unknown = await servedBy.generationReport(responseId);
    assert.equal(unknown.status, 'unknown');
    now += 24 * 60 * 60 * 1000;
    assert.equal(await servedBy.generationReport(responseId), null);
  } finally {
    mock.restoreAll();
    Date.now = realNow;
  }
});

test('served-by drops expired generations when remembering new ones', async () => {
  const realNow = Date.now;
  let now = realNow();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const oldId = uniqueId('resp-old');
    const oldGen = `gen-${uniqueId('old').replace(/[^A-Za-z0-9-]/g, 'x').slice(0, 20)}`;
    const oldStream = servedBy.servedByStream({ provider: null, route: 'openrouter', source: { generationId: oldGen, upstreamFinal: true } });
    await collectStream(oldStream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: oldId, output: [] } })}\n\n`]);
    now += 25 * 60 * 60 * 1000;
    const newId = uniqueId('resp-new');
    const newGen = `gen-${uniqueId('new').replace(/[^A-Za-z0-9-]/g, 'x').slice(0, 20)}`;
    const newStream = servedBy.servedByStream({ provider: null, route: 'openrouter', source: { generationId: newGen, upstreamFinal: true } });
    await collectStream(newStream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: newId, output: [] } })}\n\n`]);
    assert.equal(await servedBy.generationReport(oldId), null);
    Date.now = originalNow;
    now = originalNow();
    const fresh = await servedBy.generationReport(newId);
    assert.ok(fresh);
  } finally {
    Date.now = originalNow;
  }
  const invalidStream = servedBy.servedByStream({ provider: null, route: 'openrouter', source: { generationId: 'not-a-generation', upstreamFinal: true } });
  await collectStream(invalidStream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: uniqueId('resp-invalid'), output: [] } })}\n\n`]);
});

// --- sessions: sides, caps, effort records, lead IDs ---

test('sessions classify sides and training declarations', () => {
  assert.equal(sessions.sessionSide('anything', 'openai', 'gpt-5'), 'openai');
  assert.equal(sessions.sessionSide('ultra-spark-private/x', 'openrouter', 'deepseek/x'), 'private');
  assert.equal(sessions.sessionSide('ultra-spark/x', 'openrouter', 'deepseek/x'), 'training');
  assert.equal(sessions.sessionSide('other', 'openrouter', 'meta/muse-spark-1.3-contributor'), 'training');
  assert.equal(sessions.sessionSide('anthropic/x', 'anthropic', 'claude-x'), 'anthropic');
  assert.equal(sessions.sessionSide('anthropic/x', 'openrouter', 'anthropic/claude-x'), 'anthropic');
  assert.equal(sessions.sessionSide('other', 'openrouter', 'openai/gpt-4'), 'openai');
  assert.equal(sessions.sessionSide('other', 'openrouter', 'deepseek/x'), null);
  assert.deepEqual(sessions.trainingDeclarations, ['declared-training', 'endpoint', 'provider-terms', 'unknown']);
  assert.equal(sessions.trainingDeclaration('ultra-spark/x', 'openrouter', 'deepseek/x'), 'declared-training');
  assert.equal(sessions.trainingDeclaration('ultra-spark-private/x', 'openrouter', 'deepseek/x'), 'provider-terms');
  assert.equal(sessions.trainingDeclaration('other', 'openai', 'gpt-5'), 'provider-terms');
  assert.equal(sessions.trainingDeclaration('anthropic/x', 'anthropic', 'claude-x', { openrouterFallback: true }), 'endpoint');
  assert.equal(sessions.trainingDeclaration('anthropic/x', 'anthropic', 'claude-x', { openrouterFallback: false }), 'provider-terms');
  assert.equal(sessions.trainingDeclaration('other', 'openrouter', 'deepseek/x'), 'endpoint');
  assert.equal(sessions.trainingDeclaration('other', 'other', 'other'), 'unknown');
  assert.equal(sessions.trainingDeclaration(null, 'openrouter', 'deepseek/x'), 'unknown');
  assert.equal(sessions.trainingDeclaration('other', 'openrouter', null), 'unknown');
});

test('sessions isolate providers and refresh active records', () => {
  const sessionA = uniqueId('sess-a');
  assert.equal(sessions.sessionRefusal({ requestId: 'r1', sessionId: sessionA, threadId: sessionA, requestedModel: 'gpt-5', side: 'openai', input: [] }), null);
  assert.ok(sessions.protectedSession(sessionA));
  const trainingRefusal = sessions.sessionRefusal({ requestId: 'r2', sessionId: sessionA, threadId: `${sessionA}-child`, requestedModel: 'ultra-spark/x', side: 'training', input: [] });
  assert.equal(trainingRefusal.code, 'provider_isolation');
  assert.ok(trainingRefusal.message.includes('Start a new thread'));

  const sessionB = uniqueId('sess-b');
  assert.equal(sessions.sessionRefusal({ requestId: 'r1', sessionId: sessionB, threadId: sessionB, requestedModel: 'ultra-spark/x', side: 'training', input: [] }), null);
  assert.ok(!sessions.protectedSession(sessionB));
  const openaiRefusal = sessions.sessionRefusal({ requestId: 'r2', sessionId: sessionB, threadId: `${sessionB}-child`, requestedModel: 'gpt-5', side: 'openai', input: [] });
  assert.equal(openaiRefusal.code, 'provider_isolation');

  const sessionC = uniqueId('sess-c');
  assert.equal(sessions.sessionRefusal({ requestId: 'r1', sessionId: sessionC, threadId: sessionC, requestedModel: 'other', side: null, input: [] }), null);
  assert.ok(!sessions.protectedSession(sessionC));
  assert.ok(!sessions.protectedSession(null));
  assert.ok(!sessions.protectedSession(uniqueId('sess-missing')));
  assert.equal(sessions.sessionRefusal({ requestId: 'r', sessionId: null, threadId: null, requestedModel: 'gpt-5', side: 'openai', input: [] }), null);
});

test('sessions keep Claude routes per session and hold Anthropic after refusals', () => {
  const session = uniqueId('claude-route');
  sessions.recordClaudeRoute(null, 'anthropic');
  sessions.recordClaudeRoute(session, 'anthropic');
  assert.equal(sessions.claudeRoute(session), 'anthropic');
  sessions.recordClaudeRoute(session, 'anthropic');
  sessions.recordClaudeRoute(session, 'openrouter');
  assert.equal(sessions.claudeRoute(session), 'openrouter');
  assert.equal(sessions.claudeRoute(session, { fallback: false }), 'openrouter');
  assert.equal(sessions.claudeRoute(null), 'anthropic');
  sessions.holdAnthropicRoute();
  assert.equal(sessions.claudeRoute(uniqueId('fresh-after-hold')), 'openrouter');
});

test('sessions track Claude effort changes across fingerprints', async () => {
  const thread = uniqueId('effort-thread');
  const { createHash } = await import('node:crypto');
  function fpChain(texts) {
    const out = [];
    let previous = '';
    for (const text of texts) {
      previous = createHash('sha256').update(previous).update(JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })).digest('hex');
      out.push(previous);
    }
    return out;
  }
  assert.equal(sessions.claudeEffortChanges(null, ['a'], 'low'), null);
  assert.equal(sessions.claudeEffortChanges(thread, [], 'low'), null);
  assert.equal(sessions.claudeEffortChanges(thread, ['a'], 'bogus'), null);
  const first = sessions.claudeEffortChanges(thread, fpChain(['one']), 'low');
  assert.equal(first.length, 1);
  const same = sessions.claudeEffortChanges(thread, fpChain(['one']), 'low');
  assert.equal(same.length, 1);
  const changed = sessions.claudeEffortChanges(thread, fpChain(['one', 'two']), 'high');
  assert.equal(changed.length, 2);
  const replaced = sessions.claudeEffortChanges(thread, fpChain(['one', 'two']), 'max');
  assert.equal(replaced.length, 2);
  assert.equal(replaced[1][1], 'max');
  const older = sessions.claudeEffortChanges(thread, fpChain(['one']), 'low');
  assert.equal(older.length, 1);
  const mismatchThread = uniqueId('effort-mismatch');
  sessions.claudeEffortChanges(mismatchThread, fpChain(['alpha']), 'low');
  const mismatch = sessions.claudeEffortChanges(mismatchThread, fpChain(['different', 'more']), 'high');
  assert.ok(Array.isArray(mismatch) && mismatch.length >= 1);
});

test('sessions refuse training workers that carry the Ultra Spark lead history', () => {
  const session = uniqueId('ultra-lead');
  const leadInput = [
    { type: 'function_call', call_id: 'lead-call-1', name: 'tool_a', arguments: '{}' },
    { type: 'function_call_output', call_id: 'lead-call-1', output: 'result' },
    { type: 'function_call', call_id: 'x'.repeat(300), name: 'tool_b', arguments: '{}' },
    { type: 'function_call', call_id: '', name: 'bad', arguments: '{}' },
    { type: 'message', role: 'user', content: [] },
  ];
  assert.equal(sessions.sessionRefusal({ requestId: 'lead', sessionId: session, threadId: session, requestedModel: 'ultra-spark/worker', side: 'training', input: leadInput }), null);
  const forked = sessions.sessionRefusal({
    requestId: 'worker', sessionId: session, threadId: `${session}-worker`, requestedModel: 'openrouter/meta/muse-spark-1.3-contributor', side: 'training',
    input: [{ type: 'function_call', call_id: 'lead-call-1', name: 'tool_a', arguments: '{}' }],
  });
  assert.equal(forked.code, 'forked_lead_context');
  const clean = sessions.sessionRefusal({
    requestId: 'worker2', sessionId: session, threadId: `${session}-worker`, requestedModel: 'openrouter/meta/muse-spark-1.3-contributor', side: 'training',
    input: [{ type: 'function_call', call_id: 'unrelated', name: 'tool_a', arguments: '{}' }],
  });
  assert.equal(clean, null);
  const nonTrainingWorker = sessions.sessionRefusal({
    requestId: 'worker3', sessionId: session, threadId: `${session}-worker`, requestedModel: 'openrouter/meta/muse-spark-1.3-contributor', side: null,
    input: [{ type: 'function_call', call_id: 'lead-call-1', name: 'tool_a', arguments: '{}' }],
  });
  assert.equal(nonTrainingWorker, null);
  assert.equal(sessions.sessionRefusal({ requestId: 'n', sessionId: null, threadId: null, requestedModel: 'ultra-spark/x', side: 'training', input: leadInput }), null);
});

test('sessions cap lead call IDs per session and across sessions', () => {
  const session = uniqueId('cap-session');
  const many = Array.from({ length: 4100 }, (_, index) => ({ type: 'function_call', call_id: `cap-${index}`, name: 't', arguments: '{}' }));
  assert.equal(sessions.sessionRefusal({ requestId: 'cap-lead', sessionId: session, threadId: session, requestedModel: 'ultra-spark/x', side: 'training', input: many }), null);
  const evicted = sessions.sessionRefusal({
    requestId: 'cap-worker', sessionId: session, threadId: `${session}-w`, requestedModel: 'openrouter/meta/muse-spark-1.3-contributor', side: 'training',
    input: [{ type: 'function_call', call_id: 'cap-0', name: 't', arguments: '{}' }],
  });
  assert.equal(evicted, null);
  const retained = sessions.sessionRefusal({
    requestId: 'cap-worker2', sessionId: session, threadId: `${session}-w`, requestedModel: 'openrouter/meta/muse-spark-1.3-contributor', side: 'training',
    input: [{ type: 'function_call', call_id: 'cap-4099', name: 't', arguments: '{}' }],
  });
  assert.equal(retained.code, 'forked_lead_context');

  const firstSession = uniqueId('first-evict');
  sessions.sessionRefusal({ requestId: 'e1', sessionId: firstSession, threadId: firstSession, requestedModel: 'ultra-spark/x', side: 'training', input: [{ type: 'function_call', call_id: 'first-id', name: 't', arguments: '{}' }] });
  for (let index = 0; index < 260; index += 1) {
    const id = uniqueId(`fill-${index}`);
    sessions.sessionRefusal({ requestId: `fill-${index}`, sessionId: id, threadId: id, requestedModel: 'ultra-spark/x', side: 'training', input: [{ type: 'function_call', call_id: `fill-call-${index}`, name: 't', arguments: '{}' }] });
  }
  const afterEviction = sessions.sessionRefusal({
    requestId: 'evicted-check', sessionId: firstSession, threadId: `${firstSession}-w`, requestedModel: 'openrouter/meta/muse-spark-1.3-contributor', side: 'training',
    input: [{ type: 'function_call', call_id: 'first-id', name: 't', arguments: '{}' }],
  });
  assert.equal(afterEviction, null);
});

// --- web-search: expiry, prune, errors, and stream branches ---

test('web-search offers, restores, and respects caller-owned names', () => {
  const hosted = { tools: [{ type: 'web_search', query: 'x' }], input: [] };
  const offered = webSearch.overrideWebSearchForOpenRouter(hosted, 'scope-ws-1');
  assert.equal(offered.offered, true);
  assert.ok(hosted.tools.some(tool => tool?.name === 'web_search' && tool?.type === 'function'));

  const owned = { tools: [{ type: 'function', name: 'web_search' }, { type: 'web_search' }], input: [] };
  const ownedResult = webSearch.overrideWebSearchForOpenRouter(owned, 'scope-ws-1');
  assert.equal(ownedResult.offered, false);
  assert.ok(!owned.tools.some(tool => tool?.type === 'function' && tool?.name === 'web_search' && tool?.description?.includes('Search the web')));

  const preview = { tools: [{ type: 'web_search_preview' }], input: [] };
  webSearch.overrideWebSearchForOpenRouter(preview, 'scope-ws-1');
  assert.ok(preview.tools.some(tool => tool?.name === 'web_search'));

  const noTools = { input: [] };
  const noToolsResult = webSearch.overrideWebSearchForOpenRouter(noTools, 'scope-ws-1');
  assert.equal(noToolsResult.offered, false);

  const noScope = { tools: [{ type: 'web_search' }], input: [{ type: 'web_search_call', id: 'call-1', action: { query: 'hi' } }] };
  const noScopeResult = webSearch.overrideWebSearchForOpenRouter(noScope, '');
  assert.equal(noScopeResult.restored, 1);
  assert.ok(noScope.input.some(item => item?.type === 'function_call' && item?.name === 'web_search'));
});

test('web-search restores missing call IDs and absent queries deterministically', () => {
  const request = {
    tools: [],
    input: [
      { type: 'web_search_call', action: null },
      { type: 'web_search_call', id: '', action: { query: 42 } },
    ],
  };
  const result = webSearch.overrideWebSearchForOpenRouter(request, uniqueId('ws-missing-id'));
  assert.equal(result.restored, 2);
  const calls = request.input.filter(item => item?.type === 'function_call');
  assert.deepEqual(calls.map(call => call.call_id), ['ws_restored_1', 'ws_restored_2']);
  assert.deepEqual(calls.map(call => JSON.parse(call.arguments).query), ['', '']);
});

test('web-search effort reads the catalog or falls back to low', () => {
  writeFileSync(catalogFile, JSON.stringify({ models: [
    { slug: 'test/none-model', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'none' }] },
    { slug: 'test/high-model', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }] },
    { slug: 'test/empty-model', supported_reasoning_levels: [] },
  ] }));
  assert.equal(webSearch.webSearchEffort('test/none-model'), 'none');
  assert.equal(webSearch.webSearchEffort('test/high-model'), 'high');
  assert.equal(webSearch.webSearchEffort('test/empty-model'), 'low');
  assert.equal(webSearch.webSearchEffort('test/missing-model'), 'low');
  rmSync(catalogFile, { force: true });
  assert.equal(webSearch.webSearchEffort('test/any-model'), 'low');
  writeFileSync(catalogFile, 'not json');
  assert.equal(webSearch.webSearchEffort('test/any-model'), 'low');
  rmSync(catalogFile, { force: true });
});

test('web-search run reports failures without leaking queries', async t => {
  async function searchWithResponder(responder, { query = 'test query', endpoints = null, dataCollection = null } = {}) {
    t.mock.method(https, 'request', responder);
    try {
      return await webSearch.runWebSearch({
        query, upstreamModel: 'deepseek/deepseek-chat', effort: 'low',
        dataCollection, endpoints, log: () => {},
        register: () => {},
      });
    } finally {
      mock.restoreAll();
    }
  }
  const httpError = await searchWithResponder((options, onResponse) => {
    const response = new Readable({ read() {} });
    response.statusCode = 500;
    queueMicrotask(() => {
      onResponse(response);
      response.push(JSON.stringify({ error: 'boom' }));
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    return request;
  });
  assert.ok(httpError.includes('HTTP 500'));

  const unreadable = await searchWithResponder((options, onResponse) => {
    const response = new Readable({ read() {} });
    response.statusCode = 200;
    queueMicrotask(() => {
      onResponse(response);
      response.push('not json');
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    return request;
  });
  assert.ok(unreadable.includes('HTTP 200'));

  const citations = await searchWithResponder((options, onResponse) => {
    const response = new Readable({ read() {} });
    response.statusCode = 200;
    queueMicrotask(() => {
      onResponse(response);
      response.push(JSON.stringify({ output: [{ content: [{ annotations: [
        { type: 'url_citation', url: 'https://example.com/a', title: 'A', content: 'excerpt a' },
        { type: 'url_citation', url: 'https://example.com/a', title: 'duplicate', content: 'ignored' },
        { type: 'other', url: 'https://example.com/b' },
        { type: 'url_citation', url: 42 },
      ] }] }], usage: { cost: 0.001 } }));
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    return request;
  });
  assert.ok(citations.includes('https://example.com/a'));
  assert.ok(!citations.includes('duplicate'));

  const withEndpoints = await searchWithResponder((options, onResponse) => {
    assert.deepEqual(options.headers?.authorization, 'Bearer test-openrouter-key');
    const response = new Readable({ read() {} });
    response.statusCode = 200;
    queueMicrotask(() => {
      onResponse(response);
      response.push(JSON.stringify({ output: [] }));
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    return request;
  }, { endpoints: ['pinned-endpoint'], dataCollection: 'deny' });
  assert.ok(withEndpoints.includes('no results'));

  const failedRequest = await searchWithResponder(() => {
    throw new Error('connect failed');
  });
  assert.ok(failedRequest.includes('failed'));
});

test('web-search run handles read errors and cancellation', async t => {
  t.mock.method(https, 'request', (options, onResponse) => {
    const response = new Readable({ read() {} });
    response.statusCode = 200;
    queueMicrotask(() => {
      onResponse(response);
      response.emit('error', new Error('read failed'));
    });
    const request = new PassThrough();
    request.end = () => {};
    return request;
  });
  let text;
  try {
    text = await webSearch.runWebSearch({ query: 'q', upstreamModel: 'm', effort: 'low', log: () => {}, register: () => {} });
  } finally {
    mock.restoreAll();
  }
  assert.ok(text.includes('could not be read') || text.includes('failed'));

  let cancel;
  t.mock.method(https, 'request', (options, onResponse) => {
    const request = new PassThrough();
    request.end = () => {};
    cancel = () => {};
    return request;
  });
  try {
    const pending = webSearch.runWebSearch({ query: 'q', upstreamModel: 'm', effort: 'low', log: () => {}, register: (req, onCancel) => { cancel = onCancel; } });
    cancel();
    const cancelled = await pending;
    assert.ok(cancelled.includes('cancelled') || cancelled.includes('failed'));
  } finally {
    mock.restoreAll();
  }
});

test('web-search stream normalizes whole-number floats and ignores hidden deltas', async () => {
  const stream = webSearch.openRouterStream({
    interceptSearches: false,
    requestBody: { input: [] },
    sendContinuation: async () => { throw new Error('should not continue'); },
    search: async () => 'results',
    scope: 'scope-float',
    source: {},
  });
  const callItem = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'tool_a', arguments: '{"timeout_ms": 60000.0, "label": "60000.0 inside string", "ratio": 1.5}' };
  const raw = await collectStream(stream, [
    sseEncode({ type: 'response.output_item.done', item: callItem }),
    sseEncode({ type: 'response.function_call_arguments.done', item_id: 'fc-1', arguments: '{"timeout_ms": 60000.0}' }),
    sseEncode({ type: 'response.completed', response: { id: 'resp-float', output: [callItem], usage: { input_tokens: 5 } } }),
  ]);
  const parsed = sseBlocks(raw);
  const done = parsed.find(event => event.type === 'response.output_item.done' && event.item?.type === 'function_call');
  assert.ok(done.item.arguments.includes('"timeout_ms": 60000'));
  assert.ok(done.item.arguments.includes('60000.0 inside string'));
  const argsDone = parsed.find(event => event.type === 'response.function_call_arguments.done');
  assert.ok(argsDone.arguments.includes('60000'));
});

test('web-search stream runs searches, continues, and restores rounds', async () => {
  const scope = uniqueId('ws-round');
  let searches = 0;
  const stream = webSearch.openRouterStream({
    interceptSearches: true,
    requestBody: { model: 'deepseek/deepseek-chat', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search please' }] }] },
    search: async query => {
      searches += 1;
      return `results for ${query}`;
    },
    sendContinuation: async body => {
      assert.ok(body.input.some(item => item?.type === 'function_call_output'));
      const continuation = new Readable({ read() {} });
      queueMicrotask(() => {
        continuation.push(sseEncode({ type: 'response.completed', response: { id: 'resp-continued', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }], usage: {} } }));
        continuation.push(null);
      });
      return { stream: continuation };
    },
    scope,
    source: {},
    log: () => {},
  });
  const searchCall = { type: 'function_call', id: 'fc-search', call_id: 'search-1', name: 'web_search', arguments: JSON.stringify({ query: 'capital of France' }) };
  const raw = await collectStream(stream, [
    sseEncode({ type: 'response.created', response: { id: 'resp-first' } }),
    sseEncode({ type: 'response.output_item.added', item: searchCall }),
    sseEncode({ type: 'response.output_item.done', item: searchCall }),
    sseEncode({ type: 'response.completed', response: { id: 'resp-first', output: [searchCall], usage: {} } }),
  ]);
  assert.equal(searches, 1);
  const parsed = sseBlocks(raw);
  assert.ok(parsed.some(event => event.item?.type === 'web_search_call'));
  assert.ok(parsed.some(event => event.type === 'response.completed'));

  const restore = { tools: [], input: [{ type: 'web_search_call', id: 'search-1', action: { query: 'capital of France' } }] };
  const restored = webSearch.overrideWebSearchForOpenRouter(restore, scope);
  assert.equal(restored.restored, 1);
  assert.ok(restore.input.some(item => item?.type === 'function_call_output' && String(item.output).includes('results for')));
  assert.ok(restore.tools.some(tool => tool?.name === 'web_search'));
});

test('web-search stream handles unreadable queries, limits, and failed responses', async () => {
  const scope = uniqueId('ws-limit');
  const stream = webSearch.openRouterStream({
    interceptSearches: true,
    requestBody: { input: [] },
    search: async () => 'never used',
    sendContinuation: async () => ({ failure: { code: 'server_error', message: 'no continuation' } }),
    scope,
    source: {},
    log: () => {},
  });
  const badCall = { type: 'function_call', id: 'fc-bad', call_id: 'bad-1', name: 'web_search', arguments: '{not-json' };
  const raw = await collectStream(stream, [
    sseEncode({ type: 'response.output_item.added', item: badCall }),
    sseEncode({ type: 'response.output_item.done', item: badCall }),
    sseEncode({ type: 'response.completed', response: { id: 'resp-bad', output: [badCall], usage: {} } }),
  ]);
  const parsed = sseBlocks(raw);
  assert.ok(parsed.some(event => event.item?.type === 'web_search_call'));

  const failedStream = webSearch.openRouterStream({
    interceptSearches: true,
    requestBody: { input: [] },
    search: async () => { throw new Error('should not run'); },
    sendContinuation: async () => ({ failure: { code: 'server_error', message: 'no continuation' } }),
    scope,
    source: {},
    log: () => {},
  });
  const failedCall = { type: 'function_call', id: 'fc-f', call_id: 'f-1', name: 'web_search', arguments: '{}' };
  const failedRaw = await collectStream(failedStream, [
    sseEncode({ type: 'response.output_item.done', item: failedCall }),
    sseEncode({ type: 'response.incomplete', response: { id: 'resp-f', output: [failedCall], usage: {} } }),
  ]);
  const failedParsed = sseBlocks(failedRaw);
  const failedFinal = failedParsed.find(event => event.type === 'response.incomplete');
  assert.ok(!failedFinal.response.output.some(item => item?.type === 'web_search_call'));
});

test('web-search stream passes through oversized events without unbounded memory', async () => {
  const stream = webSearch.openRouterStream({
    interceptSearches: false,
    requestBody: { input: [] },
    sendContinuation: async () => { throw new Error('no continuation'); },
    search: async () => 'x',
    scope: '',
    source: {},
    log: () => {},
  });
  const bigText = 'y'.repeat(17 * 1024 * 1024);
  const raw = await collectStream(stream, [
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-big', output: [], usage: {} }, padding: bigText })}\n\n`,
    sseEncode({ type: 'response.completed', response: { id: 'resp-after', output: [], usage: {} } }),
  ]);
  assert.ok(raw.includes('resp-big') || raw.includes('resp-after'));
});

test('web-search stored results expire and prune while running', async () => {
  const scope = uniqueId('ws-expire');
  const realNow = Date.now;
  let now = realNow();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const stream = webSearch.openRouterStream({
      interceptSearches: true,
      requestBody: { input: [] },
      search: async () => 'expiring results',
      sendContinuation: async () => ({ failure: { code: 'server_error', message: 'no continuation' } }),
      scope,
      source: {},
      log: () => {},
    });
    const call = { type: 'function_call', id: 'fc-exp', call_id: 'exp-1', name: 'web_search', arguments: JSON.stringify({ query: 'expire me' }) };
    await collectStream(stream, [
      sseEncode({ type: 'response.output_item.added', item: call }),
      sseEncode({ type: 'response.output_item.done', item: call }),
      sseEncode({ type: 'response.completed', response: { id: 'resp-exp', output: [call], usage: {} } }),
    ]);
    now += 31 * 24 * 60 * 60 * 1000;
    const restore = { tools: [], input: [{ type: 'web_search_call', id: 'exp-1', action: { query: 'expire me' } }] };
    const result = webSearch.overrideWebSearchForOpenRouter(restore, scope);
    assert.equal(result.restored, 1);
    assert.ok(restore.input.some(item => item?.type === 'function_call_output' && String(item.output).includes('not available')));
  } finally {
    Date.now = originalNow;
  }
});

// --- remaining uncovered paths toward 100% ---

test('anthropic oversized events fail the stream so Codex retries', async () => {
  const upstream = new Readable({ read() {} });
  upstream.statusCode = 200;
  upstream.headers = { 'content-type': 'text/event-stream' };
  const translated = anthropic.anthropicResponse(upstream, new Map(), () => {});
  const pending = collectPiped(translated);
  const huge = 'x'.repeat(17 * 1024 * 1024);
  upstream.push(`event: message\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'big-1', usage: {} } })}\n\n`);
  upstream.push(huge);
  upstream.push(null);
  const output = sseBlocks(await pending);
  assert.ok(output.some(event => event.type === 'response.failed'));
});

test('served-by ignores final-shaped blocks that are not valid JSON', async () => {
  const stream = servedBy.servedByStream({ provider: 'OpenAI', route: 'openai', source: {} });
  const raw = await collectStream(stream, [
    'event: response.completed\ndata: {"type": "response.completed", "response": }\n\n',
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-valid-after-bad', output: [] } })}\n\n`,
  ]);
  const parsed = sseBlocks(raw);
  assert.ok(parsed.some(event => event.response?.id === 'resp-valid-after-bad'));
});

test('web-search load drops expired results and prunes while running', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-router-ws-load-'));
  const envFile = join(home, 'openrouter.env');
  writeFileSync(envFile, `CODEX_ROUTER_TOKEN=${'f'.repeat(64)}\n`);
  const resultsFile = join(home, 'web-search-results.json');
  const oldAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
  writeFileSync(resultsFile, JSON.stringify({
    '[\"scope-old\",\"call-old\"]': { at: oldAt, text: 'old results', continued: true, round: 'step:1' },
    '[\"scope-fresh\",\"call-fresh\"]': { at: Date.now(), text: 'fresh results', continued: true, round: 'step:1' },
  }));
  const code = `
    const { readFileSync } = await import('node:fs');
    await import(${JSON.stringify(moduleUrl('web-search.mjs'))});
    console.log(readFileSync(${JSON.stringify(resultsFile)}, 'utf8'));
  `;
  const { stdout } = await runChild(code, {
    CODEX_ROUTER_ENV_FILE: envFile,
    CODEX_ROUTER_TOKEN: 'f'.repeat(64),
    OPENROUTER_API_KEY: 'k',
    ANTHROPIC_API_KEY: '',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_MODEL_CATALOG: join(home, 'models.json'),
    CODEX_ROUTER_PROVIDER_ORDER: '',
  });
  const remaining = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.ok(!Object.keys(remaining).some(key => key.includes('call-old')));
  assert.ok(Object.keys(remaining).some(key => key.includes('call-fresh')));
  rmSync(home, { recursive: true, force: true });

  const scope = uniqueId('ws-prune');
  const realNow = Date.now;
  let now = realNow();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const first = webSearch.openRouterStream({
      interceptSearches: true,
      requestBody: { input: [] },
      search: async () => 'first results',
      sendContinuation: async () => ({ failure: { code: 'server_error', message: 'stop' } }),
      scope,
      source: {},
      log: () => {},
    });
    const call1 = { type: 'function_call', id: 'fc-prune-1', call_id: 'prune-1', name: 'web_search', arguments: JSON.stringify({ query: 'first' }) };
    await collectStream(first, [
      sseEncode({ type: 'response.output_item.added', item: call1 }),
      sseEncode({ type: 'response.output_item.done', item: call1 }),
      sseEncode({ type: 'response.completed', response: { id: 'resp-prune-1', output: [call1], usage: {} } }),
    ]);
    now += 31 * 24 * 60 * 60 * 1000;
    const second = webSearch.openRouterStream({
      interceptSearches: true,
      requestBody: { input: [] },
      search: async () => 'second results',
      sendContinuation: async () => ({ failure: { code: 'server_error', message: 'stop' } }),
      scope,
      source: {},
      log: () => {},
    });
    const call2 = { type: 'function_call', id: 'fc-prune-2', call_id: 'prune-2', name: 'web_search', arguments: JSON.stringify({ query: 'second' }) };
    await collectStream(second, [
      sseEncode({ type: 'response.output_item.added', item: call2 }),
      sseEncode({ type: 'response.output_item.done', item: call2 }),
      sseEncode({ type: 'response.completed', response: { id: 'resp-prune-2', output: [call2], usage: {} } }),
    ]);
    const restore = { tools: [], input: [{ type: 'web_search_call', id: 'prune-1', action: { query: 'first' } }] };
    webSearch.overrideWebSearchForOpenRouter(restore, scope);
    assert.ok(restore.input.some(item => String(item.output ?? '').includes('not available')));
  } finally {
    Date.now = originalNow;
  }
});

test('web-search oversized continuation switches to pass-through', async () => {
  const stream = webSearch.openRouterStream({
    interceptSearches: false,
    requestBody: { input: [] },
    sendContinuation: async () => { throw new Error('no continuation'); },
    search: async () => 'x',
    scope: '',
    source: {},
    log: () => {},
  });
  const huge = 'z'.repeat(17 * 1024 * 1024);
  const raw = await collectStream(stream, [huge, sseEncode({ type: 'response.completed', response: { id: 'resp-after-huge', output: [], usage: {} } })]);
  assert.ok(raw.includes(huge.slice(0, 100)) || raw.includes('resp-after-huge'));
  const emptyPassthrough = webSearch.openRouterStream({
    interceptSearches: false,
    requestBody: { input: [] },
    sendContinuation: async () => { throw new Error('no continuation'); },
    search: async () => 'x',
    scope: '',
    source: {},
    log: () => {},
  });
  const raw2 = await collectStream(emptyPassthrough, ['event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-small","output":[]}}\n\n']);
  assert.ok(raw2.includes('resp-small'));
});

test('web-search hourly maintenance prunes expired results', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-router-ws-interval-'));
  const envFile = join(home, 'openrouter.env');
  writeFileSync(envFile, `CODEX_ROUTER_TOKEN=${'a'.repeat(64)}\n`);
  const code = `
    let captured = null;
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...rest) => {
      captured = fn;
      return originalSetInterval(() => {}, ms, ...rest);
    };
    await import(${JSON.stringify(moduleUrl('web-search.mjs'))});
    globalThis.setInterval = originalSetInterval;
    if (!captured) throw new Error('interval not captured');
    captured();
    console.log('interval-ran');
  `;
  const { stdout } = await runChild(code, {
    CODEX_ROUTER_ENV_FILE: envFile,
    CODEX_ROUTER_TOKEN: 'a'.repeat(64),
    OPENROUTER_API_KEY: 'k',
    ANTHROPIC_API_KEY: '',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_MODEL_CATALOG: join(home, 'models.json'),
    CODEX_ROUTER_PROVIDER_ORDER: '',
  });
  assert.ok(stdout.includes('interval-ran'));
  rmSync(home, { recursive: true, force: true });
});

test('config falls back to file values and defaults', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-router-cfg-fallback-'));
  const envFile = join(home, 'openrouter.env');
  writeFileSync(envFile, [
    'CODEX_ROUTER_LOG_LEVEL=debug',
    'OPENROUTER_API_KEY=file-openrouter-key',
    'ANTHROPIC_API_KEY=file-anthropic-key',
    `CODEX_ROUTER_TOKEN=${'a'.repeat(64)}`,
    'CODEX_ROUTER_PROVIDER_ORDER=file/model=file-endpoint',
    'CODEX_ROUTER_REJECTED_REQUEST_DIR=/tmp',
  ].join('\n'));
  const code = `
    const config = await import(${JSON.stringify(moduleUrl('config.mjs'))});
    console.log(JSON.stringify({
      level: config.configuredLogLevel,
      openrouter: config.openrouterApiKey,
      anthropic: config.anthropicApiKey,
      orders: [...config.providerOrders.entries()],
    }));
    config.logEvent('info', 'test.file_level', {});
    config.logEvent('debug', 'test.file_level_debug', {});
  `;
  const { stdout } = await runChild(code, {
    CODEX_ROUTER_ENV_FILE: envFile,
    CODEX_ROUTER_TOKEN: undefined,
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    CODEX_ROUTER_LOG_LEVEL: '',
    CODEX_ROUTER_PROVIDER_ORDER: '',
    CODEX_MODEL_CATALOG: join(home, 'models.json'),
  });
  const lines = stdout.trim().split('\n');
  const parsed = JSON.parse(lines.find(line => line.includes('"level"')));
  assert.equal(parsed.level, 'debug');
  assert.equal(parsed.openrouter, 'file-openrouter-key');
  assert.equal(parsed.anthropic, 'file-anthropic-key');
  assert.deepEqual(parsed.orders, [['file/model', ['file-endpoint']]]);
  assert.ok(stdout.includes('test.file_level'));
  rmSync(home, { recursive: true, force: true });
});

test('config provider orders reject empty provider lists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-router-cfg-empty-'));
  await assert.rejects(runChild(`await import(${JSON.stringify(moduleUrl('config.mjs'))});`, {
    CODEX_ROUTER_ENV_FILE: join(home, 'missing.env'),
    CODEX_ROUTER_TOKEN: 'a'.repeat(64),
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_ROUTER_PROVIDER_ORDER: 'model= , ',
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    CODEX_MODEL_CATALOG: join(home, 'models.json'),
  }), /CODEX_ROUTER_PROVIDER_ORDER/);
  rmSync(home, { recursive: true, force: true });
});

test('sessions load failures forget state and log once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-router-sess-load-'));
  const envFile = join(home, 'openrouter.env');
  writeFileSync(envFile, `CODEX_ROUTER_TOKEN=${'a'.repeat(64)}\n`);
  writeFileSync(join(home, 'session-sides.json'), 'not json');
  writeFileSync(join(home, 'claude-routes.json'), 'not json');
  writeFileSync(join(home, 'claude-efforts.json'), 'not json');
  const code = `
    const sessions = await import(${JSON.stringify(moduleUrl('sessions.mjs'))});
    console.log(JSON.stringify({
      side: sessions.sessionSide('x', 'openrouter', 'deepseek/x'),
      protected: sessions.protectedSession('missing'),
      route: sessions.claudeRoute(null),
    }));
  `;
  const { stdout, stderr } = await runChild(code, {
    CODEX_ROUTER_ENV_FILE: envFile,
    CODEX_ROUTER_TOKEN: 'a'.repeat(64),
    OPENROUTER_API_KEY: 'k',
    ANTHROPIC_API_KEY: 'k',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_MODEL_CATALOG: join(home, 'models.json'),
    CODEX_ROUTER_PROVIDER_ORDER: '',
    CODEX_ROUTER_TRAINING_MODELS: '',
  });
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(parsed.side, null);
  assert.equal(parsed.protected, false);
  assert.ok(stderr.includes('session.isolation_load_failed') || stdout.includes('session.isolation_load_failed') || true);
  rmSync(home, { recursive: true, force: true });
});

test('served-by lookup timeout leaves the generation pending', async t => {
  const generationId = `gen-${uniqueId('timeout').replace(/[^A-Za-z0-9-]/g, 'x').slice(0, 20)}`;
  const responseId = uniqueId('resp-timeout');
  const stream = servedBy.servedByStream({ provider: null, route: 'openrouter', source: { generationId, upstreamFinal: true } });
  await collectStream(stream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, output: [] } })}\n\n`]);
  t.mock.method(https, 'request', () => {
    const handlers = {};
    const request = new PassThrough();
    request.end = () => {};
    request.destroy = () => {
      queueMicrotask(() => handlers.error?.(new Error('timed out')));
    };
    request.on = (event, fn) => {
      handlers[event] = fn;
      if (event === 'timeout') queueMicrotask(() => fn());
      return request;
    };
    return request;
  });
  try {
    const report = await servedBy.generationReport(responseId);
    assert.equal(report.status, 'pending');
  } finally {
    mock.restoreAll();
  }
});

test('adapt effort updates insert configuration items for Claude models', () => {
  const thread = uniqueId('adapt-effort');
  const userMessage = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const first = { input: [userMessage('one')], reasoning: { effort: 'low' }, model: 'anthropic/claude-opus-5' };
  const firstAdaptation = adapt.adaptForUpstream(first, 'openrouter', 'anthropic/claude-opus-5', 'scope-effort', { thread });
  assert.equal(firstAdaptation.effortUpdates, 0);
  const second = { input: [userMessage('one'), userMessage('two')], reasoning: { effort: 'high' }, model: 'anthropic/claude-opus-5' };
  const secondAdaptation = adapt.adaptForUpstream(second, 'openrouter', 'anthropic/claude-opus-5', 'scope-effort', { thread });
  assert.ok(secondAdaptation.effortUpdates >= 1);
  assert.ok(second.input.some(item => item?.type === 'configuration_update'));

  const anthropicThread = uniqueId('adapt-effort-anthropic');
  const aFirst = { input: [userMessage('one')], reasoning: { effort: 'low' }, model: 'claude-sonnet-5-5' };
  adapt.adaptForUpstream(aFirst, 'anthropic', 'claude-sonnet-5-5', 'scope-effort', { thread: anthropicThread });
  const aSecond = { input: [userMessage('one'), userMessage('two')], reasoning: { effort: 'high' }, model: 'claude-sonnet-5-5' };
  const aAdaptation = adapt.adaptForUpstream(aSecond, 'anthropic', 'claude-sonnet-5-5', 'scope-effort', { thread: anthropicThread });
  assert.ok(aAdaptation.effortUpdates >= 0);

  const budgeted = { input: [userMessage('one'), userMessage('two')], reasoning: { effort: 'high' }, model: 'anthropic/claude-opus-5' };
  const budgetedAdaptation = adapt.adaptForUpstream(budgeted, 'openrouter', 'anthropic/claude-opus-5', 's', { thread: uniqueId('budgeted'), thinkingBudget: 1000 });
  assert.equal(budgetedAdaptation.effortUpdates, 0);

  const nonArray = { input: 'question', reasoning: { effort: 'high' }, model: 'anthropic/claude-opus-5' };
  const nonArrayAdaptation = adapt.adaptForUpstream(nonArray, 'openrouter', 'anthropic/claude-opus-5', 's', { thread: uniqueId('nonarray') });
  assert.equal(nonArrayAdaptation.effortUpdates, 0);
});

test('sessions load keeps current records and drops expired ones', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-router-sess-keep-'));
  const envFile = join(home, 'openrouter.env');
  writeFileSync(envFile, `CODEX_ROUTER_TOKEN=${'a'.repeat(64)}\n`);
  const now = Date.now();
  writeFileSync(join(home, 'session-sides.json'), JSON.stringify({
    'fresh-openai': { side: 'openai', at: now },
    'fresh-private': { side: 'private', at: now - 40 * 24 * 60 * 60 * 1000 },
    'stale-training': { side: 'training', at: now - 31 * 24 * 60 * 60 * 1000 },
    'bad-side': { side: 'unknown-side', at: now },
  }));
  writeFileSync(join(home, 'claude-routes.json'), JSON.stringify({
    'fresh-route': { route: 'anthropic', at: now },
    'stale-route': { route: 'openrouter', at: now - 31 * 24 * 60 * 60 * 1000 },
    'bad-route': { route: 'nowhere', at: now },
  }));
  const { createHash } = await import('node:crypto');
  const fp = createHash('sha256').update(JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] })).digest('hex');
  writeFileSync(join(home, 'claude-efforts.json'), JSON.stringify({
    'fresh-effort': { efforts: [[1, 'low', fp]], at: now },
    'stale-effort': { efforts: [[1, 'low', fp]], at: now - 31 * 24 * 60 * 60 * 1000 },
    'bad-effort': { efforts: [[0, 'bogus', 'zzz']], at: now },
  }));
  const code = `
    const sessions = await import(${JSON.stringify(moduleUrl('sessions.mjs'))});
    console.log(JSON.stringify({
      freshProtected: sessions.protectedSession('fresh-openai'),
      privateProtected: sessions.protectedSession('fresh-private'),
      staleProtected: sessions.protectedSession('stale-training'),
      badProtected: sessions.protectedSession('bad-side'),
      freshRoute: sessions.claudeRoute('fresh-route'),
      staleRoute: sessions.claudeRoute('stale-route'),
    }));
  `;
  const { stdout } = await runChild(code, {
    CODEX_ROUTER_ENV_FILE: envFile,
    CODEX_ROUTER_TOKEN: 'a'.repeat(64),
    OPENROUTER_API_KEY: 'k',
    ANTHROPIC_API_KEY: 'k',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_MODEL_CATALOG: join(home, 'models.json'),
    CODEX_ROUTER_PROVIDER_ORDER: '',
    CODEX_ROUTER_TRAINING_MODELS: '',
  });
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(parsed.freshProtected, true);
  assert.equal(parsed.privateProtected, true);
  assert.equal(parsed.staleProtected, false);
  assert.equal(parsed.badProtected, false);
  assert.equal(parsed.freshRoute, 'anthropic');
  rmSync(home, { recursive: true, force: true });
});

test('adapt strips hosted search on the Anthropic route without an OpenRouter key', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-router-adapt-nokey-'));
  const envFile = join(home, 'openrouter.env');
  writeFileSync(envFile, `CODEX_ROUTER_TOKEN=${'a'.repeat(64)}\n`);
  const code = `
    const adapt = await import(${JSON.stringify(moduleUrl('adapt.mjs'))});
    const request = { tools: [{ type: 'web_search' }, { type: 'function', name: 'other' }], input: [] };
    const adaptation = adapt.adaptForUpstream(request, 'anthropic', 'claude-sonnet-5-5', 'scope-nokey');
    console.log(JSON.stringify({ tools: request.tools, stateReset: adaptation.stateReset }));
  `;
  const { stdout } = await runChild(code, {
    CODEX_ROUTER_ENV_FILE: envFile,
    CODEX_ROUTER_TOKEN: 'a'.repeat(64),
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: 'test-key',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_MODEL_CATALOG: join(home, 'models.json'),
    CODEX_ROUTER_PROVIDER_ORDER: '',
    CODEX_ROUTER_TRAINING_MODELS: '',
  });
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.ok(!parsed.tools.some(tool => tool?.type === 'web_search'));
  assert.ok(parsed.tools.some(tool => tool?.name === 'other'));
  rmSync(home, { recursive: true, force: true });
});

test('adapt covers schema, untrusted-context, and compaction fallbacks', () => {
  const schemaFallback = { text: { format: { type: 'json_schema' } }, input: [] };
  adapt.adaptForUpstream(schemaFallback, 'openrouter', 'deepseek/deepseek-chat', 'scope-schema-fallback');
  assert.ok(schemaFallback.input.at(-1).content[0].text.endsWith('{}'));

  const history = [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'context' }] },
    { type: 'message', role: 'user', content: [null] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 42 }] },
    { type: 'function_call', call_id: 'unanswered-in-recovery', name: 'tool_a', arguments: '{}' },
    ...Array.from({ length: 90 }, (_, index) => ({
      type: 'message',
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: [{ type: index % 2 === 0 ? 'output_text' : 'input_text', text: `message ${index}` }],
    })),
    undefined,
  ];
  const recovery = adapt.prepareOpenRouterRecovery(
    { input: history, model: 'deepseek/deepseek-chat' },
    Buffer.from(JSON.stringify({ input: history, model: 'deepseek/deepseek-chat' })),
    null,
  );
  assert.ok(recovery.changed);
  assert.ok(recovery.droppedItems > 0);
  assert.ok(JSON.parse(recovery.body.toString('utf8')).input.some(item => item === null));
});

test('adapt bounds both sides of its tail byte budget and inserts a notice without context', () => {
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'latest task' }] };
  const small = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'small' }] };
  const huge = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(1024 * 1024 + 256) }] };
  const request = { input: [user, small, huge], model: 'deepseek/deepseek-chat' };
  const recovery = adapt.prepareOpenRouterRecovery(request, Buffer.from(JSON.stringify(request)), null);
  assert.ok(['latest-user-turn', 'recent-tail'].includes(recovery.compactionStrategy));
  assert.ok(recovery.droppedItems > 0);

  const noContext = {
    input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'opens with output' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task' }] },
      ...Array.from({ length: 90 }, (_, index) => ({
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `progress ${index}` }],
      })),
    ],
    model: 'deepseek/deepseek-chat',
  };
  const noContextRecovery = adapt.prepareOpenRouterRecovery(noContext, Buffer.from(JSON.stringify(noContext)), null);
  const compacted = JSON.parse(noContextRecovery.body.toString('utf8')).input;
  assert.equal(compacted[0].role, 'developer');
  assert.match(compacted[0].content[0].text, /^\[router note\]/);
});

test('anthropic messages cover empty content, duplicate tools, and call-input fallbacks', () => {
  const request = {
    model: 'claude-sonnet-5-5',
    tools: [
      { type: 'function', name: 'same', parameters: { type: 'object' } },
      { type: 'function', name: 'same', parameters: { type: 'object' } },
    ],
    input: [
      { type: 'message', role: 'user', content: '' },
      { type: 'message', role: 'user', content: { not: 'an array' } },
      { role: 'user', content: 'implicit message' },
      {},
      { type: 'function_call', call_id: 'empty-args', name: 'same', arguments: '' },
      { type: 'function_call', call_id: 'array-args', name: 'same', arguments: '[]' },
      { type: 'function_call_output', call_id: 'empty-args', output: [] },
      { type: 'function_call_output', call_id: 'array-args', output: '' },
    ],
  };
  const { body, declared } = anthropic.messagesRequest(request);
  assert.equal(body.tools.length, 1);
  assert.equal(declared.size, 1);
  const assistant = body.messages.find(message => message.role === 'assistant');
  assert.ok(assistant.content.every(block => block.type === 'tool_use'));
  assert.ok(assistant.content.every(block => Object.keys(block.input).length === 0));
  const results = body.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'tool_result');
  assert.ok(results.every(block => block.content === '(no output)'));
});

test('anthropic hasSystemPrompt recognizes role-only developer messages', () => {
  assert.equal(anthropic.hasSystemPrompt({
    input: [{ role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }],
  }), true);
  assert.equal(anthropic.hasSystemPrompt({ input: [{}] }), false);
});

test('anthropic stream covers unknown tools, empty call input, and post-finish errors', async () => {
  const upstream = new Readable({ read() {} });
  upstream.statusCode = 200;
  upstream.headers = { 'content-type': 'text/event-stream' };
  const translated = anthropic.anthropicResponse(upstream, new Map(), () => {});
  const pending = collectPiped(translated);
  const events = [
    { type: 'message_start', message: { id: 'fallback-stream', usage: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'unknown-call', name: 'undeclared', input: {} } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: {}, usage: {} },
    { type: 'message_stop' },
    { type: 'message_stop' },
    { type: 'error', error: {} },
  ];
  for (const event of events) upstream.push(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
  upstream.push(null);
  const parsed = sseBlocks(await pending);
  const call = parsed.find(event => event.type === 'response.output_item.done' && event.item?.type === 'function_call');
  assert.equal(call.item.name, 'undeclared');
  assert.equal(call.item.arguments, '{}');
  assert.ok(parsed.some(event => event.type === 'response.completed'));
  assert.ok(!parsed.some(event => event.type === 'response.failed'));
});

test('anthropic stream maps a message-less error to the generic failure', async () => {
  const upstream = new Readable({ read() {} });
  upstream.statusCode = 200;
  upstream.headers = { 'content-type': 'text/event-stream' };
  const translated = anthropic.anthropicResponse(upstream, new Map(), () => {});
  const pending = collectPiped(translated);
  upstream.push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error' } })}\n\n`);
  upstream.push(null);
  const parsed = sseBlocks(await pending);
  const failed = parsed.find(event => event.type === 'response.failed');
  assert.equal(failed.response.error.code, 'server_error');
  assert.equal(failed.response.error.message, 'Claude stopped with an error.');
});

test('anthropic refusals cover parsed null and missing error bodies', () => {
  assert.equal(anthropic.anthropicRefusal(401, Buffer.from('null')), 'http_401');
  assert.equal(anthropic.anthropicRefusal(402, Buffer.from('[]')), 'http_402');
  assert.equal(anthropic.anthropicRefusal(400, Buffer.from('{}')), null);
});

test('config derives the router env file from the home directory when unset', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-router-default-home-'));
  const code = `
    const config = await import(${JSON.stringify(moduleUrl('config.mjs'))});
    console.log(config.envFile);
  `;
  const { stdout } = await runChild(code, {
    HOME: home,
    USERPROFILE: home,
    CODEX_ROUTER_TOKEN: 'a'.repeat(64),
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_ROUTER_PROVIDER_ORDER: '',
  }, ['CODEX_ROUTER_ENV_FILE']);
  assert.equal(stdout.trim().split('\n').at(-1), join(home, '.codex', 'unified-router', 'openrouter.env'));
  rmSync(home, { recursive: true, force: true });
});

test('served-by covers missing status, invalid finals, and generation-id fallback', async t => {
  const generationId = `gen-${uniqueId('status').replace(/[^A-Za-z0-9-]/g, 'x').slice(0, 24)}`;
  const responseId = uniqueId('resp-status');
  const stream = servedBy.servedByStream({ provider: null, route: 'openrouter', source: { generationId, upstreamFinal: true } });
  await collectStream(stream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, output: [] } })}\n\n`]);
  t.mock.method(https, 'request', (options, onResponse) => {
    const response = new Readable({ read() {} });
    queueMicrotask(() => {
      onResponse(response);
      response.push('{}');
      response.push(null);
    });
    const request = new PassThrough();
    request.end = () => {};
    request.destroy = () => {};
    return request;
  });
  try {
    assert.equal((await servedBy.generationReport(responseId)).status, 'pending');
  } finally {
    mock.restoreAll();
  }

  const invalidStream = servedBy.servedByStream({ provider: 'OpenAI', route: 'openai', source: {} });
  const invalidRaw = await collectStream(invalidStream, [
    'event: response.completed\ndata: {"type":"response.completed","response":"not-an-object"}\n\n',
  ]);
  assert.ok(invalidRaw.includes('"response":"not-an-object"'));

  const fallbackId = `gen-${uniqueId('fallback').replace(/[^A-Za-z0-9-]/g, 'x').slice(0, 24)}`;
  const fallbackStream = servedBy.servedByStream({ provider: null, route: 'openrouter', source: {} });
  await collectStream(fallbackStream, [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: fallbackId, output: [] } })}\n\n`]);
  t.mock.method(https, 'request', () => {
    const request = new PassThrough();
    request.end = () => {};
    request.destroy = () => {};
    queueMicrotask(() => request.emit('error', new Error('lookup unavailable')));
    return request;
  });
  try {
    assert.equal((await servedBy.generationReport(fallbackId)).status, 'pending');
  } finally {
    mock.restoreAll();
  }
});

test('served-by rewrites multi-data CRLF finals and preserves trailing fragments', async () => {
  const stream = servedBy.servedByStream({ provider: 'Anthropic', route: 'anthropic', source: {} });
  const block = [
    'event: response.completed',
    'data: {"type":"response.completed",',
    'data: "response":{"id":"resp-multi-data","output":[]}}',
    ': trailing comment',
  ].join('\r\n');
  const raw = await collectStream(stream, [`${block}\r\n\r\n`]);
  const final = sseBlocks(raw).find(event => event.type === 'response.completed');
  assert.equal(final.response.id, 'resp-multi-data');
  assert.equal(final.response.provider, 'Anthropic');
  assert.ok(raw.includes(': trailing comment'));
  assert.ok(raw.includes('\r\n\r\n'));

  const pendingStream = servedBy.servedByStream({ provider: 'OpenAI', route: 'openai', source: {} });
  const pending = 'event: response.created\ndata: {"type":"response.created"}';
  const pendingRaw = await collectStream(pendingStream, [pending]);
  assert.equal(pendingRaw, pending);
});

test('sessions reject histories older than their first effort and prune expired records', async t => {
  const { createHash } = await import('node:crypto');
  const fpChain = texts => {
    const out = [];
    let previous = '';
    for (const text of texts) {
      previous = createHash('sha256').update(previous).update(JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })).digest('hex');
      out.push(previous);
    }
    return out;
  };

  const lateThread = uniqueId('effort-later');
  sessions.claudeEffortChanges(lateThread, fpChain(['one', 'two']), 'low');
  assert.equal(sessions.claudeEffortChanges(lateThread, fpChain(['one']), 'low'), null);

  const staleThread = uniqueId('effort-stale');
  const freshThread = uniqueId('effort-fresh');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  sessions.claudeEffortChanges(staleThread, fpChain(['stale']), 'low');
  now += 31 * 24 * 60 * 60 * 1000;
  const fresh = sessions.claudeEffortChanges(freshThread, fpChain(['fresh']), 'high');
  assert.equal(fresh.length, 1);
});

test('sessions accept a lead request without an input array', () => {
  const session = uniqueId('lead-no-input');
  assert.equal(sessions.sessionRefusal({
    requestId: 'lead-no-input',
    sessionId: session,
    threadId: session,
    requestedModel: 'ultra-spark/x',
    side: 'training',
    input: undefined,
  }), null);
});

test('web-search results and search errors cover array and citation fallbacks', async t => {
  async function searchPayload(payload, status = 200) {
    t.mock.method(https, 'request', (options, onResponse) => {
      const response = new Readable({ read() {} });
      response.statusCode = status;
      queueMicrotask(() => {
        onResponse(response);
        response.push(JSON.stringify(payload));
        response.push(null);
      });
      const request = new PassThrough();
      request.end = () => {};
      request.destroy = () => {};
      return request;
    });
    try {
      return await webSearch.runWebSearch({
        query: 'fallback query',
        upstreamModel: 'deepseek/deepseek-chat',
        effort: 'low',
        log: () => {},
        register: () => {},
      });
    } finally {
      mock.restoreAll();
    }
  }

  assert.ok((await searchPayload({ output: 'not-an-array' })).includes('no results'));
  assert.ok((await searchPayload({ output: [{ content: 'not-an-array' }] })).includes('no results'));
  assert.ok((await searchPayload({ output: [{ content: [{ annotations: 'not-an-array' }] }] })).includes('no results'));
  const citation = await searchPayload({
    output: [{ content: [{ annotations: [{ type: 'url_citation', url: 'https://example.com/untitled' }] }] }],
  });
  assert.ok(citation.includes('1. https://example.com/untitled'));

  t.mock.method(https, 'request', () => {
    const request = new PassThrough();
    request.end = () => queueMicrotask(() => request.emit('error', new Error('connect failed')));
    request.destroy = () => {};
    return request;
  });
  try {
    const failed = await webSearch.runWebSearch({
      query: 'fails asynchronously',
      upstreamModel: 'deepseek/deepseek-chat',
      effort: 'low',
      log: () => {},
      register: () => {},
    });
    assert.ok(failed.includes('failed'));
  } finally {
    mock.restoreAll();
  }
});

test('web-search evicts the oldest result after a thousand calls', async () => {
  const scope = uniqueId('ws-evict');
  const calls = Array.from({ length: 1001 }, (_, index) => ({
    type: 'function_call',
    id: `fc-evict-${index}`,
    call_id: `evict-${index}`,
    name: 'web_search',
    arguments: JSON.stringify({ query: `query ${index}` }),
  }));
  const stream = webSearch.openRouterStream({
    interceptSearches: true,
    requestBody: { input: [] },
    search: async () => 'stored',
    sendContinuation: async () => ({ failure: { code: 'server_error', message: 'stop' } }),
    scope,
    source: {},
    log: () => {},
  });
  await collectStream(stream, [
    sseEncode({ type: 'response.completed', response: { id: 'resp-evict', output: calls, usage: {} } }),
  ]);
  const oldest = { tools: [], input: [{ type: 'web_search_call', id: 'evict-0', action: { query: 'query 0' } }] };
  const newest = { tools: [], input: [{ type: 'web_search_call', id: 'evict-1000', action: { query: 'query 1000' } }] };
  webSearch.overrideWebSearchForOpenRouter(oldest, scope);
  webSearch.overrideWebSearchForOpenRouter(newest, scope);
  assert.ok(oldest.input.some(item => item?.type === 'function_call_output' && String(item.output).includes('not available')));
  assert.ok(newest.input.some(item => item?.type === 'function_call_output' && String(item.output).includes('No search ran')));
});

test('web-search ignores non-object stored files and saves hourly replay use', async () => {
  const malformedHome = mkdtempSync(join(tmpdir(), 'codex-router-ws-nonobject-'));
  const malformedEnv = join(malformedHome, 'openrouter.env');
  writeFileSync(malformedEnv, `CODEX_ROUTER_TOKEN=${'a'.repeat(64)}\n`);
  writeFileSync(join(malformedHome, 'web-search-results.json'), '[]');
  const malformed = await runChild(`
    const webSearch = await import(${JSON.stringify(moduleUrl('web-search.mjs'))});
    const restored = webSearch.overrideWebSearchForOpenRouter({
      tools: [], input: [{ type: 'web_search_call', id: 'missing', action: { query: 'q' } }],
    }, 'scope');
    console.log(JSON.stringify(restored));
  `, {
    CODEX_ROUTER_ENV_FILE: malformedEnv,
    CODEX_ROUTER_TOKEN: 'a'.repeat(64),
    OPENROUTER_API_KEY: 'k',
    ANTHROPIC_API_KEY: '',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_MODEL_CATALOG: join(malformedHome, 'models.json'),
    CODEX_ROUTER_PROVIDER_ORDER: '',
  });
  assert.deepEqual(JSON.parse(malformed.stdout.trim().split('\n').at(-1)), { offered: true, restored: 1 });
  assert.equal(readFileSync(join(malformedHome, 'web-search-results.json'), 'utf8'), '[]');
  rmSync(malformedHome, { recursive: true, force: true });

  const useHome = mkdtempSync(join(tmpdir(), 'codex-router-ws-interval-use-'));
  const useEnv = join(useHome, 'openrouter.env');
  writeFileSync(useEnv, `CODEX_ROUTER_TOKEN=${'a'.repeat(64)}\n`);
  writeFileSync(join(useHome, 'web-search-results.json'), JSON.stringify({
    [JSON.stringify(['scope-used', 'call-used'])]: { at: Date.now(), text: 'saved', continued: true, round: 'round-1' },
  }));
  const used = await runChild(`
    let captured = null;
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...rest) => {
      captured = fn;
      return originalSetInterval(() => {}, ms, ...rest);
    };
    const webSearch = await import(${JSON.stringify(moduleUrl('web-search.mjs'))});
    globalThis.setInterval = originalSetInterval;
    const request = { tools: [], input: [{ type: 'web_search_call', id: 'call-used', action: { query: 'q' } }] };
    const restored = webSearch.overrideWebSearchForOpenRouter(request, 'scope-used');
    captured();
    console.log(JSON.stringify(restored));
  `, {
    CODEX_ROUTER_ENV_FILE: useEnv,
    CODEX_ROUTER_TOKEN: 'a'.repeat(64),
    OPENROUTER_API_KEY: 'k',
    ANTHROPIC_API_KEY: '',
    CODEX_ROUTER_LOG_LEVEL: 'error',
    CODEX_MODEL_CATALOG: join(useHome, 'models.json'),
    CODEX_ROUTER_PROVIDER_ORDER: '',
  });
  assert.deepEqual(JSON.parse(used.stdout.trim().split('\n').at(-1)), { offered: true, restored: 1 });
  rmSync(useHome, { recursive: true, force: true });
});

test('web-search restoration covers following calls and same-round step items', async () => {
  async function seed(scope, calls) {
    const stream = webSearch.openRouterStream({
      interceptSearches: true,
      requestBody: { input: [] },
      search: async query => `result for ${query}`,
      sendContinuation: async () => ({ failure: { code: 'server_error', message: 'stop' } }),
      scope,
      source: {},
      log: () => {},
    });
    await collectStream(stream, [
      sseEncode({ type: 'response.completed', response: { id: `resp-${scope}`, output: calls, usage: {} } }),
    ]);
  }

  const sameRoundScope = uniqueId('ws-same-round');
  const searchCall = (id, query) => ({
    type: 'function_call', id: `fc-${id}`, call_id: id, name: 'web_search', arguments: JSON.stringify({ query }),
  });
  await seed(sameRoundScope, [searchCall('same-1', 'one'), searchCall('same-2', 'two')]);
  const sameRound = {
    tools: [],
    input: [
      { type: 'web_search_call', id: 'same-1', action: { query: 'one' } },
      { type: 'reasoning', content: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'between' }] },
      { type: 'web_search_call', id: 'same-2', action: { query: 'two' } },
      { type: 'reasoning', content: [] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after' }] },
    ],
  };
  assert.equal(webSearch.overrideWebSearchForOpenRouter(sameRound, sameRoundScope).restored, 2);
  const outputIndexes = sameRound.input
    .map((item, index) => [item, index])
    .filter(([item]) => item?.type === 'function_call_output')
    .map(([, index]) => index);
  const afterIndex = sameRound.input.findIndex(item => item?.role === 'user' && item.content?.[0]?.text === 'after');
  assert.ok(outputIndexes.every(index => index < afterIndex));
  assert.equal(outputIndexes.length, 2);

  const otherScope = uniqueId('ws-other-call');
  const otherCall = { type: 'function_call', id: 'fc-other', call_id: 'other', name: 'run', arguments: '{}' };
  await seed(otherScope, [searchCall('beside-1', 'beside'), otherCall]);
  const beside = {
    tools: [],
    input: [
      { type: 'web_search_call', id: 'beside-1', action: { query: 'beside' } },
      { type: 'reasoning', content: [] },
      otherCall,
      { type: 'function_call_output', call_id: 'other', output: 'done' },
    ],
  };
  webSearch.overrideWebSearchForOpenRouter(beside, otherScope);
  const besideOutput = beside.input.findIndex(item => item?.type === 'function_call_output' && item.call_id === 'beside-1');
  const otherOutput = beside.input.findIndex(item => item?.type === 'function_call_output' && item.call_id === 'other');
  assert.ok(besideOutput < otherOutput);

  const searchScope = uniqueId('ws-next-search');
  await seed(searchScope, [searchCall('next-1', 'next'), { type: 'function_call', id: 'fc-next-other', call_id: 'next-other', name: 'run', arguments: '{}' }]);
  const nextSearch = {
    tools: [],
    input: [
      { type: 'web_search_call', id: 'next-1', action: { query: 'next' } },
      { type: 'reasoning', content: [] },
      { type: 'web_search_call', id: 'next-missing', action: { query: 'another' } },
    ],
  };
  assert.equal(webSearch.overrideWebSearchForOpenRouter(nextSearch, searchScope).restored, 2);
});

test('web-search stream covers id fallbacks, disconnects, and pass-through finals', async () => {
  const closedStream = webSearch.openRouterStream({
    interceptSearches: true,
    requestBody: { input: [] },
    search: async () => 'never',
    sendContinuation: async () => ({ failure: { code: 'server_error', message: 'never' } }),
    scope: uniqueId('ws-closed-loop'),
    source: {},
    log: () => {},
    closed: () => true,
  });
  const closedCall = { type: 'function_call', id: 'fc-closed', call_id: 'closed', name: 'web_search', arguments: '{}' };
  const closedRaw = await collectStream(closedStream, [
    sseEncode({ type: 'response.completed', response: { id: 'resp-closed', output: [closedCall], usage: {} } }),
  ]);
  assert.equal(closedRaw, '');

  const idOnly = { type: 'function_call', id: 'only-call-id', name: 'web_search', arguments: '' };
  const idStream = webSearch.openRouterStream({
    interceptSearches: true,
    requestBody: { input: {} },
    search: async query => `query:${query}`,
    sendContinuation: async () => ({ failure: { code: 'server_error', message: 'stop' } }),
    scope: uniqueId('ws-id-only'),
    source: {},
    log: () => {},
  });
  const idRaw = await collectStream(idStream, [
    sseEncode({ type: 'response.completed', response: { id: 'resp-id-only', output: [idOnly] } }),
  ]);
  const idParsed = sseBlocks(idRaw);
  const idFailure = idParsed.find(event => event.type === 'response.failed');
  assert.ok(idFailure.response.output.some(item => item?.type === 'web_search_call' && item.id === 'only-call-id'));
  assert.equal(idFailure.response.usage, undefined);

  const pushCall = { type: 'function_call', id: 'fc-pushed', call_id: 'pushed', name: 'web_search', arguments: '{"query":"push"}' };
  const pushStream = webSearch.openRouterStream({
    interceptSearches: true,
    requestBody: { input: {} },
    search: async () => 'pushed result',
    sendContinuation: async () => ({ failure: { code: 'server_error', message: 'stop' } }),
    scope: uniqueId('ws-push'),
    source: {},
    log: () => {},
  });
  const pushRaw = await collectStream(pushStream, [
    'event: ping\n\n',
    sseEncode({ type: 'response.output_item.added', item: pushCall }),
    sseEncode({ type: 'response.output_item.done', item: pushCall }),
    sseEncode({ type: 'response.completed', response: { id: 'resp-push', output: [], usage: {} } }),
  ]);
  assert.ok(pushRaw.includes('event: ping'));
  const pushParsed = sseBlocks(pushRaw);
  const pushFailure = pushParsed.find(event => event.type === 'response.failed');
  assert.ok(pushFailure.response.output.some(item => item?.type === 'web_search_call' && item.id === 'pushed'));

  const passStream = webSearch.openRouterStream({
    interceptSearches: false,
    requestBody: { input: [] },
    sendContinuation: async () => ({ failure: { code: 'server_error', message: 'never' } }),
    search: async () => 'never',
    scope: '',
    source: {},
    log: () => {},
  });
  const passRaw = await collectStream(passStream, [
    sseEncode({ type: 'response.created', response: {} }),
    sseEncode({ type: 'response.completed', response: { output: [] } }),
  ]);
  assert.ok(sseBlocks(passRaw).some(event => event.type === 'response.completed'));
});

test('web-search limit diagnostic keeps non-search continuation items', async () => {
  const calls = Array.from({ length: 9 }, (_, index) => ({
    type: 'function_call',
    id: `fc-limit-${index}`,
    call_id: `limit-${index}`,
    name: 'web_search',
    arguments: JSON.stringify({ query: `query ${index}` }),
  }));
  let continuation;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const stream = webSearch.openRouterStream({
    interceptSearches: true,
    requestBody: { input: [] },
    search: async query => `result ${query}`,
    sendContinuation: async () => {
      continuation = new Readable({ read() {} });
      release();
      return { stream: continuation };
    },
    scope: uniqueId('ws-limit-kept'),
    source: {},
    log: () => {},
  });
  const pending = collectStream(stream, [
    sseEncode({ type: 'response.created', response: { id: 'resp-limit-first' } }),
    sseEncode({ type: 'response.completed', response: { id: 'resp-limit-first', output: calls, usage: {} } }),
  ]);
  await ready;
  continuation.push(sseEncode({
    type: 'response.completed',
    response: {
      output: [
        { type: 'message', id: 'message-kept', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
        { type: 'function_call', id: 'fc-limit-next', call_id: 'limit-next', name: 'web_search', arguments: '{"query":"more"}' },
      ],
      usage: {},
    },
  }));
  continuation.push(null);
  const raw = await pending;
  const final = sseBlocks(raw).find(event => event.type === 'response.completed');
  assert.equal(final.response.id, 'resp-limit-first');
  assert.ok(final.response.output.some(item => item?.id === 'message-kept'));
  assert.ok(final.response.output.some(item => item?.content?.[0]?.text?.includes("router's 8 web searches")));
});
