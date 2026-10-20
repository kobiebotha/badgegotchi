"""Read-only capability probe. No credentials or network requests."""
import sys, os, gc, time, machine
wdt = machine.WDT(timeout=16000)
print('RUNTIME', os.uname())
print('MPY', sys.implementation._mpy)
print('RTC_UTC', time.gmtime())
print('STATE_FILES', sorted(os.listdir('/state/badgegotchi')))
print('STATE_STATVFS', os.statvfs('/state'))
print('DATABASE_BYTES', os.stat('/state/badgegotchi/state.sqlite')[6])
for name in ('network', 'socket', 'ssl', 'select', 'asyncio', 'verified_tls', 'bounded_dns', 'network_runtime', 'resilient_wifi', 'network_preference', 'clock_boot'):
    wdt.feed()
    try:
        mod = __import__(name)
        print('MODULE_API', name, sorted(dir(mod)))
        if name == 'network':
            wlan = mod.WLAN(mod.STA_IF)
            print('WLAN_STATE', 'active', wlan.active(), 'connected', wlan.isconnected(), 'status', wlan.status())
        if name == 'ssl':
            print('SSL_CONTEXT_API', sorted(dir(mod.SSLContext)))
            context = mod.SSLContext(mod.PROTOCOL_TLS_CLIENT)
            print('SSL_CONTEXT_DEFAULT_VERIFY_MODE', context.verify_mode)
            print('SSL_CONTEXT_CIPHERS', context.get_ciphers() if hasattr(context, 'get_ciphers') else 'not exposed')
    except Exception as exc:
        print('MODULE_ERROR', name, type(exc).__name__, str(exc))
wdt.feed()
a = os.urandom(32)
b = os.urandom(32)
print('URANDOM_32_DISTINCT', len(a) == 32 and len(b) == 32 and a != b)
del a, b
gc.collect()
print('MEMORY_FREE', gc.mem_free())
print('PROBE_COMPLETE')
wdt.feed()
