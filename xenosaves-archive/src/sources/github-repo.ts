import { suggestCategory } from '../metadata/category.js';
import { extractTitleId, platformForTitleId, regionFromText } from '../metadata/titleid.js';
import { GitRepo } from './git.js';
import { detectLicense } from './license.js';
import type { DiscoveredItem, SourceConnector, SourceContext } from './types.js';

/**
 * Any public GitHub repository that stores save archives as files.
 * Redistribution is granted ONLY when the repository carries a licence that permits it
 * (or the owner records explicit permission on the source); otherwise items stay PERMISSION_PENDING.
 */
const ARCHIVE_RE = /\.(zip|rar|7z)$/i;

export const githubRepoConnector: SourceConnector = {
  kind: 'github-repo',
  description: 'Save archives committed to a public GitHub repository (licence-gated)',
  liveTested: true,
  async *discover(ctx: SourceContext): AsyncIterable<DiscoveredItem> {
    const repoName: string = ctx.source.config.repo;
    if (!repoName) throw new Error('github-repo source needs config.repo');
    const include = ctx.source.config.include ? new RegExp(ctx.source.config.include, 'i') : null;
    const repo = await GitRepo.sync(ctx.cfg.gitCacheDir, repoName);
    const branch = ctx.source.config.ref ?? (await repo.defaultBranch());
    const commit = await repo.revParse(branch);
    const tree = await repo.lsTree(commit);
    const licFile = tree.find((e) => /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(e.path));
    const lic = detectLicense(licFile ? await repo.show(commit, licFile.path) : null);
    const evidence = licFile ? `https://github.com/${repoName}/blob/${commit}/${licFile.path}` : null;
    const ownerEvidence = ctx.source.policy === 'MIRROR_ALLOWED' && ctx.source.permission_evidence;
    const adds = await repo.firstAdds(commit, '.');
    const platformHint = ctx.source.config.platform as 'PS4' | 'PS5' | undefined;

    for (const e of tree) {
      if (!ARCHIVE_RE.test(e.path) || (include && !include.test(e.path))) continue;
      const segments = e.path.split('/');
      const filename = segments[segments.length - 1];
      const folder = segments.length > 1 ? segments[segments.length - 2] : null;
      const titleId = extractTitleId(e.path);
      const platform = platformForTitleId(titleId) ?? platformHint ?? (/\bps5\b/i.test(e.path) ? 'PS5' : /\bps4\b/i.test(e.path) ? 'PS4' : null);
      // Game title only when the path visibly names it: folder name (minus a title id) or file stem.
      const nameSource = folder && !/^(saves?|ps4|ps5|files?)$/i.test(folder) ? folder : filename.replace(ARCHIVE_RE, '');
      const gameTitle = nameSource.replace(/\b(CUSA|PPSA)[-_ ]?\d{5}\b/gi, '').replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim() || null;
      const add = adds.get(e.path);
      const pathText = e.path.replace(/[_/-]+/g, ' ');
      const category = suggestCategory(pathText);
      const granted = lic.redistributable || Boolean(ownerEvidence);
      yield {
        sourceItemKey: e.path,
        sourcePageUrl: `https://github.com/${repoName}/blob/${branch}/${e.path.split('/').map(encodeURIComponent).join('/')}`,
        downloadUrl: `https://raw.githubusercontent.com/${repoName}/${commit}/${e.path.split('/').map(encodeURIComponent).join('/')}`,
        fileHost: 'github',
        platform: platform as any,
        gameTitle,
        titleId,
        region: regionFromText(pathText),
        regionSource: regionFromText(pathText) ? 'source-path' : null,
        category,
        categorySource: category ? 'keyword-heuristic' : null,
        description: null,
        uploadedBy: add?.author ?? null,
        uploadedBySource: add ? 'git-commit-author' : null,
        originalFilename: filename,
        fileFormat: filename.split('.').pop()!.toLowerCase(),
        expectedHash: `git-blob-sha1:${e.oid}`,
        redistribution: granted ? 'granted' : 'pending',
        permissionBasis: lic.redistributable
          ? `${lic.spdx} licence (${lic.note}) — ${evidence}`
          : ownerEvidence
            ? `owner-recorded permission: ${ctx.source.permission_evidence}`
            : null,
        raw: { repo: repoName, commit, license: lic, added_at: add?.date ?? null, added_in_commit: add?.commit ?? null },
      };
    }
  },
};
