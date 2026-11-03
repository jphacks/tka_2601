#pragma once
/* hardware/xiao_bff/README.md: XIAO ESP32S3 + add-on board v1. */
#define PIN_AMP_DIN 1     /* D0 */
#define PIN_AMP_LRCLK 2   /* D1 */
#define PIN_AMP_BCLK 3    /* D2 */
#define PIN_MIC_DATA 4    /* D3 */
#define PIN_MIC_CLK 5     /* D4 */
#define PIN_AMP_SD_MODE 6 /* D5: LOW stops the amp; released floats to (L+R)/2 mono */
#define PIN_SERVO_CALL 7   /* D8, servo 1 */
#define PIN_SERVO_END 8    /* D9, servo 2 */
#define PIN_SERVO_UNLOCK 9 /* D10, servo 3; USB test and calibration only */
