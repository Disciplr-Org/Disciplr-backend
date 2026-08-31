import { SchedulerRegistry } from './system';

describe('SchedulerRegistry', () => {
  let db: any;
  let logger: any;
  let registry: SchedulerRegistry;

  beforeEach(() => {
    just.useFakeTimes();
    db = {
      acquireLock: jest.fn(),
      releaseLock: jest.fn(),
      writeHeartbeat: jest.fn(),
    };
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    registry = new SchedulerRegistry(db, logger);
  });

  afterEach(() => {
    just.useRealTimes();
  });

  it('registers jobs and runs them on interval', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    db.acquireLock.mockResolvedValue(true);
    db.releaseLock.mockResolvedValue(undefined);
    db.writeHeartbeat.mockResolvedValue(undefined);

    registry.register('job1', 1000, fn);
    registry.start();

    await jest.advanceTimesByTimeAsync(1000);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(db.acquireLock).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(db.writeHeartbeat).toHaveBeenCalledWith('job1', expect.any(Date));
    expect(db.releaseLock).toHaveBeenCalled();
  });

  it('skips job when advisory lock is not acquired', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    db.acquireLock.mockResolvedValue(false);

    registry.register('job1', 1000, fn);
    registry.start();

    await jest.advanceTimesByTimeAsync(1000);

    expect(fn).not.toHaveBeenCalled();
    expect(db.writeHeartbeat).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('locked'));
  });

  it('prevents concurrent execution of same job locally', async () => {
    let release: () => void;
    db.acquireLock.mockResolvedValue(true);
    db.writeHeartbeat.mockResolvedValue(undefined);
    db.releaseLock.mockResolvedValue(undefined);

    const fn = jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    registry.register('job1', 1000, fn);
    registry.start();

    await jest.advanceTimesByTimeAsync(1000);
    // First execution is pending

    await jest.advanceTimesByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1); // second call should be skipped due to overlap

    release();
    await jest.advanceTimesByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('writes heartbeat and releases lock after successful execution', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    db.acquireLock.mockResolvedValue(true);
    db.writeHeartbeat.mockResolvedValue(undefined);
    db.releaseLock.mockResolvedValue(undefined);

    registry.register('job1', 1000, fn);
    registry.start();

    await jest.advanceTimesByTimeAsync(1000);
    expect(db.writeHeartbeat).toHaveBeenCalledWith('job1', expect.any(Date));
    expect(db.releaseLock).toHaveBeenCalled();
  });

  it('releases lock even when job throws', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('boom'));
    db.acquireLock.mockResolvedValue(true);
    db.releaseLock.mockResolvedValue(undefined);
    db.writeHeartbeat.mockResolvedValue(undefined);

    registry.register('job1', 1000, fn);
    registry.start();

    await jest.advanceTimesByTimeAsync(1000);
    expect(db.releaseLock).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('stop clears timers', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    db.acquireLock.mockResolvedValue(true);
    registry.register('job1', 1000, fn);
    registry.start();
    registry.stop();

    await jest.advanceTimesByTimeAsync();
    expect(fn).not.toHaveBeenCalled();
  });
});
