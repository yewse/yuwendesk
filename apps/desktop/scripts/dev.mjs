// 开发启动：启动 Vite 开发服务器（仅开发用，打包后不存在）并拉起 Electron。
// 教师使用的正式版不含开发服务器，也不监听任何本地端口。
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

async function main() {
  const server = await createServer();
  await server.listen();
  const info = server.config.server;
  const url = `http://${info.host || '127.0.0.1'}:${server.config.server.port}`;
  server.printUrls();

  // 编译主进程/预加载。
  await run('npx', ['tsc', '-p', 'tsconfig.main.json']);

  const child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url }
  });
  child.on('close', async () => {
    await server.close();
    process.exit(0);
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
