#!/usr/bin/env python3
"""Read macOS process identity without losing argv boundaries. Fail closed."""
import ctypes
import json
import struct
import sys


def parse_procargs(data):
    """KERN_PROCARGS2: native int argc, exec path, padding, argc NUL strings."""
    if len(data) < 5:
        raise ValueError("short procargs")
    argc = struct.unpack_from("=i", data)[0]
    if argc < 1 or argc > len(data):
        raise ValueError("invalid argc")
    end = data.find(b"\0", 4)
    if end <= 4:
        raise ValueError("missing executable")
    offset = end + 1
    while offset < len(data) and data[offset] == 0:
        offset += 1
    argv = []
    for _ in range(argc):
        end = data.find(b"\0", offset)
        if end < 0:
            raise ValueError("truncated argv")
        argv.append(data[offset:end].decode("utf-8", "strict"))
        offset = end + 1
    return argv


def read_process(pid):
    if sys.platform != "darwin" or not 0 < pid <= 2147483647:
        raise ValueError("macOS and a positive PID required")
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                           ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                           ctypes.c_void_p, ctypes.c_size_t]
    libc.sysctl.restype = ctypes.c_int
    argmax = ctypes.c_int()
    size = ctypes.c_size_t(ctypes.sizeof(argmax))
    if libc.sysctl((ctypes.c_int * 2)(1, 8), 2, ctypes.byref(argmax),
                   ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "KERN_ARGMAX")
    if not 0 < argmax.value <= 16 * 1024 * 1024:
        raise ValueError("invalid KERN_ARGMAX")
    buffer = ctypes.create_string_buffer(argmax.value)
    size = ctypes.c_size_t(len(buffer))
    if libc.sysctl((ctypes.c_int * 3)(1, 49, pid), 3, buffer,
                   ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "KERN_PROCARGS2")
    argv = parse_procargs(buffer.raw[:size.value])
    libc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    libc.proc_pidpath.restype = ctypes.c_int
    executable = ctypes.create_string_buffer(4096)
    if libc.proc_pidpath(pid, executable, len(executable)) <= 0:
        raise OSError(ctypes.get_errno(), "proc_pidpath")
    return {"executable": executable.value.decode("utf-8", "strict"), "argv": argv}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("one PID required")
        print(json.dumps(read_process(int(sys.argv[1]))))
    except (ValueError, OSError, UnicodeError, AttributeError):
        sys.exit(1)
