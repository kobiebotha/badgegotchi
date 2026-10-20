"""Credential-free HTTPS capability test; no device file writes.

Bounded foreground I/O after DNS. getaddrinfo remains measured, unbounded runtime
API and is intentionally NOT a production transport. No badge app DB is opened.
"""
import os, sys, time, machine, gc, socket, tls
wdt = machine.WDT(timeout=16000)
print('TLS_RUNTIME', tls.MBEDTLS_VERSION)
print('RTC_UTC', time.gmtime())
print('TLS_CONTEXT_API', dir(tls.SSLContext))
HOSTS = ('bfccerfayrfolisawokp.supabase.co', '6ad76c8f2f27853eb0b0a128.powersync.journeyapps.com')
CA_PATHS = ('/system/lib/ca/gts-root-r1.der', '/system/lib/ca/gts-root-r4.der')

def connect_probe(host, hostname=None, trust=True):
    wdt.feed()
    gc.collect()
    before = gc.mem_free()
    started = time.ticks_ms()
    raw = None
    secure = None
    max_step = 0
    phase = 'dns'
    try:
        dns_start = time.ticks_ms()
        address = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)[0][-1]
        dns_ms = time.ticks_diff(time.ticks_ms(), dns_start)
        wdt.feed()
        phase = 'tcp'
        raw = socket.socket()
        raw.settimeout(3)
        tcp_start = time.ticks_ms()
        raw.connect(address)
        tcp_ms = time.ticks_diff(time.ticks_ms(), tcp_start)
        wdt.feed()
        raw.setblocking(False)
        phase = 'tls_context'
        ctx = tls.SSLContext(tls.PROTOCOL_TLS_CLIENT)
        ctx.verify_mode = tls.CERT_REQUIRED
        if trust:
            for path in CA_PATHS:
                with open(path, 'rb') as source:
                    ctx.load_verify_locations(source.read())
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
        if secure:
            secure.close()
        elif raw:
            raw.close()
        wdt.feed()

for host in HOSTS:
    connect_probe(host)
connect_probe(HOSTS[0], hostname='wrong-host.invalid')
connect_probe(HOSTS[0], trust=False)
print('TLS_PROBE_COMPLETE')
wdt.feed()
