"""Credential-free HTTPS capability test; no device file writes.

Uses the installed stepped resolver and nonblocking TCP/TLS. This is diagnostic
code, not the production sync supervisor. No badge app DB is opened.
"""
import os, sys, time, machine, gc, socket, tls, select, network, bounded_dns
wdt = machine.WDT(timeout=16000)
print('TLS_RUNTIME', tls.MBEDTLS_VERSION)
print('RTC_UTC', time.gmtime())
print('WIFI_CONNECTED', network.WLAN(network.STA_IF).isconnected())
print('WIFI_RSSI_DBM', network.WLAN(network.STA_IF).status('rssi'))
HOSTS = ('bfccerfayrfolisawokp.supabase.co', '6ad76c8f2f27853eb0b0a128.powersync.journeyapps.com')
CA_PATHS = ('/system/lib/ca/gts-root-r1.der', '/system/lib/ca/gts-root-r4.der')

def connect_probe(host, hostname=None, trust=True, cancel_pending=False):
    wdt.feed()
    gc.collect()
    before = gc.mem_free()
    started = time.ticks_ms()
    raw = None
    secure = None
    max_step = 0
    query = None
    phase = 'dns'
    try:
        dns_start = time.ticks_ms()
        query = bounded_dns.SteppedQuery(host, bounded_dns.resolver_address(network.WLAN(network.STA_IF)), timeout_ms=3000, attempts=2)
        while True:
            wdt.feed()
            tick = time.ticks_ms()
            resolved = query.step()
            max_step = max(max_step, time.ticks_diff(time.ticks_ms(), tick))
            if resolved is not bounded_dns.PENDING:
                address = (resolved, 443)
                break
            time.sleep_ms(5)
        dns_ms = time.ticks_diff(time.ticks_ms(), dns_start)
        wdt.feed()
        phase = 'tcp'
        raw = socket.socket()
        raw.setblocking(False)
        tcp_start = time.ticks_ms()
        try:
            raw.connect(address)
        except OSError as exc:
            if exc.args[0] != 115:
                raise
        poller = select.poll()
        poller.register(raw, select.POLLOUT)
        while not poller.poll(0):
            wdt.feed()
            if time.ticks_diff(time.ticks_ms(), tcp_start) > 4000:
                raise OSError('TCP deadline')
            time.sleep_ms(5)
        poller.unregister(raw)
        tcp_ms = time.ticks_diff(time.ticks_ms(), tcp_start)
        wdt.feed()
        raw.setblocking(False)
        phase = 'tls_context'
        ctx = tls.SSLContext(tls.PROTOCOL_TLS_CLIENT)
        ctx.verify_mode = tls.CERT_REQUIRED
        assert ctx.verify_mode == tls.CERT_REQUIRED
        ciphers = [name for name in ctx.get_ciphers() if 'GCM' in name or 'CHACHA20' in name]
        assert ciphers, 'No supported AEAD ciphers'
        ctx.set_ciphers(ciphers)
        if trust:
            for path in CA_PATHS:
                with open(path, 'rb') as source:
                    ctx.load_verify_locations(source.read())
        if trust and globals().get('EXTRA_CA'):
            ctx.load_verify_locations(EXTRA_CA)
        phase = 'tls_handshake'
        secure = ctx.wrap_socket(raw, server_hostname=hostname or host, do_handshake_on_connect=False)
        request = ('GET / HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n').encode()
        sent = 0
        deadline = time.ticks_ms()
        while sent < len(request):
            wdt.feed()
            tick = time.ticks_ms()
            count = secure.write(memoryview(request)[sent:])
            max_step = max(max_step, time.ticks_diff(time.ticks_ms(), tick))
            if cancel_pending and count is None:
                print('PENDING_TLS_CANCEL', host, 'after_ms', time.ticks_diff(time.ticks_ms(), deadline), 'max_step_ms', max_step)
                return
            if count:
                sent += count
            if time.ticks_diff(time.ticks_ms(), deadline) > 6000:
                raise OSError('TLS/write deadline')
            time.sleep_ms(5)
        phase = 'http_status'
        status = b''
        while b'\n' not in status and len(status) < 256:
            wdt.feed()
            tick = time.ticks_ms()
            chunk = secure.read(1)
            max_step = max(max_step, time.ticks_diff(time.ticks_ms(), tick))
            if chunk:
                status += chunk
            elif chunk == b'':
                raise OSError('EOF before status')
            if time.ticks_diff(time.ticks_ms(), deadline) > 8000:
                raise OSError('HTTP deadline')
            time.sleep_ms(5)
        if b'\n' not in status:
            raise OSError('Status too long')
        print('HTTPS_RESULT', host, 'hostname', hostname or host, 'trust', trust,
              'status', status.strip(), 'cipher', secure.cipher(), 'dns_ms', dns_ms,
              'tcp_ms', tcp_ms, 'max_tls_step_ms', max_step,
              'elapsed_ms', time.ticks_diff(time.ticks_ms(), started),
              'heap_delta_bytes', before - gc.mem_free())
    except Exception as exc:
        print('HTTPS_FAILURE', host, 'hostname', hostname or host, 'trust', trust,
              'phase', phase, 'type', type(exc).__name__, 'error', str(exc),
              'max_tls_step_ms', max_step,
              'elapsed_ms', time.ticks_diff(time.ticks_ms(), started))
    finally:
        if query:
            query.close()
        if secure:
            secure.close()
        elif raw:
            raw.close()
        wdt.feed()

if globals().get('PROBES'):
    for probe in PROBES:
        connect_probe(*probe)
else:
    for host in HOSTS:
        connect_probe(host)
        connect_probe(host)
    connect_probe(HOSTS[0], trust=False)
    connect_probe(HOSTS[0], cancel_pending=True)
    connect_probe(HOSTS[0])
print('TLS_PROBE_COMPLETE')
wdt.feed()
