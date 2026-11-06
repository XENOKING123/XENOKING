import { describe, expect, it } from 'vitest';
import { parseKeyValueList } from '../../src/sources/apollo.js';
import { iaItemsToDiscovered, iaLicenseGrant } from '../../src/sources/archive-org.js';
import { detectLicense } from '../../src/sources/license.js';
import { normalizeRow, parseCsv, rowToItem } from '../../src/sources/linklist.js';
import { initialState } from '../../src/sources/runner.js';
import type { SourceRow } from '../../src/sources/types.js';
import { checkExpectedHash } from '../../src/worker/pipeline.js';
import { signLocalToken, verifyLocalToken } from '../../src/storage/local.js';
import { blobKey } from '../../src/storage/index.js';

const src = (over: Partial<SourceRow>): SourceRow => ({
  id: 's', name: 's', kind: 'link-list', homepage: null, config: {}, policy: 'PERMISSION_REQUIRED', license: null,
  permission_evidence: null, enabled: true, paused: false, discovery_interval_minutes: 60, ...over,
});

describe('permission gating (initialState)', () => {
  const item = { sourceItemKey: 'k', downloadUrl: 'https://example.com/a.zip' };
  it('MIRROR_ALLOWED with evidence → QUEUED + granted', () => {
    const s = initialState(src({ policy: 'MIRROR_ALLOWED', permission_evidence: 'GPL-3.0 licence link' }), item);
    expect(s).toMatchObject({ status: 'QUEUED', redistribution: 'granted' });
    expect(s.basis).toMatch(/GPL/);
  });
  it('MIRROR_ALLOWED without recorded evidence is NOT enough', () => {
    expect(initialState(src({ policy: 'MIRROR_ALLOWED' }), item).status).toBe('PERMISSION_PENDING');
  });
  it('PERMISSION_REQUIRED → PERMISSION_PENDING (never downloaded)', () => {
    expect(initialState(src({}), item)).toMatchObject({ status: 'PERMISSION_PENDING', redistribution: 'pending' });
  });
  it('item-level grant needs its own basis (e.g. detected licence)', () => {
    expect(initialState(src({}), { ...item, redistribution: 'granted' }).status).toBe('PERMISSION_PENDING');
    expect(initialState(src({}), { ...item, redistribution: 'granted', permissionBasis: 'MIT licence — url' }).status).toBe('QUEUED');
  });
  it('EXTERNAL_ONLY / known restrictions / missing links → RESTRICTED', () => {
    expect(initialState(src({ policy: 'EXTERNAL_ONLY' }), item).status).toBe('RESTRICTED');
    expect(initialState(src({ policy: 'MIRROR_ALLOWED', permission_evidence: 'x'.repeat(20) }), { ...item, restrictedReason: 'members only' }).status).toBe('RESTRICTED');
    expect(initialState(src({ policy: 'MIRROR_ALLOWED', permission_evidence: 'x'.repeat(20) }), { sourceItemKey: 'k' }).status).toBe('RESTRICTED');
    expect(initialState(src({ policy: 'MIRROR_ALLOWED', permission_evidence: 'x'.repeat(20) }), { ...item, redistribution: 'pending' }).status).toBe('PERMISSION_PENDING');
  });
});

describe('Apollo index parsing', () => {
  it('parses key=value lists with BOM, comments and = in values', () => {
    expect(parseKeyValueList('﻿CUSA00207=Bloodborne\n# c\n\n00000001.zip=Max level = 99 (v1.09)\r\nbadline\n')).toEqual([
      ['CUSA00207', 'Bloodborne'],
      ['00000001.zip', 'Max level = 99 (v1.09)'],
    ]);
  });
});

describe('licence detection', () => {
  it.each([
    ['GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007', 'GPL-3.0', true],
    ['MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy', 'MIT', true],
    ['Creative Commons Attribution-NonCommercial 4.0', 'CC-BY-NC', false],
    ['This is free and unencumbered software released into the public domain.', 'Unlicense', true],
    ['All rights reserved. Do not redistribute.', null, false],
  ])('%#', (text, spdx, ok) => {
    const l = detectLicense(text);
    expect(l.spdx).toBe(spdx);
    expect(l.redistributable).toBe(ok);
  });
  it('no licence file → not redistributable', () => expect(detectLicense(null).redistributable).toBe(false));
});

describe('link-list import', () => {
  it('parses CSV with quotes, commas and newlines', () => {
    const rows = parseCsv('download_url,game,description\nhttps://x/a.zip,"Elden Ring","Max runes, ""NG+7""\nline2"\n');
    expect(rows).toEqual([{ download_url: 'https://x/a.zip', game: 'Elden Ring', description: 'Max runes, "NG+7"\nline2' }]);
  });
  it('maps common scraper column names', () => {
    const r = normalizeRow({ Title: 'Like a Dragon Gaiden', 'Post URL': 'https://forum/1', Link: 'https://www.mediafire.com/file/a/s.zip/file', CUSA: 'CUSA43228', Size: '12 MB', Credits: 'Bob' });
    expect(r).toMatchObject({ game: 'Like a Dragon Gaiden', page_url: 'https://forum/1', download_url: 'https://www.mediafire.com/file/a/s.zip/file', title_id: 'CUSA43228', author: 'Bob' });
    expect(r.size).toBeUndefined();
  });
  it('keeps the post page and the file host separate, never invents region', () => {
    const it = rowToItem({ page_url: 'https://forum.example/t/1', download_url: 'https://www.mediafire.com/file/a/s.zip/file', game: 'Like a Dragon Gaiden', title_id: 'CUSA43228', description: 'Platinum save' }, false, null);
    expect(it).toMatchObject({ sourcePageUrl: 'https://forum.example/t/1', fileHost: 'mediafire', platform: 'PS4', titleId: 'CUSA43228', category: 'Platinum', categorySource: 'keyword-heuristic', region: null, redistribution: 'pending' });
  });
});

describe('Internet Archive mapping', () => {
  it('grants only for open licences; maps files with hashes', () => {
    expect(iaLicenseGrant('https://creativecommons.org/publicdomain/zero/1.0/').granted).toBe(true);
    expect(iaLicenseGrant('https://creativecommons.org/licenses/by-nc/4.0/').granted).toBe(false);
    expect(iaLicenseGrant(null).granted).toBe(false);
    const items = iaItemsToDiscovered({
      metadata: { identifier: 'ps4-saves-x', title: 'PS4 saves', licenseurl: 'https://creativecommons.org/licenses/by/4.0/', creator: 'Alice' },
      files: [
        { name: 'CUSA00207 Bloodborne Platinum.zip', size: '1234', sha1: 'a'.repeat(40) },
        { name: 'thumb.jpg', size: '1' },
        { name: 'derived.zip', source: 'derivative' },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ titleId: 'CUSA00207', platform: 'PS4', expectedSize: 1234, expectedHash: `sha1:${'a'.repeat(40)}`, redistribution: 'granted', originalAuthor: 'Alice', category: 'Platinum' });
  });
});

describe('published hash verification', () => {
  const h = { sha256: 'b'.repeat(64), sha1: 'c'.repeat(40), gitBlobSha1: 'd'.repeat(40), size: 1 };
  it('matches git blob, sha1 and sha256 forms', () => {
    expect(checkExpectedHash(`git-blob-sha1:${'d'.repeat(40)}`, h).status).toBe('match');
    expect(checkExpectedHash(`sha1:${'C'.repeat(40)}`, h).status).toBe('match');
    expect(checkExpectedHash(`sha256:${'e'.repeat(64)}`, h).status).toBe('mismatch');
    expect(checkExpectedHash(null, h).status).toBe('none');
  });
});

describe('signed local download tokens', () => {
  it('verify, reject tampering and expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = signLocalToken('secret', 'blobs/sha256/aa/bb/x', 'save.zip', exp);
    expect(verifyLocalToken('secret', t)).toEqual({ key: 'blobs/sha256/aa/bb/x', filename: 'save.zip' });
    expect(verifyLocalToken('other', t)).toBeNull();
    const [p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ k: 'blobs/other', f: 'x', e: exp })).toString('base64url');
    expect(verifyLocalToken('secret', `${forged}.${s}`)).toBeNull();
    expect(verifyLocalToken('secret', signLocalToken('secret', 'k', 'f', Math.floor(Date.now() / 1000) - 1))).toBeNull();
    expect(p.length).toBeGreaterThan(0);
  });
  it('content-addressed keys', () => {
    expect(blobKey('ab'.repeat(32))).toBe(`blobs/sha256/ab/ab/${'ab'.repeat(32)}`);
    expect(() => blobKey('../../etc')).toThrow();
  });
});

describe('friendly export names', async () => {
  const { friendlySaveName, gameFolderName } = await import('../../src/export/naming.js');
  it('builds category/description names and replaces generic source names', () => {
    expect(gameFolderName({ platform: 'PS4', title_id: 'CUSA43228', game: 'Like a Dragon Gaiden: The Man Who Erased His Name' })).toBe('PS4/CUSA43228-Like-a-Dragon-Gaiden-The-Man-Who-Erased-His-Name');
    expect(friendlySaveName({ id: 5, category: '100% Completion', description: 'Game completed, everything unlocked! Run in NG+2 (v1.09)', original_filename: '00000001.zip' }))
      .toBe('100-Completion-Game-completed-everything-unlocked-Run-in-NG-2-v1-09-5.zip');
    expect(friendlySaveName({ id: 9, category: 'Platinum', description: 'Platinum save', original_filename: 'x.rar' })).toBe('Platinum-save-9.rar');
    expect(friendlySaveName({ id: 3, original_filename: 'Elden_Ring_Max_Runes.7z' })).toBe('Elden-Ring-Max-Runes-3.7z');
    expect(friendlySaveName({ id: 4, original_filename: '00000002.zip' })).toBe('Save-4.zip');
  });
});
