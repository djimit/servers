import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = JSON.parse(await fs.readFile(new URL('./tool-schema-contracts.json', import.meta.url), 'utf8'));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

for (const name of Object.keys(expected)) {
  test(name + ' preserves its public tool-schema contract over local stdio', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-contract-'));
    const created = path.join(temporary, 'allowed');
    await fs.mkdir(created);
    const allowed = await fs.realpath(created);
    const entry = path.join(root, 'src', name, 'dist', 'index.js');
    const client = new Client({ name: 'local-contract-control', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: name === 'filesystem' ? [entry, allowed] : [entry],
      // GitLab requires a nonempty token at boot; no provider tools are called.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
        GITLAB_PERSONAL_ACCESS_TOKEN: 'schema-control-placeholder', GITLAB_API_URL: 'http://127.0.0.1:9' },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      const digest = crypto.createHash('sha256').update(JSON.stringify(stable(tools))).digest('hex');
      assert.equal(digest, expected[name]);
      if (name === 'filesystem') {
        const file = path.join(allowed, 'ordinary.txt');
        await fs.writeFile(file, 'before\n', { mode: 0o600 });
        const edits = [{ oldText: 'before', newText: 'after' }];
        const dry = await client.callTool({ name: 'edit_file', arguments: { path: file, edits, dryRun: true } });
        assert.notEqual(dry.isError, true);
        assert.equal(await fs.readFile(file, 'utf8'), 'before\n');
        const edit = await client.callTool({ name: 'edit_file', arguments: { path: file, edits } });
        assert.notEqual(edit.isError, true);
        assert.equal(await fs.readFile(file, 'utf8'), 'after\n');
        const moved = path.join(allowed, 'moved.txt');
        const move = await client.callTool({ name: 'move_file', arguments: { source: file, destination: moved } });
        assert.notEqual(move.isError, true);
        assert.equal(await fs.readFile(moved, 'utf8'), 'after\n');
      }
    } finally {
      await client.close();
      await transport.close();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
}
