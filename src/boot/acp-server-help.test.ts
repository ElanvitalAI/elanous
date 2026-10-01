import { describe, expect, test } from 'bun:test';
import { parseAcpBootArgs } from './acp-server.js';
import { acpServerHelpText } from './acp-server-help.js';

describe('ACP server help', () => {
  test('advertises exactly the transports accepted by the boot parser', () => {
    const help = acpServerHelpText();
    const advertised = help.match(/^\s+--transport=([^\s]+)\s+Connection transport/m)?.[1]?.split('|');
    if (!advertised) throw new Error('ACP help does not list transports');

    const parserError = (() => {
      try {
        parseAcpBootArgs(['--transport=not-a-transport']);
      } catch (error) {
        return String(error);
      }
      throw new Error('ACP parser accepted an invalid transport');
    })();
    const accepted = parserError.match(/\(expected ([^)]+)\)/)?.[1]?.split(/\s*\|\s*/);
    if (!accepted) throw new Error('ACP parser does not list accepted transports');
    expect(advertised.join('|')).toBe(accepted.join('|'));
    for (const transport of advertised) {
      expect(String(parseAcpBootArgs([`--transport=${transport}`]).transport)).toBe(transport);
    }
    expect(parseAcpBootArgs([]).transport).toBe('stdio');
    expect(() => parseAcpBootArgs(['--transport=not-a-transport'])).toThrow();
  });

  test('includes English usage and a Zed setup manual path', () => {
    const help = acpServerHelpText();
    expect(help).toContain('Usage: elanous --acp-server');
    expect(help).toContain('docs/manual/MANUAL-zed-acp.md');
    expect(help).not.toMatch(/Example:[^\n]*--port=\d+/);
  });
});
