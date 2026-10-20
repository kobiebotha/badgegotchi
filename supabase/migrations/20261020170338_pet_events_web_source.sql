-- Browser clients use the same server-owned pet event flow as native clients.
ALTER TABLE public.pet_events
    DROP CONSTRAINT IF EXISTS pet_events_source_device_check;

ALTER TABLE public.pet_events
    ADD CONSTRAINT pet_events_source_device_check
    CHECK (source_device IN ('macos', 'ios', 'badge', 'web'));
