import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { env } from './config/env';

/**
 * Leaves the process no way to linger.
 *
 * Both Redis connections keep the event loop alive on their own, so a process
 * that stops serving does not exit by itself — it just sits there holding the
 * port. Under `nest start --watch` that is fatal: the watcher spawns a
 * replacement on every save, the replacement cannot bind, and the corpse from
 * the *first* failure keeps serving stale code for the rest of the session.
 * So every exit path here ends in an explicit process.exit, and app.close()
 * gets a deadline it cannot overrun.
 */
async function shutdown(app: INestApplication, code: number): Promise<never> {
  const timer = setTimeout(() => process.exit(code), 5_000);
  timer.unref();

  try {
    await app.close();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(`error while closing: ${message}`, 'Bootstrap');
    process.exit(1);
  }

  process.exit(code);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Required for RedisService.onApplicationShutdown to run, so connections
  // close instead of being cut off with the process.
  app.enableShutdownHooks();

  // `nest start --watch` SIGTERMs the old process and spawns its replacement
  // immediately; the old one has to be gone, not merely closing.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      Logger.log(`received ${signal}, shutting down`, 'Bootstrap');
      void shutdown(app, 0);
    });
  }

  try {
    await app.listen(env.PORT);
  } catch (error: unknown) {
    // EADDRINUSE lands here. Without the close-and-exit the failed process
    // stays up holding whatever it did manage to open.
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(`failed to listen on ${env.PORT}: ${message}`, 'Bootstrap');
    await shutdown(app, 1);
  }
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  Logger.error(`failed to start: ${message}`, 'Bootstrap');
  process.exit(1);
});
