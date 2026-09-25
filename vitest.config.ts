import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Legacy decorators with emitted metadata, as in the nestjs/nest monorepo, so
  // parameter decorators and DI type lookup work in the specs.
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
  test: {
    globalSetup: ['tests/support/global-setup.ts'],
    include: ['tests/**/*.spec.ts'],
    globals: true,
    setupFiles: ['reflect-metadata'],
  },
});
