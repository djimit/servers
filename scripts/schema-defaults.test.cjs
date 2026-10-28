const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

function schemas(workspace, filename) {
  const root = path.resolve(__dirname, '..', 'src', workspace);
  const requireOwner = createRequire(path.join(root, 'package.json'));
  const ts = requireOwner('typescript');
  const z = requireOwner('zod');
  const source = fs.readFileSync(path.join(root, filename), 'utf8');
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements.filter(ts.isVariableStatement).filter(statement =>
    statement.declarationList.declarations.some(declaration => declaration.initializer?.getText(parsed).startsWith('z.')));
  const names = declarations.flatMap(statement => statement.declarationList.declarations.map(declaration => declaration.name.getText(parsed)));
  const javascript = ts.transpileModule(declarations.map(statement => statement.getFullText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  // Evaluate only schema declarations; server boot and provider clients are excluded.
  return vm.runInNewContext(javascript + '\n({' + names.join(',') + '})', { z });
}

test('seven source defaults still validate through their owning schemas', () => {
  const everything = schemas('everything', 'everything.ts');
  const filesystem = schemas('filesystem', 'index.ts');
  const redis = schemas('redis', 'src/index.ts');
  const cases = [
    [everything.LongRunningOperationSchema, {}, { duration: 10, steps: 5 }],
    [everything.SampleLLMSchema, { prompt: 'ordinary' }, { prompt: 'ordinary', maxTokens: 100 }],
    [everything.AnnotatedMessageSchema, { messageType: 'success' }, { messageType: 'success', includeImage: false }],
    [filesystem.EditFileArgsSchema, { path: 'normal.txt', edits: [] }, { path: 'normal.txt', edits: [], dryRun: false }],
    [filesystem.SearchFilesArgsSchema, { path: '.', pattern: 'normal' }, { path: '.', pattern: 'normal', excludePatterns: [] }],
    [redis.ListArgumentsSchema, {}, { pattern: '*' }],
  ];
  for (const [schema, input, expected] of cases) assert.deepEqual(JSON.parse(JSON.stringify(schema.parse(input))), expected);
  assert.equal(everything.LongRunningOperationSchema.safeParse({ duration: '10' }).success, false);
  assert.equal(redis.SetArgumentsSchema.safeParse({ key: 'ordinary', value: 12 }).success, false);
  assert.deepEqual(JSON.parse(JSON.stringify(redis.GetArgumentsSchema.parse({ key: 'ordinary' }))), { key: 'ordinary' });
});

test('bounded collection rejection precedes element transforms', () => {
  const requireOwner = createRequire(path.resolve(__dirname, '../src/redis/package.json'));
  const z = requireOwner('zod');
  let visited = 0;
  const schema = z.array(z.string().transform(value => { visited++; return value; })).max(2);
  const result = schema.safeParse(['one', 'two', 'three']);
  assert.equal(result.success, false);
  assert.equal(visited, 0);
  assert.deepEqual(result.error.issues.map(issue => issue.code), ['too_big']);
  assert.deepEqual(schema.parse(['one', 'two']), ['one', 'two']);
  assert.equal(visited, 2);
});
