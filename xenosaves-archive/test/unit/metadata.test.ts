import { describe, expect, it } from 'vitest';
import { suggestCategories, suggestCategory } from '../../src/metadata/category.js';
import { parseSfo } from '../../src/metadata/sfo.js';
import { extractAllTitleIds, extractTitleId, platformForTitleId, regionFromContentId, regionFromText } from '../../src/metadata/titleid.js';
import { makeSfo } from '../helpers.js';

describe('title ids', () => {
  it('extracts CUSA/PPSA ids in common spellings', () => {
    expect(extractTitleId('Like a Dragon Gaiden [CUSA43228] Platinum')).toBe('CUSA43228');
    expect(extractTitleId('ppsa-01234 save')).toBe('PPSA01234');
    expect(extractTitleId('CUSA_00207.zip')).toBe('CUSA00207');
    expect(extractTitleId('no id here 12345')).toBeNull();
    expect(extractAllTitleIds('CUSA00001 and CUSA00002, CUSA00001')).toEqual(['CUSA00001', 'CUSA00002']);
  });
  it('maps prefixes to platforms', () => {
    expect(platformForTitleId('CUSA00207')).toBe('PS4');
    expect(platformForTitleId('PPSA03671')).toBe('PS5');
    expect(platformForTitleId('BLUS30001')).toBeNull();
  });
  it('derives region only from explicit content ids or explicit text', () => {
    expect(regionFromContentId('UP9000-CUSA00207_00-BLOODBORNE0000NA')?.region).toBe('US');
    expect(regionFromContentId('EP9000-CUSA00207_00-BLOODBORNE0000EU')?.region).toBe('EU');
    expect(regionFromContentId('CUSA00207')).toBeNull();
    expect(regionFromText('Save [EU] version')).toBe('EU');
    expect(regionFromText('USA version')).toBe('US');
    expect(regionFromText('Bloodborne platinum save')).toBeNull();
  });
});

describe('category suggestions (keyword heuristic, never verified)', () => {
  it.each([
    ['Platinum save, all trophies', 'Platinum'],
    ['Game completed, everything unlocked! Run in NG+2', '100% Completion'],
    ['Modded save with infinite health', 'Modded'],
    ['Max money 999999999', 'Max Money'],
    ['Max level character', 'Max Level'],
    ['NG+ ready', 'New Game+'],
    ['Right before the final boss', 'Before Final Boss'],
    ['Chapter 5 save', 'Chapter Save'],
    ['Beginning of the game, starter kit', 'Starter Save'],
  ])('%s → %s', (text, cat) => expect(suggestCategory(text)).toBe(cat));
  it('returns null when the text gives no signal', () => expect(suggestCategory('just a save')).toBeNull());
  it('can return several matches', () => expect(suggestCategories('Platinum NG+ 100%')).toEqual(expect.arrayContaining(['Platinum', '100% Completion', 'New Game+'])));
});

describe('PARAM.SFO', () => {
  it('parses strings and ints and drops account identifiers', () => {
    const sfo = parseSfo(makeSfo({ TITLE_ID: 'CUSA00207', MAINTITLE: 'Bloodborne™', ACCOUNT_ID: 'abc', SAVEDATA_BLOCKS: 99 }));
    expect(sfo).toEqual({ TITLE_ID: 'CUSA00207', MAINTITLE: 'Bloodborne™', SAVEDATA_BLOCKS: 99 });
  });
  it('rejects non-SFO and truncated data safely', () => {
    expect(parseSfo(Buffer.from('nope'))).toBeNull();
    const good = makeSfo({ TITLE_ID: 'CUSA00207' });
    expect(() => parseSfo(good.subarray(0, 30))).not.toThrow();
  });
});

describe('jsonb safety', async () => {
  const { pgJson } = await import('../../src/worker/events.js');
  it('strips NUL characters that Postgres jsonb rejects', () => {
    expect(pgJson({ a: 'x\u0000y', ['k\u0000']: ['z\u0000'] })).toBe('{"a":"xy","k":["z"]}');
  });
  it('SFO strings stop at the first NUL', () => {
    const sfo = parseSfo(makeSfo({ SUBTITLE: 'Slot 1\u0000garbage' }));
    expect(sfo?.SUBTITLE).toBe('Slot 1');
  });
});
