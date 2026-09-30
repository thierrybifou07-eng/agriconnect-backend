import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Tests purs : aucune base de donnees, aucun serveur.
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.js'],
          environment: 'node',
        },
      },
      {
        // Tests HTTP : base de test dediee, creee et migree avant la suite.
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.js', 'tests/static/**/*.test.js'],
          environment: 'node',
          globalSetup: ['tests/setup/integration.js'],
          setupFiles: ['tests/setup/env.js', 'tests/setup/hooks.js'],
          // Serialisation stricte, indispensable : chaque test tronque les
          // tables de la base dediee, donc deux fichiers de test paralleles se
          // ecraseraient mutuellement (violations de cle etrangere
          // aleatoires). fileParallelism seul ne suffit pas, il faut aussi
          // forcer un seul processus.
          fileParallelism: false,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 20000,
          hookTimeout: 120000,
        },
      },
    ],
  },
});
