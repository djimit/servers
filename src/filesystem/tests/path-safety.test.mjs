import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPathValidator, readFileSafely, writeFileAtomically } from '../dist/path-safety.js';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-path-control-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'allowed_backup');
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  const sentinel = path.join(outside, 'sentinel.txt');
  await fs.writeFile(sentinel, 'outside sentinel');
  try { await run({ root, allowed, outside, sentinel, validate: await createPathValidator([allowed]) }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('component boundaries reject existing/new siblings and outside symlink targets', () => fixture(async ({ allowed, outside, sentinel, validate }) => {
  await assert.rejects(validate(sentinel), /Access denied/);
  await assert.rejects(validate(path.join(outside, 'new.txt')), /Access denied/);
  const existing = path.join(allowed, 'outside-link');
  const dangling = path.join(allowed, 'dangling-link');
  await fs.symlink(sentinel, existing, 'file');
  await fs.symlink(path.join(outside, 'missing.txt'), dangling, 'file');
  await assert.rejects(validate(existing), /Access denied/);
  await assert.rejects(validate(dangling), /Access denied/);
  await fs.symlink(outside, path.join(allowed, 'outside-dir'), 'junction');
  await assert.rejects(validate(path.join(allowed, 'outside-dir', 'new.txt')), /Access denied/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside sentinel');
}));

test('configured aliases, internal links, ordinary and new files remain usable', () => fixture(async ({ root, allowed, validate }) => {
  const file = path.join(allowed, 'ordinary.txt');
  await fs.writeFile(file, 'ordinary');
  const alias = path.join(root, 'alias');
  await fs.symlink(allowed, alias, 'junction');
  const viaAlias = await createPathValidator([alias]);
  assert.equal(await viaAlias(path.join(alias, 'ordinary.txt')), await fs.realpath(file));
  assert.equal(await viaAlias(file), await fs.realpath(file));
  assert.equal(await viaAlias(path.join(alias, 'new.txt')), path.join(await fs.realpath(allowed), 'new.txt'));
  const internal = path.join(allowed, 'internal-link');
  await fs.symlink(file, internal, 'file');
  await writeFileAtomically(await validate(internal), 'updated');
  assert.equal(await readFileSafely(await validate(internal)), 'updated');
  assert.equal((await fs.lstat(internal)).isSymbolicLink(), true);
  const fresh = await validate(path.join(allowed, 'fresh.txt'));
  await writeFileAtomically(fresh, 'new content');
  assert.equal(await readFileSafely(fresh), 'new content');
}));

test('a leaf swapped after validation is never read or written through', () => fixture(async ({ allowed, sentinel, validate }) => {
  const file = path.join(allowed, 'normal.txt');
  await fs.writeFile(file, 'ordinary');
  const checked = await validate(file);
  await fs.unlink(file);
  await fs.symlink(sentinel, file, 'file');
  await assert.rejects(readFileSafely(checked));
  await assert.rejects(writeFileAtomically(checked, 'must not escape'));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside sentinel');
}));

test('atomic commit replaces a raced leaf link and preserves mode/owner', () => fixture(async ({ allowed, sentinel, validate }) => {
  const file = path.join(allowed, 'normal.txt');
  await fs.writeFile(file, 'ordinary', { mode: 0o600 });
  const checked = await validate(file);
  const before = await fs.stat(file);
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === checked) {
      await fs.unlink(destination);
      await fs.symlink(sentinel, destination, 'file');
    }
    return rename(source, destination);
  };
  try { await writeFileAtomically(checked, 'updated'); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside sentinel');
  assert.equal(await readFileSafely(checked), 'updated');
  assert.equal((await fs.lstat(checked)).isSymbolicLink(), false);
  const after = await fs.stat(checked);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  if (process.platform !== 'win32') assert.equal(after.mode & 0o777, before.mode & 0o777);
  assert.deepEqual((await fs.readdir(allowed)).filter(name => name.startsWith('.mcp-write-')), []);
}));

test('a failed atomic commit retains old data and cleans only its temporary file', () => fixture(async ({ allowed, validate }) => {
  const file = path.join(allowed, 'normal.txt');
  await fs.writeFile(file, 'ordinary');
  const checked = await validate(file);
  const rename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('controlled rename failure'), { code: 'EACCES' }); };
  try { await assert.rejects(writeFileAtomically(checked, 'must not commit'), /controlled rename failure/); }
  finally { fs.rename = rename; }
  assert.equal(await readFileSafely(checked), 'ordinary');
  assert.deepEqual((await fs.readdir(allowed)).filter(name => name.startsWith('.mcp-write-')), []);
}));
