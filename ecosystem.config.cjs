module.exports = {
  apps: [
    {
      name: 'mymusicanywhere',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3333',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3333
      }
    }
  ]
};
