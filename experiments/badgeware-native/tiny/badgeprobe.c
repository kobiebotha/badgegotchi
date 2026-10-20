#include "py/dynruntime.h"

// External linkage forces a GOT relocation; mpy_ld rejects static BSS offsets.
unsigned int calls;
static const char marker[] = "badgeware-native-v1";

static mp_obj_t answer(mp_obj_t value) {
    ++calls;
    return mp_obj_new_int(mp_obj_get_int(value) * 7);
}
static MP_DEFINE_CONST_FUN_OBJ_1(answer_obj, answer);

static mp_obj_t float_probe(mp_obj_t value) {
    return mp_obj_new_float(mp_obj_get_float(value) + (mp_float_t)0.5);
}
static MP_DEFINE_CONST_FUN_OBJ_1(float_probe_obj, float_probe);

static mp_obj_t locations(mp_obj_t buffer) {
    mp_buffer_info_t info;
    mp_get_buffer_raise(buffer, &info, MP_BUFFER_READ);
    mp_obj_t values[] = {
        mp_obj_new_int_from_uint((uintptr_t)&answer),
        mp_obj_new_int_from_uint((uintptr_t)marker),
        mp_obj_new_int_from_uint((uintptr_t)&calls),
        mp_obj_new_int_from_uint((uintptr_t)&info),
        mp_obj_new_int_from_uint((uintptr_t)info.buf),
        mp_obj_new_int_from_uint(calls),
    };
    return mp_obj_new_tuple(6, values);
}
static MP_DEFINE_CONST_FUN_OBJ_1(locations_obj, locations);

mp_obj_t mpy_init(mp_obj_fun_bc_t *self, size_t n_args, size_t n_kw, mp_obj_t *args) {
    MP_DYNRUNTIME_INIT_ENTRY
    calls = 0;
    mp_store_global(MP_QSTR_answer, MP_OBJ_FROM_PTR(&answer_obj));
    mp_store_global(MP_QSTR_float_probe, MP_OBJ_FROM_PTR(&float_probe_obj));
    mp_store_global(MP_QSTR_locations, MP_OBJ_FROM_PTR(&locations_obj));
    MP_DYNRUNTIME_INIT_EXIT
}
