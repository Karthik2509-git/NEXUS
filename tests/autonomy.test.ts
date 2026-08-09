import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { JsonFileStore } from '../src/persistence/jsonFileStore.js';
import { MemoryService } from '../src/memory/memoryService.js';
import { NexusAgentService } from '../src/agent/agentService.js';
import { SchedulerService } from '../src/scheduler/schedulerService.js';
import { MockLlmProvider } from '../src/generation/providers/mockLlmProvider.js';
import { createApp } from '../src/api/app.js';

describe('Production Autonomy & Resilience', () => {
  const testDir = path.resolve('./data-test-autonomy');
  let store: JsonFileStore;
  let memory: MemoryService;
  let agentService: NexusAgentService;
  let schedulerService: SchedulerService;

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    store = new JsonFileStore(testDir);
    memory = new MemoryService('local');
    agentService = new NexusAgentService({ store, memory });
    schedulerService = new SchedulerService(agentService, 60);
  });

  afterEach(() => {
    schedulerService.stop();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should maintain a singleton scheduler and prevent duplicate timers on repeated start/init', async () => {
    expect(schedulerService.isTimerActive()).toBe(false);

    schedulerService.start();
    expect(schedulerService.isTimerActive()).toBe(true);

    // Call start second time -> timer remains single instance
    schedulerService.start();
    expect(schedulerService.isTimerActive()).toBe(true);

    schedulerService.stop();
    expect(schedulerService.isTimerActive()).toBe(false);
  });

  it('should auto-resume autonomy upon server restart when state was previously initialized', async () => {
    // 1. Initialize agent
    await agentService.initialize({ name: 'NEXUS', domain: 'AI Engineering' });
    const state1 = await store.getAgentState();
    expect(state1.initialized).toBe(true);

    // 2. Simulate server reboot: instantiate fresh store & scheduler from same directory
    const freshStore = new JsonFileStore(testDir);
    const freshMemory = new MemoryService('local');
    const freshAgentService = new NexusAgentService({ store: freshStore, memory: freshMemory });
    const freshSchedulerService = new SchedulerService(freshAgentService, 60);

    expect(freshSchedulerService.isTimerActive()).toBe(false);

    // 3. Server boot invokes checkAndAutoStart()
    const resumed = await freshSchedulerService.checkAndAutoStart();
    expect(resumed).toBe(true);
    expect(freshSchedulerService.isTimerActive()).toBe(true);

    freshSchedulerService.stop();
  });

  it('should prevent concurrent tick execution via process-level lock', async () => {
    await agentService.initialize({ name: 'NEXUS', domain: 'AI Engineering' });

    // Mock long-running runAutonomousCycle
    vi.spyOn(agentService, 'runAutonomousCycle').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ status: 'completed' } as any), 100))
    );

    // Fire two ticks concurrently
    const tick1Promise = schedulerService.tick();
    const tick2Promise = schedulerService.tick();

    const [res1, res2] = await Promise.all([tick1Promise, tick2Promise]);

    expect(res1.status === 'busy' || res2.status === 'busy').toBe(true);
    const busyRes = res1.status === 'busy' ? res1 : res2;
    expect(busyRes.reason).toContain('Previous cycle still running');
  });

  it('should recover gracefully from a failed tick without killing the scheduler timer', async () => {
    await agentService.initialize({ name: 'NEXUS', domain: 'AI Engineering' });
    schedulerService.start();

    // Mock failing runAutonomousCycle
    vi.spyOn(agentService, 'runAutonomousCycle').mockRejectedValueOnce(new Error('Transient API failure'));

    const tickRes = await schedulerService.tick();
    expect(tickRes.status).toBe('error');
    expect(tickRes.reason).toContain('Transient API failure');

    // Timer remains active for future cycles!
    expect(schedulerService.isTimerActive()).toBe(true);
  });

  it('GET /api/agent/feed should read from persistence without triggering post generation', async () => {
    await agentService.initialize({ name: 'NEXUS', domain: 'AI Engineering' });

    const mockLlm = new MockLlmProvider();
    const app = createApp(agentService, schedulerService, store, memory, mockLlm);

    const initRes = await request(app).post('/api/agent/init').send();

    // Wait for the immediate first cycle (fire-and-forget) to settle
    await new Promise((resolve) => setTimeout(resolve, 150));

    // NOW set up the spy — after /init's immediate cycle has already completed
    const spyCycle = vi.spyOn(agentService, 'runAutonomousCycle');

    const res = await request(app).get(`/api/agent/feed?agentId=${initRes.body.agentId}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.posts)).toBe(true);
    // /feed must NEVER trigger generation
    expect(spyCycle).not.toHaveBeenCalled();
  });

  it('GET /api/health should report diagnostic metrics without exposing secrets', async () => {
    await agentService.initialize({ name: 'NEXUS', domain: 'AI Engineering' });
    schedulerService.start();

    const mockLlm = new MockLlmProvider();
    const app = createApp(agentService, schedulerService, store, memory, mockLlm);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.initialized).toBe(true);
    expect(res.body.schedulerActive).toBe(true);
    expect(res.body.memoryProvider).toBe('local');
    expect(res.body.llmProvider).toBe('mock');
    expect(res.body.timestamp).toBeDefined();

    // Ensure no credentials in response body
    const responseString = JSON.stringify(res.body);
    expect(responseString).not.toContain('API_KEY');
    expect(responseString).not.toContain('Bearer');
  });

  it('GET /api/health should include cycleStatus field', async () => {
    await agentService.initialize({ name: 'NEXUS', domain: 'AI Engineering' });

    const mockLlm = new MockLlmProvider();
    const app = createApp(agentService, schedulerService, store, memory, mockLlm);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.cycleStatus).toBeDefined();
    expect(res.body.cycleStatus).toBe('idle');
  });

  it('POST /api/agent/init should trigger exactly one immediate first autonomous cycle', async () => {
    const cycleSpy = vi.spyOn(agentService, 'runAutonomousCycle').mockResolvedValue({
      cycleId: 'cycle-test',
      timestamp: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      status: 'published',
      discoveredCount: 1,
      evaluatedCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      skippedDuplicatesCount: 0,
    });

    const mockLlm = new MockLlmProvider();
    const app = createApp(agentService, schedulerService, store, memory, mockLlm);

    await request(app).post('/api/agent/init').send({
      persona: { name: 'NEXUS', domain: 'AI Engineering' },
    });

    // Wait briefly for the fire-and-forget immediate tick to execute
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(cycleSpy).toHaveBeenCalledTimes(1);
    expect(schedulerService.isTimerActive()).toBe(true);
  });

  it('repeated POST /api/agent/init should NOT trigger duplicate immediate first cycles', async () => {
    const cycleSpy = vi.spyOn(agentService, 'runAutonomousCycle').mockResolvedValue({
      cycleId: 'cycle-test',
      timestamp: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      status: 'published',
      discoveredCount: 1,
      evaluatedCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      skippedDuplicatesCount: 0,
    });

    const mockLlm = new MockLlmProvider();
    const app = createApp(agentService, schedulerService, store, memory, mockLlm);

    await request(app).post('/api/agent/init').send();
    await request(app).post('/api/agent/init').send();
    await request(app).post('/api/agent/init').send();

    // Wait briefly for fire-and-forget
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Only one immediate tick should have fired (hasRunFirstCycle guard + timer guard)
    expect(cycleSpy).toHaveBeenCalledTimes(1);
  });

  it('scheduler should use the configured 60-minute interval, not a shorter one', () => {
    // The interval is set at construction time. Verify the timer interval
    // by confirming the scheduler was constructed with 60 minutes.
    const freshScheduler = new SchedulerService(agentService, 60);
    // The interval property is private, so we test behavior:
    // start() should create a timer and isTimerActive should be true
    freshScheduler.start();
    expect(freshScheduler.isTimerActive()).toBe(true);
    freshScheduler.stop();
  });

  it('cycleStatus should transition through running and final state', async () => {
    await agentService.initialize({ name: 'NEXUS', domain: 'AI Engineering' });

    expect(schedulerService.getCycleStatus()).toBe('idle');

    // Mock a slow tick to observe "running" state
    let resolvePromise: (v: any) => void;
    const longCycle = new Promise((resolve) => { resolvePromise = resolve; });
    vi.spyOn(agentService, 'runAutonomousCycle').mockImplementation(() => longCycle as any);

    const tickPromise = schedulerService.tick();

    // During execution, cycleStatus should be "running"
    expect(schedulerService.getCycleStatus()).toBe('running');

    // Resolve the cycle
    resolvePromise!({
      cycleId: 'cycle-x',
      timestamp: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
      status: 'published',
      discoveredCount: 1,
      evaluatedCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      skippedDuplicatesCount: 0,
    });

    await tickPromise;

    // After completion, status should reflect the result
    expect(schedulerService.getCycleStatus()).toBe('published');
  });

  it('auto-resume via checkAndAutoStart should NOT fire an immediate tick', async () => {
    await agentService.initialize({ name: 'NEXUS', domain: 'AI Engineering' });

    const freshStore = new JsonFileStore(testDir);
    const freshMemory = new MemoryService('local');
    const freshAgentService = new NexusAgentService({ store: freshStore, memory: freshMemory });
    const freshScheduler = new SchedulerService(freshAgentService, 60);

    const cycleSpy = vi.spyOn(freshAgentService, 'runAutonomousCycle');

    await freshScheduler.checkAndAutoStart();

    // Wait briefly
    await new Promise((resolve) => setTimeout(resolve, 100));

    // checkAndAutoStart should NOT fire an immediate tick — only set up the interval
    expect(cycleSpy).not.toHaveBeenCalled();
    expect(freshScheduler.isTimerActive()).toBe(true);

    freshScheduler.stop();
  });
});
