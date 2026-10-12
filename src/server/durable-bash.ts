import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { bashJobKey, bashCancelPath } from "./durable-bash-cancel";

// A detached local supervisor owns the shell, its deadline and spool files.
// Service shutdown cancels only the waiter. A replay observes the same receipt.
const SUPERVISOR = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const job = JSON.parse(process.argv[1]);
try { fs.mkdirSync(path.join(job.directory,'claim')); } catch (error) { if (error.code === 'EEXIST') process.exit(0); throw error; }
const receipt = path.join(job.directory, 'receipt.json');
const save = value => { value.identity=job.identity; fs.writeFileSync(receipt+'.tmp', JSON.stringify(value)); fs.renameSync(receipt+'.tmp', receipt); };
const startedAt = Date.now();
save({status:'starting', supervisorPid:process.pid, startedAt});
if(fs.existsSync(job.cancelPath)) { save({status:'done',exitCode:130,startedAt,endedAt:Date.now()}); process.exit(0); }
let command = job.command;
let output;
if(process.platform === 'win32') {
  // Git Bash cannot reliably write to inherited Node file descriptors.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  command = 'exec >> ' + quote(path.join(job.directory, 'output').replaceAll('\\','/')) + ' 2>&1\n' + command;
} else {
  output = fs.openSync(path.join(job.directory, 'output'), 'a');
}
const child = spawn(job.shell, ['-c', command], {cwd:job.cwd, env:job.env, detached:true, windowsHide:true, stdio:process.platform === 'win32' ? 'ignore' : ['ignore',output,output]});
if(process.platform !== 'win32') fs.closeSync(output);
save({status:'running', supervisorPid:process.pid, pid:child.pid, startedAt});
let timer;
let cancelled=false;
let killTimer;
const kill=signal=>{ if(!child.pid)return; if(process.platform==='win32') { spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); } else { try{process.kill(-child.pid,signal)}catch{} } };
const cancel=()=>{ if(cancelled)return; cancelled=true; kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),500); };
const monitor=setInterval(()=>{if(fs.existsSync(job.cancelPath))cancel()},20);
if(fs.existsSync(job.cancelPath))cancel();
if(job.timeout) timer=setTimeout(()=>kill('SIGKILL'),job.timeout*1000);
child.on('error', error=>{fs.appendFileSync(path.join(job.directory,'output'),error.message+'\n');save({status:'done',exitCode:1,startedAt,endedAt:Date.now()})});
child.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(killTimer);clearInterval(monitor); const signals={SIGTERM:15,SIGKILL:9,SIGINT:2};save({status:'done',exitCode:cancelled ? 130 : code ?? 128+(signals[signal] ?? 1),startedAt,endedAt:Date.now()})});
`;

export function persistentBashOperations(jobsDir: string, taskId: string): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      await fs.mkdir(jobsDir, { recursive: true });
      const directory = path.join(jobsDir, bashJobKey(taskId));
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "intent.json"), JSON.stringify({ identity: taskId }));
      const supervisor = spawn(
        process.execPath,
        [
          "-e",
          SUPERVISOR,
          JSON.stringify({
            directory,
            identity: taskId,
            cancelPath: bashCancelPath(jobsDir, taskId),
            command,
            shell:
              process.env.BATTY_BASH_PATH ??
              (process.platform === "win32"
                ? "C:\\Program Files\\Git\\bin\\bash.exe"
                : "/bin/bash"),
            cwd,
            env: options.env ?? process.env,
            timeout: options.timeout,
          }),
        ],
        {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      await new Promise<void>((resolve, reject) => {
        supervisor.once("spawn", resolve);
        supervisor.once("error", reject);
      });
      supervisor.unref();
      let position = 0;
      while (true) {
        options.signal?.throwIfAborted();
        let receipt: { status: string; exitCode: number; supervisorPid?: number } | undefined;
        try {
          receipt = JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          const file = await fs.open(path.join(directory, "output"), "r");
          try {
            const size = (await file.stat()).size;
            while (position < size) {
              const chunk = Buffer.alloc(Math.min(64 * 1024, size - position));
              const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
              position += bytesRead;
              options.onData(chunk.subarray(0, bytesRead));
            }
          } finally {
            await file.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (receipt?.status === "done") return { exitCode: receipt.exitCode };
        if (receipt?.supervisorPid) {
          try {
            process.kill(receipt.supervisorPid, 0);
          } catch {
            throw new Error(`Bash supervisor died without completing receipt: ${directory}`);
          }
        }
        await delay(100, undefined, { signal: options.signal });
      }
    },
  };
}
