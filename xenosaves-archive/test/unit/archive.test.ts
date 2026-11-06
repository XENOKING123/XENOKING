import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { contentFingerprint, detectFormat, inspectArchive, safeEntryPath } from '../../src/verify/archive.js';
import { goodSaveZip, makeZip, patchZipName, tmpDir } from '../helpers.js';

const LIMITS = { maxEntries: 1000, maxUncompressedBytes: 64 * 1024 * 1024, maxCompressionRatio: 100 };
let dir: string;
const has7z = (() => {
  try {
    execFileSync('7z', ['i'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function write(name: string, buf: Buffer) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

beforeAll(() => {
  dir = tmpDir();
});

describe('safeEntryPath', () => {
  it.each(['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', '\\\\server\\share', 'a\0b'])('rejects %j', (p) => expect(safeEntryPath(p)).toBeNull());
  it('normalises benign paths', () => {
    expect(safeEntryPath('CUSA00207\\SPRJ0005\\./userdata0000')).toBe('CUSA00207/SPRJ0005/userdata0000');
  });
});

describe('inspectArchive (zip)', () => {
  it('accepts a normal save zip, hashes entries and parses PARAM.SFO (dropping account ids)', async () => {
    const p = await write('good.zip', await goodSaveZip());
    const r = await inspectArchive(p, LIMITS);
    expect(r.format).toBe('zip');
    expect(r.verdict).toBe('ok');
    expect(r.entryCount).toBe(2);
    expect(r.sfo?.TITLE_ID).toBe('CUSA00207');
    expect(r.sfo?.MAINTITLE).toBe('Bloodborne');
    expect(r.sfo?.SAVEDATA_BLOCKS).toBe(1024);
    expect(r.sfo).not.toHaveProperty('ACCOUNT_ID');
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256!))).toBe(true);
  });

  it('gives the same content fingerprint to a re-packed copy (different compression, extra top folder)', async () => {
    const a = await inspectArchive(await write('a.zip', await makeZip([{ name: 'S/x.bin', data: 'hello' }, { name: 'S/y.bin', data: 'world' }])), LIMITS);
    const b = await inspectArchive(await write('b.zip', await makeZip([{ name: 'y.bin', data: 'world', compress: false }, { name: 'x.bin', data: 'hello', compress: false }])), LIMITS);
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = await inspectArchive(await write('c.zip', await makeZip([{ name: 'x.bin', data: 'hellO' }, { name: 'y.bin', data: 'world' }])), LIMITS);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  it('quarantines path traversal (zip slip)', async () => {
    const z = patchZipName(await makeZip([{ name: 'aa/evil.txt', data: 'x' }]), 'aa/evil.txt', '../evil.txt');
    const r = await inspectArchive(await write('slip.zip', z), LIMITS);
    expect(r.verdict).toBe('quarantine');
    expect(r.reasons.join()).toMatch(/unsafe path/);
  });

  it('quarantines symlinks', async () => {
    const r = await inspectArchive(await write('link.zip', await makeZip([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }])), LIMITS);
    expect(r.verdict).toBe('quarantine');
    expect(r.reasons.join()).toMatch(/symbolic link/);
  });

  it('quarantines executables by type and by header', async () => {
    const byExt = await inspectArchive(await write('exe1.zip', await makeZip([{ name: 'tool.exe', data: 'whatever' }])), LIMITS);
    expect(byExt.verdict).toBe('quarantine');
    const mz = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
    const byHdr = await inspectArchive(await write('exe2.zip', await makeZip([{ name: 'save/userdata0000', data: mz }])), LIMITS);
    expect(byHdr.verdict).toBe('quarantine');
    expect(byHdr.reasons.join()).toMatch(/PE\/MZ/);
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
    expect((await inspectArchive(await write('exe3.zip', await makeZip([{ name: 'data.bin', data: elf }])), LIMITS)).verdict).toBe('quarantine');
  });

  it('accepts sparse (zero-padded) save slots but quarantines zip bombs that exceed the decompression cap', async () => {
    const zeros = Buffer.alloc(11 * 1024 * 1024);
    const sparse = await inspectArchive(await write('sparse.zip', await makeZip([{ name: 'savedata0/memory.dat', data: zeros }])), LIMITS);
    expect(sparse.verdict).toBe('ok');
    const bomb = await inspectArchive(await write('bomb.zip', await makeZip([{ name: 'z.bin', data: zeros }])), { ...LIMITS, maxUncompressedBytes: 4 * 1024 * 1024 });
    expect(bomb.verdict).toBe('quarantine');
    expect(bomb.reasons.join()).toMatch(/zip bomb|exceeds/);
    const big = await inspectArchive(await write('big.zip', await makeZip([{ name: 'r.bin', data: Buffer.alloc(3 * 1024 * 1024, 7), compress: false }])), {
      ...LIMITS,
      maxUncompressedBytes: 1024 * 1024,
    });
    expect(big.verdict).toBe('quarantine');
  });

  it('enforces the entry-count limit', async () => {
    const many = await makeZip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, data: String(i) })));
    const r = await inspectArchive(await write('many.zip', many), { ...LIMITS, maxEntries: 10 });
    expect(r.verdict).toBe('quarantine');
  });

  it('marks HTML interstitials as restricted, random bytes as invalid, corrupt zips as invalid', async () => {
    expect((await inspectArchive(await write('page.zip', Buffer.from('<!DOCTYPE html><html>login</html>')), LIMITS)).verdict).toBe('restricted');
    expect((await inspectArchive(await write('rand.bin', Buffer.from('hello world, not an archive')), LIMITS)).verdict).toBe('invalid');
    const good = await goodSaveZip();
    expect((await inspectArchive(await write('trunc.zip', good.subarray(0, good.length - 30)), LIMITS)).verdict).toBe('invalid');
  });

  it.runIf(has7z)('marks password-protected zips as restricted (never cracked)', async () => {
    const src = path.join(dir, 'pwsrc.txt');
    fs.writeFileSync(src, 'secret save');
    const out = path.join(dir, 'pw.zip');
    execFileSync('7z', ['a', '-tzip', '-pSECRET', out, src], { stdio: 'ignore' });
    const r = await inspectArchive(out, LIMITS);
    expect(r.verdict).toBe('restricted');
    expect(r.reasons.join()).toMatch(/password/);
  });
});

describe.runIf(has7z)('inspectArchive (7z / password-protected 7z)', () => {
  it('lists and integrity-tests a 7z archive without extracting', async () => {
    const src = path.join(dir, 'sevsrc');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'userdata0000'), 'x'.repeat(1000));
    const out = path.join(dir, 'save.7z');
    execFileSync('7z', ['a', out, src], { stdio: 'ignore' });
    expect(await detectFormat(out)).toBe('7z');
    const r = await inspectArchive(out, LIMITS);
    expect(r.verdict).toBe('ok');
    expect(r.entries.some((e) => e.path.endsWith('userdata0000'))).toBe(true);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('restricts encrypted 7z (headers encrypted)', async () => {
    const src = path.join(dir, 'pw7src.txt');
    fs.writeFileSync(src, 'x');
    const out = path.join(dir, 'pw.7z');
    execFileSync('7z', ['a', '-pSECRET', '-mhe=on', out, src], { stdio: 'ignore' });
    const r = await inspectArchive(out, LIMITS);
    expect(r.verdict).toBe('restricted');
  });

  it('quarantines executables inside 7z', async () => {
    const src = path.join(dir, 'evil.bat');
    fs.writeFileSync(src, 'echo hi');
    const out = path.join(dir, 'evil.7z');
    execFileSync('7z', ['a', out, src], { stdio: 'ignore' });
    expect((await inspectArchive(out, LIMITS)).verdict).toBe('quarantine');
  });
});

describe('contentFingerprint', () => {
  it('returns null for archives with no files', () => expect(contentFingerprint([{ path: 'dir/', size: 0 }])).toBeNull());
});
