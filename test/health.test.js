const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HealthController,
} = require('../dist/modules/health/health.controller.js');

// The probe is the contract an uptime monitor relies on, so the tests assert
// the two answers it can give (200/ok, 503/degraded) and the one property that
// makes it safe: it must answer even when the database never does.

function fakeReply() {
  const reply = {
    statusCode: undefined,
    status(code) {
      reply.statusCode = code;
      return reply;
    },
  };

  return reply;
}

function prismaThat(behaviour) {
  const queries = [];

  return {
    queries,
    $queryRaw: (...args) => {
      queries.push(args);
      return behaviour();
    },
  };
}

test('reports ok and 200 when the database answers', async () => {
  const prisma = prismaThat(async () => [{ '?column?': 1 }]);
  const reply = fakeReply();
  const controller = new HealthController(prisma);

  const body = await controller.check(reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'up');
  assert.equal(typeof body.uptimeSeconds, 'number');
  assert.ok(body.uptimeSeconds >= 0);
  // The answer has to be measured, not assumed.
  assert.equal(prisma.queries.length, 1);
});

test('reports degraded and 503 when the database rejects', async () => {
  const prisma = prismaThat(async () => {
    throw new Error('ConnectorError(QueryError(UnexpectedMessage))');
  });
  const reply = fakeReply();
  const controller = new HealthController(prisma);

  const body = await controller.check(reply);

  assert.equal(reply.statusCode, 503);
  assert.equal(body.status, 'degraded');
  assert.equal(body.db, 'down');
});

test('reports degraded and 503 when the database never answers', async () => {
  const original = HealthController.DB_PROBE_TIMEOUT_MS;
  // Shrink the bound so a hung query is proven quickly, not after two seconds.
  HealthController.DB_PROBE_TIMEOUT_MS = 25;

  try {
    const prisma = prismaThat(() => new Promise(() => {}));
    const reply = fakeReply();
    const controller = new HealthController(prisma);

    const startedAt = Date.now();
    const body = await controller.check(reply);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(reply.statusCode, 503);
    assert.equal(body.db, 'down');
    assert.ok(elapsedMs >= 20, `probe returned too early (${elapsedMs}ms)`);
    assert.ok(elapsedMs < 1000, `probe hung for ${elapsedMs}ms`);
  } finally {
    HealthController.DB_PROBE_TIMEOUT_MS = original;
  }
});

test('exposes liveness only, never configuration or secrets', async () => {
  const prisma = prismaThat(async () => []);
  const controller = new HealthController(prisma);

  const body = await controller.check(fakeReply());

  assert.deepEqual(Object.keys(body).sort(), ['db', 'status', 'uptimeSeconds']);
});
