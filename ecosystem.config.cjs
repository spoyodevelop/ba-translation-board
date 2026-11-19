// 전용 사용자(tbworker)의 PM2로 시작한다. root로 실행하면 Chrome sandbox를 쓸 수 없어 worker가 시작을 거부한다.
// interpreter는 PM2를 실행한 Node이므로, 그 Node도 tbworker가 읽을 수 있는 곳에 있어야 한다.
module.exports = {
  apps: [
    {
      name: "translation-board-worker",
      cwd: __dirname,
      script: "scripts/worker.ts",
      args: "run",
      interpreter: process.execPath,
      // Healthchecks 연결은 기본 주소별 대기 250ms보다 오래 걸릴 수 있다.
      node_args:
        "--env-file-if-exists=.env.local --experimental-strip-types --network-family-autoselection-attempt-timeout=1000",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      restart_delay: 10_000,
      kill_timeout: 30_000,
      watch: false,
      env: { NODE_ENV: "production" },
    },
  ],
};
