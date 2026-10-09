// SPDX-License-Identifier: MIT
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { vncCommandTool, actionQueueTool, controlTools, validateActionParameters } from '../../tools/index.js';
import { ResponseBudget, MAX_BATCH_RESPONSE_BYTES, MAX_BATCH_RESPONSES,
  validateResponse, responseMetadata } from './protocol.js';
import { replyBudget } from '../deadlines.mjs';

export const TOOL_TIMEOUT_MS = 30000;

function errorResult(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function formatResponse(response) {
  if (response.error) return errorResult(response.error.message);
  const { detail, image, x, y, scaledWidth, scaledHeight, elements, timing } = response.result;
  const content = [];
  if (detail) content.push({ type: 'text', text: detail });
  if (image) content.push({ type: 'image', data: image, mimeType: 'image/png' });
  if (elements) content.push({ type: 'text', text: JSON.stringify(elements) });
  if (timing) content.push({ type: 'text', text: JSON.stringify(timing) });
  if (x !== undefined && y !== undefined) content.push({ type: 'text', text: `cursor: (${x}, ${y})` });
  if (scaledWidth !== undefined && !image) {
    content.push({ type: 'text', text: `display: ${scaledWidth}×${scaledHeight}` });
  }
  if (!content.length) content.push({ type: 'text', text: 'OK' });
  // The image already has its native MCP content block. Retain only its
  // metadata in structured output instead of serializing base64 twice.
  const { image: _image, ...structuredContent } = response.result;
  return { content, structuredContent };
}

/** Executors own target serialization and cancellation. A batch is one call;
 * the ordinary deadline includes every action and time waiting for ownership.
 * Optional onResponse preserves completed progress if the transport is lost. */
export class McpSession {
  constructor(executor, { timeoutMs = TOOL_TIMEOUT_MS,
    maxBatchResponseBytes = MAX_BATCH_RESPONSE_BYTES } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TOOL_TIMEOUT_MS) {
      throw new Error('Invalid MCP tool deadline');
    }
    new ResponseBudget({ maxBytes: maxBatchResponseBytes });
    this.executor = executor;
    this.timeoutMs = timeoutMs;
    this.maxBatchResponseBytes = maxBatchResponseBytes;
    this.display = { width: null, height: null };
  }

  async execute(actions, signal) {
    if (!Array.isArray(actions) || !actions.length || actions.length > MAX_BATCH_RESPONSES) {
      throw new Error('Invalid executor action batch');
    }
    for (const action of actions) validateActionParameters(action);
    if (signal?.aborted) throw new Error('Tool request cancelled');
    const controller = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    const progress = [];
    const progressBudget = new ResponseBudget({ maxBytes: this.maxBatchResponseBytes,
      maxResponses: actions.length });
    let active = true;
    let timer;
    let onAbort;
    const interruption = new Promise((_, reject) => {
      const interrupt = (message) => {
        const error = new Error(message);
        controller.abort(error);
        error.responses = [...progress];
        reject(error);
      };
      onAbort = () => interrupt('Tool request cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => interrupt(`Tool request timed out after ${this.timeoutMs}ms`), this.timeoutMs);
    });
    try {
      const responses = await Promise.race([
        Promise.resolve().then(() => {
          const remaining = deadline - performance.now();
          if (controller.signal.aborted || remaining <= 0) {
            throw controller.signal.reason || new Error(`Tool request timed out after ${this.timeoutMs}ms`);
          }
          return this.executor.execute(actions, {
            signal: controller.signal, timeoutMs: replyBudget(remaining),
            onResponse: (response) => {
              if (!active || controller.signal.aborted || performance.now() >= deadline) return;
              try {
                progress.push(progressBudget.add(responseMetadata(validateResponse(response))));
              } catch (error) {
                controller.abort(error);
                error.responses = [...progress];
                throw error;
              }
            },
          });
        }),
        interruption,
      ]);
      if (controller.signal.aborted || performance.now() >= deadline) {
        const error = controller.signal.reason || new Error(`Tool request timed out after ${this.timeoutMs}ms`);
        controller.abort(error);
        error.responses = [...progress];
        throw error;
      }
      if (!Array.isArray(responses) || responses.length > actions.length) {
        throw new Error('Invalid executor batch response');
      }
      const validated = [];
      const budget = new ResponseBudget({ maxBytes: this.maxBatchResponseBytes,
        maxResponses: actions.length });
      for (const response of responses) {
        try { validated.push(budget.add(validateResponse(response))); }
        catch (error) { error.responses = validated; throw error; }
        const result = response.result;
        if (result?.scaledWidth !== undefined) {
          this.display = { width: result.scaledWidth, height: result.scaledHeight };
        }
        if (response.error) break;
      }
      if (!validated.some((response) => response.error) && validated.length !== actions.length) {
        const error = new Error('Executor returned incomplete batch results');
        error.responses = validated;
        throw error;
      }
      return validated;
    } catch (error) {
      controller.abort(error);
      // Executors may attach partial results even without onResponse. Admit
      // those with the same limits before retaining or formatting them.
      const partial = [];
      const budget = new ResponseBudget({ maxBytes: this.maxBatchResponseBytes,
        maxResponses: actions.length });
      const candidates = Array.isArray(error.responses) ? error.responses : progress;
      try {
        for (const response of candidates) {
          const admitted = budget.add(responseMetadata(validateResponse(response)));
          partial.push(admitted);
          if (admitted.error) break;
        }
      } catch (invalid) { error = invalid; }
      error.responses = partial;
      throw error;
    } finally {
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async release(signal) {
    if (signal?.aborted) throw new Error('Tool request cancelled');
    if (typeof this.executor.release !== 'function') return;
    const controller = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    let timer;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      const interrupt = (message) => {
        const error = new Error(message);
        controller.abort(error);
        reject(error);
      };
      onAbort = () => interrupt('Tool request cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => interrupt(`Ownership release timed out after ${this.timeoutMs}ms`), this.timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(() => {
        const remaining = deadline - performance.now();
        if (controller.signal.aborted || remaining <= 0) {
          throw controller.signal.reason || new Error(`Ownership release timed out after ${this.timeoutMs}ms`);
        }
        return this.executor.release({ signal: controller.signal, timeoutMs: replyBudget(remaining) });
      }), interrupted]);
      if (controller.signal.aborted || performance.now() >= deadline) {
        const error = controller.signal.reason || new Error(`Ownership release timed out after ${this.timeoutMs}ms`);
        controller.abort(error);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async command(input, signal) {
    try { return formatResponse((await this.execute([input], signal))[0]); }
    catch (error) { return errorResult(error.message); }
  }

  async queue(input, signal) {
    let responses;
    let failure;
    try { responses = await this.execute(input.actions, signal); }
    catch (error) { responses = error.responses || []; failure = error.message; }
    const results = [];
    let completed = 0;
    let failedIndex;
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      const action = input.actions[i].action;
      if (response.error) {
        results.push(`[${i + 1}] ${action}: ERROR — ${response.error.message}`);
        failedIndex = i + 1;
        break;
      }
      results.push(`[${i + 1}] ${action}: ${response.result?.detail || 'OK'}`);
      completed++;
    }
    if (failure) {
      failedIndex = completed + 1;
      results.push(`[${failedIndex}] ${input.actions[completed]?.action || 'batch'}: ERROR — ${failure}`);
    }
    return {
      content: [{ type: 'text', text: results.join('\n') }],
      ...(failedIndex === undefined ? {} : { isError: true }),
      structuredContent: { completed, ...(failedIndex === undefined ? {} : { failedIndex }) },
    };
  }
}

export function createMcpServer({ executor, name = 'fruitctl', version = '0.1.0',
  timeoutMs, maxBatchResponseBytes } = {}) {
  if (typeof executor?.execute !== 'function') throw new Error('MCP executor is required');
  const session = new McpSession(executor, { timeoutMs, maxBatchResponseBytes });
  const server = new McpServer({ name, version }, { capabilities: { tools: {} } });
  const command = vncCommandTool();
  server.registerTool(command.name, {
    description: command.description, inputSchema: command.inputSchema,
  }, (input, extra) => session.command(input, extra.signal));
  const queue = actionQueueTool();
  server.registerTool(queue.name, {
    description: queue.description, inputSchema: queue.inputSchema,
  }, (input, extra) => session.queue(input, extra.signal));
  for (const tool of controlTools()) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema },
      async (input, extra) => {
        try { await session.release(extra.signal); }
        catch (error) { return errorResult(error.message); }
        return tool.name === 'task_complete'
          ? { content: [{ type: 'text', text: input.summary }] }
          : { content: [{ type: 'text', text: input.reason }], isError: true };
      });
  }
  return { server, session };
}

export async function startMcp({ executor, transport = new StdioServerTransport(), ...options }) {
  const { server, session } = createMcpServer({ executor, ...options });
  let closing;
  const close = () => closing ||= (async () => {
    await executor.close?.();
    await server.close();
  })();
  server.server.onclose = () => { void close().catch(() => {}); };
  await server.connect(transport);
  return { server, session, close };
}
