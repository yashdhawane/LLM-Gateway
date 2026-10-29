const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HttpService } = require('@nestjs/axios');
const {
  OpenAIProvider,
} = require('../dist/modules/providers/openai.provider.js');
const {
  AnthropicProvider,
} = require('../dist/modules/providers/anthropic.provider.js');
const {
  ProviderError,
} = require('../dist/modules/providers/base.provider.js');

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

function quiet(provider) {
  provider.logger.error = () => {};
  return provider;
}

test('OpenAI adapter calls the normalized chat endpoint', async () => {
  let seen;

  await withServer(
    async (request, response) => {
      seen = {
        url: request.url,
        authorization: request.headers.authorization,
        traceId: request.headers['x-trace-id'],
        body: await readBody(request),
      };
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'chatcmpl_test',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    },
    async (baseUrl) => {
      const provider = quiet(new OpenAIProvider(new HttpService()));
      const result = await provider.chatCompletion(
        {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hello' }],
        },
        {
          baseUrl: `${baseUrl}/v1`,
          apiKey: 'sk-test',
          timeoutMs: 1000,
        },
        'trace-openai',
      );

      assert.equal(result.response.id, 'chatcmpl_test');
      assert.equal(result.response.trace_id, 'trace-openai');
    },
  );

  assert.equal(seen.url, '/v1/chat/completions');
  assert.equal(seen.authorization, 'Bearer sk-test');
  assert.equal(seen.traceId, 'trace-openai');
  assert.deepEqual(seen.body, {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  });
});

test('Anthropic adapter translates request and response formats', async () => {
  let seen;

  await withServer(
    async (request, response) => {
      seen = {
        url: request.url,
        apiKey: request.headers['x-api-key'],
        version: request.headers['anthropic-version'],
        body: await readBody(request),
      };
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'msg_test',
          model: 'claude-test',
          content: [{ type: 'text', text: 'hello from Claude' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 4 },
        }),
      );
    },
    async (baseUrl) => {
      const provider = quiet(new AnthropicProvider(new HttpService()));
      const result = await provider.chatCompletion(
        {
          model: 'claude-test',
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'hello' },
          ],
        },
        {
          baseUrl,
          apiKey: 'sk-ant-test',
          timeoutMs: 1000,
        },
        'trace-anthropic',
      );

      assert.equal(result.response.id, 'msg_test');
      assert.equal(
        result.response.choices[0].message.content,
        'hello from Claude',
      );
      assert.equal(result.response.choices[0].finish_reason, 'stop');
      assert.deepEqual(result.response.usage, {
        prompt_tokens: 2,
        completion_tokens: 4,
        total_tokens: 6,
      });
    },
  );

  assert.equal(seen.url, '/v1/messages');
  assert.equal(seen.apiKey, 'sk-ant-test');
  assert.equal(seen.version, '2023-06-01');
  assert.deepEqual(seen.body, {
    model: 'claude-test',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
    system: 'Be concise.',
  });
});

test('provider timeout aborts the upstream request', async () => {
  await withServer(
    () => {},
    async (baseUrl) => {
      const provider = quiet(new OpenAIProvider(new HttpService()));

      await assert.rejects(
        () =>
          provider.chatCompletion(
            {
              model: 'gpt-test',
              messages: [{ role: 'user', content: 'slow' }],
            },
            { baseUrl, apiKey: 'sk-test', timeoutMs: 50 },
            'trace-timeout',
          ),
        (error) =>
          error instanceof ProviderError
          && error.code === 'PROVIDER_TIMEOUT',
      );
    },
  );
});

test('provider rate limits map to a retryable provider error', async () => {
  await withServer(
    (request, response) => {
      response.statusCode = 429;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { message: 'slow down' } }));
    },
    async (baseUrl) => {
      const provider = quiet(new OpenAIProvider(new HttpService()));

      await assert.rejects(
        () =>
          provider.chatCompletion(
            {
              model: 'gpt-test',
              messages: [{ role: 'user', content: 'hello' }],
            },
            { baseUrl, apiKey: 'sk-test', timeoutMs: 1000 },
            'trace-429',
          ),
        (error) =>
          error instanceof ProviderError
          && error.code === 'PROVIDER_RATE_LIMIT',
      );
    },
  );
});
