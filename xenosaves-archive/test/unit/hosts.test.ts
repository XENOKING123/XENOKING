import { describe, expect, it } from 'vitest';
import { normalizeLink, resolverFor } from '../../src/hosts/index.js';
import { interpretGdriveHtml, gdriveFileId } from '../../src/hosts/gdrive.js';
import { interpretMediafireHtml } from '../../src/hosts/mediafire.js';
import { parseMegaLink } from '../../src/hosts/mega.js';
import { oneDriveShareContentUrl } from '../../src/hosts/onedrive.js';
import { classifyLink, extractFileLinks } from '../../src/hosts/links.js';

const ctx = { http: {} as any };

describe('resolver selection', () => {
  it.each([
    ['https://www.mediafire.com/file/abc123/save.zip/file', 'mediafire'],
    ['https://mega.nz/file/AbCd#key', 'mega'],
    ['https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view', 'gdrive'],
    ['https://www.dropbox.com/s/xyz/save.zip?dl=0', 'dropbox'],
    ['https://1drv.ms/u/s!Abc', 'onedrive'],
    ['https://github.com/o/r/releases/download/v1/save.zip', 'github'],
    ['https://example.org/files/save.rar', 'direct'],
  ])('%s → %s', (url, id) => expect(resolverFor(url).id).toBe(id));
});

describe('host link transforms', () => {
  it('github blob pages become raw URLs', async () => {
    const r = await resolverFor('https://github.com/o/r/blob/main/PS4/x.zip').resolve(new URL('https://github.com/o/r/blob/main/PS4/x.zip'), ctx);
    expect(r.url).toBe('https://raw.githubusercontent.com/o/r/main/PS4/x.zip');
  });
  it('dropbox links get dl=1', async () => {
    const u = new URL('https://www.dropbox.com/scl/fi/abc/save.zip?rlkey=k&dl=0');
    const r = await resolverFor(u.toString()).resolve(u, ctx);
    expect(new URL(r.url).searchParams.get('dl')).toBe('1');
    expect(new URL(r.url).searchParams.get('rlkey')).toBe('k');
  });
  it('onedrive uses the documented shares API encoding', () => {
    expect(oneDriveShareContentUrl('https://1drv.ms/u/s!AbC?e=x')).toBe(
      `https://api.onedrive.com/v1.0/shares/u!${Buffer.from('https://1drv.ms/u/s!AbC?e=x').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}/root/content`,
    );
  });
  it('mega links: file with key parsed; keyless links refused', async () => {
    expect(parseMegaLink(new URL('https://mega.nz/file/AbCd123#k3y-_x'))).toEqual({ kind: 'file', id: 'AbCd123', key: 'k3y-_x' });
    expect(parseMegaLink(new URL('https://mega.nz/#!AbCd123!k3y'))).toEqual({ kind: 'file', id: 'AbCd123', key: 'k3y' });
    expect(parseMegaLink(new URL('https://mega.nz/file/AbCd123'))).toBeNull();
    await expect(resolverFor('https://mega.nz/file/AbCd123').resolve(new URL('https://mega.nz/file/AbCd123'), ctx)).rejects.toThrow(/no decryption key/);
    await expect(resolverFor('https://mega.nz/folder/X#k').resolve(new URL('https://mega.nz/folder/X#k'), ctx)).rejects.toThrow(/folder/);
  });
  it('gdrive file ids', () => {
    expect(gdriveFileId(new URL('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'))).toBe('1AbCdEfGhIjKlMnOp');
    expect(gdriveFileId(new URL('https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOp&export=download'))).toBe('1AbCdEfGhIjKlMnOp');
  });
});

describe('Google Drive page interpretation', () => {
  it('follows the virus-scan notice form (same as clicking "Download anyway")', () => {
    const html = `<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
      <input type="hidden" name="id" value="FILEID"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>`;
    const o = interpretGdriveHtml(html, 'https://drive.usercontent.google.com/download?id=FILEID');
    expect(o.kind).toBe('confirm');
    const u = new URL((o as any).url);
    expect(u.searchParams.get('confirm')).toBe('t');
    expect(u.searchParams.get('uuid')).toBe('u-1');
  });
  it('reports quota and sign-in walls as restricted', () => {
    expect(interpretGdriveHtml('Too many users have viewed or downloaded this file recently', 'https://x').kind).toBe('restricted');
    expect(interpretGdriveHtml('<a href="https://accounts.google.com/ServiceLogin">', 'https://x').kind).toBe('restricted');
    expect(interpretGdriveHtml('Sorry, the file you have requested does not exist.', 'https://x').kind).toBe('dead');
  });
});

describe('MediaFire page interpretation', () => {
  it('reads the public download button', () => {
    const o = interpretMediafireHtml(`<div class="filename">save.zip</div><a class="input popsok" aria-label="Download file" href="https://download1234.mediafire.com/abc/save.zip" id="downloadButton">Download (1.2MB)</a>`);
    expect(o).toMatchObject({ kind: 'link', url: 'https://download1234.mediafire.com/abc/save.zip', filename: 'save.zip' });
  });
  it('decodes the page-provided scrambled URL attribute', () => {
    const url = 'https://download99.mediafire.com/x/y/save.rar';
    const o = interpretMediafireHtml(`<a id="downloadButton" href="javascript:void(0)" data-scrambled-url="${Buffer.from(url).toString('base64')}">Download</a>`);
    expect(o).toMatchObject({ kind: 'link', url });
  });
  it('never bypasses captchas or passwords; flags deleted files', () => {
    expect(interpretMediafireHtml('<div class="g-recaptcha"></div>').kind).toBe('restricted');
    expect(interpretMediafireHtml('This file is password protected').kind).toBe('restricted');
    expect(interpretMediafireHtml('Invalid or Deleted File.').kind).toBe('dead');
  });
  it('rejects buttons that point off MediaFire', () => {
    expect(interpretMediafireHtml('<a id="downloadButton" href="https://evil.example/x.zip">').kind).toBe('unknown');
  });
});

describe('link extraction from forum posts', () => {
  it('keeps file-host links and archive URLs, ignores others', () => {
    const html = `<p>Platinum save for CUSA00207 by Bob</p>
      <a href="https://www.mediafire.com/file/abc/plat.zip/file">MediaFire</a>
      <a href="https://example.com/about">about</a>
      mirror: https://mega.nz/file/Xyz#Key1 and https://cdn.example.org/saves/plat.7z.
      <a href="/attachments/123/save.zip">attachment</a>`;
    const links = extractFileLinks(html, 'https://forum.example.net/threads/1');
    expect(links.map((l) => l.host)).toEqual(['mediafire', 'direct', 'mega', 'direct']);
    expect(links.find((l) => l.url.endsWith('save.zip'))?.url).toBe('https://forum.example.net/attachments/123/save.zip');
    expect(classifyLink('https://example.com/page')).toBeNull();
  });
  it('normalises tracking params but keeps MEGA keys', () => {
    expect(normalizeLink('https://Example.com/a.zip?utm_source=x&id=1#frag')).toBe('https://example.com/a.zip?id=1');
    expect(normalizeLink('https://mega.nz/file/A#key')).toBe('https://mega.nz/file/A#key');
  });
});
