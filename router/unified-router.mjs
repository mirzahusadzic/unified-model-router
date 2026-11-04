import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicRefusal } from './anthropic.mjs';
import { isObject, routerRevision as sourceRevision } from './common.mjs';
import { anthropicApiKey, envFile, host, logEvent, modelCatalogFile, openrouterApiKey, port, rejectedRequestDir, routerToken } from './config.mjs';
import { claudeRoute, holdAnthropicRoute, protectedSession, recordClaudeRoute, sessionRefusal, sessionSide } from './sessions.mjs';
import { generationReport, reportValues, servedByStream } from './served-by.mjs';
import { contextOverflowMessage, openUpstream, openrouterTarget, parseUpstreamError, readUpstreamBody, routeFor, upstreamHeaders, upstreamModelFor, upstreamTrace, usageLogging, usageTap } from './upstream.mjs';
import { openRouterStream, runWebSearch, webSearchEffort } from './web-search.mjs';
import { adaptForUpstream, prepareOpenRouterRecovery } from './adapt.mjs';

const maxBodyBytes = 64 * 1024 * 1024;
const routerRevision = sourceRevision(fileURLToPath(import.meta.url));
// Values of X-Codex-Router-Prompt-Cache, where a caller places Claude's cache
// breakpoint instead of the router; see messagesRequest.
const promptCacheModes = ['instructions', 'none'];
// Values of X-Codex-Router-Data-Policy: `deny` keeps a request, with or without
// a session, off the training tier and off endpoints that collect data.
const dataPolicies = ['deny'];
// X-Codex-Router-Endpoints: OpenRouter endpoint tags, tried in that order with
// no fallbacks, such as `deepinfra/fp8,fireworks`.
const maxEndpoints = 16;
const endpointTagPattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/i;
function parseEndpoints(value) {
  const tags = String(value).split(',').map(tag => tag.trim());
  return tags.length > 0 && tags.length <= maxEndpoints && tags.every(tag => endpointTagPattern.test(tag)) ? tags : null;
}

const openrouterRejectedDiagnostic = '[router diagnostic] OpenRouter rejected this step. The thread is intact; retry or start a new thread.';
const anthropicRejectedDiagnostic = '[router diagnostic] Anthropic rejected this step. The thread is intact; retry or start a new thread.';
const openrouterRefusedDiagnostic = status => `[router diagnostic] OpenRouter refused this request (HTTP ${status}). Check OPENROUTER_API_KEY, your OpenRouter credits, and your OpenRouter settings for this model.`;
const openrouterDataPolicyDiagnostic = '[router diagnostic] This session used a native OpenAI or Claude model or non-training Ultra Spark, or this request asked for the deny data policy, so its OpenRouter requests go only to endpoints that do not collect data, and your OpenRouter settings allow none for this model. Pin it to such an endpoint (CODEX_ROUTER_PROVIDER_ORDER and your OpenRouter guardrails), or start a new thread.';
const anthropicRefusedDiagnostic = reason => `[router diagnostic] Anthropic's API refused this request (${reason}), and no OpenRouter key is configured to fall back to. Check ANTHROPIC_API_KEY and its organization's credits and limits.`;

function isAuthenticated(headers) {
  const supplied = headers['x-codex-router-token'];
  return typeof supplied === 'string'
    && Buffer.byteLength(supplied) === Buffer.byteLength(routerToken)
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(routerToken));
}

function validRequest(body) {
  return isObject(body)
    && typeof body.model === 'string' && body.model.trim().length > 0
    && (body.input == null || typeof body.input === 'string' || Array.isArray(body.input))
    && (body.reasoning == null || (isObject(body.reasoning)
      && (body.reasoning.effort == null || typeof body.reasoning.effort === 'string')))
    // OpenRouter's `provider` settings, when sent, are an object.
    && (body.provider === undefined || isObject(body.provider))
    && (body.text == null || (isObject(body.text)
      && (body.text.format == null || (isObject(body.text.format)
        && (body.text.format.type == null || typeof body.text.format.type === 'string')))));
}

function responseHeaders(headers) {
  const result = { ...headers };
  for (const name of ['connection', 'transfer-encoding', 'content-length', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'set-cookie']) {
    delete result[name];
  }
  return result;
}

function sendJson(response, status, value) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function payloadHash(body) {
  return createHash('sha256').update(body).digest('hex');
}

// File modes do not restrict access on Windows, so captures go only into the
// router directory itself: the installer gives it a protected current-user ACL
// that new files inherit, which a subdirectory could override.
export function captureDirectoryAllowed(directory, routerDirectory, platform = process.platform) {
  if (platform !== 'win32') return true;
  return resolve(directory).toLowerCase() === resolve(routerDirectory).toLowerCase();
}

function captureRejectedRequest({
  requestId, attempt, requestBody, responseBody,
}) {
  if (!rejectedRequestDir) return null;
  if (!captureDirectoryAllowed(rejectedRequestDir, dirname(envFile))) {
    logEvent('error', 'openrouter.rejection_capture_refused', {
      requestId, attempt, reason: 'not_private_router_directory',
    });
    return null;
  }
  const prefix = `${requestId}-attempt-${attempt}`;
  try {
    mkdirSync(rejectedRequestDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(rejectedRequestDir, `${prefix}.request.json`), requestBody, { mode: 0o600 });
    writeFileSync(join(rejectedRequestDir, `${prefix}.response.json`), responseBody, { mode: 0o600 });
    return prefix;
  } catch (error) {
    logEvent('error', 'openrouter.rejection_capture_failed', {
      requestId,
      attempt,
      errorCode: error.code || null,
    });
    return null;
  }
}

function sendSyntheticResponse(response, requestId, diagnostic, finalEvents) {
  const responseId = `resp_router_${requestId.replaceAll('-', '')}`;
  const events = [
    {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        output: [],
      },
    },
    ...finalEvents(responseId),
  ];
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-codex-router-diagnostic': diagnostic,
  });
  for (const event of events) {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function sendResponsesDiagnostic(response, requestId, text = openrouterRejectedDiagnostic, diagnostic = 'openrouter-request-rejected') {
  // Omit usage so Codex keeps its last real token accounting.
  sendSyntheticResponse(response, requestId, diagnostic, responseId => [
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        id: responseId.replace(/^resp_/, 'msg_'),
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        status: 'completed',
        end_turn: true,
      },
    },
  ]);
}

function sendContextOverflow(response, requestId, diagnostic, message = contextOverflowMessage) {
  // Codex maps this code to its context-window error, which drives compaction.
  sendSyntheticResponse(response, requestId, diagnostic, responseId => [
    {
      type: 'response.failed',
      response: {
        id: responseId,
        object: 'response',
        status: 'failed',
        error: { code: 'context_length_exceeded', message },
      },
    },
  ]);
}

function modelList() {
  try {
    const catalog = JSON.parse(readFileSync(modelCatalogFile, 'utf8'));
    return {
      object: 'list',
      data: (catalog.models || []).map(model => ({ id: model.slug, object: 'model' })),
    };
  } catch {
    return { object: 'list', data: [] };
  }
}

const server = http.createServer((request, response) => {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const requestInfo = {
    requestId,
    method: request.method,
    path: request.url,
    model: null,
    sessionId: null,
  };
  // Codex 0.163 sends `session-id`; earlier versions sent `session_id`.
  const suppliedSessionId = request.headers['session-id'] ?? request.headers.session_id;
  if (typeof suppliedSessionId === 'string' && suppliedSessionId.length <= 256) requestInfo.sessionId = suppliedSessionId;
  // Codex 0.163 sends `thread-id`; earlier versions sent `conversation_id`.
  const suppliedThreadId = request.headers['thread-id'] ?? request.headers.conversation_id;
  const threadId = typeof suppliedThreadId === 'string' && suppliedThreadId.length <= 256 ? suppliedThreadId : null;
  let clientClosed = false;
  let upstreamFailed = false;
  response.once('finish', () => {
    const status = response.statusCode || null;
    logEvent(status !== null && status >= 400 ? 'error' : 'info', 'request.finished', {
      ...requestInfo,
      status,
      durationMs: Date.now() - requestStartedAt,
    });
  });
  response.once('close', () => {
    if (!response.writableFinished && !upstreamFailed) {
      clientClosed = true;
      logEvent('info', 'request.aborted', {
        ...requestInfo,
        durationMs: Date.now() - requestStartedAt,
      });
    }
  });
  request.on('error', () => response.destroy());
  const localPort = request.socket?.localPort || port;
  if (![`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(request.headers.host)
      || request.headers.origin !== undefined
      || (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'none')) {
    sendJson(response, 403, { error: { message: 'Only local CLI requests are supported' } });
    return;
  }
  if (request.method === 'GET' && ['/health', '/v1/health'].includes(request.url)) {
    sendJson(response, 200, {
      ok: true,
      openai: true,
      openrouter: Boolean(openrouterApiKey),
      anthropic: Boolean(anthropicApiKey),
      clientAuth: true,
      revision: routerRevision,
      // The verifier compares it with the service's own process, so a stray
      // copy of the same code holding the port does not pass as the service.
      pid: process.pid,
      capabilities: {
        routingPolicies: ['preserve-model-v1'],
        openrouterRejectionRecovery: 'completed-diagnostic-v1',
        providerIsolation: 'session-v3',
        revisionPrecondition: true,
        promptCacheModes,
        dataPolicies,
        reports: reportValues,
        generationLookup: true,
        endpointPins: true,
      },
    });
    return;
  }

  if (!isAuthenticated(request.headers)) {
    sendJson(response, 401, { error: { message: 'Invalid or missing router token; rerun the installer and restart Codex' } });
    return;
  }

  const expectedRevision = request.headers['x-codex-router-revision'];
  if (expectedRevision !== undefined) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      sendJson(response, 400, { error: { code: 'invalid_router_revision', message: 'Expected a lowercase SHA-256 router revision' } });
      return;
    }
    if (expectedRevision !== routerRevision) {
      sendJson(response, 409, { error: { code: 'router_revision_mismatch', message: 'The running router revision differs from the requested revision' } });
      return;
    }
  }

  if (request.method === 'GET' && ['/models', '/v1/models'].includes(request.url)) {
    sendJson(response, 200, modelList());
    return;
  }

  // The provider of a generation this router served with the report, once
  // OpenRouter has recorded it; see served-by.mjs.
  const generation = request.method === 'GET' ? /^\/v1\/generations\/([^/?#]{1,200})$/.exec(request.url ?? '') : null;
  if (generation) {
    let id;
    try {
      id = decodeURIComponent(generation[1]);
    } catch {
      sendJson(response, 400, { error: { message: 'Malformed generation ID' } });
      return;
    }
    generationReport(id).then(report => {
      if (report) sendJson(response, 200, report);
      else sendJson(response, 404, { error: { message: 'This router served no such generation with the provider report in the last day' } });
    }, () => sendJson(response, 502, { error: { message: 'The generation lookup failed' } }));
    return;
  }

  if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(request.url)) {
    sendJson(response, 404, { error: { message: `Unsupported route: ${request.method} ${request.url}` } });
    return;
  }

  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) {
    sendJson(response, 415, { error: { message: 'Content-Type must be application/json' } });
    return;
  }

  const chunks = [];
  let receivedBytes = 0;
  let rejected = false;
  request.on('data', chunk => {
    if (rejected) return;
    receivedBytes += chunk.length;
    if (receivedBytes > maxBodyBytes) {
      rejected = true;
      response.once('finish', () => request.destroy());
      // Codex would retry a 413 with the same bytes; compaction makes the thread smaller.
      sendContextOverflow(response, requestId, 'router-request-too-large',
        'The request exceeds the Unified Model Router\'s 64 MiB limit.');
      return;
    }
    chunks.push(chunk);
  });

  request.on('end', () => {
    if (rejected || response.destroyed) return;
    const startedAt = Date.now();
    const rawBody = Buffer.concat(chunks);
    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch (error) {
      sendJson(response, 400, { error: { message: `Invalid JSON request: ${error.message}` } });
      return;
    }

    if (!validRequest(parsed)) {
      sendJson(response, 400, { error: { message: 'Expected a JSON object with a model string and valid input, reasoning, and text fields' } });
      return;
    }

    const requestedModel = parsed.model;
    requestInfo.model = requestedModel;
    const routingPolicy = request.headers['x-codex-routing-policy'];
    if (routingPolicy !== undefined && routingPolicy !== 'preserve-model-v1') {
      sendJson(response, 400, { error: { message: 'Unsupported routing policy' } });
      return;
    }
    const promptCache = request.headers['x-codex-router-prompt-cache'];
    if (promptCache !== undefined && !promptCacheModes.includes(promptCache)) {
      sendJson(response, 400, { error: { message: 'Unsupported prompt cache mode' } });
      return;
    }
    const requestDataPolicy = request.headers['x-codex-router-data-policy'];
    if (requestDataPolicy !== undefined && !dataPolicies.includes(requestDataPolicy)) {
      sendJson(response, 400, { error: { message: 'Unsupported data policy' } });
      return;
    }
    const report = request.headers['x-codex-router-report'];
    if (report !== undefined && !reportValues.includes(report)) {
      sendJson(response, 400, { error: { message: 'Unsupported report' } });
      return;
    }
    const endpointsHeader = request.headers['x-codex-router-endpoints'];
    const endpoints = endpointsHeader === undefined ? null : parseEndpoints(endpointsHeader);
    if (endpointsHeader !== undefined && !endpoints) {
      sendJson(response, 400, { error: { message: 'X-Codex-Router-Endpoints must list 1 to 16 OpenRouter endpoint tags, separated by commas' } });
      return;
    }
    if (endpoints && parsed.provider?.order !== undefined) {
      sendJson(response, 400, { error: { message: 'Pin endpoints with X-Codex-Router-Endpoints or provider.order, not both' } });
      return;
    }
    // The router never substitutes another model, including for structured
    // output; preserve-model-v1 remains accepted for clients that send it.
    const model = requestedModel;
    let target = routeFor(model);
    if (target.provider === 'anthropic' && claudeRoute(requestInfo.sessionId) === 'openrouter') target = openrouterTarget;

    let upstreamModel = upstreamModelFor(model, target.provider);
    // A request under the deny data policy counts as the non-training side when
    // its model has no side of its own, so its session stays off the training tier.
    const side = sessionSide(requestedModel, target.provider, upstreamModel) ?? (requestDataPolicy === 'deny' ? 'private' : null);
    if (requestDataPolicy === 'deny' && side === 'training') {
      logEvent('error', 'data_policy.refused', { requestId, sessionId: requestInfo.sessionId, model: requestedModel });
      sendJson(response, 409, { error: { code: 'data_policy', message: 'This request asks for endpoints that do not train on inputs, and this model\'s provider trains on them. Choose a model outside the training tier.' } });
      return;
    }
    const refusal = sessionRefusal({ requestId, sessionId: requestInfo.sessionId, threadId, requestedModel,
      side, input: parsed.input });
    if (refusal) {
      sendJson(response, 409, { error: refusal });
      return;
    }
    if (side === 'anthropic') recordClaudeRoute(requestInfo.sessionId, target.provider);
    // Non-training Ultra Spark and the deny data policy stay off collecting
    // endpoints even without a session ID.
    const sessionProtected = protectedSession(requestInfo.sessionId) || side === 'private' || requestDataPolicy === 'deny';
    let {
      stateReset, providerOrder, toolHistoryRepairs, structuredOutputInstruction, promptCachingAdded, webSearch,
    } = adaptForUpstream(parsed, target.provider, upstreamModel, requestInfo.sessionId, { protectedSession: sessionProtected, promptCache, endpoints });
    let structuredOutputAdapted = Boolean(structuredOutputInstruction);
    parsed.model = upstreamModel;
    let body;
    try {
      body = Buffer.from(JSON.stringify(parsed));
    } catch (error) {
      sendJson(response, 400, { error: { message: `Unable to encode request: ${error.message}` } });
      return;
    }

    if (toolHistoryRepairs?.changed) {
      logEvent('info', 'history.repaired', {
        requestId, sessionId: requestInfo.sessionId, model: upstreamModel, ...toolHistoryRepairs,
      });
    }

    let currentUpstream;
    let upstreamErrorLogged = false;
    let recoveryAttempted = false;
    // After a refusal no retry can fix, the same request goes to OpenRouter's
    // copy of the model, and the session stays there.
    const fallBackToOpenRouter = () => {
      target = openrouterTarget;
      upstreamModel = upstreamModelFor(model, target.provider);
      recordClaudeRoute(requestInfo.sessionId, target.provider);
      parsed = JSON.parse(rawBody.toString('utf8'));
      ({
        stateReset, providerOrder, toolHistoryRepairs, structuredOutputInstruction, promptCachingAdded, webSearch,
      } = adaptForUpstream(parsed, target.provider, upstreamModel, requestInfo.sessionId, { protectedSession: sessionProtected, promptCache, endpoints }));
      structuredOutputAdapted = Boolean(structuredOutputInstruction);
      parsed.model = upstreamModel;
      body = Buffer.from(JSON.stringify(parsed));
      recoveryAttempted = false;
    };
    const anthropicLog = (level, event, fields) => logEvent(level, event, {
      requestId, sessionId: requestInfo.sessionId, model, ...fields,
    });
    const upstreamError = error => {
      if (clientClosed || response.writableFinished || upstreamErrorLogged) return;
      upstreamFailed = true;
      upstreamErrorLogged = true;
      logEvent('error', 'upstream.error', {
        requestId,
        sessionId: requestInfo.sessionId,
        provider: target.provider,
        model,
        errorCode: error.code || null,
        durationMs: Date.now() - startedAt,
      });
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else sendJson(response, 502, { error: { message: 'Unified Model Router upstream request failed' } });
    };

    // Searches and continuations the router starts for this response end with it.
    // Each one is cancelled with its settle callback, so nothing waits on it afterwards.
    const auxiliaryRequests = new Map();
    const clientGone = () => clientClosed || (response.destroyed && !response.writableFinished);
    const cancel = (auxiliary, settle) => {
      auxiliary.destroy();
      settle?.();
    };
    const track = (auxiliary, settle) => {
      // Work started after Codex disconnected stops at once.
      if (clientGone()) {
        cancel(auxiliary, settle);
        return;
      }
      auxiliaryRequests.set(auxiliary, settle);
      auxiliary.once('close', () => auxiliaryRequests.delete(auxiliary));
    };
    response.once('close', () => {
      if (!response.writableFinished && currentUpstream && !currentUpstream.destroyed) {
        currentUpstream.destroy();
      }
      if (!response.writableFinished) for (const [auxiliary, settle] of auxiliaryRequests) cancel(auxiliary, settle);
    });

    // Continues a response after the router's own searches. Resolves with
    // { stream } for the continuation's events, { contextOverflow } when
    // OpenRouter refuses it, or null when it never answers.
    // A refused continuation ends the response Codex is already reading, as the
    // first request would have: a context or size limit compacts the thread, a
    // refusal no retry fixes on Anthropic's API moves the thread to OpenRouter
    // and fails the response so Codex retries it there, rate limits and server
    // errors fail it so Codex retries, and anything else gets the provider's diagnostic.
    const continuationRefusal = (status, body, continuationBody) => {
      if (status === 413 || parseUpstreamError(body).contextOverflow) return { contextOverflow: true };
      const reason = target.provider === 'anthropic' ? anthropicRefusal(status, body) : null;
      if (reason) {
        holdAnthropicRoute();
        logEvent('error', 'anthropic.refused', {
          requestId, sessionId: requestInfo.sessionId, model, status, reason, continuation: true, fallback: Boolean(openrouterApiKey),
        });
        if (!openrouterApiKey) return { diagnostic: anthropicRefusedDiagnostic(reason) };
        recordClaudeRoute(requestInfo.sessionId, 'openrouter');
        return { failure: { code: 'server_error', message: `Anthropic's API refused the request (${reason}); the thread continues on OpenRouter.` } };
      }
      if (status === 429) return { failure: { code: 'rate_limit_exceeded', message: 'The upstream is limiting requests; try again shortly.' } };
      if (status >= 500) return { failure: { code: 'server_error', message: `The upstream answered HTTP ${status}.` } };
      if (target.provider === 'openrouter' && [401, 402, 403, 404].includes(status)) {
        const dataPolicy = status === 404 && continuationBody.provider?.data_collection === 'deny'
          && /data policy/i.test(body.toString('utf8'));
        return { diagnostic: dataPolicy ? openrouterDataPolicyDiagnostic : openrouterRefusedDiagnostic(status) };
      }
      return { diagnostic: `[router diagnostic] The web search ran, but ${target.provider === 'anthropic' ? 'Anthropic' : 'OpenRouter'} rejected the next step. The thread is intact; retry or start a new thread.` };
    };

    const continueAfterSearch = continuationBody => new Promise(resolve => {
      if (clientGone()) {
        resolve(null);
        return;
      }
      const continuationRequestBody = Buffer.from(JSON.stringify(continuationBody));
      let headers;
      try {
        headers = upstreamHeaders(request.headers, target.provider, continuationRequestBody.length);
      } catch {
        resolve(null);
        return;
      }
      const continuation = openUpstream({
        target, headers, body: continuationRequestBody, onError: () => resolve(null), log: anthropicLog, promptCache,
      }, continuationResponse => {
        const status = continuationResponse.statusCode || null;
        logEvent(status >= 200 && status < 300 ? 'info' : 'error', 'web_search.continuation', {
          requestId, sessionId: requestInfo.sessionId, model, status, bytes: continuationRequestBody.length,
          ...upstreamTrace(continuationResponse.headers),
        });
        if (status >= 200 && status < 300 && /^text\/event-stream/i.test(continuationResponse.headers?.['content-type'] || '')) {
          resolve({ stream: continuationResponse });
          return;
        }
        // The refusal is read up to a bound, then the connection ends.
        readUpstreamBody(continuationResponse).then(({ body: refusal }) => {
          resolve(continuationRefusal(status, refusal, continuationBody));
        }, () => resolve(null)).finally(() => continuation.destroy());
      });
      track(continuation, () => resolve(null));
    });

    const sendUpstream = ({
      requestBody,
      attempt,
      recovery = null,
    }) => {
      let headers;
      try {
        headers = upstreamHeaders(request.headers, target.provider, requestBody.length);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: { message: error.message } });
        return;
      }

      const requestHash = payloadHash(requestBody);
      const upstreamInputItems = Array.isArray(parsed.input) ? parsed.input.length : null;
      logEvent('info', 'request.forwarded', {
        requestId,
        sessionId: requestInfo.sessionId,
        provider: target.provider,
        model,
        upstreamModel,
        requestedModel,
        structuredOutputAdapted,
        promptCachingAdded,
        promptCache: promptCache || 'default',
        requestDataPolicy: requestDataPolicy || 'default',
        webSearchOverride: webSearch.offered || webSearch.restored > 0 ? { offered: webSearch.offered, restored: webSearch.restored } : null,
        providerOrder,
        dataCollection: parsed.provider?.data_collection ?? null,
        stateReset,
        routingPolicy: routingPolicy || 'default',
        bytes: requestBody.length,
        inputItems: recovery?.inputItems ?? upstreamInputItems,
        payloadSha256: requestHash,
        attempt,
        recoveryStrategy: recovery?.compactionStrategy || null,
        droppedItems: recovery?.droppedItems || 0,
        droppedReasoningItems: recovery?.droppedReasoningItems || 0,
        historyRepairs: attempt === 1
          ? (toolHistoryRepairs?.changed ? toolHistoryRepairs : null)
          : (recovery?.historyRepairs?.changed ? recovery.historyRepairs : null),
      });

      let upstream;
      try {
        upstream = openUpstream({ target, headers, body: requestBody, onError: upstreamError, log: anthropicLog, promptCache }, upstreamResponse => {
          if (response.destroyed) {
            upstreamResponse.destroy();
            return;
          }
          const status = upstreamResponse.statusCode || null;
          const trace = upstreamTrace(upstreamResponse.headers);
          upstreamResponse.once('error', () => {
            if (!clientClosed) upstreamFailed = true;
          });
          upstreamResponse.once('close', () => {
            if (!clientClosed && !upstreamResponse.readableEnded) upstreamFailed = true;
          });

          logEvent(status !== null && status >= 400 ? 'error' : 'info', 'upstream.response_started', {
            requestId,
            sessionId: requestInfo.sessionId,
            provider: target.provider,
            model,
            status,
            timeToHeadersMs: Date.now() - startedAt,
            attempt,
            payloadSha256: requestHash,
            ...trace,
          });

          // Refusals are read before Codex sees them: a 401 would make Codex refresh its ChatGPT sign-in,
          // and a 413 would be retried with the same bytes.
          if ((target.provider === 'openrouter' && [400, 401, 402, 403, 404, 413].includes(status))
              || (target.provider === 'anthropic' && [400, 401, 402, 403, 404, 413, 429].includes(status))) {
            void (async () => {
              const upstreamBody = await readUpstreamBody(upstreamResponse);
              logEvent('error', 'upstream.response_finished', {
                requestId,
                sessionId: requestInfo.sessionId,
                provider: target.provider,
                model,
                status,
                durationMs: Date.now() - startedAt,
                attempt,
                payloadSha256: requestHash,
                ...trace,
              });

              const refusalReason = target.provider === 'anthropic' ? anthropicRefusal(status, upstreamBody.body) : null;
              if (refusalReason) {
                holdAnthropicRoute();
                logEvent('error', 'anthropic.refused', {
                  requestId, sessionId: requestInfo.sessionId, model, status, reason: refusalReason, attempt,
                  fallback: Boolean(openrouterApiKey), ...trace,
                });
                if (clientClosed || response.destroyed) return;
                if (!openrouterApiKey) {
                  sendResponsesDiagnostic(response, requestId, anthropicRefusedDiagnostic(refusalReason), 'anthropic-request-refused');
                  return;
                }
                fallBackToOpenRouter();
                sendUpstream({ requestBody: body, attempt: attempt + 1 });
                return;
              }
              // Other rate limits pass through with their retry-after, which Codex honours.
              if (status === 429) {
                if (clientClosed || response.destroyed) return;
                response.writeHead(status, responseHeaders(upstreamResponse.headers));
                response.end(upstreamBody.body);
                return;
              }
              if (target.provider === 'openrouter' && [401, 402, 403, 404].includes(status)) {
                // OpenRouter finds no endpoint for a protected session when every allowed one collects data.
                const dataPolicy = status === 404 && parsed.provider?.data_collection === 'deny'
                  && /data policy/i.test(upstreamBody.body.toString('utf8'));
                logEvent('error', 'openrouter.refused', { requestId, sessionId: requestInfo.sessionId, model, status, dataPolicy, attempt, ...trace });
                if (clientClosed || response.destroyed) return;
                sendResponsesDiagnostic(response, requestId, dataPolicy ? openrouterDataPolicyDiagnostic : openrouterRefusedDiagnostic(status),
                  dataPolicy ? 'openrouter-data-policy' : 'openrouter-request-refused');
                return;
              }

              const capture = captureRejectedRequest({
                requestId,
                attempt,
                requestBody,
                responseBody: upstreamBody.body,
              });
              const upstreamErrorDetails = parseUpstreamError(upstreamBody.body);
              // A request too large for the upstream shrinks the same way as one over the context window.
              if (status === 413) upstreamErrorDetails.contextOverflow = true;
              logEvent('error', 'openrouter.request_rejected', {
                requestId,
                sessionId: requestInfo.sessionId,
                provider: target.provider,
                model,
                upstreamModel,
                status,
                attempt,
                payloadSha256: requestHash,
                bytes: requestBody.length,
                inputItems: recovery?.inputItems ?? upstreamInputItems,
                recoveryStrategy: recovery?.compactionStrategy || null,
                droppedItems: recovery?.droppedItems || 0,
                upstreamErrorCode: upstreamErrorDetails.errorCode,
                upstreamErrorType: upstreamErrorDetails.errorType,
                upstreamErrorSha256: payloadHash(upstreamBody.body),
                upstreamErrorBytes: upstreamBody.bytes,
                upstreamErrorTruncated: upstreamBody.truncated,
                contextOverflow: upstreamErrorDetails.contextOverflow,
                capture,
                ...trace,
              });

              if (clientClosed || response.destroyed) return;
              if (upstreamErrorDetails.contextOverflow) {
                // Let Codex compact the thread itself instead of silently
                // retrying with history the router chose to discard.
                sendContextOverflow(response, requestId, `${target.provider}-context-overflow`);
                return;
              }
              if (!recoveryAttempted) {
                const recovery = prepareOpenRouterRecovery(parsed, body, structuredOutputInstruction);
                if (recovery.changed) {
                  recoveryAttempted = true;
                  logEvent('info', 'openrouter.recovery_attempt', {
                    requestId,
                    sessionId: requestInfo.sessionId,
                    model,
                    upstreamModel,
                    attempt: 2,
                    previousPayloadSha256: requestHash,
                    payloadSha256: payloadHash(recovery.body),
                    bytes: recovery.body.length,
                    inputItems: recovery.inputItems,
                    compactionStrategy: recovery.compactionStrategy,
                    droppedItems: recovery.droppedItems,
                    droppedReasoningItems: recovery.droppedReasoningItems,
                    omissionNotice: recovery.omissionNotice,
                    historyRepairs: recovery.historyRepairs?.changed ? recovery.historyRepairs : null,
                  });
                  sendUpstream({ requestBody: recovery.body, attempt: 2, recovery });
                  return;
                }
              }

              if (clientClosed || response.destroyed) return;
              logEvent('error', 'openrouter.fallback_completion', {
                requestId,
                sessionId: requestInfo.sessionId,
                model,
                upstreamModel,
                attempt,
                payloadSha256: requestHash,
                ...trace,
              });
              if (target.provider === 'anthropic') sendResponsesDiagnostic(response, requestId, anthropicRejectedDiagnostic, 'anthropic-request-rejected');
              else sendResponsesDiagnostic(response, requestId);
            })().catch(error => upstreamError(error));
            return;
          }

          response.writeHead(status || 502, responseHeaders(upstreamResponse.headers));
          const streams = [upstreamResponse, response];
          const eventStream = status >= 200 && status < 300
            && /^text\/event-stream/i.test(upstreamResponse.headers?.['content-type'] || '');
          // What the search step learns about the final event, for the served-by report.
          const servedSource = {};
          if (eventStream && target.provider !== 'openai') {
            const effort = webSearch.offered ? webSearchEffort(requestedModel) : null;
            streams.splice(1, 0, openRouterStream({
              interceptSearches: webSearch.offered,
              requestBody: JSON.parse(requestBody.toString('utf8')),
              sendContinuation: continueAfterSearch,
              log: (level, event, fields) => logEvent(level, event, { requestId, sessionId: requestInfo.sessionId, model, ...fields }),
              closed: clientGone,
              scope: requestInfo.sessionId,
              source: servedSource,
              search: query => runWebSearch({
                // Searches run through OpenRouter, on its copy of a Claude model.
                query, upstreamModel: upstreamModelFor(model, 'openrouter'), effort, register: track,
                dataCollection: sessionProtected ? 'deny' : undefined,
                endpoints,
                log: (level, event, fields) => logEvent(level, event, { requestId, sessionId: requestInfo.sessionId, model, ...fields }),
              }),
            }));
          }
          if (usageLogging && eventStream) {
            streams.splice(streams.length - 1, 0, usageTap(({ responseStatus, usage }) => logEvent('info', 'upstream.usage', {
              requestId,
              sessionId: requestInfo.sessionId,
              provider: target.provider,
              model,
              upstreamModel,
              attempt,
              responseStatus,
              usage,
              ...trace,
            })));
          }
          // The served-by step comes last, so it marks the final event as the client reads it.
          if (report === 'provider' && eventStream) {
            streams.splice(streams.length - 1, 0, servedByStream({
              provider: { anthropic: 'Anthropic', openai: 'OpenAI' }[target.provider] ?? null,
              route: target.provider,
              // One pinned endpoint with no fallbacks is the one that served.
              endpoint: target.provider === 'openrouter' && endpoints?.length === 1 ? endpoints[0] : null,
              source: servedSource,
            }));
          }
          pipeline(...streams, error => {
            if (error) {
              upstream.destroy();
              upstreamError(error);
            }
          });
          upstreamResponse.on('end', () => {
            if (clientClosed || upstreamFailed) return;
            logEvent(status !== null && status >= 400 ? 'error' : 'info', 'upstream.response_finished', {
              requestId,
              sessionId: requestInfo.sessionId,
              provider: target.provider,
              model,
              status,
              durationMs: Date.now() - startedAt,
              attempt,
              payloadSha256: requestHash,
              ...trace,
            });
          });
        });

        currentUpstream = upstream;
      } catch (error) {
        upstream?.destroy();
        upstreamError(error);
      }
    };

    sendUpstream({ requestBody: body, attempt: 1 });
  });
});

// A taken port, or an invalid one, ends the process with one JSON event
// instead of an error's stack trace, so the log stays one object per line; the
// service manager starts the router again until the port is free.
function listenFailed(error) {
  logEvent('error', 'router.listen_failed', { host, port, errorCode: error.code ?? null });
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000).unref();
}

server.on('error', error => {
  if (error.syscall !== 'listen') throw error;
  listenFailed(error);
});

try {
  server.listen(port, host, () => {
    logEvent('info', 'router.ready', {
      host,
      port,
      openrouterConfigured: Boolean(openrouterApiKey),
      anthropicConfigured: Boolean(anthropicApiKey),
      revision: routerRevision,
    });
  });
} catch (error) {
  // An invalid port throws here instead of emitting 'error'.
  listenFailed(error);
}

function shutdown(signal) {
  logEvent('info', 'router.shutdown', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
