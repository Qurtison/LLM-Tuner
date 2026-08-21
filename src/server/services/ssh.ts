import { spawn } from 'node:child_process';

export function isValidSSHHost(host: string): boolean {
    return /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(host);
}

export function runSSHCommand(host: string, command: string): Promise<{ stdout: string; stderr: string }> {
    if (!isValidSSHHost(host)) throw new Error('Invalid SSH host format');
    return new Promise((resolve, reject) => {
        const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, command]);
        let stdout = '';
        let stderr = '';
        ssh.stdout.on('data', data => { stdout += data; });
        ssh.stderr.on('data', data => { stderr += data; });
        ssh.on('close', code => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(stderr || `SSH exited with code ${code}`));
        });
        ssh.on('error', reject);
    });
}
