import fs from 'node:fs/promises';
import { nowIso, pathExists, readJson, sha256File, writeJsonAtomic } from './utils.mjs';

async function describeOutput(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) return null;
  return {
    path: file,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: await sha256File(file),
  };
}

export class StateStore {
  constructor(file) {
    this.file = file;
    this.state = { schemaVersion: 1, createdAt: nowIso(), updatedAt: nowIso(), stages: {} };
  }

  async load() {
    if (await pathExists(this.file)) this.state = await readJson(this.file);
    return this;
  }

  async canReuse(stage, fingerprint, outputs = [], { mutableOutputs = [] } = {}) {
    const current = this.state.stages[stage];
    if (!current || current.status !== 'succeeded' || current.fingerprint !== fingerprint) return false;
    const mutable = new Set(mutableOutputs);
    for (const output of outputs) {
      const actual = await describeOutput(output);
      if (!actual) return false;
      const recorded = current.outputRecords?.find((item) => item.path === output);
      if (!recorded) return false;
      const changed = actual.size !== recorded.size || actual.mtimeMs !== recorded.mtimeMs || (recorded.sha256 && actual.sha256 !== recorded.sha256);
      if (changed && !mutable.has(output)) return false;
    }
    return true;
  }

  async start(stage, fingerprint) {
    const previous = this.state.stages[stage];
    const lastSucceeded = previous?.status === 'succeeded'
      ? {
          fingerprint: previous.fingerprint,
          completedAt: previous.completedAt,
          outputs: previous.outputs,
          outputRecords: previous.outputRecords,
          metadata: previous.metadata,
        }
      : previous?.lastSucceeded || null;
    this.state.stages[stage] = {
      status: 'running', fingerprint, startedAt: nowIso(), completedAt: null, outputs: [], error: null, lastSucceeded,
    };
    await this.save();
  }

  async succeed(stage, outputs = [], metadata = {}) {
    const current = this.state.stages[stage] || {};
    const outputRecords = [];
    for (const output of outputs) {
      const record = await describeOutput(output);
      if (!record) throw new Error(`階段 ${stage} 宣告的輸出不存在或為空：${output}`);
      outputRecords.push(record);
    }
    this.state.stages[stage] = {
      ...current,
      status: 'succeeded', completedAt: nowIso(), outputs, outputRecords, metadata, error: null,
    };
    await this.save();
  }

  async fail(stage, error) {
    const current = this.state.stages[stage] || {};
    this.state.stages[stage] = {
      ...current,
      status: 'failed', completedAt: nowIso(), error: String(error?.stack || error),
    };
    await this.save();
  }

  async save() {
    this.state.updatedAt = nowIso();
    await writeJsonAtomic(this.file, this.state);
  }
}
