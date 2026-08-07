import { spawn } from 'node:child_process'

const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js'], {
  stdio: 'inherit',
})
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })

function shutdown() {
  server.kill()
  vite.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
