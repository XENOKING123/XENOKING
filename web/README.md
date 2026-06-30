# XENO TOOL Web

Run the **full** XENO TOOL from a web browser — phone, tablet, laptop, anything
on your network. No install. Same tool as the desktop app: connect to your PS5,
run cheats, send payloads, browse trainers, manage plugins, XENO CHAT.

## How it works

XENO TOOL Web is the same app you know, served by a tiny local server. You run
the server once on any always-on machine (your PC, a mini-PC, a Pi-class box),
and then open it from any browser on your network:

```
http://<that-machine's-IP>:6969
```

You enter your PS5's IP in the app exactly like the desktop version.

## Quick start

**Windows**

1. Unzip `XENO_TOOL_Web_windows_x64.zip`.
2. Double-click `launch-windows.bat`.
3. Note the IP it prints (run `ipconfig` if unsure — your IPv4 Address).
4. On your phone/laptop, open `http://THAT-IP:6969`.

**Linux / macOS**

```bash
unzip XENO_TOOL_Web_linux_x64.zip && cd XENO_TOOL_Web
./launch-linux.sh
```

Then open `http://<printed-ip>:6969` from any browser.

## Changing the port

Set `PS5UPLOAD_ENGINE_PORT` before launching (default `6969`):

```bash
PS5UPLOAD_ENGINE_PORT=8080 ./launch-linux.sh
```

## Notes

- The server binds `0.0.0.0`, so anyone on your LAN can reach it while it's
  running. Run it on a trusted home network; stop it (Ctrl+C) when done.
- Feature coverage grows over time. Core PS5 screens (Dashboard, Hardware,
  Installed Apps, Plugin Manager, Volumes, File browser) work today; screens
  for commands not yet wired to the web API show a clear "not available in web
  yet" message instead of breaking.
