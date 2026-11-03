#pragma once
/* Owns Wi-Fi, NTP and the on-demand API HTTPS check. */
void net_task(void* argument);
void net_request_api_probe(void);
void net_report_wifi(void);
void net_report_calibration(void); /* "@net" */
