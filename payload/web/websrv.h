/* XENO-AIO web server — public entry point. Linked into the full payload
 * only when built with -DWITH_WEBSRV (the XENO-AIO.elf target). */
#ifndef WEBSRV_H
#define WEBSRV_H

/* Pop the URL toast and start the HTTP server on a detached thread.
 * Call from the payload's main() AFTER the mgmt server (:9114) is up —
 * the web API proxies to it on localhost. */
void websrv_start(void);

#endif /* WEBSRV_H */
