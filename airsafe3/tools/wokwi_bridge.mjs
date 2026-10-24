#!/usr/bin/env node
/**
 * Wokwi -> AIRSAFE backend bridge (Node, no dependencies).
 *
 * The simulated ESP32 (built with -DTRANSPORT_SERIAL=1) prints one line per reading on USB serial:
 *     AIRSAFE_JSON {"co2_ppm":812,"pm25_ugm3":14,...}
 * Wokwi exposes that serial port on localhost:4000 (rfc2217ServerPort in wokwi.toml). This script reads
 * those lines and POSTs each to /api/ingest/reading with the device's X-Device-Id / X-Device-Key headers,
 * exactly what the real firmware does over WiFi. The backend cannot tell the difference.
 *
 * Usage:
 *   node tools/wokwi_bridge.mjs --device-id esp32-iso1-01 --device-key <KEY>
 *   node tools/wokwi_bridge.mjs --serial tcp://localhost:4000 --base http://localhost:8000 ...
 * A real board on a COM port also works if you `npm i serialport` (optional): --serial COM5
 */
import net from 'node:net';

const PREFIX = 'AIRSAFE_JSON ';
const IAC = 255, SB = 250, SE = 240, WILL = 251, WONT = 252, DO = 253, DONT = 254;

// Wokwi's rfc2217 port speaks telnet: strip option negotiation (IAC sequences) and politely refuse options.
export function createTelnetFilter(onByte, reply) {
  let state = 'data', cmd = 0;
  return (chunk) => {
    for (const b of chunk) {
      if (state === 'data') { if (b === IAC) state = 'iac'; else onByte(b); }
      else if (state === 'iac') {
        if (b === IAC) { onByte(255); state = 'data'; }
        else if (b === SB) state = 'sb';
        else if (b >= WILL && b <= DONT) { cmd = b; state = 'opt'; }
        else state = 'data';
      } else if (state === 'opt') {
        if (cmd === DO) reply(Buffer.from([IAC, WONT, b]));
        else if (cmd === WILL) reply(Buffer.from([IAC, DONT, b]));
        state = 'data';
      } else if (state === 'sb') { if (b === IAC) state = 'sb_iac'; }
      else if (state === 'sb_iac') { state = b === SE ? 'data' : 'sb'; }
    }
  };
}

function parseArgs(argv) {
  const a = { serial: 'tcp://localhost:4000', base: 'http://localhost:8000', max: 0,
    deviceId: process.env.AIRSAFE_DEVICE_ID, deviceKey: process.env.AIRSAFE_DEVICE_KEY };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--serial') { a.serial = v; i++; }
    else if (k === '--base') { a.base = v; i++; }
    else if (k === '--device-id') { a.deviceId = v; i++; }
    else if (k === '--device-key') { a.deviceKey = v; i++; }
    else if (k === '--max') { a.max = Number(v); i++; }
    else if (k === '-h' || k === '--help') { console.log('see header of tools/wokwi_bridge.mjs'); process.exit(0); }
  }
  return a;
}

async function postReading(base, id, key, rawBody) {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/ingest/reading`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': id, 'X-Device-Key': key },
      body: rawBody,   // exact bytes from the firmware
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.status, body: (await res.text()).slice(0, 160) };
  } catch (e) {
    return { status: 0, body: e.cause?.code || e.message };
  }
}

function connectTcp(url, onLine) {
  const m = url.match(/^(?:tcp|socket|rfc2217):\/\/([^:/]+):(\d+)/);
  if (!m) throw new Error(`unsupported --serial "${url}" (use tcp://host:port)`);
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: m[1], port: Number(m[2]) });
    let buf = '';
    const filter = createTelnetFilter((b) => {
      if (b === 10) { onLine(buf.trim()); buf = ''; } else if (b !== 13) buf += String.fromCharCode(b);
    }, (r) => sock.write(r));
    sock.on('connect', () => console.log(`[bridge] connected to ${url}`));
    sock.on('data', filter);
    sock.on('error', (e) => console.log(`[bridge] serial source unavailable (${e.code || e.message}); retrying in 3 s (is the Wokwi simulation running?)`));
    sock.on('close', () => resolve());
  });
}

async function connectSerialPort(path, onLine) {
  let SerialPort, ReadlineParser;
  try { ({ SerialPort } = await import('serialport')); ({ ReadlineParser } = await import('@serialport/parser-readline')); }
  catch { throw new Error('COM/tty ports need the optional package:  npm i serialport'); }
  await new Promise((resolve) => {
    const port = new SerialPort({ path, baudRate: 115200 });
    port.pipe(new ReadlineParser({ delimiter: '\n' })).on('data', (l) => onLine(String(l).trim()));
    port.on('open', () => console.log(`[bridge] connected to ${path}`));
    port.on('error', (e) => console.log(`[bridge] ${e.message}`));
    port.on('close', resolve);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.deviceId || !args.deviceKey) {
    console.error('Need --device-id and --device-key (or AIRSAFE_DEVICE_ID / AIRSAFE_DEVICE_KEY). Provision the device on the Devices page first; the key is shown once.');
    process.exit(2);
  }
  let ok = 0, rejected = 0, failed = 0, done = false;
  const queue = [];
  let busy = false;

  const finish = () => {
    console.log(`[bridge] done: ${ok} ok, ${rejected} rejected, ${failed} failed`);
    process.exit(ok && !failed ? 0 : 1);
  };

  async function pump() {   // one POST at a time, in order
    if (busy) return;
    busy = true;
    while (queue.length && !done) {
      const { payload, raw } = queue.shift();
      const { status, body } = await postReading(args.base, args.deviceId, args.deviceKey, raw);
      if (status === 200) { ok++; console.log(`[bridge] OK  co2=${payload.co2_ppm} pm25=${payload.pm25_ugm3} occ=${payload.occupancy}  (sent ${ok}, rejected ${rejected}, failed ${failed})`); }
      else if (status === 401 || status === 403) { failed++; console.log(`[bridge] AUTH FAILED (${status}): wrong --device-id/--device-key? ${body}`); }
      else if (status >= 400 && status < 500) { rejected++; console.log(`[bridge] REJECTED (${status}) permanently: ${body}`); }
      else { failed++; console.log(`[bridge] backend unreachable or error (${status}): ${body}`); }
      if (args.max && ok + rejected + failed >= args.max) { done = true; finish(); }
    }
    busy = false;
  }

  const onLine = (line) => {
    if (!line.startsWith(PREFIX)) { if (line) console.log(`[esp32] ${line}`); return; }
    const raw = line.slice(PREFIX.length);
    try { queue.push({ payload: JSON.parse(raw), raw }); } catch { console.log(`[bridge] bad JSON ignored: ${line.slice(0, 80)}`); return; }
    pump();
  };

  for (;;) {
    try {
      if (/^(tcp|socket|rfc2217):\/\//.test(args.serial)) await connectTcp(args.serial, onLine);
      else await connectSerialPort(args.serial, onLine);
    } catch (e) { console.error(e.message); process.exit(2); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('wokwi_bridge.mjs')) main();
