import { AgentService, TickResult } from '../agent/types.js';

export type CycleStatus = 'idle' | 'running' | 'published' | 'all_rejected' | 'error' | 'no_topics' | 'not_initialized';

export class SchedulerService {
  private agentService: AgentService;
  private intervalMinutes: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunningCycle = false;
  private _cycleStatus: CycleStatus = 'idle';
  private hasRunFirstCycle = false;

  constructor(agentService: AgentService, intervalMinutes: number = 60) {
    this.agentService = agentService;
    this.intervalMinutes = intervalMinutes;
  }

  async checkAndAutoStart(): Promise<boolean> {
    const initialized = await this.agentService.isInitialized();
    if (initialized) {
      // On restart, resume the interval timer but do NOT fire an immediate tick.
      // The agent may have run a cycle recently before the restart.
      this.start();
      return true;
    }
    return false;
  }

  /**
   * Start the autonomous scheduler timer.
   * @param options.immediateFirstTick  If true, fire the first cycle immediately
   *        (non-blocking) before waiting for the interval. Only fires once —
   *        repeated calls with this flag are safely ignored.
   */
  start(options?: { immediateFirstTick?: boolean }): void {
    if (this.timer !== null) {
      console.log('[SchedulerService] Autonomous scheduler timer is already active. Skipping duplicate timer creation.');
      return;
    }
    const ms = this.intervalMinutes * 60 * 1000;
    console.log(`[SchedulerService] Starting autonomous cycle timer (interval: ${this.intervalMinutes}m / ${ms}ms)`);

    this.timer = setInterval(async () => {
      await this.tick();
    }, ms);

    // Fire the very first cycle immediately, but only once ever.
    // The concurrency guard (isRunningCycle) provides additional safety.
    if (options?.immediateFirstTick && !this.hasRunFirstCycle) {
      this.hasRunFirstCycle = true;
      console.log('[SchedulerService] Triggering immediate first autonomous cycle.');
      // Fire-and-forget: don't await so /init returns instantly to the evaluator.
      this.tick().catch((err) => {
        console.error('[SchedulerService] Immediate first cycle error (non-fatal):', err);
      });
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[SchedulerService] Stopped autonomous cycle timer cleanly.');
    }
  }

  isTimerActive(): boolean {
    return this.timer !== null;
  }

  getCycleStatus(): CycleStatus {
    return this._cycleStatus;
  }

  async tick(): Promise<TickResult | { status: string; reason?: string; error?: string }> {
    if (this.isRunningCycle) {
      console.log('[SchedulerService] Autonomous cycle already in progress, skipping concurrent tick.');
      return { status: 'busy', reason: 'Previous cycle still running' };
    }

    this.isRunningCycle = true;
    this._cycleStatus = 'running';
    try {
      console.log(`[SchedulerService] Triggering autonomous cycle tick at ${new Date().toISOString()}`);
      const result = await this.agentService.runAutonomousCycle();
      console.log(`[SchedulerService] Autonomous cycle completed with status: ${result.status}`);
      this._cycleStatus = result.status as CycleStatus;
      return result;
    } catch (err: any) {
      console.error('[SchedulerService] Cycle execution error:', err);
      this._cycleStatus = 'error';
      return { status: 'error', reason: String(err), error: err.message || String(err) };
    } finally {
      this.isRunningCycle = false;
    }
  }
}
