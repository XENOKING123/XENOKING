import { suggestCategory } from '../metadata/category.js';
import { extractTitleId, platformForTitleId, regionFromText } from '../metadata/titleid.js';
import { GitRepo } from './git.js';
import type { DiscoveredItem, SourceConnector, SourceContext } from './types.js';

/**
 * Apollo Save Tool online database (github.com/bucanero/apollo-saves), GPL-3.0.
 * Layout: <PLATFORM>/games.txt ("TITLEID=Name"), <PLATFORM>/<TITLEID>/saves.txt ("NNNNNNNN.zip=Description"),
 * and the zips themselves. Read via a blobless git clone so we get blob ids (published hashes) and
 * per-file commit history (uploader attribution) without fetching file contents during discovery.
 */
export function parseKeyValueList(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return out;
}

export const apolloConnector: SourceConnector = {
  kind: 'apollo-db',
  description: 'Apollo Save Tool online database on GitHub (games.txt / saves.txt index + zip files)',
  liveTested: true,
  async *discover(ctx: SourceContext): AsyncIterable<DiscoveredItem> {
    const repoName: string = ctx.source.config.repo ?? 'bucanero/apollo-saves';
    const platforms: string[] = ctx.source.config.platforms ?? ['PS4'];
    const repo = await GitRepo.sync(ctx.cfg.gitCacheDir, repoName);
    const branch = ctx.source.config.ref ?? (await repo.defaultBranch());
    const commit = await repo.revParse(branch);
    ctx.log.info({ source: ctx.source.id, repo: repoName, commit }, 'apollo: synced repository');

    for (const plat of platforms) {
      const gamesTxt = await repo.show(commit, `${plat}/games.txt`);
      if (!gamesTxt) {
        ctx.log.warn({ plat }, 'apollo: games.txt missing');
        continue;
      }
      const games = new Map(parseKeyValueList(gamesTxt));
      const tree = await repo.lsTree(commit, `${plat}/`);
      const blobs = new Map(tree.map((e) => [e.path, e.oid]));
      const adds = await repo.firstAdds(commit, `${plat}/`);
      const byGame = new Map<string, string[]>();
      for (const e of tree) {
        const m = e.path.match(new RegExp(`^${plat}/([A-Z0-9]{4}\\d{5})/([^/]+\\.zip)$`, 'i'));
        if (m) byGame.set(m[1], [...(byGame.get(m[1]) ?? []), m[2]]);
      }
      for (const [titleIdDir, zips] of byGame) {
        const savesTxt = (await repo.show(commit, `${plat}/${titleIdDir}/saves.txt`)) ?? '';
        const descriptions = new Map(parseKeyValueList(savesTxt));
        for (const zip of zips.sort()) {
          const path = `${plat}/${titleIdDir}/${zip}`;
          const description = descriptions.get(zip) ?? null;
          const titleId = extractTitleId(titleIdDir);
          const add = adds.get(path);
          const category = suggestCategory(description);
          const listed = descriptions.has(zip);
          yield {
            sourceItemKey: path,
            sourcePageUrl: `https://github.com/${repoName}/tree/${branch}/${plat}/${titleIdDir}`,
            downloadUrl: `https://raw.githubusercontent.com/${repoName}/${commit}/${path}`,
            fileHost: 'github',
            platform: (platformForTitleId(titleId) ?? (plat === 'PS5' ? 'PS5' : plat === 'PS4' ? 'PS4' : null)) as any,
            gameTitle: games.get(titleIdDir) ?? null,
            titleId,
            region: regionFromText(description),
            regionSource: regionFromText(description) ? 'source-description' : null,
            category,
            categorySource: category ? 'keyword-heuristic' : null,
            description,
            originalAuthor: null, // Apollo's index does not name save creators
            uploadedBy: add?.author ?? null,
            uploadedBySource: add ? 'git-commit-author (person who committed the file; may be the maintainer)' : null,
            originalFilename: zip,
            fileFormat: 'zip',
            expectedHash: blobs.get(path) ? `git-blob-sha1:${blobs.get(path)}` : null,
            raw: {
              repo: repoName,
              commit,
              listed_in_saves_txt: listed,
              added_in_commit: add?.commit ?? null,
              added_at: add?.date ?? null,
              game_listed_in_games_txt: games.has(titleIdDir),
            },
          };
        }
      }
    }
  },
};
