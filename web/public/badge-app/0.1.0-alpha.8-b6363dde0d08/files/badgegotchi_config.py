"""Public development target only. No user credentials or signing keys."""
import os
GATEWAY_URL = "https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway"
POWERSYNC_URL = "https://6ad76c8f2f27853eb0b0a128.powersync.journeyapps.com"
STREAMS = ("badge_projection_compact",)
_APP = __file__.rsplit("/", 1)[0]
CA_FILES = ("/system/lib/ca/gts-root-r1.der", "/system/lib/ca/gts-root-r4.der",
            _APP + "/ca/sectigo-r46.der")
