// llama.cpp build/upgrade pipeline (gap G3, docs/gap-analysis.md).
// Mirrors the old dashboard upgrade.py: git fetch -> dirty/diverged guard ->
// --ff-only merge -> cmake --build in the existing configured build dir.
// Streams progress line-by-line; a caller supplies an emit callback.
import { spawn } from 'node:child_process';

export class UpgradeError extends Error {}

async function run(cmd: string[], cwd: string, emit: (line: string) => void, timeoutMs = 600_000): Promise<number> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const onData = (buf: Buffer) => {
            out += buf.toString();
            for (const line of out.split(/\r?\n/)) {
                if (line.trim()) emit(line);
            }
            out = out.slice(out.lastIndexOf('\n') + 1);
        };
        proc.stdout?.on('data', onData);
        proc.stderr?.on('data', onData);
        const timer = setTimeout(() => { proc.kill('SIGKILL'); }, timeoutMs);
        proc.on('error', err => { clearTimeout(timer); reject(new UpgradeError(err.message)); });
        proc.on('close', code => {
            clearTimeout(timer);
            resolve(code ?? 1);
        });
    });
}

export async function runUpgrade(repoDir: string, buildDir: string, emit: (line: string) => void): Promise<void> {
    emit('== fetching origin in ' + repoDir + ' ==');
    let code = await run(['git', 'fetch', 'origin'], repoDir, emit);
    if (code !== 0) throw new UpgradeError('git fetch failed (exit ' + code + ')');

    const status = await run(['git', 'status', '--porcelain'], repoDir, emit);
    // status is not a real exit signal; re-check via a dedicated command below
    const porcelain = await new Promise<string>(resolve => {
        const proc = spawn('git', ['status', '--porcelain'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] });
        let text = '';
        proc.stdout?.on('data', (b: Buffer) => { text += b.toString(); });
        proc.on('close', () => resolve(text));
    });
    if (porcelain.trim().length > 0) {
        emit('ERROR: working tree is dirty, refusing to auto-update');
        emit(porcelain.trim());
        throw new UpgradeError('dirty working tree');
    }

    const anc = await new Promise<number>(resolve => {
        const proc = spawn('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/master'], { cwd: repoDir, stdio: 'ignore' });
        proc.on('close', c => resolve(c ?? 1));
    });
    if (anc !== 0) {
        emit('ERROR: local master has diverged from origin/master, refusing to auto-update');
        throw new UpgradeError('diverged history');
    }

    const before = await new Promise<string>(resolve => {
        const proc = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] });
        let text = '';
        proc.stdout?.on('data', (b: Buffer) => { text += b.toString(); });
        proc.on('close', () => resolve(text.trim()));
    });

    emit('== merging (fast-forward only) ==');
    code = await run(['git', 'merge', '--ff-only', 'origin/master'], repoDir, emit);
    if (code !== 0) throw new UpgradeError('git merge --ff-only failed (exit ' + code + ')');

    const after = await new Promise<string>(resolve => {
        const proc = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] });
        let text = '';
        proc.stdout?.on('data', (b: Buffer) => { text += b.toString(); });
        proc.on('close', () => resolve(text.trim()));
    });
    if (before === after) emit('Already up to date at ' + before + '.');
    else emit('Updated ' + before + ' -> ' + after);

    emit('== building in ' + buildDir + ' ==');
    code = await run(['cmake', '--build', buildDir, '-j', String(Math.max(1, (require('node:os') as typeof import('node:os')).cpus().length - 1))], buildDir, emit);
    if (code !== 0) throw new UpgradeError('cmake --build failed (exit ' + code + ')');

    emit('== verifying binary ==');
    code = await run(['./bin/llama-server', '--version'], buildDir, emit);
    if (code !== 0) throw new UpgradeError('llama-server --version failed (exit ' + code + ')');
    emit('== done ==');
}
