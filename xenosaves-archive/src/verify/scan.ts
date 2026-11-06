import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

/**
 * Malware scanning via ClamAV (clamd INSTREAM over TCP, or the clamscan CLI).
 * When no scanner/signature database is available the result is 'not_run' — never reported as clean.
 */
export type ScanStatus = 'clean' | 'infected' | 'error' | 'not_run';

export interface ScanResult {
  engine: string;
  status: ScanStatus;
  signature?: string;
  detail?: string;
}

export interface ScannerConfig {
  clamscanPath?: string;
  clamdHost?: string;
  clamdPort: number;
}

function clamDbPresent(): boolean {
  for (const dir of ['/var/lib/clamav', '/usr/local/share/clamav']) {
    try {
      if (fs.readdirSync(dir).some((f) => /^(main|daily)\.(cvd|cld)$/.test(f))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export async function scanFile(filePath: string, cfg: ScannerConfig): Promise<ScanResult> {
  if (cfg.clamdHost) return scanWithClamd(filePath, cfg.clamdHost, cfg.clamdPort);
  const bin = cfg.clamscanPath ?? (fs.existsSync('/usr/bin/clamscan') ? '/usr/bin/clamscan' : undefined);
  if (!bin) return { engine: 'clamav', status: 'not_run', detail: 'no ClamAV scanner configured' };
  if (!clamDbPresent()) return { engine: 'clamav', status: 'not_run', detail: 'ClamAV signature database not installed (run freshclam)' };
  return new Promise((resolve) => {
    const child = spawn(bin, ['--no-summary', '--stdout', '--infected', '--scan-archive=yes', '--alert-encrypted=no', '--max-filesize=2000M', '--max-scansize=4000M', '--', filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    const t = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ engine: 'clamscan', status: 'error', detail: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ engine: 'clamscan', status: 'clean' });
      else if (code === 1) resolve({ engine: 'clamscan', status: 'infected', signature: out.match(/: (.+) FOUND/)?.[1] ?? 'unknown' });
      else resolve({ engine: 'clamscan', status: 'error', detail: out.trim().slice(0, 500) });
    });
  });
}

function scanWithClamd(filePath: string, host: string, port: number): Promise<ScanResult> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let reply = '';
    let settled = false;
    const finish = (r: ScanResult) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(15 * 60_000, () => finish({ engine: 'clamd', status: 'error', detail: 'timeout' }));
    sock.on('error', (e) => finish({ engine: 'clamd', status: 'error', detail: e.message }));
    sock.on('data', (d) => (reply += d.toString()));
    sock.on('end', () => {
      const msg = reply.replace(/\0/g, '').trim();
      if (/: OK$/.test(msg)) finish({ engine: 'clamd', status: 'clean' });
      else if (/FOUND$/.test(msg)) finish({ engine: 'clamd', status: 'infected', signature: msg.match(/: (.+) FOUND/)?.[1] });
      else finish({ engine: 'clamd', status: 'error', detail: msg.slice(0, 500) });
    });
    sock.on('connect', async () => {
      sock.write('zINSTREAM\0');
      const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        if (!sock.write(Buffer.concat([len, chunk]))) await new Promise((r) => sock.once('drain', r));
      }
      sock.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
    });
  });
}
