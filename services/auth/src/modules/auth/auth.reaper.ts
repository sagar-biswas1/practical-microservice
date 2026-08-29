import { logger, type Logger } from "../../lib/logger.js";
import { fail, ok, type Result } from "../../utils/result.js";
import type { AuthRepository } from "./auth.repository.js";

export interface ReaperOptions {
  /**
   * Grace period before an *expired* refresh token is deleted. Past its
   * `expiresAt` the row can never be accepted again, so this exists only to
   * keep the recent past readable while someone debugs a session that ended.
   */
  expiredGraceDays: number;
  /**
   * How long a *revoked* refresh token is kept. Longer than the expired grace
   * on purpose: these are the interesting rows. A `REUSE_DETECTED` family is
   * the only record that a session was stolen, and that investigation rarely
   * starts the same day.
   */
  revokedRetentionDays: number;
  /** How long a settled verification code is kept. `0` disables that sweep. */
  verificationRetentionDays: number;
  /** How long login history is kept. `0` disables that sweep. */
  loginHistoryRetentionDays: number;
  /** Rows removed per table per cycle. Bounds the cost of one sweep. */
  batchSize: number;
  /** Gap between sweeps. */
  intervalMs: number;
  /** Injectable clock — the tests need it deterministic. */
  now?: () => Date;
  logger?: Logger;
}

export interface ReapSummary {
  expiredTokens: number;
  revokedTokens: number;
  verifications: number;
  loginHistory: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function totalDeleted(summary: ReapSummary): number {
  return (
    summary.expiredTokens +
    summary.revokedTokens +
    summary.verifications +
    summary.loginHistory
  );
}

/**
 * Deletes authentication rows that have outlived their usefulness.
 *
 * Every table this service owns is append-mostly, and `refresh_tokens` is the
 * worst of them. Rotation writes a row on *every* refresh, so with a
 * fifteen-minute access token one active client produces roughly ninety-six
 * rows a day, forever, and nothing in the request path ever removes one. Left
 * alone the table grows without bound — and since `findRefreshTokenByHash` is
 * on the hot path of every refresh, its unique index grows along with it.
 *
 * Doing this on a schedule rather than during rotation is a deliberate choice,
 * and the reasons are worth stating because the opposite looks cheaper:
 *
 *   - The predecessor row is load-bearing. Reuse detection works by finding an
 *     already-rotated token and seeing that it is revoked; deleting it at
 *     rotation time would turn the one signal that a token was stolen into an
 *     ordinary "unknown token" 401.
 *   - Opportunistic cleanup has inverted coverage. Rows accumulate from
 *     sessions nobody came back to, and those never rotate again — so the
 *     users who refresh constantly would pay to clean up after the users who
 *     left, while the abandoned rows stayed forever.
 *   - Rotation is the most latency-sensitive write in the service and already
 *     runs a transaction whose `revokedAt: null` guard resolves a real race
 *     between concurrent clients. It is the wrong place to add work that has
 *     no deadline at all.
 *
 * The sweep belongs to the service that owns the schema rather than to a
 * database job, so the retention policy is versioned and reviewed alongside
 * the code that writes the rows. `runOnce` is public so the same policy can be
 * driven by a real scheduler instead — a CronJob running `pnpm --filter
 * @services/auth reap` with `REAPER_ENABLED=false` on the API instances —
 * without the policy itself changing with the deployment shape.
 *
 * Safe to run on several instances at once. Each pass is a bounded delete of
 * rows that are already dead, so two workers racing over the same slice only
 * means one of them removes fewer rows than it asked for.
 */
export class AuthReaper {
  private readonly log: Logger;
  private readonly now: () => Date;

  private running = false;
  private timer?: NodeJS.Timeout;
  private cycle?: Promise<unknown>;

  constructor(
    private readonly repository: AuthRepository,
    private readonly options: ReaperOptions,
  ) {
    this.log = (options.logger ?? logger).child({ component: "auth-reaper" });
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Begins sweeping.
   *
   * Chained `setTimeout` rather than `setInterval`, so a sweep that runs long —
   * and the first one against a table that has never been swept will — delays
   * the next instead of overlapping with it.
   *
   * The first sweep waits a full interval rather than running at boot. Startup
   * is when the database is already busiest with the connection storm of the
   * instance coming up, and a process that crash-loops would otherwise reopen
   * the same batch of deletes on every restart without ever finishing one.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info({ intervalMs: this.options.intervalMs }, "reaper_started");
    this.schedule(this.options.intervalMs);
  }

  /** Stops sweeping and waits for the cycle in flight to finish. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.cycle;
    this.log.info("reaper_stopped");
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => void this.tick(), delayMs);
    // Never hold the event loop open on the reaper's account.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    this.cycle = (async () => {
      const [error, summary] = await this.runOnce();

      if (error) {
        // A failed sweep must not stop the loop, and there is nothing to
        // recover: the usual cause is the database being briefly unreachable,
        // and the rows are still there next cycle.
        this.log.error({ err: error }, "reap_cycle_failed");
      } else if (totalDeleted(summary) > 0) {
        this.log.info(summary, "reap_cycle_complete");
      }
    })();

    await this.cycle;

    if (this.running) this.schedule(this.options.intervalMs);
  }

  /**
   * One sweep across every table with a retention policy.
   *
   * Public so a cron, a test, or an operator can drive it directly instead of
   * the loop.
   *
   * Stops at the first failure rather than pressing on: the passes run in the
   * same order every cycle, and a database that just refused one delete is
   * unlikely to accept the next three. Nothing is lost by stopping — the
   * remaining rows are still dead, and the next cycle starts over.
   */
  async runOnce(): Promise<Result<ReapSummary>> {
    const now = this.now().getTime();
    const summary: ReapSummary = {
      expiredTokens: 0,
      revokedTokens: 0,
      verifications: 0,
      loginHistory: 0,
    };

    const [tokenError, tokens] = await this.repository.purgeRefreshTokens({
      expiredBefore: new Date(now - this.options.expiredGraceDays * MS_PER_DAY),
      revokedBefore: new Date(now - this.options.revokedRetentionDays * MS_PER_DAY),
      limit: this.options.batchSize,
    });
    if (tokenError) return fail(tokenError);
    summary.expiredTokens = tokens.expired;
    summary.revokedTokens = tokens.revoked;

    if (this.options.verificationRetentionDays > 0) {
      const [error, deleted] = await this.repository.purgeVerifications(
        new Date(now - this.options.verificationRetentionDays * MS_PER_DAY),
        this.options.batchSize,
      );
      if (error) return fail(error);
      summary.verifications = deleted;
    }

    if (this.options.loginHistoryRetentionDays > 0) {
      const [error, deleted] = await this.repository.purgeLoginHistory(
        new Date(now - this.options.loginHistoryRetentionDays * MS_PER_DAY),
        this.options.batchSize,
      );
      if (error) return fail(error);
      summary.loginHistory = deleted;
    }

    return ok(summary);
  }
}
