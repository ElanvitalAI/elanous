import { expect, test } from 'bun:test';
import { createFakeAdbPhoneWorld } from './fake-adb-phone-world.js';

test('fake Fold adb world supplies discovered dimensions, screenshot and UI tree without a device or network', async () => {
  const world = createFakeAdbPhoneWorld();
  expect((await world.run(['devices'])).toString()).toContain(`${world.serial} device`);
  expect((await world.run(['-s', world.serial, 'shell', 'wm', 'size'])).toString()).toContain('2176x1812');
  expect((await world.run(['-s', world.serial, 'exec-out', 'screencap', '-p'])).subarray(0, 8))
    .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const uiPath = '/data/local/tmp/elanous-phone-ui-sim.xml';
  await world.run(['-s', world.serial, 'shell', 'uiautomator', 'dump', uiPath]);
  expect((await world.run(['-s', world.serial, 'exec-out', 'cat', uiPath])).toString())
    .toContain('resource-id="app.demo/title"');
  await world.run(['-s', world.serial, 'shell', 'rm', '-f', uiPath]);
  expect(world.networkAttempts).toEqual([]);
});

test('fake adb models adb shell joining remote argv into one command string', async () => {
  const world = createFakeAdbPhoneWorld();
  const typed = 'hello $(id); echo not-a-command';
  const typedB64 = Buffer.from(typed).toString('base64');
  const typeCommand = `decoded=$(printf %s '${typedB64}' | base64 -d); input text "$decoded"`;
  const typeResult = await world.run(['-s', world.serial, 'shell', typeCommand]);
  expect(typeResult.toString()).toContain(`${Buffer.byteLength(typed)} bytes`);
  const url = 'http://127.0.0.1:4173/path?a=$(id)&x=1';
  const urlB64 = Buffer.from(url).toString('base64');
  const openCommand = `url=$(printf %s '${urlB64}' | base64 -d); am start -a android.intent.action.VIEW -d "$url"`;
  const openResult = await world.run(['-s', world.serial, 'shell', openCommand]);
  expect(openResult.toString()).toContain(url);
  expect(world.commands).toHaveLength(2);
  expect(world.commands[0]).toEqual(['-s', world.serial, 'shell', typeCommand]);
  expect(world.commands[1]).toEqual(['-s', world.serial, 'shell', openCommand]);
  expect(world.networkAttempts).toEqual([]);
});
