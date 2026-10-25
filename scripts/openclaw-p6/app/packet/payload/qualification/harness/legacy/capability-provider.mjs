// Synthetic two-step Responses fixture, derived from the retained P1b SSE owner.
import { createServer } from 'node:http';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CAPABILITY_CASES = {
  'node-vm': {
    marker: 'CAP_NODE_VM_OK',
    arguments: { title: 'Node VM capability', code: 'text("CAP_NODE_VM_OK")' },
    schemaProperty: 'code',
  },
  pty: {
    marker: 'CAP_PTY_OK',
    arguments: { command: "test -t 0 && test -t 1 && /usr/bin/printf 'CAP_PTY_OK\\n'", pty: true, yieldMs: 1000, timeoutSeconds: 10 },
    schemaProperty: 'command',
  },
};

function promptPresent(input, marker) {
  if (typeof input === 'string') return input.includes(marker);
  return Array.isArray(input) && input.some(item => item?.role === 'user' &&
    (typeof item.content === 'string' ? item.content.includes(marker) :
      Array.isArray(item.content) && item.content.some(part =>
        typeof part?.text === 'string' && part.text.includes(marker))));
}

function inspectOutput(value) {
  if (typeof value === 'string') {
    try { return inspectOutput(JSON.parse(value)); }
    catch { return { texts: [value], failed: false }; }
  }
  if (Array.isArray(value)) {
    const parts = value.map(inspectOutput);
    return { texts: parts.flatMap(part => part.texts), failed: parts.some(part => part.failed) };
  }
  if (!value || typeof value !== 'object') return { texts: [], failed: false };
  const failed = value.isError === true || value.error != null ||
    ['error', 'failed', 'denied', 'cancelled', 'timed_out'].includes(value.status) ||
    (typeof value.exitCode === 'number' && value.exitCode !== 0);
  const parts = ['content', 'details'].filter(key => key in value).map(key => inspectOutput(value[key]));
  // Code Mode returns text records under output inside its serialized tool result.
  if (Array.isArray(value.output)) parts.push(inspectOutput(value.output.filter(item => item?.type === 'text')));
  if (typeof value.text === 'string') parts.push(inspectOutput(value.text));
  return { texts: parts.flatMap(part => part.texts), failed: failed || parts.some(part => part.failed) };
}

function sendEvents(res, output, ordinal) {
  const events = [{ type: 'response.output_item.added', output_index: 0,
    item: { ...output, status: 'in_progress', ...(output.type === 'function_call' ? { arguments: '' } : { content: [] }) } }];
  if (output.type === 'function_call') {
    events.push(
      { type: 'response.function_call_arguments.delta', item_id: output.id, output_index: 0, delta: output.arguments },
      { type: 'response.function_call_arguments.done', item_id: output.id, output_index: 0, arguments: output.arguments },
    );
  } else {
    const text = output.content[0].text;
    events.push(
      { type: 'response.output_text.delta', item_id: output.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_text.done', item_id: output.id, output_index: 0, content_index: 0, text },
    );
  }
  events.push(
    { type: 'response.output_item.done', output_index: 0, item: output },
    { type: 'response.completed', response: { id: `resp_cap_${ordinal}`, status: 'completed', output: [output],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  );
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' });
  res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
}

export function createCapabilityServer({ mode, receipt }) {
  const scenario = CAPABILITY_CASES[mode];
  if (!scenario || !isAbsolute(receipt)) throw new Error('Use a supported mode and fresh absolute receipt path');
  closeSync(openSync(receipt, 'wx', 0o600));
  const callId = `call_cap_${mode.replace('-', '_')}`;
  let phase = 'initial';
  let ordinal = 0;
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404); res.end('unexpected fixture endpoint'); return;
    }
    ordinal++;
    const before = phase;
    const record = (status, outcome, extra = {}) => appendFileSync(receipt,
      JSON.stringify({ ordinal, mode, phase: before, status, outcome, ...extra }) + '\n');
    const reject = reason => {
      phase = 'failed'; record(400, 'rejected', { reason });
      res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' }); res.end(reason);
    };
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { reject('invalid JSON'); return; }
    if (phase === 'completed' || phase === 'failed') { reject('fixture already terminal'); return; }
    if (!body || body.stream !== true) { reject('streamed Responses request required'); return; }
    const outputs = Array.isArray(body.input) ? body.input.filter(item => item?.type === 'function_call_output') : [];
    if (phase === 'initial') {
      const offered = Array.isArray(body.tools) && body.tools.find(tool => tool?.type === 'function' && tool.name === 'exec');
      if (!promptPresent(body.input, scenario.marker) || outputs.length !== 0 ||
          !offered?.parameters?.properties?.[scenario.schemaProperty]) {
        reject('matching prompt and exec schema required before tool call'); return;
      }
      phase = 'tool'; record(200, 'tool-issued', { toolName: 'exec', toolCallId: callId });
      sendEvents(res, { type: 'function_call', id: `fc_cap_${mode}`, call_id: callId, name: 'exec',
        arguments: JSON.stringify(scenario.arguments), status: 'completed' }, ordinal);
      return;
    }
    if (outputs.length !== 1 || outputs[0].call_id !== callId) {
      reject('exactly one matching tool output required'); return;
    }
    const output = inspectOutput(outputs[0].output);
    const markerPresent = output.texts.some(text => text.split(/\r?\n/).some(line => line.trim() === scenario.marker));
    if (output.failed || !markerPresent) { reject('successful marked tool output required'); return; }
    phase = 'completed'; record(200, 'marker-complete', { toolCallId: callId, toolOutputMarkerPresent: true });
    sendEvents(res, { type: 'message', id: `msg_cap_${mode}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: scenario.marker, annotations: [] }] }, ordinal);
  });
}

function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    if (!['--mode', '--port', '--receipt'].includes(key) || key in args || !process.argv[i + 1]) {
      throw new Error('Use --mode node-vm|pty --port PORT --receipt FRESH_ABSOLUTE_JSONL');
    }
    args[key] = process.argv[i + 1];
  }
  const port = Number(args['--port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !args['--receipt']) throw new Error('Invalid port or receipt');
  const server = createCapabilityServer({ mode: args['--mode'], receipt: args['--receipt'] });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`CAPABILITY_PROVIDER_READY ${port}\n`));
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
