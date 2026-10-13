/*
 * launcher_icon.h — registers the XENO STORE deep-link shortcut on the PS5
 * home screen ("Games" row) so the store opens with one press of the icon.
 *
 * launcher_icon_register() is called once from main.c after the server binds.
 * It is idempotent and never fatal: a failure only means the icon is absent,
 * the server keeps running. On the host build it is a logged no-op.
 */
#ifndef XENO_LAUNCHER_ICON_H
#define XENO_LAUNCHER_ICON_H

/* Writes /user/app/XENO00002/sce_sys/{param.json,icon0.png} and asks the shell
 * to register the title. Returns 0 when the icon is in place (or on host),
 * -1 when the files could not be written. Records the outcome in
 * <data_dir>/launcher.json. Safe to call once; guards every Sony symbol. */
int launcher_icon_register(void);

#endif
