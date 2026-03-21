import { resolve } from 'path';
import { readdirSync, existsSync } from 'fs';

// Auto-discover game entry points from games/ directory
function getGameEntries() {
  const gamesDir = resolve(__dirname, 'games');
  const entries = {
    main: resolve(__dirname, 'index.html'),
  };

  if (existsSync(gamesDir)) {
    const games = readdirSync(gamesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .filter(d => existsSync(resolve(gamesDir, d.name, 'index.html')));

    for (const game of games) {
      entries[game.name] = resolve(gamesDir, game.name, 'index.html');
    }
  }

  return entries;
}

export default {
  root: '.',
  build: {
    rollupOptions: {
      input: getGameEntries(),
    },
  },
  server: {
    host: true,
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
};
