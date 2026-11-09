import { Buffer } from 'node:buffer';

export interface FakeAdbPhoneWorld {
  readonly serial: string;
  readonly dimensions: { readonly width: number; readonly height: number };
  readonly rotation: 0 | 1 | 2 | 3;
  readonly secondaryRotation?: 0 | 1 | 2 | 3;
  readonly viewportFormat: 'display-viewport' | 'viewport-internal';
  readonly commands: string[][];
  readonly networkAttempts: string[];
  run(args: readonly string[]): Promise<Buffer>;
}

/** In-memory Android Fold boundary. It models adb's argv contract without starting adb or contacting a device. */
export function createFakeAdbPhoneWorld(options: {
  serial?: string;
  width?: number;
  height?: number;
  rotation?: 0 | 1 | 2 | 3;
  secondaryRotation?: 0 | 1 | 2 | 3;
  viewportFormat?: 'display-viewport' | 'viewport-internal';
  screenshot?: Buffer;
  uiDump?: string;
} = {}): FakeAdbPhoneWorld {
  const serial = options.serial ?? 'R58FAKEPHONE';
  const dimensions = { width: options.width ?? 2176, height: options.height ?? 1812 };
  const rotation = options.rotation ?? 0;
  const secondaryRotation = options.secondaryRotation;
  const viewportFormat = options.viewportFormat ?? 'display-viewport';
  const screenshot = options.screenshot ?? Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WQAAAABJRU5ErkJggg==',
    'base64',
  );
  const uiDump = options.uiDump ?? '<hierarchy rotation="0"><node text="Elanous demo" resource-id="app.demo/title" bounds="[0,0][2176,1812]" /><node class="android.widget.EditText" text="" resource-id="app.demo/demo-input" editable="true" focused="true" bounds="[0,600][2176,760]" /></hierarchy>';
  let uiPath: string | undefined;
  const commands: string[][] = [];
  const networkAttempts: string[] = [];
  return {
    serial,
    dimensions,
    rotation,
    ...(secondaryRotation === undefined ? {} : { secondaryRotation }),
    viewportFormat,
    commands,
    networkAttempts,
    async run(args) {
      const argv = [...args];
      commands.push(argv);
      if (argv[0] === 'devices') {
        return Buffer.from(`List of devices attached\n${serial} device product:fold model:Fold transport_id:1\n`);
      }
      if (argv[0] !== '-s' || argv[1] !== serial) throw new Error(`unknown fake adb target: ${argv.slice(0, 2).join(' ')}`);
      const command = argv.slice(2);
      if (command.join(' ') === 'shell wm size') {
        return Buffer.from(`Physical size: ${dimensions.width}x${dimensions.height}\n`);
      }
      if (command.join(' ') === 'shell dumpsys input') {
        const prefix = viewportFormat === 'viewport-internal' ? 'Viewport INTERNAL:' : 'DisplayViewport:';
        const secondaryPrefix = viewportFormat === 'viewport-internal' ? 'Viewport EXTERNAL:' : 'DisplayViewport:';
        return Buffer.from([
        `${prefix} displayId=0, orientation=${rotation}`,
        ...(secondaryRotation === undefined ? [] : [`${secondaryPrefix} displayId=1, orientation=${secondaryRotation}`]),
        '',
        ].join('\n'));
      }
      if (command.join(' ') === 'exec-out screencap -p') return Buffer.from(screenshot);
      if (command[0] === 'shell' && command[1] === 'uiautomator' && command[2] === 'dump' && command[3]?.startsWith('/data/local/tmp/elanous-phone-ui-')) {
        uiPath = command[3];
        return Buffer.from(`UI hierarchy dumped to: ${uiPath}\n`);
      }
      if (command[0] === 'exec-out' && command[1] === 'cat' && command[2] === uiPath) return Buffer.from(`${uiDump}\n`);
      if (command[0] === 'shell' && command[1] === 'rm' && command[2] === '-f' && command[3] === uiPath) {
        uiPath = undefined;
        return Buffer.alloc(0);
      }
      if (command[0] === 'shell' && command[1] === 'input' && ['tap', 'text'].includes(command[2] ?? '')) {
        return Buffer.alloc(0);
      }
      if (command[0] === 'shell' && command[1] === 'am' && command[2] === 'start'
        && command.includes('-a') && command.includes('android.intent.action.VIEW') && command.includes('-d')) {
        return Buffer.from('Starting: Intent { act=android.intent.action.VIEW }\n');
      }
      // adb shell sends one remote command string. Model its argument join so
      // tests catch callers that mistakenly expect host argv boundaries to
      // survive on the Android side.
      if (command[0] === 'shell') {
        const remoteCommand = command.slice(1).join(' ');
        const type = /^decoded=\$\(printf %s '([A-Za-z0-9+/=]+)' \| base64 -d\); input text "\$decoded"$/.exec(remoteCommand);
        if (type) {
          const payload = Buffer.from(type[1]!, 'base64').toString('utf8');
          return Buffer.from(`typed ${Buffer.byteLength(payload)} bytes\n`);
        }
        const open = /^url=\$\(printf %s '([A-Za-z0-9+/=]+)' \| base64 -d\); am start -a android\.intent\.action\.VIEW -d "\$url"$/.exec(remoteCommand);
        if (open) return Buffer.from(`opened ${Buffer.from(open[1]!, 'base64').toString('utf8')}\n`);
      }
      throw new Error(`unsupported fake adb argv: ${argv.join(' ')}`);
    },
  };
}
