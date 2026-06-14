import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cachedLabel: string | null = null;

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Short label for logs: package version + git commit when available. */
export function getBuildLabel(): string {
  if (cachedLabel) {
    return cachedLabel;
  }

  const version = readPackageVersion();
  try {
    const commit = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
    cachedLabel = commit ? `v${version}@${commit}` : `v${version}`;
  } catch {
    cachedLabel = `v${version}`;
  }

  return cachedLabel;
}
