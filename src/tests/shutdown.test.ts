import { EventEmitter } from "node:events";
import type { Server, Socket } from "node:net";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { ShutdownOptions } from "../server/shutdown.js";

let inFlightCount = 0;
const mockGetInFlightCount = jest.fn<() => number>(() => inFlightCount);
const mockSetDraining = jest.fn<(draining: boolean) => void>();

jest.unstable_mockModule("../middleware/inFlightRequests.js", () => ({
  getInFlightCount: mockGetInFlightCount,
  setDraining: mockSetDraining,
}));

jest.unstable_mockModule("../config/index.js", () => ({
  getEnv: () => ({ SHUTDOWN_DRAIN_MS: 200 }),
}));

const { createShutdownHandler } = await import("../server/shutdown.js");

function createServerMock(onClose?: (callback: (error?: Error) => void) => void) {
  const emitter = new EventEmitter();
  const close = jest.fn((callback: (error?: Error) => void) => {
    if (onClose) {
      onClose(callback);
    } else {
      callback();
    }
  });

  return {
    server: Object.assign(emitter, { close }) as unknown as Server,
    close,
  };
}

function createOptions(
  overrides: Partial<ShutdownOptions> = {},
): ShutdownOptions {
  const { server } = createServerMock();

  return {
    server,
    jobSystem: { stop: jest.fn<() => Promise<void>>().mockResolvedValue() } as
      ShutdownOptions["jobSystem"],
    etlWorker: { stop: jest.fn<() => Promise<void>>().mockResolvedValue() } as
      ShutdownOptions["etlWorker"],
    closeDb: jest.fn(),
    ...overrides,
  };
}

describe("createShutdownHandler", () => {
  beforeEach(() => {
    inFlightCount = 0;
    jest.clearAllMocks();
    jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("stops workers, drains requests, closes the server and database, then exits successfully", async () => {
    const calls: string[] = [];
    const { server, close } = createServerMock((callback) => {
      calls.push("server.close");
      callback();
    });
    const options = createOptions({
      server,
      etlWorker: {
        stop: jest.fn<() => Promise<void>>().mockImplementation(async () => {
          calls.push("etl.stop");
        }),
      } as ShutdownOptions["etlWorker"],
      jobSystem: {
        stop: jest.fn<() => Promise<void>>().mockImplementation(async () => {
          calls.push("jobs.stop");
        }),
      } as ShutdownOptions["jobSystem"],
      closeDb: jest.fn(() => calls.push("db.close")),
    });

    await createShutdownHandler(options)("SIGTERM");

    expect(calls).toEqual([
      "etl.stop",
      "jobs.stop",
      "server.close",
      "db.close",
    ]);
    expect(mockSetDraining.mock.calls).toEqual([[true], [false]]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("exits with failure when stopping the ETL worker rejects", async () => {
    const options = createOptions({
      etlWorker: {
        stop: jest
          .fn<() => Promise<void>>()
          .mockRejectedValue(new Error("ETL stop failed")),
      } as ShutdownOptions["etlWorker"],
    });

    await createShutdownHandler(options)("SIGTERM");

    expect(options.jobSystem.stop).not.toHaveBeenCalled();
    expect(options.closeDb).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with failure when stopping the job system rejects", async () => {
    const options = createOptions({
      jobSystem: {
        stop: jest
          .fn<() => Promise<void>>()
          .mockRejectedValue(new Error("job stop failed")),
      } as ShutdownOptions["jobSystem"],
    });

    await createShutdownHandler(options)("SIGTERM");

    expect(options.closeDb).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("does not close the database when the HTTP server fails to close", async () => {
    const { server } = createServerMock((callback) => {
      callback(new Error("server close failed"));
    });
    const options = createOptions({ server });

    await createShutdownHandler(options)("SIGTERM");

    expect(options.closeDb).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with failure when closing the database throws", async () => {
    const options = createOptions({
      closeDb: jest.fn(() => {
        throw new Error("database close failed");
      }),
    });

    await createShutdownHandler(options)("SIGTERM");

    expect(options.closeDb).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("ignores subsequent signals while a shutdown is already running", async () => {
    let finishEtL!: () => void;
    const etlStop = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishEtL = resolve;
        }),
    );
    const options = createOptions({
      etlWorker: { stop: etlStop } as ShutdownOptions["etlWorker"],
    });
    const handler = createShutdownHandler(options);

    const firstShutdown = handler("SIGTERM");
    await handler("SIGINT");
    expect(etlStop).toHaveBeenCalledTimes(1);

    finishEtL();
    await firstShutdown;

    expect(process.exit).toHaveBeenCalledTimes(1);
  });

  it("force-destroys open sockets when the drain deadline expires", async () => {
    jest.useFakeTimers();
    inFlightCount = 1;
    const { server } = createServerMock();
    const socket = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
    }) as unknown as Socket;
    const handler = createShutdownHandler(createOptions({ server }));
    server.emit("connection", socket);

    const shutdown = handler("SIGTERM");
    await jest.advanceTimersByTimeAsync(200);
    await shutdown;

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(mockSetDraining.mock.calls).toEqual([[true], [false]]);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
