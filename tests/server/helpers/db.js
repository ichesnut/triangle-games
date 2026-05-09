import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Create a fresh temp DATA_DIR and set the env var before any module that
// reaches db.js gets imported. Each test file should call this at the top
// level *before* importing anything that touches the DB.
export function freshDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tri-test-'));
  process.env.DATA_DIR = dir;
  return dir;
}
