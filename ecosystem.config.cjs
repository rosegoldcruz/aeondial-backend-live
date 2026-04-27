module.exports = {
  apps: [
    {
      name: 'aeondial-api',
      script: 'dist/index.js',
      cwd: '/var/www/aeondial/backend',
      env_file: '/var/www/aeondial/backend/.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      error_file: '/var/log/aeondial/api-error.log',
      out_file: '/var/log/aeondial/api-out.log',
      env: {
        NODE_ENV: 'production',
      }
    },
    {
      name: 'aeondial-worker',
      script: 'dist/workers/dialer.js',
      cwd: '/var/www/aeondial/backend',
      env_file: '/var/www/aeondial/backend/.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      error_file: '/var/log/aeondial/worker-error.log',
      out_file: '/var/log/aeondial/worker-out.log',
      env: {
        NODE_ENV: 'production',
      }
    },
  ],
};
