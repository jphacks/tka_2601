#include "xlog.h"
#include <stdarg.h>
#include <stdio.h>
void xlog(const char *format, ...)
{
    va_list arguments;
    va_start(arguments, format);
    vprintf(format, arguments);
    va_end(arguments);
}
