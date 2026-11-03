const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Migration invariants (V1-V4) read straight from the SQL, so a regeneration
// that silently drops a column, re-adds a renamed one, reorders a foreign key
// or tightens a column before its backfill fails here instead of on Neon.

const ROOT = path.join(__dirname, '..');

const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations');

const INIT_SQL = fs.readFileSync(
  path.join(MIGRATIONS, '20261022162245_init', 'migration.sql'),
  'utf8',
);
const FOUNDATION_SQL = fs.readFileSync(
  path.join(
    MIGRATIONS,
    '20261102090000_requestlog_foundation',
    'migration.sql',
  ),
  'utf8',
);
const HEARTBEAT_SQL = fs.readFileSync(
  path.join(
    MIGRATIONS,
    '20261102120000_requestlog_heartbeat_liveness',
    'migration.sql',
  ),
  'utf8',
);
const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

// Init ran first, so offsets in this text are the real apply order.
const APPLIED_SQL = `${INIT_SQL}\n${FOUNDATION_SQL}`;

const SCHEMA_MODELS = new Set(
  [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]),
);

function createTableOffset(sql, table) {
  const offset = sql.indexOf(`CREATE TABLE "${table}"`);

  assert.notEqual(offset, -1, `missing CREATE TABLE "${table}"`);

  return offset;
}

/** Column names declared inside `CREATE TABLE "<table>" (...)`. */
function createTableColumns(sql, table) {
  const start = createTableOffset(sql, table);
  const end = sql.indexOf(');', start);

  assert.notEqual(end, -1, `unterminated CREATE TABLE "${table}"`);

  return [...sql.slice(start, end).matchAll(/^\s+"(\w+)"/gm)].map(
    (match) => match[1],
  );
}

/** Scalar column names of one `model` block: relations and lists are not columns. */
function schemaColumns(model) {
  const start = SCHEMA.indexOf(`model ${model} {`);

  assert.notEqual(start, -1, `missing model ${model} in schema.prisma`);

  const body = SCHEMA.slice(start, SCHEMA.indexOf('\n}', start));
  const columns = [];

  for (const line of body.split('\n')) {
    const match = /^(\w+)\s+(\w+)(\[\])?\??/.exec(line.trim());

    if (match === null) {
      continue;
    }

    const [, field, type, isList] = match;

    // A field whose type is another model is a relation, not a column.
    if (isList || SCHEMA_MODELS.has(type)) {
      continue;
    }

    columns.push(field);
  }

  return columns;
}

test('V1 renames cost to totalCost instead of dropping it', () => {
  assert.match(FOUNDATION_SQL, /RENAME COLUMN "cost" TO "totalCost"/);

  // The widened type is what makes the snapshot arithmetic exact.
  assert.match(FOUNDATION_SQL, /DECIMAL\(18,10\)/);

  // Drop + re-add would lose existing values and reintroduce the old scale.
  assert.doesNotMatch(FOUNDATION_SQL, /DROP COLUMN "cost"/);
  assert.doesNotMatch(FOUNDATION_SQL, /ADD COLUMN\s+"totalCost"/);
});

test('V2 adds every foreign key after the tables it references', () => {
  const foreignKeys = [
    ...APPLIED_SQL.matchAll(
      /ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" FOREIGN KEY \("\w+"\) REFERENCES "(\w+)"/g,
    ),
  ];

  // User -> ApiKey/RequestLog/Model plus the four added by this migration.
  assert.equal(foreignKeys.length, 8);

  for (const match of foreignKeys) {
    const [, owner, name, referenced] = match;
    const offset = match.index;

    assert.notEqual(offset, undefined, `missing FK statement ${name}`);
    assert.ok(
      offset > createTableOffset(APPLIED_SQL, owner),
      `${name} is added before its own table "${owner}" exists`,
    );
    assert.ok(
      offset > createTableOffset(APPLIED_SQL, referenced),
      `${name} is added before the table it references ("${referenced}") exists`,
    );
  }
});

test('V3 covers every schema column exactly once', () => {
  const addedColumns = [
    ...FOUNDATION_SQL.matchAll(/ADD COLUMN\s+"(\w+)"/g),
  ].map((match) => match[1]);

  const seen = new Set();

  for (const column of addedColumns) {
    assert.equal(seen.has(column), false, `duplicate ADD COLUMN "${column}"`);
    seen.add(column);
  }

  // RequestLog predates this migration: its columns are the init ones with the
  // renamed "cost", plus everything added above.
  // The later liveness migration is additive too: its columns are part of the
  // applied shape, not of the foundation migration.
  const heartbeatColumns = [
    ...HEARTBEAT_SQL.matchAll(/ADD COLUMN\s+"(\w+)"/g),
  ].map((match) => match[1]);

  const requestLogColumns = [
    ...createTableColumns(APPLIED_SQL, 'RequestLog').map((column) =>
      column === 'cost' ? 'totalCost' : column,
    ),
    ...addedColumns,
    ...heartbeatColumns,
  ];

  const sqlColumns = {
    RequestLog: requestLogColumns,
    RequestAttempt: createTableColumns(APPLIED_SQL, 'RequestAttempt'),
    ModelPricing: createTableColumns(APPLIED_SQL, 'ModelPricing'),
  };

  for (const model of ['RequestLog', 'RequestAttempt', 'ModelPricing']) {
    const expected = schemaColumns(model);
    const actual = sqlColumns[model];

    assert.equal(
      new Set(actual).size,
      actual.length,
      `${model} declares a column twice in the migration`,
    );

    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      `${model} columns in the migration do not match schema.prisma`,
    );
  }
});

test('V10d creates the documented number of indexes', () => {
  // The runbook quotes these numbers (section 4.4, step 6). 12 btree indexes
  // plus 2 unique constraints = 14 CREATE INDEX statements; with the five
  // primary keys the three tables end on 20 indexes.
  const btree = [...FOUNDATION_SQL.matchAll(/^CREATE INDEX /gm)];
  const unique = [...FOUNDATION_SQL.matchAll(/^CREATE UNIQUE INDEX /gm)];

  assert.equal(btree.length, 12);
  assert.equal(unique.length, 2);
  assert.equal(btree.length + unique.length, 14);
});

test('V5 adds heartbeatAt nullable, backfills it, then tightens and indexes it', () => {
  const add = /ALTER TABLE "RequestLog"\s+ADD COLUMN "heartbeatAt" TIMESTAMP\(3\)([^;]*);/.exec(
    HEARTBEAT_SQL,
  );

  assert.ok(add !== null, 'heartbeatAt is not added to RequestLog');
  // Existing PROCESSING rows need the backfill before NOT NULL can apply.
  assert.doesNotMatch(add[1], /NOT NULL/);
  assert.doesNotMatch(add[1], /DEFAULT/);

  const backfill = HEARTBEAT_SQL.indexOf('"heartbeatAt" = "startedAt"');

  assert.ok(backfill > add.index, 'heartbeatAt is not backfilled from startedAt');

  const tighten = HEARTBEAT_SQL.indexOf(
    'ALTER COLUMN "heartbeatAt" SET NOT NULL',
  );

  assert.ok(tighten > backfill, 'heartbeatAt is tightened before its backfill');

  assert.match(
    HEARTBEAT_SQL,
    /CREATE INDEX "RequestLog_status_heartbeatAt_idx" ON "RequestLog"\("status", "heartbeatAt"\)/,
  );

  // The already-rehearsed foundation migration stays untouched.
  assert.doesNotMatch(FOUNDATION_SQL, /heartbeatAt/);
});

test('V4 backfills before setting NOT NULL', () => {
  // The first UPDATE that assigns the column.
  const updateStatements = [
    ...FOUNDATION_SQL.matchAll(/UPDATE\s+"RequestLog"[\s\S]*?;/g),
  ];

  const firstBackfill = (column) => {
    const assignment = new RegExp(`"${column}"\\s*=`);

    for (const statement of updateStatements) {
      if (assignment.test(statement[0])) {
        return statement.index;
      }
    }

    assert.fail(`no backfill UPDATE sets "${column}"`);
  };

  // "status" must be added nullable and default-free: the backfill supplies
  // every value before the NOT NULL / DEFAULT are applied.
  const statusAdd = /ADD COLUMN\s+"status"\s+"RequestStatus"([^,\n]*)/.exec(
    FOUNDATION_SQL,
  );

  assert.ok(statusAdd !== null, 'status is not added to RequestLog');
  assert.doesNotMatch(statusAdd[1], /NOT NULL/);
  assert.doesNotMatch(statusAdd[1], /DEFAULT/);
  assert.ok(statusAdd.index < firstBackfill('status'));

  for (const column of [
    'status',
    'startedAt',
    'finishedAt',
    'requestedModel',
  ]) {
    const backfilledAt = firstBackfill(column);
    // "finishedAt" stays nullable: only the tightened columns are ordered.
    const tightened = new RegExp(
      `ALTER COLUMN "${column}" SET NOT NULL`,
    ).exec(FOUNDATION_SQL);

    if (tightened !== null) {
      assert.ok(
        backfilledAt < tightened.index,
        `"${column}" is set NOT NULL before it is backfilled`,
      );
    }
  }
});
