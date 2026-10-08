import { spyOn } from 'bun:test';
import * as os from 'node:os';

/** Bun does not refresh os.homedir() when HOME changes after process startup. */
export async function withTestHome<T>(home: string, run: () => T | Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const homedirSpy = spyOn(os, 'homedir');
  try {
    process.env.HOME = home;
    homedirSpy.mockReturnValue(home);
    return await run();
  } finally {
    homedirSpy.mockRestore();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}
