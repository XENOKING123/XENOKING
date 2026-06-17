# Jailbreak Payloads

## p2jb_turbo.js — P2JB TURBO 1.0 (FW 9.00 – 12.40+)

6-core optimized P2JB kernel exploit for Y2JB. Cuts time from ~50 min to ~33 min.

**Works on:** FW 9.00 – 12.40 (and above as long as P2JB is viable)

### How to use

1. Open YouTube on PS5 — Y2JB loads and shows your PS5 IP on screen
2. Wait for "Waiting for payload on port 50000"
3. Send the file to your PS5:
   ```
   python payload_sender.py YOUR_PS5_IP p2jb_turbo.js
   ```
4. Wait ~33 minutes — progress % shown on PS5 screen

### Make it permanent (FileZilla FTP)

After the jailbreak succeeds once, FTP in and replace the file so it runs automatically on every YouTube open:

1. Open FileZilla → connect to `192.168.4.44` port `21` (or whatever FTP server your PS5 runs)
2. Navigate to:
   ```
   /mnt/sandbox/PPSA01650_000/download0/cache/splash_screen/aHR0cHM6Ly93d3cueW91dHViZS5jb20vdHY=/
   ```
   (try `_001` or `_002` if `_000` doesn't exist)
3. Find `p2jb.js` in that folder
4. Right-click `p2jb_turbo.js` on your PC side → Upload → it will ask to overwrite `p2jb.js` — **rename it to `p2jb.js` when uploading**
5. Close YouTube completely on PS5, reopen it — now runs turbo automatically forever

**Extract password if needed:** `DLPSGAME.COM`
