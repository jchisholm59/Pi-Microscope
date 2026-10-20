// pm2: pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{ name: 'pi-microscope', script: 'server.py', interpreter: 'python3', cwd: __dirname, env: { PORT: 8075, PYTHONUNBUFFERED: '1' }, kill_timeout: 5000, restart_delay: 3000 }],
};
