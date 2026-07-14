module.exports = {
  apps: [{
    name: 'dashboard',
    script: 'server4.js',
    cwd: __dirname,
    restart_delay: 2000,   // wait 2s between restart attempts
    max_restarts: 20,      // give up after 20 restarts within min_uptime windows (crash-loop guard)
    min_uptime: 5000,      // must stay up 5s to count as a stable start
    autorestart: true
  }]
};
