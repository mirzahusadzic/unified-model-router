// What the router remembers per Codex session: its provider-isolation side,
// its Claude route, a Claude thread's effort changes, and an Ultra Spark lead's
// tool call IDs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { anthropicApiKey, envFile, fileEnvironment, logEvent, openrouterApiKey, persistJson } from './config.mjs';

// OpenAI models and models that train on their inputs never share a
// Codex session. Spawned agents reuse their parent's session ID, so the rule
// covers whole agent trees: OpenAI output never reaches a training tier, and
// training-tier output never reaches OpenAI. Claude models are kept apart from
// the training tier the same way, since Anthropic's terms bar using Claude's
// output to train competing models; Claude and OpenAI may share a session.
// Ultra Spark counts as training because its workers run on Muse Contributor;
// non-training Ultra Spark (`ultra-spark-private/`), and any request under the
// deny data policy, is a protected side of its own (`private`), so its session
// never reaches the training tier or an endpoint that collects data. The list
// can be extended, not disabled.
const trainingModels = new Set(['meta/muse-spark-1.3-contributor', ...String(
  process.env.CODEX_ROUTER_TRAINING_MODELS || fileEnvironment.CODEX_ROUTER_TRAINING_MODELS || '',
).split(',').map(model => model.trim()).filter(Boolean)]);
const sessionSidesFile = join(dirname(envFile), 'session-sides.json');
const sessionSideRetentionMs = 30 * 24 * 60 * 60 * 1000;
// Requests refresh a session's record at most daily, so active sessions never expire.
const sessionSideRefreshMs = 24 * 60 * 60 * 1000;
// A record older than the retention counts as absent, also in a router that has
// run for longer than that; the next write prunes it. A non-training Ultra Spark
// session never expires: its thread holds code that must not reach an endpoint
// that trains, however long it sits idle.
const lasting = entry => entry?.side === 'private';
const current = entry => (entry && (lasting(entry) || Date.now() - entry.at < sessionSideRetentionMs) ? entry : undefined);

function loadSessionSides() {
  try {
    const stored = JSON.parse(readFileSync(sessionSidesFile, 'utf8'));
    const cutoff = Date.now() - sessionSideRetentionMs;
    return new Map(Object.entries(stored).filter(([, entry]) => Object.hasOwn(sideNames, entry?.side)
      && (lasting(entry) || entry.at > cutoff)));
  } catch (error) {
    // A missing record is a first start. An unreadable one forgets every
    // session's side, so isolation starts over and the loss is logged.
    if (error.code !== 'ENOENT') logEvent('error', 'session.isolation_load_failed', { errorCode: error.code || null });
    return new Map();
  }
}
// Sides other than `training` are protected from it; they may share a session.
const sideNames = {
  openai: 'an OpenAI model',
  anthropic: 'a Claude model',
  private: 'the non-training tier',
  training: 'a model whose provider trains on its inputs',
};
const sessionSides = loadSessionSides();

export function sessionSide(requestedModel, provider, upstreamModel) {
  if (provider === 'openai') return 'openai';
  if (requestedModel.startsWith('ultra-spark-private/')) return 'private';
  if (requestedModel.startsWith('ultra-spark/') || trainingModels.has(upstreamModel)) return 'training';
  if (provider === 'anthropic' || upstreamModel.startsWith('anthropic/')) return 'anthropic';
  // OpenAI's models on OpenRouter count with the native ones.
  if (upstreamModel.startsWith('openai/')) return 'openai';
  return null;
}

// What the router itself declares about a model's training, for each entry of
// GET /v1/models: the weakest route a request for it can take, also without a
// session ID. Caller headers only ever make a request stricter. A route not
// classified here is `unknown`; values are added, never renamed or reused.
export const trainingDeclarations = ['declared-training', 'endpoint', 'provider-terms', 'unknown'];

export function trainingDeclaration(requestedModel, provider, upstreamModel, { openrouterFallback = Boolean(openrouterApiKey) } = {}) {
  if (typeof requestedModel !== 'string' || typeof upstreamModel !== 'string') return 'unknown';
  const side = sessionSide(requestedModel, provider, upstreamModel);
  if (side === 'training') return 'declared-training';
  // Non-training Ultra Spark's lead always carries the deny, and its workers share its session.
  if (provider === 'openai' || side === 'private') return 'provider-terms';
  // A refusal Anthropic's API gives can move Claude to OpenRouter, without the deny when there is no session.
  if (provider === 'anthropic') return openrouterFallback ? 'endpoint' : 'provider-terms';
  if (provider === 'openrouter') return 'endpoint';
  return 'unknown';
}

// A session that used an OpenAI or Claude model, or non-training Ultra
// Spark: its OpenRouter requests go only to endpoints that do not collect data
// (see adaptForUpstream).
export function protectedSession(sessionId) {
  return ['openai', 'anthropic', 'private'].includes(sessionId ? current(sessionSides.get(sessionId))?.side : undefined);
}

function recordSessionSide(sessionId, side) {
  const cutoff = Date.now() - sessionSideRetentionMs;
  for (const [id, entry] of sessionSides) if (!lasting(entry) && entry.at <= cutoff) sessionSides.delete(id);
  sessionSides.set(sessionId, { side, at: Date.now() });
  persistJson(sessionSidesFile, Object.fromEntries(sessionSides), 'session.isolation_persist_failed');
}

// A session keeps the route its first Claude request took. Prompt caches and
// Claude's signed thinking stay with the route that made them, so moving a
// thread costs a full cache write and its earlier reasoning. Records follow the
// isolation records' retention and survive restarts.
const claudeRoutesFile = join(dirname(envFile), 'claude-routes.json');
const claudeRoutes = loadClaudeRoutes();
// After a refusal no retry can fix, such as spent credits, Anthropic's API is
// tried again for new sessions an hour later.
const anthropicRetryMs = 60 * 60 * 1000;
let anthropicUnavailableUntil = 0;

export function holdAnthropicRoute() {
  anthropicUnavailableUntil = Date.now() + anthropicRetryMs;
}

function loadClaudeRoutes() {
  try {
    const stored = JSON.parse(readFileSync(claudeRoutesFile, 'utf8'));
    const cutoff = Date.now() - sessionSideRetentionMs;
    return new Map(Object.entries(stored).filter(([, entry]) => ['anthropic', 'openrouter'].includes(entry?.route)
      && entry.at > cutoff));
  } catch (error) {
    if (error.code !== 'ENOENT') logEvent('error', 'claude.routes_load_failed', { errorCode: error.code || null });
    return new Map();
  }
}

export function recordClaudeRoute(sessionId, route) {
  if (!sessionId) return;
  const recorded = current(claudeRoutes.get(sessionId));
  if (recorded?.route === route && Date.now() - recorded.at < sessionSideRefreshMs) return;
  const cutoff = Date.now() - sessionSideRetentionMs;
  for (const [id, entry] of claudeRoutes) if (entry.at <= cutoff) claudeRoutes.delete(id);
  claudeRoutes.set(sessionId, { route, at: Date.now() });
  persistJson(claudeRoutesFile, Object.fromEntries(claudeRoutes), 'claude.routes_persist_failed');
}

// The session's route while it can still be used; otherwise Anthropic's API
// when it has a key and has not refused recently, and OpenRouter after that.
// Without the fallback, Anthropic's API unless the session already moved.
export function claudeRoute(sessionId, { fallback = true } = {}) {
  const recorded = sessionId ? current(claudeRoutes.get(sessionId))?.route : undefined;
  if (recorded === 'openrouter' && openrouterApiKey) return 'openrouter';
  if (!fallback) return 'anthropic';
  if ((anthropicApiKey && Date.now() >= anthropicUnavailableUntil) || !openrouterApiKey) return 'anthropic';
  return 'openrouter';
}

// A Claude thread's effort changes, so a change can go into the conversation
// instead of the top-level effort, which would restart the prompt cache. Each
// record lists [user message count, effort] pairs: the effort the thread
// started with, then each change at the count of Codex user messages its
// request held. The history is append-only, so every later request can place
// the same changes at the same messages. Records are kept per thread, since
// spawned agents share their parent's session ID, and follow the isolation
// records' retention.
const claudeEffortsFile = join(dirname(envFile), 'claude-efforts.json');
const claudeEfforts = loadClaudeEfforts();
const maxEffortChanges = 64;

function loadClaudeEfforts() {
  try {
    const stored = JSON.parse(readFileSync(claudeEffortsFile, 'utf8'));
    const cutoff = Date.now() - sessionSideRetentionMs;
    return new Map(Object.entries(stored).filter(([, entry]) => entry?.at > cutoff && Array.isArray(entry.efforts)
      && entry.efforts.length > 0 && entry.efforts.every(pair => Array.isArray(pair) && Number.isInteger(pair[0])
        && pair[0] > 0 && typeof pair[1] === 'string')));
  } catch (error) {
    if (error.code !== 'ENOENT') logEvent('error', 'claude.efforts_load_failed', { errorCode: error.code || null });
    return new Map();
  }
}

// Records this request's effort for its thread and returns the thread's
// [user message count, effort] pairs, the first being the thread's starting
// effort. A history shorter than a recorded change, after compaction or a
// rewind, drops that change; a second effort for the same user message
// replaces the first.
export function claudeEffortChanges(thread, userMessages, effort) {
  if (!thread || !Number.isInteger(userMessages) || userMessages < 1 || typeof effort !== 'string') return null;
  const recorded = current(claudeEfforts.get(thread));
  const efforts = (recorded?.efforts ?? []).filter(([count]) => count <= userMessages);
  const last = efforts.at(-1);
  if (!last) efforts.push([userMessages, effort]);
  else if (last[1] !== effort) {
    if (last[0] === userMessages) efforts.pop();
    if (efforts.at(-1)?.[1] !== effort) efforts.push([userMessages, effort]);
  }
  while (efforts.length > maxEffortChanges) efforts.splice(1, 1);
  const unchanged = recorded && JSON.stringify(recorded.efforts) === JSON.stringify(efforts);
  if (!unchanged || Date.now() - recorded.at >= sessionSideRefreshMs) {
    const cutoff = Date.now() - sessionSideRetentionMs;
    for (const [id, entry] of claudeEfforts) if (entry.at <= cutoff) claudeEfforts.delete(id);
    claudeEfforts.set(thread, { efforts, at: Date.now() });
    persistJson(claudeEffortsFile, Object.fromEntries(claudeEfforts), 'claude.efforts_persist_failed');
  }
  return efforts;
}

// Ultra Spark workers must start with fork_context: false, but only the prompt
// asks for that. Codex gives a session's main thread a thread ID equal to the
// session ID, and each spawned agent its own thread ID. The router remembers
// the tool call IDs in Ultra Spark requests from a main thread and refuses a
// Muse or other training-tier request from a spawned agent in the same session
// that carries one of them: that request holds the lead's forked history. A
// fork before the lead's first tool call carries no known ID and is not
// detected. Records are in memory only and keep each session's most recent
// IDs; after a restart the check resumes with the lead's next request.
// Requests without a session or thread ID are not checked.
const leadCallIds = new Map();
const maxLeadSessions = 256;
const maxLeadCallIdsPerSession = 4096;
const maxCallIdLength = 256;

function callIdsIn(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(item => (item?.type === 'function_call' || item?.type === 'function_call_output')
      && typeof item.call_id === 'string' && item.call_id.length > 0 && item.call_id.length <= maxCallIdLength)
    .map(item => item.call_id);
}

function recordLeadCallIds(sessionId, input) {
  const ids = leadCallIds.get(sessionId) ?? new Set();
  leadCallIds.delete(sessionId);
  leadCallIds.set(sessionId, ids);
  for (const id of callIdsIn(input)) {
    ids.delete(id);
    ids.add(id);
  }
  for (const id of ids) {
    if (ids.size <= maxLeadCallIdsPerSession) break;
    ids.delete(id);
  }
  for (const id of leadCallIds.keys()) {
    if (leadCallIds.size <= maxLeadSessions) break;
    leadCallIds.delete(id);
  }
}

function forkedLeadCallIds(sessionId, input) {
  const ids = leadCallIds.get(sessionId);
  if (!ids) return 0;
  return new Set(callIdsIn(input).filter(id => ids.has(id))).size;
}

// The session rules, checked before anything is forwarded: OpenAI and
// Claude models never share a session with the training tier, and a spawned
// training-tier worker may not carry an Ultra Spark lead's forked history.
// Returns the refusal to send, or null after recording what the request shows.
export function sessionRefusal({ requestId, sessionId, threadId, requestedModel, side, input }) {
  const recorded = sessionId ? current(sessionSides.get(sessionId)) : undefined;
  if (side && sessionId) {
    if (recorded && (recorded.side === 'training') !== (side === 'training')) {
      logEvent('error', 'session.provider_isolation', {
        requestId, sessionId, model: requestedModel, recordedSide: recorded.side, side,
      });
      return {
        code: 'provider_isolation',
        message: side === 'training'
          ? `This session already used ${sideNames[recorded.side]}, and this model's provider trains on its inputs. Start a new thread to use it.`
          : `This session already used ${sideNames.training}. Start a new thread to use ${sideNames[side]}.`,
      };
    }
    if (!recorded) recordSessionSide(sessionId, side);
  }
  if (recorded && Date.now() - recorded.at > sessionSideRefreshMs) recordSessionSide(sessionId, recorded.side);
  if (sessionId && threadId) {
    const ultraSpark = requestedModel.startsWith('ultra-spark/');
    if (threadId === sessionId) {
      if (ultraSpark) recordLeadCallIds(sessionId, input);
    } else if (side === 'training' && !ultraSpark) {
      const forkedCallIds = forkedLeadCallIds(sessionId, input);
      if (forkedCallIds > 0) {
        logEvent('error', 'session.forked_lead_context', { requestId, sessionId, model: requestedModel, forkedCallIds });
        return {
          code: 'forked_lead_context',
          message: 'This worker request carries the Ultra Spark lead thread\'s history, and its provider trains on its inputs. Spawn workers with fork_context: false.',
        };
      }
    }
  }
  return null;
}
