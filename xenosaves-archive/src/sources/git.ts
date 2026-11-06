import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Git-based access to public GitHub repositories: a blobless (--filter=blob:none) clone gives the full
 * file tree, blob ids and history without downloading file contents. Blob ids double as published
 * content hashes (git-blob-sha1) used to verify each downloaded file.
 */
function git(args: string[], cwd?: string, timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err += d.toString()));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`git ${args.slice(0, 2).join(' ')} failed (${code}): ${err.trim().slice(0, 500)}`));
    });
  });
}

export function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.includes('..');
}

export class GitRepo {
  constructor(public dir: string, public repo: string) {}

  static async sync(cacheDir: string, repo: string, ref?: string): Promise<GitRepo> {
    if (!validRepo(repo)) throw new Error(`invalid repository name ${repo}`);
    const dir = path.join(cacheDir, repo.replace('/', '__'));
    const url = `https://github.com/${repo}.git`;
    if (!fs.existsSync(path.join(dir, 'HEAD')) && !fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(cacheDir, { recursive: true });
      await git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--bare', url, dir]);
    } else {
      await git(['fetch', '--quiet', '--prune', '--filter=blob:none', 'origin', '+refs/heads/*:refs/heads/*'], dir);
    }
    const r = new GitRepo(dir, repo);
    if (ref) await r.revParse(ref);
    return r;
  }

  async revParse(ref = 'HEAD'): Promise<string> {
    return (await git(['rev-parse', `${ref}^{commit}`], this.dir)).trim();
  }

  async defaultBranch(): Promise<string> {
    const s = (await git(['symbolic-ref', '--short', 'HEAD'], this.dir).catch(() => 'master')).trim();
    return s || 'master';
  }

  /** All blobs under a path: [{path, oid}] — no contents fetched. */
  async lsTree(commit: string, prefix = ''): Promise<Array<{ path: string; oid: string; mode: string }>> {
    const out = await git(['ls-tree', '-r', '-z', '--full-tree', commit, ...(prefix ? ['--', prefix] : [])], this.dir);
    return out
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const [mode, type, oid] = line.slice(0, tab).split(' ');
        return { path: line.slice(tab + 1), oid, mode, type };
      })
      .filter((e) => e.type === 'blob');
  }

  /** Small text file contents (lazily fetched blob). */
  async show(commit: string, filePath: string): Promise<string | null> {
    try {
      return await git(['show', `${commit}:${filePath}`], this.dir, 120_000);
    } catch {
      return null;
    }
  }

  /** First commit that added each file under prefix: path -> {author, date, commit}. */
  async firstAdds(commit: string, prefix: string): Promise<Map<string, { author: string; date: string; commit: string }>> {
    const out = await git(
      ['log', '--diff-filter=A', '--no-renames', '--format=%x01%H%x02%an%x02%aI', '--name-only', commit, '--', prefix],
      this.dir,
    );
    const map = new Map<string, { author: string; date: string; commit: string }>();
    for (const block of out.split('\x01').filter(Boolean)) {
      const [header, ...files] = block.split('\n');
      const [hash, author, date] = header.split('\x02');
      for (const f of files.map((s) => s.trim()).filter(Boolean)) {
        // log is newest-first; keep overwriting so the oldest add wins
        map.set(f, { author, date, commit: hash });
      }
    }
    return map;
  }
}

/** git blob id of content: sha1("blob <len>\0" + data) */
export function gitBlobSha1Header(size: number): Buffer {
  return Buffer.from(`blob ${size}\0`, 'utf8');
}
