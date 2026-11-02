#pragma once
/* USB serial: one command per line. @... calibration and tuning, single letters
 * for everything else (h lists them). Runs on the Arduino loop task. */
void console_begin(void);
void console_poll(void);
