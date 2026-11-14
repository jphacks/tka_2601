"""Temporary packet storage must not be borrowed by queued TCP writes."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


class SocketCopyTests(unittest.TestCase):
    def test_copy_ownership_flags_partial_count_and_error(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work/'lwip').mkdir()
            (work/'lwip/api.h').write_text('''#include <stddef.h>
typedef int err_t;
typedef unsigned char u8_t;
struct netconn { int unused; };
#define NETCONN_COPY 1
''')
            (work/'test.c').write_text('''#include "lwip/api.h"
#include <assert.h>
#include <string.h>
static char queued[16];
static unsigned observed;
err_t __real_netconn_write_partly(struct netconn *c,const void *p,size_t n,u8_t flags,size_t *written) {
    assert(c && n==4); observed=flags;
    assert(flags&NETCONN_COPY); memcpy(queued,p,n);
    *written=2; return -7;
}
err_t __wrap_netconn_write_partly(struct netconn *,const void *,size_t,u8_t,size_t *);
int main(void) {
    struct netconn c={0}; char packet[4]={'a','b','c','d'}; size_t written=0;
    assert(__wrap_netconn_write_partly(&c,packet,4,6,&written)==-7);
    memset(packet,0,4);
    assert(written==2 && observed==7 && !memcmp(queued,"abcd",4));
    return 0;
}
''')
            binary=work/'copy'
            subprocess.run(['clang','-std=c11','-Wall','-Wextra','-Werror',
                            '-fsanitize=address,undefined','-I',str(work),
                            str(ROOT/'source/socket_copy.c'),str(work/'test.c'),'-o',str(binary)],check=True)
            subprocess.run([str(binary)],check=True)
